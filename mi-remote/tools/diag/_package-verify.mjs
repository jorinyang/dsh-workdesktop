import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// _package-verify.mjs —— 封装完成的最终验收。逐项读实际文件，不凭印象。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const p = (rel) => path.join(ROOT, rel)
const has = (rel) => fs.existsSync(p(rel))
const rows = []
const check = (name, ok, detail = '') => rows.push([ok, name, detail])

/** 递归算某个相对路径的字节数（文件就是它自己，目录就累加）。 */
const sizeOf = (rel) => {
  const abs = p(rel)
  if (!fs.existsSync(abs)) return 0
  const st = fs.statSync(abs)
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    total += sizeOf(path.join(rel, e.name))
  }
  return total
}

// ── 一、标准目录结构 ──
/*
 * 这套自证要能在**两种形态**下都跑绿：
 *   ① 源插件（作者本机）：带 `state/`、`tmp/`、28 MB 的 `assets/vendor/` 安装包；
 *   ② 发布副本（从公开仓库克隆）：`state/` 与 `tmp/` 被 .gitignore 排除、
 *      `assets/vendor/` 只有一份 README（安装包是第三方商业软件，不分发）。
 * 所以凡"两种形态本来就不同"的项，按形态分别断言，而不是写死源插件的形状。
 */
const HAS_VENDOR_BINARIES = sizeOf('assets') > 20e6
for (const d of ['lib', 'engine', 'engine/diag', 'tools', 'tools/diag', 'scripts', 'docs', 'audio', 'locale', 'assets/vendor']) {
  check('目录 ' + d, has(d))
}
// state/ 与 tmp/ 是运行时目录：克隆体没有它们是正常的，check.ps1 / 宿主会自己建
for (const d of ['state', 'tmp']) {
  if (!has(d)) console.log('  （提示）' + d + '/ 不存在 —— 运行时目录，克隆体没有它是正常的')
}
for (const f of [
  'package.json', 'cordis.patch.yml', 'icon.svg', 'README.md',
  'lib/index.js', 'lib/client.js',
  'engine/rc003-tap.py', 'engine/read-engine.py', 'engine/KeyBridge.exe', 'engine/KeyBridge.cs', 'engine/build.ps1',
  'tools/check.ps1', 'tools/kill-strays.ps1', 'tools/test-buttons.py', 'tools/keyprobe.html',
  'scripts/selftest.mjs', 'scripts/verify-render.mjs', 'scripts/verify-live.mjs', 'scripts/fix-bom.mjs',
  'docs/ARCHITECTURE.md',
]) {
  check('文件 ' + f, has(f))
}
// 发布副本的 vendor 目录里必须有那份下载指引（不然别人不知道装什么）
check('assets/vendor/README.md 在（说明装什么、从哪下）', has('assets/vendor/README.md'))

// ── 二、不该再有的东西 ──
const stray = fs.readdirSync(ROOT).filter((n) => /^(selftest|verify-|fix-bom).*\.mjs$/.test(n))
check('根目录不再散落脚本', stray.length === 0, stray.join(' ') || '干净')
/*
 * tmp/ 是**运行时暂存**目录：check.ps1 会往这里写一次性探测日志，诊断脚本也默认写这里。
 * 所以断言不该是"只许有 README"（那是把正常产物当垃圾），而是"**不许有源码**"——
 * 源码该在 tools/ 或 scripts/ 里，不该散在暂存目录。
 */
const SOURCE_EXT = /\.(mjs|js|py|ps1|cs|ts|json|html|cmd|bat|vbs)$/i
const tmpFiles = fs.existsSync(p('tmp')) ? fs.readdirSync(p('tmp')) : []
const tmpSource = tmpFiles.filter((n) => SOURCE_EXT.test(n))
check('tmp/ 里没有源码残留（运行时暂存除外）', tmpSource.length === 0,
  tmpSource.join(' ') || ('有 ' + tmpFiles.length + ' 个暂存文件，无源码'))
const engineRoot = fs.readdirSync(p('engine'))
check('engine/ 根目录只有运行时件',
  engineRoot.every((n) => ['diag', 'build.ps1', 'inject.py', 'KeyBridge.cs', 'KeyBridge.exe', 'rc003-tap.py', 'read-engine.py'].includes(n)),
  engineRoot.join(' '))

// ── 三、体积 ──
const mb = (b) => (b / 1048576).toFixed(1) + ' MB'
const assetsSize = sizeOf('assets')
/*
 * assets 的期望**随形态而变**：
 *   · 源插件：带三个第三方安装包，约 28 MB；
 *   · 发布副本：只有一个 README，几十 KB —— 安装包是别人家的商业软件，仓库不分发。
 * 两种都算通过，但要各自落在自己的区间里，不能是"什么都没有"或"意外膨胀"。
 */
check('体积：assets 符合当前形态（源≈28MB 带安装包 / 发布≈0MB 只有说明）',
  (assetsSize > 20e6 && assetsSize < 40e6) || (assetsSize < 1e6 && has('assets/vendor/README.md')),
  mb(assetsSize) + (HAS_VENDOR_BINARIES ? '（带安装包）' : '（发布形态，只有说明）'))
check('体积：state 不含超大日志', sizeOf('state') < 20e6, mb(sizeOf('state')))
check('体积：tmp 已清空', sizeOf('tmp') < 100e3, mb(sizeOf('tmp')))

// ── 四、跨目录引用是否都指向存在的东西 ──
const refChecks = [
  ['lib/index.js 的 ENGINE', 'lib/index.js', 'engine', 'KeyBridge.exe'],
  ['lib/index.js 的 COLLECTOR', 'lib/index.js', 'engine', 'rc003-tap.py'],
  ['lib/index.js 的 python 引擎', 'lib/index.js', 'engine', 'read-engine.py'],
]
for (const [name, src, dir, file] of refChecks) {
  const s = fs.readFileSync(p(src), 'utf8')
  const ok = s.includes("'" + dir + "'") && s.includes("'" + file + "'") && has(dir + '/' + file)
  check(name, ok, dir + '/' + file)
}
check('check.ps1 引用的 fgcheck 路径存在',
  fs.readFileSync(p('tools/check.ps1'), 'utf8').includes("engine\\diag\\fgcheck.py") && has('engine/diag/fgcheck.py'))

// ── 五、package.json 自洽 ──
const pkg = JSON.parse(fs.readFileSync(p('package.json'), 'utf8'))
const missingFiles = pkg.files.filter((f) => !has(f))
check('package.json 的 files 白名单全部存在', missingFiles.length === 0, missingFiles.join(' ') || pkg.files.length + ' 项')
const scriptRefs = []
for (const v of Object.values(pkg.scripts)) {
  for (const m of v.matchAll(/(?:node|python|-File)\s+([^\s&]+)/g)) scriptRefs.push(m[1])
}
const missingScripts = scriptRefs.filter((f) => !has(f))
check('npm scripts 引用的脚本全部存在', missingScripts.length === 0, missingScripts.join(' ') || scriptRefs.length + ' 个引用')
check('声明了外部耦合', Array.isArray(pkg.dshMiRemote?.externalCoupling) && pkg.dshMiRemote.externalCoupling.length > 0)

// ── 六、路径引用不残留旧位置 ──
const legacy = []
for (const f of ['tools/test-buttons.py', 'tools/check.ps1', 'scripts/selftest.mjs', 'scripts/verify-render.mjs']) {
  const s = stripComments(fs.readFileSync(p(f), 'utf8'))
  if (/LOCALAPPDATA.*dsh-mi-remote/.test(s)) legacy.push(f + '（还在用旧的 LOCALAPPDATA 落点）')
}
check('没有残留的旧路径假设', legacy.length === 0, legacy.join(' ') || '干净')

// ── 输出 ──
let pass = 0
let fail = 0
for (const [ok, name, detail] of rows) {
  if (ok) pass++
  else fail++
  console.log('  ' + (ok ? 'OK ' : '!! ') + name + (detail ? '   [' + detail + ']' : ''))
}
console.log('')
console.log('  结构验收：PASS ' + pass + ' / FAIL ' + fail)

/**
 * 抹掉注释与字符串字面量再扫 —— 否则"注释里提到旧路径"会被误判成"还在用旧路径"。
 * （和 scripts/selftest.mjs 里修过的是同一类毛病：检测工具自己也要经得起检测。）
 */
function stripComments(src) {
  let out = ''
  let i = 0
  let state = 'code'
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { state = c === "'" ? 'single' : c === '"' ? 'double' : 'template'; i += 1; continue }
      out += c; i += 1; continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } i += 1; continue }
    if (state === 'block') { if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue } i += 1; continue }
    if (c === '\\') { i += 2; continue }
    const close = state === 'single' ? "'" : state === 'double' ? '"' : '`'
    if (c === close) state = 'code'
    i += 1
  }
  return out
}