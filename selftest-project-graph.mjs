/**
 * dsh-workdesktop · 「工程图」host 半段自测（本地，离线）
 *
 * 为什么需要它：`node --check` 只证明语法正确，不证明**路由能应答、CLI 真的被调起来**。
 * 本脚本用一个假的 `ctx`（只提供 webServer.register + tools.register）跑通 host 半段，
 * 再对 `/pg/*` 发合成请求 —— 每一次都**真的 spawn 上游 CLI**，断言的是真回执，
 * 不是桩数据。
 *
 * 它证到什么 / 证不到什么（不许过度解读）：
 *   ✅ 路由可达、入参校验、工程文件的新建/改名/删除、CLI 的读与写、上游错误码原样透传
 *   ❌ 不覆盖浏览器半段的渲染与点击（那是 `selftest-project-graph-client.mjs` 的源码级断言
 *      + 真机套件的事）
 *   ❌ 不覆盖"打开态"那 10 条工具（要桌面端；本脚本反过来断言关闭态确实回 PROJECT_MUST_BE_OPEN）
 *
 * 前置：上游检出已 `pnpm install`；`DSH_WORKDESKTOP_PROJECT_GRAPH_REPO` 指向它。
 * 用法：node selftest-project-graph.mjs [上游检出目录]
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = process.argv[2] || process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_REPO
  || join(process.env.USERPROFILE || '', 'Desktop', 'DSH', 'project-graph')
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dshw-pg-'))

// 环境必须在 import 之前摆好：host 半段在模块加载期就把这些读成常量了。
process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_REPO = REPO
process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_DIR = WORKSPACE
process.env.DSH_WORKDESKTOP_KNOWLEDGE = process.env.DSH_WORKDESKTOP_KNOWLEDGE
  || join(process.env.USERPROFILE || '', 'Desktop', 'Knowledge')

const { apply } = await import('./lib/index.js')

let pass = 0
let fail = 0
function chk(id, desc, ok, detail = '') {
  if (ok) { pass++; console.log(`  [PASS] ${id.padEnd(11)} ${desc}`) } else { fail++; console.log(`  [FAIL] ${id.padEnd(11)} ${desc}`) }
  if (detail) console.log(`         ${detail}`)
}

let captured = null
const registeredTools = []
const ctx = {
  effect: (fn) => { fn() },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  webServer: { register: (r) => { captured = r; return () => {} } },
  on: () => () => {},
  get: (name) => {
    if (name === 'tools') return { register: (def) => { registeredTools.push(def); return () => {} } }
    if (name === 'sessionQuery') return { listSessions: async () => [], readTitleSnapshot: async () => null, readSurface: async () => null }
    if (name === 'agents') return { currentInitiator: () => undefined }
    return undefined
  },
}

apply(ctx)
const ROUTE = captured === null ? '' : captured.path

function call(method, url, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = {
      url, method,
      on(ev, fn) {
        if (ev === 'data') { if (payload !== null) setTimeout(() => fn(payload), 0); return req }
        if (ev === 'end') { setTimeout(() => fn(), 1); return req }
        return req
      },
      destroy: () => {},
    }
    const res = {
      _code: 0, _body: '',
      writeHead(code) { this._code = code },
      end(b) { this._body = String(b || ''); resolve({ code: this._code, json: safeJson(String(b || '')) }) },
    }
    Promise.resolve(captured.handler(req, res)).catch((e) => resolve({ code: -1, json: { error: `THROW: ${String(e && e.message || e)}` } }))
  })
}
function safeJson(text) { try { return JSON.parse(text) } catch { return null } }

console.log(`repo      : ${REPO}`)
console.log(`workspace : ${WORKSPACE}`)

// ── PG-1 可用性自检 ───────────────────────────────────────────────────────
const status = await call('GET', `${ROUTE}/pg/status`)
chk('PG-1', '★ /pg/status 回 200，且**每一样**都报出具体状态（不是一句"不可用"）',
  status.code === 200 && status.json !== null
  && typeof status.json.repo === 'string' && typeof status.json.cli === 'string'
  && typeof status.json.helperExe === 'string' && typeof status.json.projectsDir === 'string',
  JSON.stringify(status.json).slice(0, 320))
chk('PG-1b', '★ 上游检出 / CLI / 依赖 / helper 四样就绪',
  status.json && status.json.ok === true,
  `repoReady=${status.json && status.json.repoReady} cliReady=${status.json && status.json.cliReady}`
  + ` deps=${status.json && status.json.dependenciesReady} helper=${status.json && status.json.helperReady}`
  + ` helperError=${status.json && status.json.helperError}`)

// ── PG-2 工程清单（空工作区）─────────────────────────────────────────────
const empty = await call('GET', `${ROUTE}/pg/projects`)
chk('PG-2', '空工作区：/pg/projects 回 200 且 projects 为空数组',
  empty.code === 200 && Array.isArray(empty.json && empty.json.projects) && empty.json.projects.length === 0,
  JSON.stringify(empty.json).slice(0, 200))

// ── PG-3 新建工程（从插件自带的空模板复制）──────────────────────────────
const created = await call('POST', `${ROUTE}/pg/project`, { action: 'create', name: '自测工程' })
chk('PG-3', '★ POST /pg/project action=create 建出工程文件',
  created.code === 200 && created.json && created.json.ok === true,
  JSON.stringify(created.json).slice(0, 200))
chk('PG-3b', '工程名不合法会被拒（不许路径穿越）',
  (await call('POST', `${ROUTE}/pg/project`, { action: 'create', name: '..\\逃逸' })).json.ok === false)
const again = await call('POST', `${ROUTE}/pg/project`, { action: 'create', name: '自测工程' })
chk('PG-3c', '重名新建被拒（不覆盖既有工程）', again.json && again.json.ok === false, String(again.json && again.json.error))

// ── PG-4 上游工具目录 ────────────────────────────────────────────────────
// ⚠️ 顺序是有意的：**先冷后热**。`/pg/tool` 曾经在"缓存没命中"与"缓存命中"两种状态下
// 回两种形状（`{value}` / `{tool}`），先调 `/pg/tools`（把缓存填上）就把这个缺陷盖住了。
// 所以这里必须先单独调 `/pg/tool`（冷），再调 `/pg/tools`，最后再调一次 `/pg/tool`（热），
// 断言**两次形状完全一样**。
const cold = await call('GET', `${ROUTE}/pg/tool?name=expand_node_tree_from_node`)
chk('PG-4c', '★ 缓存冷时 /pg/tool 也回 `{ok,tool}`（与热时同一形状）',
  cold.json && cold.json.ok === true && cold.json.tool && cold.json.tool.inputSchema,
  JSON.stringify(Object.keys(cold.json || {})).slice(0, 120))
const tools = await call('GET', `${ROUTE}/pg/tools`)
chk('PG-4', '★ /pg/tools 透传上游 tool list（29 条，带 inputSchema）',
  tools.code === 200 && tools.json && tools.json.ok === true && tools.json.tools.length === 29
  && tools.json.tools.every((t) => t && t.name && t.inputSchema),
  `count=${tools.json && tools.json.tools && tools.json.tools.length}`)
const one = await call('GET', `${ROUTE}/pg/tool?name=expand_node_tree_from_node`)
chk('PG-4b', '/pg/tool?name=… 给出那一条的 schema（热时同形状）',
  one.json && one.json.ok === true && one.json.tool && one.json.tool.inputSchema, '')
chk('PG-4d', '★ 冷 / 热两次回执的**键集与内容**一致（缓存不该改变形状）',
  JSON.stringify(Object.keys(cold.json).sort()) === JSON.stringify(Object.keys(one.json).sort())
  && cold.json.tool.name === one.json.tool.name,
  `cold=${JSON.stringify(Object.keys(cold.json).sort())} warm=${JSON.stringify(Object.keys(one.json).sort())}`)

// ── PG-5 读图（真的起一次 CLI）───────────────────────────────────────────
const graph = await call('GET', `${ROUTE}/pg/graph?project=${encodeURIComponent('自测工程.prg')}`)
chk('PG-5', '★ /pg/graph 起 CLI 读回对象列表，模板里那个根节点在',
  graph.code === 200 && graph.json && graph.json.ok === true
  && Array.isArray(graph.json.objects)
  && graph.json.objects.length === 1
  && graph.json.objects[0].ref === 'n1',
  JSON.stringify(graph).slice(0, 400))
chk('PG-5b', '读不存在的工程回可读错误（不是崩）',
  (await call('GET', `${ROUTE}/pg/graph?project=不存在.prg`)).json.ok === false, '')

// ── PG-6 写：树扩展 / 改文字 / 删除（三条关闭态正路）──────────────────────
const expand = await call('POST', `${ROUTE}/pg/invoke`, {
  tool: 'expand_node_tree_from_node', project: '自测工程.prg',
  input: { ref: 'n1', text: '一层\n  二层\n三层' },
})
chk('PG-6', '★ POST /pg/invoke 跑 expand_node_tree_from_node 成功',
  expand.code === 200 && expand.json && expand.json.ok === true, JSON.stringify(expand.json).slice(0, 200))

const after = await call('GET', `${ROUTE}/pg/graph?project=${encodeURIComponent('自测工程.prg')}`)
const objs = (after.json && after.json.objects) || []
// 树扩展会**同时**长出节点与连线（上游把连线也作为 `LineEdge` 对象返回）——
// 所以这里把两类分开数：3 个新节点 + 3 条新连线，加模板里的根节点 = 4 节点 / 3 连线。
const nodesOnly = objs.filter((o) => /^n[1-9]\d*$/.test(String(o.ref)))
const edgesOnly = objs.filter((o) => /^e[1-9]\d*$/.test(String(o.ref)))
chk('PG-6b', '★ 读回里多了 3 个节点 + 3 条连线（真写进了 .prg）',
  nodesOnly.length === 4 && edgesOnly.length === 3,
  JSON.stringify(objs.map((o) => `${o.ref}:${o.text || o.type}`)))
const two = nodesOnly.find((o) => o.text === '二层')
await call('POST', `${ROUTE}/pg/invoke`, {
  tool: 'edit_text_node', project: '自测工程.prg', input: { ref: two.ref, data: { text: '二层（改过）' } },
})
const edited = await call('GET', `${ROUTE}/pg/graph?project=${encodeURIComponent('自测工程.prg')}`)
chk('PG-6c', '★ edit_text_node 的改动能在下一次读回里看到',
  ((edited.json.objects || []).find((o) => o.ref === two.ref) || {}).text === '二层（改过）', '')

await call('POST', `${ROUTE}/pg/invoke`, { tool: 'delete_node', project: '自测工程.prg', input: { ref: two.ref } })
const deleted = await call('GET', `${ROUTE}/pg/graph?project=${encodeURIComponent('自测工程.prg')}`)
chk('PG-6d', '★ delete_node 之后读回里没有它',
  (deleted.json.objects || []).every((o) => o.ref !== two.ref), '')

// ── PG-7 上游边界要原样透传（不许把"要打开态"说成"我们也行"）──────────────
const boundary = await call('POST', `${ROUTE}/pg/invoke`, {
  tool: 'create_text_node', project: '自测工程.prg', input: { text: '不该成功' },
})
chk('PG-7', '★ 关闭态调 create_text_node ⇒ 原样透传上游 PROJECT_MUST_BE_OPEN',
  boundary.json && boundary.json.ok === false && boundary.json.code === 'PROJECT_MUST_BE_OPEN',
  JSON.stringify(boundary.json).slice(0, 200))
const badTool = await call('POST', `${ROUTE}/pg/invoke`, { tool: 'no_such_tool', project: '自测工程.prg', input: {} })
chk('PG-7b', '不存在的工具名 ⇒ 上游 UNKNOWN_TOOL 原样回传', badTool.json && badTool.json.code === 'UNKNOWN_TOOL',
  JSON.stringify(badTool.json).slice(0, 160))

// ── PG-8 改名 / 删除工程 ─────────────────────────────────────────────────
chk('PG-8', 'POST /pg/project action=rename 改名成功',
  (await call('POST', `${ROUTE}/pg/project`, { action: 'rename', name: '自测工程', to: '改过名的工程' })).json.ok === true)
const list2 = await call('GET', `${ROUTE}/pg/projects`)
chk('PG-8b', '改名后清单里是新名字',
  (list2.json.projects || []).some((p) => p.name === '改过名的工程.prg'),
  JSON.stringify((list2.json.projects || []).map((p) => p.name)))
chk('PG-8c', 'POST /pg/project action=delete 真删掉文件',
  (await call('POST', `${ROUTE}/pg/project`, { action: 'delete', name: '改过名的工程' })).json.ok === true)

// ── PG-9 事件通道（agent 落图/唤起面板用）────────────────────────────────
const ev0 = await call('GET', `${ROUTE}/pg/events?since=0`)
const open = await call('POST', `${ROUTE}/pg/open`, { project: 'x.prg' })
const ev1 = await call('GET', `${ROUTE}/pg/events?since=${ev0.json.rev}`)
chk('PG-9', '★ /pg/open 推的事件能被 /pg/events?since= 增量读到',
  open.json.ok === true && (ev1.json.events || []).some((e) => e.kind === 'open'),
  JSON.stringify(ev1.json).slice(0, 200))

// ── PG-10 agent 工具：结构与动作枚举 ─────────────────────────────────────
const tool = registeredTools.find((t) => t.name === 'project_graph')
chk('PG-10', '★ agent 工具 project_graph 已注册，且十个动作一个不少',
  tool !== undefined && Array.isArray(tool.parameters?.properties?.action?.enum)
  && ['status', 'projects', 'create', 'rename', 'delete', 'tools', 'describe', 'invoke', 'graph', 'open']
    .every((a) => tool.parameters.properties.action.enum.includes(a)),
  tool === undefined ? '未注册' : tool.parameters.properties.action.enum.join(' / '))
chk('PG-10b', '工具结构合规（execute + output.render + parameters 根 type=object）',
  tool !== undefined && typeof tool.execute === 'function' && typeof tool.output?.render === 'function'
  && tool.parameters.type === 'object', '')

// 工具走的是与路由**同一条** pgInvoke：这里直接执行，验证会话侧真的能建/读/删。
const viaTool = await tool.execute({ action: 'create', project: '工具建的工程' })
chk('PG-10c', '★ 会话侧 action=create 真的建出工程', viaTool && viaTool.ok === true, JSON.stringify(viaTool).slice(0, 200))
const viaTools = await tool.execute({ action: 'invoke', project: '工具建的工程', tool: 'expand_node_tree_from_node', input: { ref: 'n1', text: '会话说' } })
chk('PG-10d', '★ 会话侧 action=invoke 真的写进图', viaTools && viaTools.ok === true, JSON.stringify(viaTools).slice(0, 200))
const viaGraph = await tool.execute({ action: 'graph', project: '工具建的工程' })
chk('PG-10e', '★ 会话侧 action=graph 读回根节点 + 树扩展出来的那个节点',
  viaGraph && viaGraph.ok === true
  && (viaGraph.objects || []).filter((o) => /^n[1-9]\d*$/.test(String(o.ref))).length === 2,
  JSON.stringify(viaGraph).slice(0, 220))
const viaDelete = await tool.execute({ action: 'delete', project: '工具建的工程' })
chk('PG-10f', '会话侧 action=delete 删掉工程文件', viaDelete && viaDelete.ok === true, '')
chk('PG-10g', '会话侧 action=status 与路由同源',
  (await tool.execute({ action: 'status' })).ok === true, '')

// ── PG-11 收尾：不得留下垃圾 ─────────────────────────────────────────────
const finalList = await call('GET', `${ROUTE}/pg/projects`)
chk('PG-11', '跑完工作区里没有残留工程',
  (finalList.json.projects || []).length === 0,
  JSON.stringify((finalList.json.projects || []).map((p) => p.name)))

rmSync(WORKSPACE, { recursive: true, force: true })
console.log(`\nPASS=${pass} FAIL=${fail}`)
console.log(existsSync(WORKSPACE) ? '（临时工作区未清干净）' : '（临时工作区已清理）')
process.exitCode = fail === 0 ? 0 : 1
