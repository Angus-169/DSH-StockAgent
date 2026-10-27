/**
 * quant-bridge.test.mjs — Node→Python 桥测试
 * 运行：node tests/quant-bridge.test.mjs
 *
 * 不依赖真实网络；Python 不可用时跳过需要解释器的断言（但不跳过路径断言）。
 */
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

const { runPythonJson, isPythonAvailable, paths } = await import('../src/services/quant-bridge/index.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

console.log('路径解析')
await t('backendDir 指向包内 backend（不是 src/backend）', () => {
  assert.equal(paths.backendDir, join(pkgRoot, 'backend'))
  assert.ok(existsSync(paths.backendDir), 'backend 目录不存在: ' + paths.backendDir)
})
await t('pkgRoot 是包根（含 package.json）', () => {
  assert.equal(paths.pkgRoot, pkgRoot)
  assert.ok(existsSync(join(paths.pkgRoot, 'package.json')), 'package.json 不在包根')
})
await t('关键 Python 脚本存在', () => {
  for (const p of [
    'quant/event_study.py',
    'collectors/collector.py',
    'storage/storage.py',
  ]) {
    assert.ok(existsSync(join(paths.backendDir, p)), '缺失脚本: ' + p)
  }
})

console.log('\n错误处理（不需要 Python）')
await t('脚本不存在时给出明确错误', async () => {
  await assert.rejects(
    runPythonJson('quant/does_not_exist.py', []),
    /Python 脚本不存在/,
  )
})

console.log('\nPython 解释器')
const hasPy = await isPythonAvailable()
console.log('  （Python 可用性：' + hasPy + '）')

if (hasPy) {
  await t('能执行 storage.py 并解析 __main__ JSON', async () => {
    const out = await runPythonJson('storage/storage.py', [])
    assert.ok(out.home || out.data_dir, 'storage.py 未返回预期字段: ' + JSON.stringify(out))
    assert.ok('has_parquet' in out, '缺少 has_parquet')
    console.log('    backend = ' + out.backend + ', data_dir = ' + out.data_dir)
  })
  await t('collector status 返回可解析 JSON（含 __JSON__ 标记）', async () => {
    const out = await runPythonJson('collectors/collector.py', ['status'])
    assert.ok(typeof out.count === 'number', 'count 应为数字: ' + JSON.stringify(out))
    assert.ok(Array.isArray(out.symbols), 'symbols 应为数组')
  })
  await t('event_study 对无数据标的给出可读错误', async () => {
    await assert.rejects(
      runPythonJson('quant/event_study.py', ['--symbol', 'SH000000', '--condition', 'volume_spike']),
      /无历史数据/,
    )
  })
} else {
  console.log('  - 跳过需要 Python 解释器的断言（不可用）')
}

console.log(`\n${passed} passed`)