/**
 * quant-bridge.js — Node → Python 计算桥（ARCHITECTURE §2 quant-bridge）
 *
 * 职责：
 *   把 Quant Engine 的重计算委托给 Python 子进程，Node 侧只负责参数校验与结果透传。
 *
 * 为什么走子进程而不是 FastAPI sidecar：
 *   MVP 阶段调用频率低（一次研究一次计算），子进程最简单、无端口、无生命周期管理。
 *   ARCHITECTURE 预留了 sidecar 方案；若将来需要常驻/并发，只需替换本文件的实现。
 *
 * 环境变量：
 *   DSH_STOCK_LAB_PYTHON   Python 解释器路径（缺省用 `python`）
 *   DSH_STOCK_LAB_DATA     数据目录（传给子进程）
 *   DSH_STOCK_LAB_BACKEND  backend 目录（缺省为包内 backend）
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pkgRoot, backendDir, resolveDataRoot } from '../../data-root.js'

const TIMEOUT_MS = 120000

/** 缓存解析结果，避免每次调用都探测文件系统 */
let _pythonCache = null

/**
 * 解析 Python 解释器路径。
 *
 * 顺序：
 *   1. DSH_STOCK_LAB_PYTHON（显式配置，最高优先级）
 *   2. 包内 .python-path 文件（用户自定义，一行路径）
 *   3. DSH_PYTHON 环境变量
 *   4. DSH 运行时自带的 python（$DSH_HOME / ~/.dsh 下的 dsh-runtimes）
 *   5. PATH 上的 python / python3
 *
 * 注：DSH 宿主进程通常不把 python 放进 PATH，所以第 4 步是实际生效的那一步。
 */
function resolvePython() {
  if (_pythonCache) return _pythonCache

  const candidates = []
  if (process.env.DSH_STOCK_LAB_PYTHON) candidates.push(process.env.DSH_STOCK_LAB_PYTHON)
  // 包内配置文件
  try {
    const cfg = join(pkgRoot, '.python-path')
    if (existsSync(cfg)) {
      const line = readFileSync(cfg, 'utf8').split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'))
      if (line) candidates.push(line)
    }
  } catch { /* ignore */ }
  if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON)

  // DSH 运行时位置（多个可能根）
  const dshRoots = [
    process.env.DSH_HOME,
    join(homedir(), '.dsh'),
  ].filter(Boolean)
  for (const root of dshRoots) {
    candidates.push(join(root, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
    candidates.push(join(root, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'))
  }

  // 兜底：PATH
  candidates.push('python', 'python3')

  for (const c of candidates) {
    if (!c) continue
    // 只在是路径时校验存在性；裸命令名交给 spawn 解析
    if (c.includes('\\') || c.includes('/')) {
      if (existsSync(c)) { _pythonCache = c; return c }
      continue
    }
    _pythonCache = c
    return c
  }
  _pythonCache = 'python'
  return _pythonCache
}

/** 供诊断路由使用：返回探测过程与结果 */
export function pythonDiagnostics() {
  const chosen = resolvePython()
  const probes = []
  const add = (label, p) => {
    if (!p) return
    const isPath = p.includes('\\') || p.includes('/')
    probes.push({ label, value: p, isPath, exists: isPath ? existsSync(p) : null })
  }
  add('DSH_STOCK_LAB_PYTHON', process.env.DSH_STOCK_LAB_PYTHON)
  add('DSH_PYTHON', process.env.DSH_PYTHON)
  for (const root of [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)) {
    add('runtime(' + root + ')', join(root, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  }
  return {
    chosen,
    env: {
      DSH_STOCK_LAB_PYTHON: process.env.DSH_STOCK_LAB_PYTHON || null,
      DSH_PYTHON: process.env.DSH_PYTHON || null,
      DSH_HOME: process.env.DSH_HOME || null,
      DSH_PROFILE: process.env.DSH_PROFILE || null,
      DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR || null,
      PATH: (process.env.PATH || '').includes('python') ? '包含 python' : '不含 python',
    },
    dataDir: process.env.DSH_STOCK_LAB_DATA || join(pkgRoot, 'data'),
    backendDir,
    probes,
  }
}

/**
 * 执行一个 Python 脚本并解析其 JSON 输出。
 * @param scriptPath backend 下的相对路径，如 'quant/event_study.py'
 * @param args 命令行参数数组
 */
export function runPythonJson(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const script = join(backendDir, scriptPath)
    if (!existsSync(script)) {
      reject(new Error('Python 脚本不存在：' + script))
      return
    }
    const py = resolvePython()
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      // 关键：把 Node 侧解析出的数据根目录交给 Python，
      // 保证「写入方」与「读取方」指向同一个目录（否则会出现写进 A 读 B 的怪象）
      DSH_STOCK_LAB_DATA: resolveDataRoot(),
    }
    let child
    try {
      child = spawn(py, [script, ...args], { env, windowsHide: true })
    } catch (e) {
      // spawn 可能同步抛错（如受限环境下的 EPERM），必须在这里兜住
      reject(new Error('无法启动 Python（' + py + '）：' + (e?.message || e)))
      return
    }

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('Python 计算超时（' + TIMEOUT_MS / 1000 + 's）'))
    }, TIMEOUT_MS)

    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error('无法启动 Python（' + py + '）：' + (e?.message || e)
        + '。请设置环境变量 DSH_STOCK_LAB_PYTHON 指向 python 可执行文件。'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const trimmed = out.trim()
      if (code !== 0) {
        // 优先从 stderr 里提取可读的异常消息
        const lastErrLine = err.trim().split('\n').filter(Boolean).pop() || ''
        reject(new Error(
          (lastErrLine || `Python 退出码 ${code}`)
          + (trimmed ? ' | stdout: ' + trimmed.slice(0, 300) : ''),
        ))
        return
      }
      // 脚本可能先打印人类可读日志，再以 __JSON__ 前缀输出机器可读结果
      const marker = '__JSON__'
      const pos = trimmed.lastIndexOf(marker)
      const payload = pos >= 0 ? trimmed.slice(pos + marker.length).trim() : trimmed
      try {
        resolve(JSON.parse(payload))
      } catch {
        reject(new Error('Python 输出不是合法 JSON：' + payload.slice(0, 300)))
      }
    })
  })
}

/** 数据是否已落库（供工具提前给出友好提示） */
export function isPythonAvailable() {
  return new Promise((resolve) => {
    const py = resolvePython()
    let child
    try {
      child = spawn(py, ['-c', 'print(1)'], { windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch { } ; resolve(false) }, 15000)
    child.on('error', () => { clearTimeout(timer); resolve(false) })
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
}

export const paths = { backendDir, pkgRoot }
