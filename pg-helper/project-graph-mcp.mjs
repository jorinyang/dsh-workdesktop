/**
 * 工程图（Project Graph）· MCP server（stdio）
 *
 * 把一个工程图工作区**按 MCP 暴露出去**，让 DSH（或任何 MCP 客户端）用标准工具调用
 * 建 / 改 / 删工程图里的内容。工具面与插件里的 agent 工具 `project_graph` **同一批动作**，
 * 底下走的是**同一条上游 CLI**（`tool list` / `tool describe` / `tool invoke`）。
 *
 * ── 为什么是零依赖手写 ────────────────────────────────────────────────────
 * 它要被 DSH 以 `command: <node.exe> args: [<这个文件>]` 直接 spawn（见
 * `~/.dsh/profiles/web/cordis.patch.yml` 的 `mcp-project-graph` 行）。上游 MCP SDK 装在
 * DSH 自己的检出里，从本文件的位置**解析不到**；而本项目对插件的纪律是"只用 node: 内置"。
 * 所以这里手写 JSON-RPC 子集 —— 报文格式以官方 SDK 为准，并由
 * `verify-project-graph-mcp.mjs` **拿官方 SDK 客户端做一致性验证**（不是自说自话）。
 *
 * 协议要点（取自 `@modelcontextprotocol/server` v2.0.0）：
 *   · 传输：stdio，**一行一个 JSON-RPC 消息**（消息里不许有裸换行）；
 *   · 最新版本 `2025-11-25`，支持集 `2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 / 2024-10-07`；
 *   · 必须实现：`initialize` →（客户端发 `notifications/initialized`）→ `tools/list` / `tools/call`；
 *   · `initialize` 回执的 `protocolVersion` 取"客户端要的且在支持集里"的那个，否则回最新的。
 *
 * ⚠️ **stdout 只能出现 JSON-RPC 消息**。任何日志一律走 stderr —— 往 stdout 写一行
 *    人类可读的字，客户端当场解析失败。
 *
 * ── 与插件 host 半段的关系 ────────────────────────────────────────────────
 * 两边读**同一组环境变量、同一套缺省值**（见下面 ENV 段）。这份路径解析是**刻意重复**的：
 * MCP server 要能独立于 DSH 插件运行，所以不 import 插件的代码。改一边请改另一边。
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ── ENV：与 dsh-workdesktop/lib/index.js 的 PG_* 段保持一致 ───────────────── */

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE || process.env.HOME || homedir()
const NODE = process.env.DSH_WORKDESKTOP_NODE || process.execPath || 'node'
const CSC = process.env.DSH_WORKDESKTOP_CSC
  || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'

const REPO = process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_REPO || join(HOME, 'Desktop', 'DSH', 'project-graph')
const PG_HOME = process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_DIR
  || join(process.env.DSH_HOME || join(HOME, '.dsh'), '.dsh-project-graph')
const PROJECTS = join(PG_HOME, 'projects')
const BIN = join(PG_HOME, 'bin')
const HELPER_EXE = join(BIN, 'project-graph-ownership-helper.exe')
const SEED = join(BIN, 'empty-project.prg')
const SEED_BUNDLED = join(HERE, 'empty-project.prg')
const HELPER_SRC = join(HERE, 'ProjectGraphOwnershipHelper.cs')
const CLI = join(REPO, 'packages', 'project-graph-cli', 'src', 'cli.mjs')
const NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,80}$/

const SERVER_NAME = 'project-graph'
const SERVER_VERSION = '0.1.0'
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const LATEST_VERSION = '2025-11-25'

function log(...parts) {
  process.stderr.write(`[project-graph-mcp] ${parts.join(' ')}\n`)
}

/* ── 上游 CLI 桥（与插件 host 半段同一条）────────────────────────────────── */

function cli(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(NODE, [CLI, '--', ...args], {
      cwd: existsSync(REPO) ? REPO : undefined,
      timeout: timeoutMs || 180000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PROJECT_GRAPH_OWNERSHIP_HELPER_PATH: HELPER_EXE },
    }, (err, stdout, stderr) => resolve({
      ok: err === null,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      error: err === null ? null : String((err && err.message) || err),
    }))
  })
}

/** 上游的报文契约是"恰好一个 JSON 值"，**可以是数组** —— 先整段解析再退回宽松。 */
function parseCliJson(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  try { return JSON.parse(trimmed) } catch { /* 落下去 */ }
  const a = trimmed.indexOf('{')
  const b = trimmed.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(trimmed.slice(a, b + 1)) } catch { return null }
}

function cliResult(r) {
  if (r.ok) {
    const value = parseCliJson(r.stdout)
    if (value === null) return { ok: false, error: 'CLI 退出码 0 但 stdout 不是 JSON', raw: r.stdout.slice(0, 4000) }
    return { ok: true, value }
  }
  const failure = parseCliJson(r.stderr)
  return {
    ok: false,
    error: (failure && failure.message) || r.error || 'CLI 调用失败',
    code: failure && failure.code ? failure.code : undefined,
    stderr: failure === null ? r.stderr.slice(0, 2000) : undefined,
  }
}

/** 工程名 / 工作区内绝对路径 → 绝对路径。 */
function projectPath(name) {
  const raw = String(name || '')
  if (isAbsolute(raw)) {
    const root = PROJECTS.endsWith('\\') ? PROJECTS : PROJECTS + '\\'
    if (!raw.toLowerCase().startsWith(root.toLowerCase())) throw new Error(`工程路径越出工作区：${raw}`)
    if (!raw.toLowerCase().endsWith('.prg')) throw new Error(`不是 .prg 工程：${raw}`)
    return raw
  }
  if (!NAME_RE.test(raw)) throw new Error(`工程名不合法：${raw}`)
  return join(PROJECTS, raw.toLowerCase().endsWith('.prg') ? raw : `${raw}.prg`)
}

function listProjects() {
  let entries = []
  try { entries = readdirSync(PROJECTS, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.prg')) continue
    let info = null
    try { info = statSync(join(PROJECTS, entry.name)) } catch { /* 读不到就报 0 */ }
    out.push({
      name: entry.name,
      title: entry.name.replace(/\.prg$/i, ''),
      size: info === null ? 0 : info.size,
      updatedAt: info === null ? 0 : info.mtimeMs,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

let helperBuild = null
async function ensureHelper() {
  if (helperBuild !== null && helperBuild.ok) return helperBuild
  try {
    await mkdir(BIN, { recursive: true })
    const srcStat = await stat(HELPER_SRC)
    const exeStat = await stat(HELPER_EXE).catch(() => null)
    if (exeStat !== null && exeStat.mtimeMs >= srcStat.mtimeMs && exeStat.size > 0) {
      helperBuild = { ok: true, reused: true, error: null }
      return helperBuild
    }
    const build = await new Promise((resolve) => {
      execFile(CSC, ['/nologo', '/target:exe', '/optimize+', '/r:System.Web.Extensions.dll',
        `/out:${HELPER_EXE}`, HELPER_SRC], { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: err === null, error: err === null ? null : String(stderr || err.message).slice(0, 400) })
      })
    })
    helperBuild = { ok: build.ok, error: build.error, reused: false }
  } catch (error) {
    helperBuild = { ok: false, error: String((error && error.message) || error) }
  }
  return helperBuild
}

async function status() {
  const helper = await ensureHelper()
  const repoReady = existsSync(REPO)
  const cliReady = existsSync(CLI)
  const depsReady = existsSync(join(REPO, 'node_modules'))
  return {
    ok: repoReady && cliReady && helper.ok,
    repo: REPO, repoReady,
    cli: CLI, cliReady,
    dependenciesReady: depsReady,
    workspace: PG_HOME, projectsDir: PROJECTS,
    helperExe: HELPER_EXE, helperReady: helper.ok === true, helperError: helper.error || null,
    seedReady: existsSync(SEED) || existsSync(SEED_BUNDLED),
    node: NODE,
    installHint: depsReady ? null : `先在上游检出里装依赖：cd "${REPO}" && pnpm install`,
  }
}

async function ensureSeed() {
  if (existsSync(SEED)) return { ok: true, seed: SEED }
  if (!existsSync(SEED_BUNDLED)) {
    return { ok: false, error: `空工程模板不存在：${SEED} 与 ${SEED_BUNDLED} 都没有` }
  }
  await mkdir(BIN, { recursive: true })
  await copyFile(SEED_BUNDLED, SEED)
  return { ok: true, seed: SEED }
}

/** 分一次项目级引用（`n1` 是分配出来的，不是凭空的）。 */
async function ensureReferences(file) {
  return (await invoke('get_all_nodes', file, {}, false)).ok === true
}

async function invoke(tool, project, input, allowUpgrade) {
  const name = String(tool || '').trim()
  if (name === '') return { ok: false, error: 'invoke 需要 tool' }
  let file
  try { file = projectPath(project) } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
  if (!existsSync(file)) return { ok: false, error: `没有这个工程：${file}`, code: 'PROJECT_NOT_FOUND' }
  const args = ['tool', 'invoke', name, '--project', file, '--input',
    JSON.stringify(input === undefined || input === null ? {} : input)]
  if (allowUpgrade === true) args.push('--allow-upgrade')
  const first = cliResult(await cli(args))
  if (first.ok !== true && name !== 'get_all_nodes'
    && /unknown_ref|Reference does not exist/i.test(String(first.error || ''))) {
    if (await ensureReferences(file)) return cliResult(await cli([...args]))
  }
  return first
}

/* ── 工具面（与插件 agent 工具 project_graph 同一批动作）────────────────── */

const TOOLS = [
  {
    name: 'pg_status',
    description: '工程图可用性自检：逐条报出上游检出 / CLI / 依赖 / 所有权 helper 的状态，'
      + '以及工作区与工程目录在哪。返回 ok=false 时 error 里写清缺的是哪一样。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => await status(),
  },
  {
    name: 'pg_projects',
    description: '列出工程图工作区里的全部工程（.prg）及其大小与修改时间。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ ok: true, projectsDir: PROJECTS, projects: listProjects() }),
  },
  {
    name: 'pg_create',
    description: '新建一个空工程（从空模板复制）。新工程自带一个根节点，引用是 n1 —— '
      + '接着用 pg_invoke 调 expand_node_tree_from_node 就能长出整棵树。',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: '工程名（可省 .prg；不要带路径分隔符）' } },
      required: ['project'],
      additionalProperties: false,
    },
    run: async (args) => {
      try {
        const target = projectPath(args.project)
        if (existsSync(target)) return { ok: false, error: `工程已存在：${target}` }
        const seed = await ensureSeed()
        if (seed.ok !== true) return seed
        await mkdir(PROJECTS, { recursive: true })
        await copyFile(seed.seed, target)
        await ensureReferences(target)
        return { ok: true, project: target, name: target.split('\\').pop(), note: '空工程已建好，自带根节点 n1' }
      } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
    },
  },
  {
    name: 'pg_rename',
    description: '给一个工程改名（只动 .prg 文件名，不动图内容）。',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, to: { type: 'string', description: '新工程名' } },
      required: ['project', 'to'],
      additionalProperties: false,
    },
    run: async (args) => {
      try {
        const from = projectPath(args.project)
        if (!existsSync(from)) return { ok: false, error: `没有这个工程：${from}` }
        const to = projectPath(args.to)
        if (existsSync(to)) return { ok: false, error: `目标已存在：${to}` }
        await rename(from, to)
        return { ok: true, project: to }
      } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
    },
  },
  {
    name: 'pg_delete',
    description: '删除一个工程文件。**不可恢复** —— 调用前请确认。',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
    run: async (args) => {
      try {
        const target = projectPath(args.project)
        if (!existsSync(target)) return { ok: false, error: `没有这个工程：${target}` }
        await rm(target, { force: true })
        return { ok: true, deleted: target }
      } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
    },
  },
  {
    name: 'pg_tools',
    description: '列出上游 Project Graph 的全部内置工具（29 条：读 / 建 / 改 / 删 / 连线 / 布局 / 上色），'
      + '每条带名字与说明。要入参 schema 用 pg_describe。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await cli(['tool', 'list'], 120000)
      const list = r.ok ? parseCliJson(r.stdout) : null
      if (!Array.isArray(list)) return cliResult(r)
      return {
        ok: true,
        count: list.length,
        tools: list.map((t) => ({ name: t && t.name, description: t && t.description })),
      }
    },
  },
  {
    name: 'pg_describe',
    description: '给出上游某一条内置工具的完整入参 JSON Schema。invoke 之前先用它拿准确键名。',
    inputSchema: {
      type: 'object',
      properties: { tool: { type: 'string', description: '上游工具名' } },
      required: ['tool'],
      additionalProperties: false,
    },
    run: async (args) => cliResult(await cli(['tool', 'describe', String(args.tool || '')], 120000)),
  },
  {
    name: 'pg_graph',
    description: '读一个工程的全部对象：节点（ref / type / position / size / text / childRefs）'
      + '与连线（LineEdge，带 sourceRef / targetRef / text）。',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await invoke('get_all_nodes', args.project, {}, false)
      if (r.ok !== true) return r
      return {
        ok: true,
        project: String(args.project || ''),
        objects: (r.value && Array.isArray(r.value.objects)) ? r.value.objects : [],
      }
    },
  },
  {
    name: 'pg_invoke',
    description: '执行任意一条上游内置工具（tool / input **原样透传**，本服务不做任何参数改写）。'
      + '这是建 / 改 / 删工程图内容的唯一入口。关闭态可跑 19 条（读、改、删、连线、树扩展、布局、上色）；'
      + '声明了 viewport 或 selection 的 10 条（如 create_text_node）需要 Project Graph 桌面端开着，'
      + '关闭态会回 PROJECT_MUST_BE_OPEN —— 那个错误码原样返回。'
      + '新工程"加节点"的正路是 expand_node_tree_from_node（ref=n1 + 缩进文本）。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '上游工具名（先用 pg_tools / pg_describe 拿准确名字与入参）' },
        project: { type: 'string', description: '工程名或绝对路径' },
        input: { type: 'object', description: '原样交给上游的入参对象', additionalProperties: true },
        allowUpgrade: { type: 'boolean', description: '允许上游对旧版本工程做升级迁移（默认否）' },
      },
      required: ['tool', 'project'],
      additionalProperties: false,
    },
    run: async (args) => await invoke(args.tool, args.project, args.input, args.allowUpgrade === true),
  },
]

/* ── JSON-RPC / MCP 传输（stdio，一行一个消息）──────────────────────────── */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } })
}

/** 工具回执：成功与失败都回一条 text content；失败带 isError:true（MCP 的约定）。 */
function toolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const failed = value !== null && typeof value === 'object' && value.ok === false
  return failed
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}

async function handle(message) {
  const method = message.method
  const id = message.id
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    const asked = message.params && message.params.protocolVersion
    const version = SUPPORTED_VERSIONS.includes(asked) ? asked : LATEST_VERSION
    reply(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: '工程图（Project Graph）：pg_tools 看上游工具清单 → pg_describe 看入参 schema → '
        + 'pg_invoke 执行。工程是工作区里的 .prg 文件，用 pg_projects 列、pg_create 建。',
    })
    return
  }
  // 通知（无 id）一律不回应。
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (isNotification) return

  if (method === 'ping') { reply(id, {}); return }

  if (method === 'tools/list') {
    reply(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    })
    return
  }

  if (method === 'tools/call') {
    const params = message.params || {}
    const name = String(params.name || '')
    const tool = TOOLS.find((t) => t.name === name)
    if (tool === undefined) {
      replyError(id, -32602, `Unknown tool: ${name}`)
      return
    }
    try {
      reply(id, toolResult(await tool.run(params.arguments || {})))
    } catch (error) {
      reply(id, toolResult({ ok: false, error: String((error && error.message) || error) }))
    }
    return
  }

  replyError(id, -32601, `Method not found: ${method}`)
}

/* ── stdin：一行一个消息，跨 chunk 拼包 ─────────────────────────────────── */

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\n')
    if (line === '') continue
    let message = null
    try { message = JSON.parse(line) } catch {
      replyError(null, -32700, 'Parse error')
      continue
    }
    // 逐条处理但**不并发**：JSON-RPC 允许乱序回执，可上游 CLI 是重资源，
    // 串行反而更好预测（也避免同一 .prg 上两次调用抢所有权锁）。
    handle(message).catch((error) => log('handler failed:', String((error && error.message) || error)))
  }
})
process.stdin.on('end', () => { process.exitCode = 0 })
process.stdin.on('error', (error) => { log('stdin error:', String(error && error.message || error)); process.exitCode = 1 })

log(`ready · workspace=${PG_HOME} · repo=${REPO} · tools=${TOOLS.length}`)
