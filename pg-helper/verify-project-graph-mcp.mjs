/**
 * 工程图 MCP server 的**一致性自测**：用**官方 SDK 的客户端**连上来跑一遍。
 *
 * 为什么必须用官方 SDK，而不是自己写个客户端：自己写客户端只能证明
 * "我按自己的理解说、按自己的理解听"，两边一起错的时候照样全绿。
 * 这里让 `@modelcontextprotocol/client`（v2.0.0，DSH 自己用的就是它）当客户端，
 * 握手、列工具、调工具全部走它的实现 —— 它认了，才算真的合规。
 *
 * 用法：
 *   node verify-project-graph-mcp.mjs [官方 SDK 的 client 包目录]
 * 缺省按本机 DSH 检出去找；找不到就跳过并**明说跳过**（不算通过）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'project-graph-mcp.mjs')
const SDK = process.argv[2]
  || 'D:\\deepseek-harness\\packages\\mcp\\mcp-client\\node_modules\\@modelcontextprotocol\\client'

let pass = 0
let fail = 0
let skipped = 0
function chk(id, desc, ok, detail = '') {
  if (ok === 'skip') { skipped++; console.log(`  [SKIP] ${id.padEnd(9)} ${desc}${detail ? `\n         ${detail}` : ''}`); return }
  if (ok) { pass++; console.log(`  [PASS] ${id.padEnd(9)} ${desc}`) } else { fail++; console.log(`  [FAIL] ${id.padEnd(9)} ${desc}`) }
  if (detail) console.log(`         ${detail}`)
}

if (!existsSync(join(SDK, 'dist', 'index.mjs')) || !existsSync(join(SDK, 'dist', 'stdio.mjs'))) {
  console.log(`官方 SDK 不在 ${SDK}`)
  console.log('（跳过 —— 这条套件要拿官方客户端当对手，缺了就证明不了合规；不算通过）')
  process.exit(2)
}

const { Client } = await import(pathToFileURL(join(SDK, 'dist', 'index.mjs')).href)
const { StdioClientTransport } = await import(pathToFileURL(join(SDK, 'dist', 'stdio.mjs')).href)

// 独立工作区：绝不碰用户真实的 projects/
const WORKSPACE = mkdtempSync(join(tmpdir(), 'pg-mcp-'))
const REPO = process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_REPO
  || join(process.env.USERPROFILE || '', 'Desktop', 'DSH', 'project-graph')

console.log(`server    : ${SERVER}`)
console.log(`sdk       : ${SDK}`)
console.log(`workspace : ${WORKSPACE}`)

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  cwd: HERE,
  env: {
    DSH_WORKDESKTOP_PROJECT_GRAPH_DIR: WORKSPACE,
    DSH_WORKDESKTOP_PROJECT_GRAPH_REPO: REPO,
    DSH_WORKDESKTOP_NODE: process.execPath,
  },
})
const client = new Client(
  { name: 'pg-mcp-conformance', version: '0.0.1' },
  {
    capabilities: {},
    versionNegotiation: { mode: 'auto' },
    listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {} } },
  },
)

/** 取工具回执里的文本；顺带报 isError。 */
function readResult(result) {
  const blocks = (result && Array.isArray(result.content)) ? result.content : []
  const first = blocks.find((b) => b && b.type === 'text')
  let parsed = null
  try { parsed = first ? JSON.parse(first.text) : null } catch { /* 非 JSON 就留 null */ }
  return { text: first ? first.text : '', parsed, isError: result && result.isError === true }
}

let connected = false
try {
  await client.connect(transport)
  connected = true
} catch (error) {
  chk('MCP-1', '★ 官方客户端握手成功（initialize + 版本协商）', false,
    String((error && error.message) || error))
}

if (connected) {
  chk('MCP-1', '★ 官方客户端握手成功（initialize + 版本协商）', true)

  // ── 工具清单 ─────────────────────────────────────────────────────────────
  let tools = []
  try {
    const listed = await client.listTools(undefined, { cacheMode: 'refresh' })
    tools = Array.isArray(listed && listed.tools) ? listed.tools : []
    chk('MCP-2', '★ tools/list 回执能被官方客户端解析出工具数组', tools.length > 0, `count=${tools.length}`)
  } catch (error) {
    chk('MCP-2', '★ tools/list 回执能被官方客户端解析出工具数组', false, String((error && error.message) || error))
  }
  const names = tools.map((t) => t.name)
  chk('MCP-2b', '九个工具齐备（status/projects/create/rename/delete/tools/describe/graph/invoke）',
    ['pg_status', 'pg_projects', 'pg_create', 'pg_rename', 'pg_delete', 'pg_tools', 'pg_describe', 'pg_graph', 'pg_invoke']
      .every((n) => names.includes(n)), names.join(' / '))
  chk('MCP-2c', '每条工具都带 JSON Schema 形态的 inputSchema（官方客户端会照它校验）',
    tools.every((t) => t && t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object'),
    '')
  chk('MCP-2d', '每条工具都有描述（模型选工具靠它）', tools.every((t) => typeof t.description === 'string' && t.description.length > 10), '')

  // ── 自检 / 列工程 ───────────────────────────────────────────────────────
  const st = readResult(await client.callTool({ name: 'pg_status', arguments: {} }))
  chk('MCP-3', '★ pg_status 经官方客户端调用成功，且四样状态逐条给出',
    st.parsed && st.parsed.ok === true && typeof st.parsed.repo === 'string'
    && typeof st.parsed.helperReady === 'boolean' && typeof st.parsed.dependenciesReady === 'boolean',
    st.text.slice(0, 260))

  const empty = readResult(await client.callTool({ name: 'pg_projects', arguments: {} }))
  chk('MCP-4', '空工作区：pg_projects 回空数组', empty.parsed && empty.parsed.ok === true
    && Array.isArray(empty.parsed.projects) && empty.parsed.projects.length === 0, empty.text.slice(0, 160))

  // ── 建 → 写 → 读 → 删（真 CRUD，全走 MCP）────────────────────────────────
  const created = readResult(await client.callTool({ name: 'pg_create', arguments: { project: 'MCP自测工程' } }))
  chk('MCP-5', '★ pg_create 建出工程（空模板 + 立刻分配引用）',
    created.parsed && created.parsed.ok === true, created.text.slice(0, 200))

  const written = readResult(await client.callTool({
    name: 'pg_invoke',
    arguments: { tool: 'expand_node_tree_from_node', project: 'MCP自测工程', input: { ref: 'n1', text: '一级\n  二级\n三级' } },
  }))
  chk('MCP-6', '★ pg_invoke 跑上游工具成功（真写进 .prg）',
    written.parsed && written.parsed.ok === true, written.text.slice(0, 200))

  const graph = readResult(await client.callTool({ name: 'pg_graph', arguments: { project: 'MCP自测工程' } }))
  const objects = (graph.parsed && graph.parsed.objects) || []
  const nodes = objects.filter((o) => /^n[1-9]\d*$/.test(String(o.ref)))
  const edges = objects.filter((o) => /^e[1-9]\d*$/.test(String(o.ref)))
  chk('MCP-6b', '★ pg_graph 读回 4 个节点 + 3 条连线',
    nodes.length === 4 && edges.length === 3,
    JSON.stringify(objects.map((o) => `${o.ref}:${o.text || o.type}`)))

  const target = nodes.find((o) => o.text === '二级')
  const edited = readResult(await client.callTool({
    name: 'pg_invoke',
    arguments: { tool: 'edit_text_node', project: 'MCP自测工程', input: { ref: target.ref, data: { text: '二级（改过）' } } },
  }))
  const afterEdit = readResult(await client.callTool({ name: 'pg_graph', arguments: { project: 'MCP自测工程' } }))
  chk('MCP-6c', '★ 改：edit_text_node 的改动下一次读回可见',
    edited.parsed && edited.parsed.ok === true
    && ((afterEdit.parsed.objects || []).find((o) => o.ref === target.ref) || {}).text === '二级（改过）', '')

  const deleted = readResult(await client.callTool({
    name: 'pg_invoke', arguments: { tool: 'delete_node', project: 'MCP自测工程', input: { ref: target.ref } },
  }))
  const afterDel = readResult(await client.callTool({ name: 'pg_graph', arguments: { project: 'MCP自测工程' } }))
  chk('MCP-6d', '★ 删：delete_node 之后读回里没有它',
    deleted.parsed && deleted.parsed.ok === true
    && (afterDel.parsed.objects || []).every((o) => o.ref !== target.ref), '')

  // ── 上游边界与错误路径：必须**如实**回 isError，不许伪装成功 ─────────────
  const boundary = readResult(await client.callTool({
    name: 'pg_invoke', arguments: { tool: 'create_text_node', project: 'MCP自测工程', input: { text: '不该成功' } },
  }))
  chk('MCP-7', '★ 关闭态调 create_text_node ⇒ isError=true 且原样带 PROJECT_MUST_BE_OPEN',
    boundary.isError === true && boundary.parsed && boundary.parsed.code === 'PROJECT_MUST_BE_OPEN',
    boundary.text.slice(0, 180))

  const unknown = readResult(await client.callTool({
    name: 'pg_invoke', arguments: { tool: 'no_such_tool', project: 'MCP自测工程', input: {} },
  }))
  chk('MCP-7b', '不存在的上游工具名 ⇒ 原样回 UNKNOWN_TOOL',
    unknown.isError === true && unknown.parsed && unknown.parsed.code === 'UNKNOWN_TOOL', unknown.text.slice(0, 140))

  let unknownToolErrored = false
  try { await client.callTool({ name: 'pg_nope', arguments: {} }) } catch { unknownToolErrored = true }
  chk('MCP-7c', '调用不存在的 MCP 工具 ⇒ 客户端能收到错误（不是静默成功）', unknownToolErrored, '')

  // ── 改名 / 删除工程 ─────────────────────────────────────────────────────
  const renamed = readResult(await client.callTool({ name: 'pg_rename', arguments: { project: 'MCP自测工程', to: 'MCP改过名' } }))
  const list2 = readResult(await client.callTool({ name: 'pg_projects', arguments: {} }))
  chk('MCP-8', '★ pg_rename 改名成功且清单里是新名字',
    renamed.parsed && renamed.parsed.ok === true
    && (list2.parsed.projects || []).some((p) => p.title === 'MCP改过名'),
    JSON.stringify((list2.parsed.projects || []).map((p) => p.name)))

  const removed = readResult(await client.callTool({ name: 'pg_delete', arguments: { project: 'MCP改过名' } }))
  const list3 = readResult(await client.callTool({ name: 'pg_projects', arguments: {} }))
  chk('MCP-8b', '★ pg_delete 真删掉，清单回到空',
    removed.parsed && removed.parsed.ok === true && (list3.parsed.projects || []).length === 0,
    JSON.stringify((list3.parsed.projects || []).map((p) => p.name)))

  // ── 上游工具目录 ────────────────────────────────────────────────────────
  const catalog = readResult(await client.callTool({ name: 'pg_tools', arguments: {} }))
  chk('MCP-9', '★ pg_tools 透传上游 29 条工具清单', catalog.parsed && catalog.parsed.ok === true
    && catalog.parsed.count === 29, `count=${catalog.parsed && catalog.parsed.count}`)
  const described = readResult(await client.callTool({ name: 'pg_describe', arguments: { tool: 'expand_node_tree_from_node' } }))
  chk('MCP-9b', 'pg_describe 给出那一条的入参 schema',
    described.parsed && described.parsed.ok === true && described.parsed.value && described.parsed.value.inputSchema,
    '')

  try { await transport.close() } catch { /* 已关 */ }
}

rmSync(WORKSPACE, { recursive: true, force: true })
console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skipped}`)
process.exitCode = fail === 0 ? 0 : 1
