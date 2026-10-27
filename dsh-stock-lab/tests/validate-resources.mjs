/**
 * validate-resources.mjs — 校验插件的展示资源与清单一致性
 * 运行：node tests/validate-resources.mjs
 *
 * 检查：locale JSON 可解析且含 meta.title/description、icon 是合法 SVG 且未超限、
 * package.json 的 exports/files 指向的文件真实存在（防止声明了不存在的文件）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

console.log('locale 资源')
for (const loc of ['en', 'zh']) {
  t(`locale/${loc}.json 含 meta.title 与 meta.description`, () => {
    const j = JSON.parse(readFileSync(join(pkgRoot, 'locale', `${loc}.json`), 'utf8'))
    assert.ok(j.meta, '缺 meta')
    assert.ok(typeof j.meta.title === 'string' && j.meta.title.length > 0, '缺 title')
    assert.ok(typeof j.meta.description === 'string' && j.meta.description.length > 10, 'description 过短')
    assert.ok(!/^My |template|TODO/i.test(j.meta.title), 'title 仍是模板文案: ' + j.meta.title)
  })
}
t('中英文标题一致（同一插件不应有两个名字）', () => {
  const en = JSON.parse(readFileSync(join(pkgRoot, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(join(pkgRoot, 'locale', 'zh.json'), 'utf8'))
  assert.equal(en.meta.title, zh.meta.title)
})

console.log('\n图标')
const iconPath = join(pkgRoot, 'icon.svg')
t('icon.svg 存在', () => assert.ok(existsSync(iconPath), '缺少 icon.svg'))
t('icon.svg 体积在 256 KiB 以内', () => {
  const size = statSync(iconPath).size
  assert.ok(size < 256 * 1024, `图标 ${size} 字节，超过 256 KiB`)
})
t('icon.svg 是合法 SVG（xmlns + viewBox + 标签闭合）', () => {
  const svg = readFileSync(iconPath, 'utf8')
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), '缺 xmlns')
  assert.match(svg, /viewBox="[^"]+"/, '缺 viewBox')
  assert.ok(svg.trim().endsWith('</svg>'), '未以 </svg> 结尾')
  // 统计开标签与闭合/自闭合标签数量是否平衡（粗略但足以发现截断）
  const opens = (svg.match(/<[a-zA-Z]/g) || []).length
  const closes = (svg.match(/\/>|<\/[a-zA-Z]/g) || []).length
  assert.equal(opens, closes, `标签不平衡：开 ${opens} / 闭 ${closes}`)
})

console.log('\n清单一致性')
t('package.json 声明了 icon 与 locale 导出', () => {
  assert.ok(pkg.icon, '缺顶层 icon 字段')
  assert.ok(pkg.exports['./icon'], '缺 exports["./icon"]')
  assert.ok(pkg.exports['./locale/*.json'], '缺 exports["./locale/*.json"]')
})
t('exports 指向的文件都存在（或通配目录存在）', () => {
  const missing = []
  for (const [k, v] of Object.entries(pkg.exports)) {
    const base = v.includes('*') ? v.split('*')[0] : v
    if (!existsSync(join(pkgRoot, base))) missing.push(`${k} → ${v}`)
  }
  assert.deepEqual(missing, [], 'exports 指向不存在的文件: ' + missing.join(' | '))
})
t('files 声明的路径都存在', () => {
  const missing = []
  for (const f of pkg.files) {
    const base = f.includes('*') ? f.split('*')[0].replace(/\/$/, '') : f
    if (!existsSync(join(pkgRoot, base))) missing.push(f)
  }
  assert.deepEqual(missing, [], 'files 声明了不存在的路径: ' + missing.join(', '))
})
t('运行时依赖的文件都在 files 里（本地安装虽不过滤，打包时会）', () => {
  // skill.md 与 backend/ 是运行时读取的，必须随包分发
  for (const need of ['src', 'backend', 'skill.md', 'cordis.patch.yml']) {
    assert.ok(pkg.files.includes(need), `files 缺 ${need}（运行时需要）`)
  }
})
t('dsh.bundle.patch 指向的文件存在且格式正确', () => {
  const patchPath = join(pkgRoot, pkg.dsh.bundle.patch)
  assert.ok(existsSync(patchPath), '缺 cordis.patch.yml')
  const yaml = readFileSync(patchPath, 'utf8')
  assert.match(yaml, /-\s*insert:/, 'patch 缺 insert 块')
  assert.ok(yaml.includes(pkg.name), 'patch 里的 name 与包名不一致')
})

console.log('\n插件标识')
t('包名与 patch 行 id 一致（避免插入重复行）', () => {
  const yaml = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  const m = yaml.match(/id:\s*([\w-]+)/)
  assert.ok(m, 'patch 缺 id')
  assert.equal(m[1], 'stock-lab')
})
t('Host 入口与 Client 入口存在', () => {
  assert.ok(existsSync(join(pkgRoot, pkg.exports['.'])), '缺少 Host 入口')
  assert.ok(existsSync(join(pkgRoot, pkg.exports['./client'])), '缺少 Client 入口')
})

console.log(`\n${passed} passed`)