/**
 * 所有权 helper 的协议自测（离线，不起 DSH）。
 * 逐条对齐 app/src/cli/OwnershipHelper.ts 的期望形状。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HELPER = process.argv[2]
if (!HELPER) {
  console.error('usage: node verify-ownership-helper.mjs <helper.exe>')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'pg-own-'))
const good = join(dir, 'graph.prg')
writeFileSync(good, '{}')
const wrongExt = join(dir, 'graph.json')
writeFileSync(wrongExt, '{}')
const missing = join(dir, 'nope.prg')

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass += 1; console.log(`  ok   ${label}`) }
  else { fail += 1; console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`) }
}

/** 跑一次 helper：拿第一行 JSON + 退出码；hold=true 时把结果留在手里好并发。 */
function run(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(HELPER, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.once('error', (error) => resolve({ error: String(error) }))
    if (options.hold !== true) child.stdin.end()
    child.once('close', (code) => resolve({ stdout, stderr, code, child }))
    if (options.hold === true) resolve({ stdout, stderr, child, held: true, read: () => stdout })
  })
}

function lineOf(stdout) {
  const newline = stdout.indexOf('\n')
  return newline === -1 ? null : stdout.slice(0, newline)
}

console.log(`helper: ${HELPER}`)
console.log(`dir:    ${dir}`)

// 1) 文件不存在
{
  const r = await run(['try-hold-project', missing])
  check('missing file → PROJECT_NOT_FOUND / exit 1',
    [{ status: 'error', code: 'PROJECT_NOT_FOUND' }, r.code],
    [{ status: 'error', code: 'PROJECT_NOT_FOUND' }, 1])
  check('missing file → JSON.parse 可读且键集恰为 status,code',
    Object.keys(JSON.parse(lineOf(r.stdout))).sort(), ['code', 'status'])
}

// 2) 扩展名不对
{
  const r = await run(['try-hold-project', wrongExt])
  check('wrong extension → PROJECT_LOAD_FAILED / exit 1',
    [{ status: 'error', code: 'PROJECT_LOAD_FAILED' }, r.code],
    [{ status: 'error', code: 'PROJECT_LOAD_FAILED' }, 1])
}

// 3) 正常取得所有权：只一行 JSON、键集恰为 status,canonicalPath、stdin 关掉后退出 0
{
  const r = await run(['try-hold-project', good])
  const parsed = JSON.parse(lineOf(r.stdout))
  check('acquire → 键集恰为 status,canonicalPath', Object.keys(parsed).sort(), ['canonicalPath', 'status'])
  check('acquire → status=acquired', parsed.status, 'acquired')
  check('acquire → canonicalPath 无 \\\\?\\ 前缀', parsed.canonicalPath.startsWith('\\\\?\\'), false)
  check('acquire → stdout 恰好一行', r.stdout.endsWith('\n') && r.stdout.indexOf('\n') === r.stdout.length - 1, true)
  check('acquire → 退出 0', r.code, 0)
}

// 4) 并发：第二个拿同一个文件必须 busy / exit 75，且 owner 形状正确
{
  const held = await run(['try-hold-project', good], { hold: true })
  await new Promise((resolve) => setTimeout(resolve, 700))
  const first = lineOf(held.read())
  check('holder 先拿到 acquired', first !== null && JSON.parse(first).status, 'acquired')
  const second = await run(['try-hold-project', good])
  const parsed = JSON.parse(lineOf(second.stdout))
  check('contended → 键集恰为 status,owner', Object.keys(parsed).sort(), ['owner', 'status'])
  check('contended → status=busy + unconnectable_holder',
    [parsed.status, parsed.owner && parsed.owner.kind, Object.keys(parsed.owner || {}).sort()],
    ['busy', 'unconnectable_holder', ['kind']])
  check('contended → 退出 75', second.code, 75)
  // 放掉 holder 之后应当又能拿到（锁随进程退出释放）
  held.child.stdin.end()
  await new Promise((resolve) => setTimeout(resolve, 500))
  const third = await run(['try-hold-project', good])
  check('holder 释放后可再次取得', JSON.parse(lineOf(third.stdout)).status, 'acquired')
  check('再次取得退出 0', third.code, 0)
}

// 5) 用法错
{
  const r = await run(['nonsense'])
  check('bad command → HELPER_USAGE_ERROR / exit 2',
    [JSON.parse(lineOf(r.stdout)).code, r.code],
    ['HELPER_USAGE_ERROR', 2])
}

console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1
