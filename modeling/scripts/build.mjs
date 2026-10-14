/**
 * 把 `src/` 的源码合成为 `lib/` 的两个运行时入口。
 *
 * ── 为什么需要这一步 ─────────────────────────────────────────────────────
 * 同一份建模代数（`src/modeling.mjs`）要同时服务两个运行环境，而两边的
 * 语法约束**互相冲突**：
 *   · host（Node ESM）需要 `export`，运行时可加载；
 *   · client（DSH 浏览器模块加载器）只接受
 *     `window.__ModuleLoader__.load({ id, factory })` 这一种形状，工厂体里
 *     **不能有 import / export**（React 走 `require`），相对导入无法解析。
 *
 * 解法：源文件全部保持标准 ESM，构建时剥掉 ESM 语法后内联 —— 顶层
 * `const` / `function` 在函数作用域里照样成立。于是：
 *   lib/index.js   = host.template.js + modeling.mjs(去 ESM) + index.js(去 ESM 导入)
 *   lib/client.js  = client.js      + modeling.mjs(去 ESM) + client.dom.js
 * 两个入口共用同一份代数源码，永远不可能漂移。
 *
 * 用法：
 *   node scripts/build.mjs            # 生成 lib/index.js 与 lib/client.js
 *   node scripts/build.mjs --check    # 只校验产物与源码一致（自测 / CI 用）
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
 * 剥掉 import 块。
 *
 * ⚠️ 语义是"**由模板负责声明 import**，被内联的主体不再自带"：
 * 生成物（lib/index.js）是真正的 Node ESM，它的 import 写在
 * `src/host.template.js` 里；被内联的 `src/index.js` 若留着 import，
 * 而模板忘了对应的一条，符号就会在运行时消失 —— 报告成
 * "xxx is not defined"，与"构建吞了源码"是同一种症状。
 * `selftest-build.mjs` 的 B-2 专门守这个坑。
 *
 * 用**字符级扫描**而不是正则：import 可以跨行（具名导入的 `{` / `}` 各自
 * 独占一行），正则版曾经把两条 import 之间的整段源码一起吞掉。
 */
export function stripImports(source) {
  const out = []
  let index = 0
  while (index < source.length) {
    const atLineStart = index === 0 || source[index - 1] === '\n'
    // 行首 `import` 之后必须是空白、`{`、`*` 或引号
    // （`import { a } from …` / `import * as ns from …` / `import 'x'`）
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

/** 校验关键符号确实保留了下来（防止正则误删）。 */
export function assertKept(label, source, symbols) {
  for (const symbol of symbols) {
    const pattern = new RegExp(`\\b${symbol}\\b`)
    if (!pattern.test(source)) throw new Error(`${label} 丢失了关键符号 ${symbol}`)
  }
}

async function readSource(name) {
  return readFile(join(root, 'src', name), 'utf8')
}

/** 组装一个产物：模板 + 若干内联源。 */
function compose(template, parts) {
  let out = template
  for (const [marker, body] of parts) {
    if (!out.includes(marker)) throw new Error(`模板缺少占位符 ${marker}`)
    // 必须传 **replacer 函数**：`$` 在 String.replace 的替换串里有特殊含义
    // （`$&` / `$'` / `$1` …）。踩过的坑：源码注释里写了 `$DSH_HOME` 与
    // `` `$'`` 这类字样，直接把紧随其后的代码整段吞掉，产物"看起来对"、
    // 运行到 dataRoot 才炸 join is not defined。
    out = out.replace(marker, () => body.trimEnd())
  }
  if (out.includes('__INLINE_')) throw new Error('仍有未替换的占位符')
  return out
}

const BANNER = (what, from) => [
  '/**',
  ` * dsh-modeling ${what} —— 由 scripts/build.mjs 从 src/ 生成，**请勿手改**。`,
  ' *',
  ' * 要改行为请改对应源码然后重跑构建：',
  ` *   ${from}`,
  ' *   node scripts/build.mjs',
  ' */',
].join('\n')

export async function build() {
  const modelingRaw = await readSource('modeling.mjs')
  const hostRaw = await readSource('index.js')
  const domRaw = await readSource('client.dom.js')
  const clientTpl = await readSource('client.js')
  const hostTpl = await readSource('host.template.js')

  const modelingForHost = stripExports(modelingRaw)
  const modelingForClient = stripExports(modelingRaw)
  // host 主体**保留 export**：lib/index.js 是真正的 ESM 入口，Cordis 要能
  // 读到具名的 `name` / `apply` / `inject`；只有它自带的 import 要剥掉 ——
  // 那些符号由 `src/host.template.js` 顶部的 import 提供（B-2 守这个契约）。
  const hostBody = stripImports(hostRaw)
  const domBody = stripExports(stripImports(domRaw))

  assertNoEsm('client 内联体', domBody)
  assertNoEsm('client 内联代数', modelingForClient)
  assertKept('host 内联体', hostBody, ['export const name', 'export function apply', '__internals', 'buildSystemPrompt', 'extractJson'])
  // 内联源依赖的 node 内置符号必须由剥掉的 import 补齐 —— 断言它们没被执行流
  // 之外的简化误删（这一条就是踩过坑后加的：曾经把整条 node:path 导入连同
  // 后续源码一起吞掉，构建"成功"、运行时才炸 resolve is not defined）。
  assertKept('host 内联体', hostBody, ['resolve', 'join', 'sep', 'homedir', 'mkdir', 'readFile', 'writeFile', 'readdir', 'rm', 'AiGen'.slice(0, 0) + 'extractJson'])
  assert.ok(/^\s*import\s/m.test(hostBody) === false, 'host 内联体不应残留 import')
  assertKept('client 内联体', domBody, ['ModelingCenter', 'Canvas', 'NodeInspector', 'AiDialog', 'api'])
  assertKept('client 内联代数', modelingForClient, ['AXIS', 'PROFILES', 'EDGE_TYPES', 'ATTR_FIELDS', 'layoutModel', 'normalizeModel'])

  const host = `${BANNER('host 半段', 'src/host.template.js / src/index.js / src/modeling.mjs')}\n`
    + compose(hostTpl, [
      ['/* __INLINE_modeling.mjs__ */', modelingForHost],
      ['/* __INLINE_index.js__ */', hostBody],
    ])
  const client = `${BANNER('浏览器半段', 'src/client.js / src/client.dom.js / src/modeling.mjs')}\n`
    + compose(clientTpl, [
      ['/* __INLINE_modeling.mjs__ */', modelingForClient],
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
      const same = current === output.content
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
