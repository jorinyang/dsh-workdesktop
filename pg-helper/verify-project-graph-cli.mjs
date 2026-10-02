/**
 * 工程图：走上游 CLI 的**真实 CRUD 自测**（离线，不需要 DSH 起来）。
 *
 * ⚠️ 上游把 29 条工具分两档（`BuiltInToolRuntimeProfiles.ts` 的 `closedProjectCapabilities`）：
 *   · **关闭态可跑 19 条**（本文件验的就是这一档）——不需要桌面端，CLI 直接读盘跑；
 *   · **需要打开态 10 条** —— 它们声明了 `viewport` 或 `selection`，只有桌面端开着才有，
 *     关闭态调用回 `PROJECT_MUST_BE_OPEN`（本文件最后一条断言就守着这条边界，
 *     免得哪天上游放宽了我们却还写着"不支持"）。
 * 所以"新建一个节点"在关闭态走的是**树扩展**（`expand_node_tree_from_node` /
 * `breadth_expand_node` / `depth_expand_node`）——它们不需要 viewport；
 * 而 `create_text_node`（要插到"当前视野中心"）属于打开态那一档。
 *
 * 用法：node verify-project-graph-cli.mjs <repo> <helper.exe> <template.prg> <workdir>
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.argv[2]
const HELPER = process.argv[3]
const TEMPLATE = process.argv[4]
const WORKDIR = process.argv[5]
if (!REPO || !HELPER || !TEMPLATE || !WORKDIR) {
  console.error('usage: node verify-project-graph-cli.mjs <repo> <helper.exe> <template.prg> <workdir>')
  process.exit(2)
}
const CLI = join(REPO, 'packages', 'project-graph-cli', 'src', 'cli.mjs')
const PROJECT = join(WORKDIR, 'project-graph-selftest.prg')

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${label}`) }
  else { fail += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : `\n       ${detail}`}`) }
}

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

/** 调一条工具；成功返回 value（空输出 → null）。 */
async function invoke(tool, input = {}) {
  const r = await cli(['tool', 'invoke', tool, '--project', PROJECT, '--input', JSON.stringify(input)])
  if (r.code !== 0) throw new Error(`${tool} exit=${r.code} ${r.stderr.slice(0, 300)}`)
  return r.stdout.trim() === '' ? null : JSON.parse(r.stdout)
}
/** 调一条工具并**期望它失败**，返回 stderr 里的错误码。 */
async function invokeExpectFailure(tool, input = {}) {
  const r = await cli(['tool', 'invoke', tool, '--project', PROJECT, '--input', JSON.stringify(input)])
  if (r.code === 0) return null
  try { return JSON.parse(r.stderr).code } catch { return `exit=${r.code}` }
}
const objs = (v) => (v && Array.isArray(v.objects) ? v.objects : [])
const nodesOf = (v) => objs(v).filter((o) => /^n[1-9]\d*$/.test(String(o.ref)))
const edgesOf = (v) => objs(v).filter((o) => /^e[1-9]\d*$/.test(String(o.ref)))
const byText = (v, text) => objs(v).find((o) => o.text === text)

mkdirSync(WORKDIR, { recursive: true })
if (existsSync(PROJECT)) rmSync(PROJECT, { force: true })
copyFileSync(TEMPLATE, PROJECT)

console.log(`repo    : ${REPO}`)
console.log(`helper  : ${HELPER}`)
console.log(`project : ${PROJECT}`)

// ── 0) 工具目录 ───────────────────────────────────────────────────────────
{
  const r = await cli(['tool', 'list'])
  const list = r.code === 0 ? JSON.parse(r.stdout) : []
  check('目录：tool list 给出 29 条内置工具', list.length === 29, `count=${list.length}`)
  const need = ['get_all_nodes', 'edit_text_node', 'delete_node', 'delete_nodes', 'delete_all_nodes',
    'create_edges', 'change_edge_text', 'expand_node_tree_from_node', 'breadth_expand_node',
    'depth_expand_node', 'auto_layout_dag', 'batch_change_color', 'check_connections',
    'get_children', 'get_parents', 'search_text_nodes_by_regex', 'get_object_details']
  const names = list.map((t) => t.name)
  check('目录：关闭态要用的那 17 条都在', need.every((n) => names.includes(n)),
    need.filter((n) => !names.includes(n)).join(', '))
  check('目录：每条都带入参 schema', list.every((t) => t && t.inputSchema), '')
}

// ── 1) 读 ─────────────────────────────────────────────────────────────────
const start = await invoke('get_all_nodes')
check('读：新工程里恰有模板留下的 1 个根节点', nodesOf(start).length === 1,
  JSON.stringify(objs(start).map((o) => `${o.ref}:${o.type}`)))
check('读：根节点分到的是 n1', nodesOf(start)[0] && nodesOf(start)[0].ref === 'n1', JSON.stringify(nodesOf(start)[0]))
check('读：每条都带 ref / type / position / size',
  objs(start).every((o) => typeof o.ref === 'string' && typeof o.type === 'string' && o.position && o.size), '')

// ── 2) 建：树扩展（关闭态里"新建节点"的正路）─────────────────────────────────
await invoke('expand_node_tree_from_node', { ref: 'n1', text: '设计\n  前端\n  后端\n实现\n  联调' })
let cur = await invoke('get_all_nodes')
check('建：expand_node_tree_from_node 长出 5 个子节点', nodesOf(cur).length === 6,
  `nodes=${nodesOf(cur).length}`)
check('建：新节点的文本对得上',
  ['设计', '前端', '后端', '实现', '联调'].every((t) => byText(cur, t) !== undefined),
  JSON.stringify(nodesOf(cur).map((o) => o.text)))

await invoke('breadth_expand_node', { ref: 'n1', texts: ['横向A', '横向B'] })
cur = await invoke('get_all_nodes')
check('建：breadth_expand_node 加了一层', byText(cur, '横向A') !== undefined && byText(cur, '横向B') !== undefined, '')

const depthRoot = byText(cur, '实现')
await invoke('depth_expand_node', { ref: depthRoot.ref, texts: ['链1', '链2'] })
cur = await invoke('get_all_nodes')
check('建：depth_expand_node 串出一条链', byText(cur, '链1') !== undefined && byText(cur, '链2') !== undefined, '')

// ── 3) 改 ─────────────────────────────────────────────────────────────────
const target = byText(cur, '前端')
await invoke('edit_text_node', { ref: target.ref, data: { text: '前端（已改）', color: [255, 0, 0, 1] } })
cur = await invoke('get_all_nodes')
const edited = cur.objects.find((o) => o.ref === target.ref)
check('改：edit_text_node 改掉文本', edited && edited.text === '前端（已改）', JSON.stringify(edited && edited.text))
check('改：颜色也落了盘', edited && Array.isArray(edited.color) && edited.color[0] === 255, JSON.stringify(edited && edited.color))

// ── 4) 连线 ───────────────────────────────────────────────────────────────
const a = byText(cur, '设计')
const b = byText(cur, '实现')
await invoke('create_edges', { edges: [{ sourceRef: a.ref, targetRef: b.ref, text: '自测连线' }] })
cur = await invoke('get_all_nodes')
const edge = edgesOf(cur).find((o) => o.sourceRef === a.ref && o.targetRef === b.ref)
check('连：create_edges 建出可读回的连线', edge !== undefined,
  JSON.stringify(edgesOf(cur).map((e) => `${e.ref}:${e.sourceRef}->${e.targetRef}`)))
check('连：连线上带文字', edge && edge.text === '自测连线', JSON.stringify(edge && edge.text))

if (edge !== undefined) {
  await invoke('change_edge_text', { edgeRef: edge.ref, text: '改过的连线文字' })
  cur = await invoke('get_all_nodes')
  check('连：change_edge_text 改掉连线文字',
    (edgesOf(cur).find((o) => o.ref === edge.ref) || {}).text === '改过的连线文字', '')
}

const connected = await invoke('check_connections', { pairs: [[a.ref, b.ref]] })
check('连：check_connections 认得这条边', JSON.stringify(connected).includes('true'), JSON.stringify(connected))
// 挑一对**确实没连**的：树扩展让同层兄弟之间有边（设计→前端、设计→后端 都是真的），
// 所以拿"前端（已改）" 与 "联调" 这两个叶子比 —— 它们分属不同分支。
const notConnected = await invoke('check_connections', { pairs: [[byText(cur, '前端（已改）').ref, byText(cur, '联调').ref]] })
check('连：check_connections 对没连的返回 false',
  JSON.stringify(notConnected).includes('"connected":false'), JSON.stringify(notConnected))

// ── 5) 图查询 ─────────────────────────────────────────────────────────────
const children = await invoke('get_children', { ref: 'n1' })
check('图：get_children 返回 n1 的直接子节点', children !== null && JSON.stringify(children).length > 4,
  JSON.stringify(children).slice(0, 200))
const parents = await invoke('get_parents', { ref: b.ref })
check('图：get_parents 返回 b 的父节点', parents !== null && JSON.stringify(parents).length > 4,
  JSON.stringify(parents).slice(0, 200))
const found = await invoke('search_text_nodes_by_regex', { regex: '^设计$' })
check('图：search_text_nodes_by_regex 命中"设计"', JSON.stringify(found).includes('设计'),
  JSON.stringify(found).slice(0, 200))
const details = await invoke('get_object_details', { refs: [a.ref] })
check('图：get_object_details 有回执', details !== null, JSON.stringify(details).slice(0, 160))

// ── 6) 布局 / 上色 ────────────────────────────────────────────────────────
const beforeLayout = JSON.stringify(nodesOf(await invoke('get_all_nodes')).map((o) => o.position))
await invoke('auto_layout_dag', { refs: [a.ref, b.ref] })
const afterLayout = JSON.stringify(nodesOf(await invoke('get_all_nodes')).map((o) => o.position))
check('布局：auto_layout_dag 真的动了坐标', beforeLayout !== afterLayout, '')

await invoke('batch_change_color', { refs: [a.ref, b.ref], color: [0, 128, 255, 1] })
cur = await invoke('get_all_nodes')
check('上色：batch_change_color 落盘', (cur.objects.find((o) => o.ref === a.ref) || {}).color[2] === 255, '')

// ── 7) 删 ─────────────────────────────────────────────────────────────────
const countBeforeDelete = nodesOf(cur).length
await invoke('delete_node', { ref: byText(cur, '横向A').ref })
cur = await invoke('get_all_nodes')
check('删：delete_node 之后读回里没有它', byText(cur, '横向A') === undefined, '')
check('删：节点数 -1', nodesOf(cur).length === countBeforeDelete - 1, `${countBeforeDelete} -> ${nodesOf(cur).length}`)

const pair = [byText(cur, '横向B').ref, byText(cur, '链1').ref]
await invoke('delete_nodes', { refs: pair })
cur = await invoke('get_all_nodes')
check('删：delete_nodes 批量删除', pair.every((ref) => !cur.objects.some((o) => o.ref === ref)), '')

await invoke('delete_all_nodes')
cur = await invoke('get_all_nodes')
check('删：delete_all_nodes 清空舞台', objs(cur).length === 0, `${objs(cur).length} 个对象残留`)

// ── 8) 上游边界（不许把"需要打开态"说成"我们也支持"）────────────────────────
const closedOnly = await invokeExpectFailure('create_text_node', { text: '不该成功' })
check('边界：create_text_node 在关闭态明确回 PROJECT_MUST_BE_OPEN',
  closedOnly === 'PROJECT_MUST_BE_OPEN', `code=${closedOnly}`)
const selOnly = await invokeExpectFailure('get_selected_nodes')
check('边界：get_selected_nodes 同样属于打开态', selOnly === 'PROJECT_MUST_BE_OPEN', `code=${selOnly}`)

// ── 9) 失败路径要说人话 ───────────────────────────────────────────────────
const badRef = await invokeExpectFailure('delete_node', { ref: 'n999999' })
check('错：删不存在的 ref 会明确报错（而不是静默成功）', badRef !== null, `code=${badRef}`)
const badInput = await invokeExpectFailure('edit_text_node', { ref: 'nope' })
check('错：非法 ref 形态在调用前就被 schema 拦住', badInput === 'TOOL_INPUT_INVALID', `code=${badInput}`)

rmSync(PROJECT, { force: true })
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1
