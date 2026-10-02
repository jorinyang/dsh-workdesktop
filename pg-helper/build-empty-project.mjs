/**
 * 生成「空工程模板」。
 *
 * 为什么模板里**留一个根节点**、而不是真的空：
 *   上游把 29 条工具分成两档 —— 19 条能在**关闭态**（CLI 直接读盘、没有桌面端）跑，
 *   10 条需要**打开态**（要 viewport / selection，只有桌面端开着才有）。
 *   `create_text_node` 恰好属于后者（它要把节点插到"当前视野中心"）。
 *   ⇒ 一棵树得有个起点：模板里预置**一个** TextNode，之后用
 *   `expand_node_tree_from_node` / `breadth_expand_node` / `depth_expand_node`
 *   就能在关闭态下长出整棵树（这些都不需要 viewport）。
 *
 * 用法：node build-empty-project.mjs <repo> <helper.exe> <source.prg> <out.prg>
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const REPO = process.argv[2]
const HELPER = process.argv[3]
const SOURCE = process.argv[4]
const OUT = process.argv[5]
if (!REPO || !HELPER || !SOURCE || !OUT) {
  console.error('usage: node build-empty-project.mjs <repo> <helper.exe> <source.prg> <out.prg>')
  process.exit(2)
}
const CLI = join(REPO, 'packages', 'project-graph-cli', 'src', 'cli.mjs')
const WORK = join(dirname(OUT), 'seed-work.prg')

function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--', ...args], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PROJECT_GRAPH_OWNERSHIP_HELPER_PATH: HELPER },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}
/**
 * 派生子进程调一次工具。
 * ⚠️ `allowUpgrade` 恒为真：源工程是旧版本，而**升级只在调用成功时随项目落盘** ——
 * 只读工具（`get_all_nodes` 的 persistence 是 `project-references`）不会把升级写回去，
 * 所以每一次都要带上这个开关，直到有一次写盘型调用把新版本固定下来。
 */
async function invoke(tool, input, allowUpgrade = true) {
  const args = ['tool', 'invoke', tool, '--project', WORK, '--input', JSON.stringify(input)]
  if (allowUpgrade) args.push('--allow-upgrade')
  const r = await cli(args)
  if (r.code !== 0) throw new Error(`${tool} exit=${r.code} ${r.stderr.slice(0, 400)}`)
  return r.stdout.trim() === '' ? null : JSON.parse(r.stdout)
}

mkdirSync(dirname(OUT), { recursive: true })
if (existsSync(WORK)) rmSync(WORK, { force: true })
copyFileSync(SOURCE, WORK)

const all = await invoke('get_all_nodes', {}, true)
const objects = Array.isArray(all.objects) ? all.objects : []
console.log(`源工程对象数：${objects.length}`)

// 留一个 TextNode 当根：优先挑有文字的（模板更像"一个起点"而不是残骸）。
const survivors = objects.filter((o) => o.type === 'TextNode' && typeof o.text === 'string' && o.text.length > 0)
const keep = survivors[0] || objects.find((o) => o.type === 'TextNode') || objects[0]
if (!keep) throw new Error('源工程里一个对象都没有，没法派生模板')

// `delete_nodes` 只收**节点**引用（`^n[1-9]\d*$`）—— 连线引用 `e*` 传进去会被 schema 拒。
// 连线随节点一起消失，所以这里只挑节点。
const doomed = objects
  .filter((o) => o.ref !== keep.ref && /^n[1-9]\d*$/.test(String(o.ref)))
  .map((o) => o.ref)
if (doomed.length > 0) {
  await invoke('delete_nodes', { refs: doomed })
}
await invoke('edit_text_node', { ref: keep.ref, data: { text: '根节点' } })

const after = await invoke('get_all_nodes', {})
const left = Array.isArray(after.objects) ? after.objects : []
console.log(`模板对象数：${left.length} -> ${JSON.stringify(left.map((o) => `${o.ref}:${o.type}:${o.text ?? ''}`))}`)
if (left.length !== 1) throw new Error(`模板应当只剩 1 个对象，实际 ${left.length} 个`)

copyFileSync(WORK, OUT)
rmSync(WORK, { force: true })
console.log(`已写出模板：${OUT}`)

// 复验：把模板复制成一份"新工程"，看根节点在新 URI 下拿到什么 ref。
const CHECK = join(dirname(OUT), 'seed-check.prg')
if (existsSync(CHECK)) rmSync(CHECK, { force: true })
copyFileSync(OUT, CHECK)
const probe = await new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, '--', 'tool', 'invoke', 'get_all_nodes', '--project', CHECK, '--input', '{}'], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, PROJECT_GRAPH_OWNERSHIP_HELPER_PATH: HELPER },
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => { stdout += c })
  child.once('close', () => resolve(stdout))
})
const probed = JSON.parse(probe)
console.log(`新工程复验：${JSON.stringify((probed.objects || []).map((o) => `${o.ref}:${o.type}:${o.text ?? ''}`))}`)
rmSync(CHECK, { force: true })
