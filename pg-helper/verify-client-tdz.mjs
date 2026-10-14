/**
 * 静态守卫：找「hook 依赖数组 / 回调体引用了同一作用域里**后面才声明**的 const/let」——
 * 也就是 TDZ（暂时性死区）白屏的根因模式。
 *
 * 来由：2026-10-10 工程图面板白屏，根因就是
 *   React.useEffect(() => { loadSnaps(current) }, [current, loadSnaps])   ← 用了
 *   ...
 *   const loadSnaps = React.useCallback(...)                              ← 才声明
 * 依赖数组在 render 阶段求值 ⇒ ReferenceError: Cannot access 'loadSnaps' before initialization
 * ⇒ slot entry crashed ⇒ 面板整个不渲染。
 *
 * 用法：node pg-helper/verify-client-tdz.mjs [client.js 路径]
 * 退出码：0 = 干净；1 = 有可疑点（按文件:行 列出）。
 *
 * ⚠️ 这是启发式检查（按缩进判同层作用域），会有假阳性 —— 报出来的人工确认一遍，
 *    但**不许为了让数字好看把它放宽**（见 HANDOFF 纪律）。
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] || new URL('../lib/client.js', import.meta.url).pathname.replace(/^\//, '')
const src = readFileSync(file, 'utf8')
const lines = src.split(/\r?\n/)

/** 这一行的缩进宽度（tab 按 4 算）。 */
const indentOf = (s) => {
  const m = /^[ \t]*/.exec(s)[0]
  let n = 0
  for (const ch of m) n += ch === '\t' ? 4 : 1
  return n
}

/** 收集所有 `const|let|var NAME =` 声明：name -> [{line, indent}] */
const decls = new Map()
const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  declRe.lastIndex = 0
  let m
  while ((m = declRe.exec(line)) !== null) {
    if (!decls.has(m[1])) decls.set(m[1], [])
    decls.get(m[1]).push({ line: i + 1, indent: indentOf(line) })
  }
}

/** hook 调用行：React.useEffect / useEffect / useCallback / useMemo / useLayoutEffect */
const hookRe = /\b(?:React\.)?(useEffect|useLayoutEffect|useCallback|useMemo)\s*\(/
/** 从 `[` 处拿到配对 `]` 的内容（依赖数组）。 */
function bracketEnd(text, openIdx, open = '[', close = ']') {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) { depth--; if (depth === 0) return i }
  }
  return -1
}

const problems = []
for (let i = 0; i < lines.length; i++) {
  if (!hookRe.test(lines[i])) continue
  const startIndent = indentOf(lines[i])
  // 把这个 hook 调用拼到配对括号结束（最多看 40 行）
  let text = ''
  let endLine = i
  for (let j = i; j < Math.min(lines.length, i + 40); j++) {
    text += (j === i ? lines[j] : '\n' + lines[j])
    endLine = j
    // 括号配平就算完
    let depth = 0, ok = true
    for (const ch of text) { if (ch === '(') depth++; else if (ch === ')') depth-- }
    if (depth <= 0 && text.includes(')')) { ok = true; break }
    if (j === i + 39) ok = false
    if (!ok) break
  }
  // 依赖数组：最后一个 [ ... ]
  const arrStart = text.lastIndexOf('[')
  let deps = ''
  if (arrStart >= 0) {
    const e = bracketEnd(text, arrStart)
    if (e > 0) deps = text.slice(arrStart + 1, e)
  }
  // 只看 hook 名和依赖数组里的标识符 —— 这是 render 阶段真的会求值的部分
  const head = hookRe.exec(text)[1]
  const scanned = head + ' ' + deps
  const ids = new Set(scanned.match(/[A-Za-z_$][\w$]*/g) || [])
  for (const id of ids) {
    if (['React', 'useEffect', 'useCallback', 'useLayoutEffect', 'useMemo', 'current', 'true', 'false', 'null', 'undefined'].includes(id)) continue
    const list = decls.get(id)
    if (!list) continue
    for (const d of list) {
      // 声明在后面、且缩进不深于这个 hook（= 同一个或更外层作用域，会在本行之前被求值）
      if (d.line > i + 1 && d.indent <= startIndent) {
        problems.push({
          id,
          hookLine: i + 1,
          declLine: d.line,
          hookIndent: startIndent,
          declIndent: d.indent,
        })
      }
    }
  }
}

// 去重
const seen = new Set()
const uniq = problems.filter((p) => {
  const k = `${p.id}@${p.hookLine}->${p.declLine}`
  if (seen.has(k)) return false
  seen.add(k); return true
})

console.log(`[client-tdz] ${file}`)
console.log(`[client-tdz] 扫描 ${lines.length} 行；可疑点 ${uniq.length}`)
for (const p of uniq) {
  console.log(`  ✗ ${p.id}：第 ${p.hookLine} 行的 hook 引用了它，但声明在第 ${p.declLine} 行（缩进 ${p.hookIndent} / ${p.declIndent}）`)
}
console.log(uniq.length === 0 ? '[client-tdz] PASS' : '[client-tdz] FAIL')
process.exit(uniq.length === 0 ? 0 : 1)
