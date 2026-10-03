/**
 * 把 `src/` 的源码合成为 `lib/` 的两个运行时入口（与 dsh-modeling 同款构建）。
 *
 * ── 为什么需要这一步 ─────────────────────────────────────────────────────
 * 同一份坐标代数（`src/coords.mjs`）要同时服务两个运行环境，而两边的语法
 * 约束**互相冲突**：
 *   · host（Node ESM）需要 `export`，运行时可加载；
 *   · client（DSH 浏览器模块加载器）只接受
 *     `window.__ModuleLoader__.load({ id, factory })` 这一种形状，工厂体里
 *     **不能有 import / export**（React 走 `require`），相对导入无法解析。
 *
 * 解法：源文件全部保持标准 ESM，构建时剥掉 ESM 语法后内联。
 *   lib/index.js   = host.template.js + coords.mjs(去 export) + index.js(去 import)
 *   lib/client.js  = client.js       + coords.mjs(去 export) + client.dom.js(去 ESM)
 *
 * 用法：
 *   node scripts/build.mjs            # 生成 lib/index.js 与 lib/client.js
 *   node scripts/build.mjs --check    # 只校验产物与源码一致（自测 / 提交前）
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 剥掉 ESM 的 export 语法（内联进函数体 / 单文件模块时用）。 */
export function stripExports(source) {
  let out = source
  out = out.replace(/^\s*export\s+default\s+/gm, '')
  out = out.replace(/^\s*export\s+(?=(const|let|var|function|class|async)\b)/gm, '')
  out = out.replace(/^\s*export\s*\{[\s\S]*?\}\s*;?\s*$/gm, '')
  return out
}

/**
 * 剥掉 import 块（字符级扫描，不用正则 —— 具名导入可以跨行，正则版会把
 * 两条 import 之间的整段源码一起吞掉）。语义是"由模板负责声明 import"。
 */
export function stripImports(source) {
  const out = []
  let index = 0
  while (index < source.length) {
    const atLineStart = index === 0 || source[index - 1] === '\n'
    if (atLineStart && source.startsWith('import', index)
      && /[\s{*'"]/.test(source[index + 6] ?? '')) {
      let cursor = index + 6
      let sawString = false
      while (cursor < source.length) {
        const char = source[cursor]
        if (char === "'" || char === '"') {
          const end = source.indexOf(char, cursor + 1)
          if (end === -1) throw new Error('stripImports: import 里的字符串没有闭合')
          cursor = end + 1
          sawString = true
          continue
        }
        if (char === '\n' && sawString) break
        cursor += 1
      }
      if (!sawString) throw new Error('stripImports: import 语句里没有模块说明符')
      while (cursor < source.length && source[cursor] !== '\n') cursor += 1
      if (source[cursor] === '\n') cursor += 1
      index = cursor
      continue
    }
    out.push(source[index])
    index += 1
  }
  return out.join('')
}

/** 校验内联结果里没有残留的 ESM 语法。 */
export function assertNoEsm(label, source) {
  const found = source.match(/^\s*(export|import)\b/m)
  if (found !== null) throw new Error(`${label} 仍残留 ESM 语法：${found[0].trim()}`)
}

/** 校验关键符号确实保留了下来（防止剥离逻辑误删）。 */
export function assertKept(label, source, symbols) {
  for (const symbol of symbols) {
    const pattern = new RegExp(`\\b${symbol}\\b`)
    if (!pattern.test(source)) throw new Error(`${label} 丢失了关键符号 ${symbol}`)
  }
}

/**
 * 统一换行：**源与产物都按 LF 处理**。
 *
 * 为什么必须有这一步（2026-10-03，进 CI 当天在 Windows runner 上抓到）：
 * 产物是"模板 + 内联源"**拼**出来的，而拼装用的分隔符是 `\n`（见 `BANNER()` / `compose()`）。
 * 一旦工作区是 CRLF（Windows 上 `core.autocrlf=true` 的检出就是），`lib/` 里那些**本来由模板带的**
 * 行尾是 CRLF，而**由本脚本拼出来的**行尾是 LF ⇒ 逐字节比必然不一致，`--check` 当场假红。
 * 这条守卫要守的是"**产物与源码一致**"，不是"行尾风格"，所以两侧都归一化再比。
 * （不改 `.gitattributes` 是因为那会改掉整个仓库的检出行为，代价比这条守卫大得多。）
 */
const toLF = (s) => s.replace(/\r\n/g, '\n')

async function readSource(name) {
  return toLF(await readFile(join(root, 'src', name), 'utf8'))
}

/** 组装一个产物：模板 + 若干内联源。 */
function compose(template, parts) {
  let out = template
  for (const [marker, body] of parts) {
    if (!out.includes(marker)) throw new Error(`模板缺少占位符 ${marker}`)
    // 必须传 **replacer 函数**：`$` 在替换串里有特殊含义（`$&` / `$'` / `$1`），
    // 源码里写了 `$DSH_HOME` 这类字样会把紧随其后的代码整段吞掉。
    out = out.replace(marker, () => body.trimEnd())
  }
  if (out.includes('__INLINE_')) throw new Error('仍有未替换的占位符')
  return out
}

const BANNER = (what, from) => [
  '/**',
  ` * dsh-coords ${what} —— 由 scripts/build.mjs 从 src/ 生成，**请勿手改**。`,
  ' *',
  ' * 要改行为请改对应源码然后重跑构建：',
  ` *   ${from}`,
  ' *   node scripts/build.mjs',
  ' */',
].join('\n')

export async function build() {
  const coordsRaw = await readSource('coords.mjs')
  const hostRaw = await readSource('index.js')
  const domRaw = await readSource('client.dom.js')
  const clientTpl = await readSource('client.js')
  const hostTpl = await readSource('host.template.js')

  const coordsForHost = stripExports(coordsRaw)
  const coordsForClient = stripExports(coordsRaw)
  const hostBody = stripImports(hostRaw)
  const domBody = stripExports(stripImports(domRaw))

  assertNoEsm('client 内联体', domBody)
  assertNoEsm('client 内联代数', coordsForClient)
  assertKept('host 内联体', hostBody, ['export const name', 'export function apply', '__internals', 'registerTools', 'tableFromXlsx'])
  // 内联源依赖的 node 内置符号必须由模板的 import 提供 —— 少一条的症状是
  // 运行时 "xxx is not defined"，与"构建吞了源码"同形。
  assertKept('host 内联体', hostBody, ['resolve', 'join', 'sep', 'homedir', 'dirname', 'mkdir', 'readFile', 'writeFile', 'readdir', 'rm', 'stat', 'inflateRawSync'])
  assert.ok(/^\s*import\s/m.test(hostBody) === false, 'host 内联体不应残留 import')
  assertKept('host 内联代数', coordsForHost, ['normalizeSpec', 'specFromTable', 'auditSpec', 'TEMPLATES', 'buildRecognizePrompt', 'extractJson'])
  assertKept('client 内联体', domBody, ['CoordsCenter', 'Canvas2D', 'Canvas3D', 'PointInspector', 'IntakeDialog', 'api', 'iconCoords'])
  assertKept('client 内联代数', coordsForClient, ['MODES', 'TEMPLATES', 'normalizeSpec', 'parseTable', 'guessAxes', 'project3d', 'quadrantOf'])

  const host = `${BANNER('host 半段', 'src/host.template.js / src/index.js / src/coords.mjs')}\n`
    + compose(hostTpl, [
      ['/* __INLINE_coords.mjs__ */', coordsForHost],
      ['/* __INLINE_index.js__ */', hostBody],
    ])
  const client = `${BANNER('浏览器半段', 'src/client.js / src/client.dom.js / src/coords.mjs')}\n`
    + compose(clientTpl, [
      ['/* __INLINE_coords.mjs__ */', coordsForClient],
      ['/* __INLINE_client.dom.js__ */', domBody],
    ])

  return [
    { file: join(root, 'lib', 'index.js'), content: host, esm: true },
    { file: join(root, 'lib', 'client.js'), content: client, esm: false },
  ]
}

async function main() {
  const check = process.argv.includes('--check')
  const outputs = await build()
  let drifted = 0
  for (const output of outputs) {
    if (check) {
      const current = await readFile(output.file, 'utf8').catch(() => null)
      // 两侧都归一到 LF 再比：CRLF 检出不算"产物与源码不一致"（见 readSource 上面的注释）。
      const same = current !== null && toLF(current) === output.content
      process.stdout.write(`${same ? '✓' : '✗'} ${output.file} ${same ? '与 src/ 一致' : '与 src/ 不一致'}\n`)
      if (!same) drifted += 1
      continue
    }
    await mkdir(dirname(output.file), { recursive: true })
    await writeFile(output.file, output.content, 'utf8')
    process.stdout.write(`✓ 已生成 ${output.file}（${output.content.length} 字节）\n`)
  }
  if (check && drifted > 0) throw new Error(`${drifted} 个产物与源码不一致，请重跑 node scripts/build.mjs`)
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('scripts/build.mjs')
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`构建失败：${error.message}\n`)
    process.exitCode = 1
  })
}
