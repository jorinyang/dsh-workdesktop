/**
 * 工程图（Project Graph）· MCP server（stdio）
 *
 * 把一个工程图工作区**按 MCP 暴露出去**，让 DSH（或任何 MCP 客户端）用标准工具
 * 建 / 改 / 删工程图里的内容。
 *
 * ── 工具面分三层（合起来才是"对文档内容的全部操作"）──────────────────────
 *   ① **上游那 29 条内置工具** —— **原样**暴露成 29 个 MCP 工具（名字、说明、inputSchema
 *      全部取自上游 `tool list` 的 `inputSchema`，一个字都不改写）。这是"项目原本具备"
 *      的那一层：建 / 改 / 删节点与连线、树扩展、自动布局、上色、检索、图像识别。
 *   ② **文档容器层**（`pg_document` / `pg_locate` / `pg_move_node` / `pg_set_details`）——
 *      上游 CLI **没有**这一层的工具：容器的元数据与附件、**移动**节点（实体有位置、
 *      文档也说得明明白白可移动，但 29 条里没有"移动"）、以及"任何实体上都可以写的详细信息"。
 *      这一层由 `project-graph-prg.mjs` 直接读写 `.prg`（ZIP + MessagePack）实现。
 *   ③ **本服务的元工具**（`pg_status` / `pg_projects` / `pg_create` / `pg_rename` /
 *      `pg_delete` / `pg_tools` / `pg_describe` / `pg_graph` / `pg_invoke`）——
 *      可用性自检、工程文件的增删改名、目录与 schema 查询，以及 `pg_invoke` 这条
 *      "任意上游工具"的兜底通道。
 *
 * ⚠️ 两层用的是**两套不同的标识**，别混：
 *   · CLI 层用**项目级引用**（`n1` / `e1`），存在按工程 URI 分键的引用存储里；
 *   · 文档层用**舞台对象的 `uuid`**（`.prg` 里写死的那个）。
 *   `pg_locate` 给出**精确**的两层对照（按 类型+文本+坐标 三元组做双射，**不是**模糊猜），
 *   匹配不成双射就如实报 ok=false。
 *
 * ── 为什么手写 MCP 而不是用官方 SDK ───────────────────────────────────────
 * 它要被 DSH 以 `command: <node.exe> args: [<这个文件>]` 直接 spawn，而官方 SDK 装在
 * DSH 自己的检出里，从这个文件的位置**解析不到**；本项目对插件的纪律也是"只用 node: 内置"。
 * 报文格式以官方 SDK 为准，由 `verify-project-graph-mcp.mjs` **拿官方 SDK 客户端做一致性验证**。
 *
 * 协议要点（取自 `@modelcontextprotocol/server` v2.0.0）：
 *   · 传输：stdio，**一行一个 JSON-RPC 消息**；最新版本 `2025-11-25`；
 *   · 必须实现：`initialize` →（客户端发 `notifications/initialized`）→ `tools/list` / `tools/call`；
 *   · `initialize` 的 `protocolVersion` 取"客户端要的且在支持集里"的那个，否则回最新的。
 *
 * ⚠️ **stdout 只能出现 JSON-RPC 消息**。任何日志一律走 stderr。
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPrg, writePrg } from './project-graph-prg.mjs'

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
const CACHE = join(PG_HOME, 'cache')
const CATALOG_FILE = join(CACHE, 'tool-catalog.json')
const HELPER_EXE = join(BIN, 'project-graph-ownership-helper.exe')
const SEED = join(BIN, 'empty-project.prg')
const SEED_BUNDLED = join(HERE, 'empty-project.prg')
const HELPER_SRC = join(HERE, 'ProjectGraphOwnershipHelper.cs')
const CLI = join(REPO, 'packages', 'project-graph-cli', 'src', 'cli.mjs')
const NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,80}$/

const SERVER_NAME = 'project-graph'
const SERVER_VERSION = '0.2.0'
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const LATEST_VERSION = '2025-11-25'
const CATALOG_TTL_MS = 60 * 60 * 1000

function log(...parts) {
  process.stderr.write(`[project-graph-mcp] ${parts.join(' ')}\n`)
}

/* ── 上游 CLI 桥 ────────────────────────────────────────────────────────── */

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

/* ── 上游工具目录（磁盘缓存）────────────────────────────────────────────── */

let catalog = null
let catalogAt = 0
let catalogFetch = null

function readCatalogFromDisk() {
  try {
    const raw = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
    if (raw && Array.isArray(raw.tools) && raw.tools.length > 0) return raw
  } catch { /* 没有或坏了就当没有 */ }
  return null
}

/**
 * 拿上游 29 条工具的定义。
 *
 * 为什么要落盘缓存：`tool list` 是 tsx 冷启动 + Vite SSR 载入整个 app，单次 10~20 秒；
 * 而 `tools/list` 是客户端**每次连接都会发**的请求，不能每次都等 15 秒。
 * 所以：磁盘有缓存就**立刻**用它（过期了在后台刷新，不阻塞本次回执）。
 */
async function ensureCatalog() {
  if (catalog !== null) return catalog
  const disk = readCatalogFromDisk()
  if (disk !== null) {
    catalog = disk.tools
    catalogAt = Number(disk.at) || 0
    if (Date.now() - catalogAt > CATALOG_TTL_MS) {
      void refreshCatalog()
    }
    return catalog
  }
  return await refreshCatalog()
}

async function refreshCatalog() {
  if (catalogFetch !== null) return await catalogFetch
  catalogFetch = (async () => {
    const r = await cli(['tool', 'list'], 120000)
    const list = r.ok ? parseCliJson(r.stdout) : null
    if (!Array.isArray(list)) {
      log('catalog fetch failed:', String(r.stderr || r.error || '').slice(0, 200))
      return catalog
    }
    catalog = list
    catalogAt = Date.now()
    try {
      await mkdir(CACHE, { recursive: true })
      writeFileSync(CATALOG_FILE, JSON.stringify({ at: catalogAt, tools: list }), 'utf8')
    } catch (error) { log('catalog cache write failed:', String(error && error.message || error)) }
    return catalog
  })()
  try { return await catalogFetch } finally { catalogFetch = null }
}

/** 上游工具 → MCP 工具：**名字与 inputSchema 原样**，只加上 `project` / `allowUpgrade`。 */
function upstreamToolDefinition(entry) {
  const schema = entry.inputSchema && typeof entry.inputSchema === 'object' ? entry.inputSchema : { type: 'object' }
  const properties = { ...(schema.properties || {}) }
  // `project` 放最前，方便人读；`allowUpgrade` 是上游 CLI 自己的开关。
  const merged = {
    ...schema,
    type: 'object',
    properties: {
      project: { type: 'string', description: '工程名（可省 .prg）或工作区内的绝对路径' },
      ...properties,
      allowUpgrade: { type: 'boolean', description: '允许上游对旧版本工程做升级迁移（默认否）' },
    },
    required: [...new Set([...(schema.required || []), 'project'])],
  }
  delete merged.$schema
  return {
    name: entry.name,
    description: `【上游内置工具】${entry.description || ''}`.trim()
      + '（入参与上游完全一致，另加 project / allowUpgrade；实现走 `tool invoke`。）',
    inputSchema: merged,
    upstream: true,
  }
}

/* ── 文档层（读 / 移动 / 详情）──────────────────────────────────────────── */

function loadDocument(project) {
  let file
  try { file = projectPath(project) } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
  if (!existsSync(file)) return { ok: false, error: `没有这个工程：${file}`, code: 'PROJECT_NOT_FOUND' }
  try {
    const doc = readPrg(readFileSync(file))
    return { ok: true, file, doc }
  } catch (error) {
    return { ok: false, error: `读 .prg 失败：${String((error && error.message) || error)}` }
  }
}

/** 舞台对象 → 摘要。坐标/尺寸从 `collisionBox.shapes[0]` 取（实体就是存在这里的）。 */
function summarize(object, index) {
  if (object === null || typeof object !== 'object') return { index, broken: true }
  const shape = object.collisionBox && Array.isArray(object.collisionBox.shapes)
    ? object.collisionBox.shapes[0] : null
  const location = shape && shape.location ? { x: shape.location.x, y: shape.location.y } : null
  const size = shape && shape.size ? { width: shape.size.x, height: shape.size.y } : null
  return {
    index,
    uuid: typeof object.uuid === 'string' ? object.uuid : null,
    type: typeof object._ === 'string' ? object._ : null,
    text: typeof object.text === 'string' ? object.text : undefined,
    details: object.details,
    location,
    size,
    // 连线：两级 `$` 引用是**舞台数组下标**（实测 `/0` → stage[0]），不是 uuid。
    links: Array.isArray(object.associationList)
      ? object.associationList.map((a) => (a && typeof a.$ === 'string' ? a.$ : null))
      : undefined,
    fields: Object.keys(object),
  }
}

/** 实体（有 collisionBox 的）配对键：类型 + 文本 + 坐标，三者都要精确相等。 */
function entityKey(type, text, location) {
  return [String(type), String(text === undefined ? '' : text),
    location ? Number(location.x) : 'NaN', location ? Number(location.y) : 'NaN'].join('\u0000')
}

/**
 * CLI 的 `ref`（`n1`）与文档的 `uuid` 的**精确对照**。
 *
 * 分两步，因为两类对象"身份"的来源不同（实测踩过：只按 类型+文本+坐标 一把配，
 * 连线全配不上 —— 连线在文档里**没有坐标**，它的身份由两端决定）：
 *
 *   ① **实体**（stage 里带 `collisionBox.shapes[*].location` 的）：
 *      键 = 类型 + 文本 + x + y。两边都**唯一**才配对。
 *   ② **连线**（`LineEdge`）：文档里 `associationList` 是**舞台数组下标**（`{"$":"/0"}` → stage[0]，
 *      实测确认），CLI 那边是 `sourceRef` / `targetRef`。先把两端各自映射到 uuid（用第①步的结果），
 *      再按 (源uuid, 目标uuid, 文本) 配对 —— 同样是两边唯一才认。
 *
 * 任何一步出现"同名同坐标的重复项"都**不猜**：列进 unmatched 并让 ok=false。
 */
async function locate(project) {
  const loaded = loadDocument(project)
  if (loaded.ok !== true) return loaded
  const nodes = await invoke('get_all_nodes', project, {}, false)
  if (nodes.ok !== true) return nodes
  const cliObjects = (nodes.value && Array.isArray(nodes.value.objects)) ? nodes.value.objects : []
  const stage = loaded.doc.stage || []

  const isEdge = (type) => String(type) === 'LineEdge'
  const docEntityLocation = (object) => {
    const shape = object && object.collisionBox && Array.isArray(object.collisionBox.shapes)
      ? object.collisionBox.shapes[0] : null
    return shape && shape.location ? shape.location : null
  }

  // ── ① 实体 ──────────────────────────────────────────────────────────────
  const docEntities = []
  const cliEntities = []
  stage.forEach((object, index) => {
    if (!object || isEdge(object._)) return
    docEntities.push({ index, object, uuid: object.uuid, type: object._, text: object.text, location: docEntityLocation(object) })
  })
  for (const ref of cliObjects) {
    if (!ref || isEdge(ref.type)) continue
    cliEntities.push({ ref, type: ref.type, text: ref.text, location: ref.position || null })
  }
  const pairs = []
  const unmatchedRefs = []
  const refToUuid = new Map()
  const usedUuids = new Set()
  const docEntityIndex = new Map()
  const docEntityDup = new Set()
  for (const item of docEntities) {
    const key = entityKey(item.type, item.text, item.location)
    if (docEntityIndex.has(key)) { docEntityDup.add(key); continue }
    docEntityIndex.set(key, item)
  }
  const cliEntityIndex = new Map()
  const cliEntityDup = new Set()
  for (const item of cliEntities) {
    const key = entityKey(item.type, item.text, item.location)
    if (cliEntityIndex.has(key)) { cliEntityDup.add(key); continue }
    cliEntityIndex.set(key, item)
  }
  for (const [key, item] of cliEntityIndex) {
    const target = docEntityIndex.get(key)
    if (target === undefined || docEntityDup.has(key) || cliEntityDup.has(key) || target.uuid === undefined) {
      unmatchedRefs.push(item.ref.ref)
      continue
    }
    refToUuid.set(item.ref.ref, target.uuid)
    usedUuids.add(target.uuid)
    pairs.push({ ref: item.ref.ref, uuid: target.uuid, type: target.type, index: target.index, text: target.text, kind: 'entity' })
  }

  // ── ② 连线 ──────────────────────────────────────────────────────────────
  const edgeDocKey = (object) => {
    const links = Array.isArray(object.associationList) ? object.associationList : []
    const uuidAt = (entry) => {
      if (!entry || typeof entry.$ !== 'string') return null
      const m = /^\/(\d+)$/.exec(entry.$)
      if (m === null) return null
      const other = stage[Number(m[1])]
      return other && typeof other.uuid === 'string' ? other.uuid : null
    }
    return [uuidAt(links[0]), uuidAt(links[1]), String(object.text === undefined ? '' : object.text)].join('\u0000')
  }
  const edgeCliKey = (ref) => [
    refToUuid.get(String(ref.sourceRef)) || null,
    refToUuid.get(String(ref.targetRef)) || null,
    String(ref.text === undefined ? '' : ref.text),
  ].join('\u0000')
  const docEdges = []
  stage.forEach((object, index) => { if (object && isEdge(object._)) docEdges.push({ index, object }) })
  const docEdgeIndex = new Map()
  const docEdgeDup = new Set()
  for (const item of docEdges) {
    const key = edgeDocKey(item.object)
    if (docEdgeIndex.has(key)) { docEdgeDup.add(key); continue }
    docEdgeIndex.set(key, item)
  }
  const cliEdges = cliObjects.filter((o) => o && isEdge(o.type))
  const cliEdgeIndex = new Map()
  const cliEdgeDup = new Set()
  for (const ref of cliEdges) {
    const key = edgeCliKey(ref)
    if (cliEdgeIndex.has(key)) { cliEdgeDup.add(key); continue }
    cliEdgeIndex.set(key, ref)
  }
  for (const [key, ref] of cliEdgeIndex) {
    const target = docEdgeIndex.get(key)
    if (target === undefined || docEdgeDup.has(key) || cliEdgeDup.has(key) || target.object.uuid === undefined) {
      unmatchedRefs.push(ref.ref)
      continue
    }
    // 端点没配上的连线，key 里是 `null`，上面那一步就查不到 → 已经落进 unmatchedRefs，
    // 这里不需要再判一次（`null` 永远不会等于某个 uuid）。
    usedUuids.add(target.object.uuid)
    pairs.push({
      ref: ref.ref, uuid: target.object.uuid, type: target.object._,
      index: target.index, text: target.object.text, kind: 'edge',
    })
  }

  const unmatchedObjects = stage
    .map((object, index) => ({ object, index }))
    .filter(({ object }) => object && typeof object.uuid === 'string' && !usedUuids.has(object.uuid))
    .map(({ object, index }) => ({ uuid: object.uuid, type: object._, index, text: object.text }))

  return {
    ok: unmatchedRefs.length === 0 && unmatchedObjects.length === 0,
    project: String(project || ''),
    refs: cliObjects.length,
    objects: stage.length,
    matched: pairs.length,
    pairs,
    unmatchedRefs,
    unmatchedObjects,
    note: unmatchedRefs.length === 0 && unmatchedObjects.length === 0
      ? '两层完全对上（每个引用恰配一个对象，反之亦然）'
      : '不是双射：有引用或对象没配上（实体按 类型+文本+坐标、连线按 两端uuid+文本，都要求两边唯一；'
        + '重复项会被判为无法确定，不猜）',
  }
}

/**
 * 把 `ref`（n1）或 `uuid` 解析成**uuid**。
 *
 * 走的是 `locate()` 那条**已经验证过是双射**的桥（实体按 类型+文本+坐标、连线按 两端uuid+文本），
 * 所以"配不上"或"有歧义"时**直接拒绝改动** —— 宁可不动，也不改错对象。
 * 返回 uuid 而不是下标：调用方拿到后再读一遍文档、按 uuid 找对象，于是两次读之间即使
 * 文档被动过也不会改错（下标会漂，uuid 不会）。
 */
async function resolveUuid(project, refOrUuid) {
  const wanted = String(refOrUuid || '').trim()
  if (wanted === '') return { ok: false, error: '需要 ref（如 n1）或 uuid' }
  if (!/^n[1-9]\d*$/.test(wanted)) {
    const loaded = loadDocument(project)
    if (loaded.ok !== true) return loaded
    const hits = (loaded.doc.stage || []).filter((object) => object && object.uuid === wanted)
    if (hits.length === 0) return { ok: false, error: `没有这个 uuid：${wanted}` }
    if (hits.length > 1) return { ok: false, error: `uuid ${wanted} 在文档里出现 ${hits.length} 次（文档本身有问题）` }
    return { ok: true, uuid: wanted, type: hits[0]._ }
  }
  const found = await locate(project)
  if (found.ok !== true) {
    return {
      ok: false,
      error: '引用与文档对不上（不是双射），拒绝改：' + found.note,
      detail: { unmatchedRefs: found.unmatchedRefs, unmatchedObjects: found.unmatchedObjects },
    }
  }
  const pair = found.pairs.find((item) => item.ref === wanted)
  if (pair === undefined) return { ok: false, error: `没有这个引用：${wanted}` }
  return { ok: true, uuid: pair.uuid, type: pair.type }
}

/** 实体的几何存在 `collisionBox.shapes[0].{location,size}` —— 移动就是改它。 */
function moveTarget(object, x, y, width, height) {
  const shapes = object && object.collisionBox && object.collisionBox.shapes
  if (!Array.isArray(shapes) || shapes.length === 0) {
    return { ok: false, error: `这个对象没有 collisionBox.shapes（类型 ${object && object._}），动不了` }
  }
  let touched = 0
  for (const shape of shapes) {
    if (x !== null || y !== null) {
      if (!shape.location) return { ok: false, error: 'shape 上没有 location，拒绝造一个（形状要原样保留）' }
      if (x !== null) { shape.location.x = x; touched += 1 }
      if (y !== null) { shape.location.y = y; touched += 1 }
    }
    if (width !== null || height !== null) {
      if (!shape.size) return { ok: false, error: 'shape 上没有 size，拒绝造一个（形状要原样保留）' }
      if (width !== null) { shape.size.x = width; touched += 1 }
      if (height !== null) { shape.size.y = height; touched += 1 }
    }
  }
  return { ok: true, touched }
}

function writeDocument(loaded, stage) {
  try {
    const out = writePrg(loaded.doc, { stage })
    writeFileSync(loaded.file, out)
    return { ok: true, bytes: out.length }
  } catch (error) {
    return { ok: false, error: `写 .prg 失败：${String((error && error.message) || error)}` }
  }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/* ── 工具面 ─────────────────────────────────────────────────────────────── */

/** 元工具（本服务自己的）：与插件 agent 工具 `project_graph` 同一批动作。 */
const META_TOOLS = [
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
      + '接着用 expand_node_tree_from_node 就能长出整棵树。',
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
    description: '列出上游 Project Graph 的全部内置工具（29 条：读 / 建 / 改 / 删 / 连线 / 布局 / 上色）。'
      + '注意：这 29 条**本身也已经各自是一个 MCP 工具**（同名），这里只给清单与说明。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const list = await ensureCatalog()
      if (list === null) return { ok: false, error: '取不到上游工具清单（先看 pg_status）' }
      return {
        ok: true,
        count: list.length,
        tools: list.map((t) => ({ name: t && t.name, description: t && t.description })),
      }
    },
  },
  {
    name: 'pg_describe',
    description: '给出上游某一条内置工具的完整入参 JSON Schema（与它作为 MCP 工具时暴露的 schema 只差 project / allowUpgrade 两项）。',
    inputSchema: {
      type: 'object',
      properties: { tool: { type: 'string', description: '上游工具名' } },
      required: ['tool'],
      additionalProperties: false,
    },
    run: async (args) => {
      const list = await ensureCatalog()
      const wanted = String(args.tool || '')
      const found = Array.isArray(list) ? list.find((t) => t && t.name === wanted) : undefined
      if (found === undefined) return { ok: false, error: `没有这条上游工具：${wanted}` }
      return { ok: true, tool: found }
    },
  },
  {
    name: 'pg_graph',
    description: '读一个工程的全部对象（上游 get_all_nodes 的载荷摊平成 objects）：'
      + '节点（ref / type / position / size / text / childRefs）与连线（LineEdge，带 sourceRef / targetRef / text）。',
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
    description: '执行任意一条上游内置工具（tool / input **原样透传**）。'
      + '这 29 条现在**各自也是一个 MCP 工具**，所以正常情况下直接调那一个即可；'
      + '本工具留给"工具名是动态拼出来的"或"想走一条统一通道"的场景。'
      + '关闭态可跑 19 条；声明了 viewport 或 selection 的 10 条需要桌面端开着，会回 PROJECT_MUST_BE_OPEN。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '上游工具名' },
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

/** 文档容器层的工具：上游 CLI 没有这一层，直接读写 `.prg`。 */
const DOCUMENT_TOOLS = [
  {
    name: 'pg_document',
    description: '【文档容器层】把 `.prg` 当**文档**读出来（不走上游 CLI）：'
      + '格式元数据（version 等）、容器里的全部条目、附件清单，以及**全部舞台对象**'
      + '（不只是节点与连线 —— 涂鸦、分区、孪生关系等类型也会列出来），每个对象给 uuid / 类型 / '
      + '文本 / 详细信息 / 坐标 / 尺寸 / 字段名。'
      + '⚠️ 这是**文档层**，标识是 uuid；上游工具那层用的是引用（n1）。两层的对照用 pg_locate。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        includeRaw: { type: 'boolean', description: 'true 时连原始字段值一起回（体积大；默认只给摘要）' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    run: async (args) => {
      const loaded = loadDocument(args.project)
      if (loaded.ok !== true) return loaded
      const doc = loaded.doc
      return {
        ok: true,
        file: loaded.file,
        metadata: doc.metadata,
        entries: doc.entries.map((e) => ({ name: e.name, bytes: e.data.length })),
        attachments: doc.attachments,
        hasExtension: doc.extension !== null,
        stageCount: doc.stage === null ? 0 : doc.stage.length,
        types: doc.stage === null ? {} : doc.stage.reduce((acc, object) => {
          const t = object && typeof object._ === 'string' ? object._ : '(未知)'
          acc[t] = (acc[t] || 0) + 1
          return acc
        }, {}),
        objects: doc.stage === null ? [] : doc.stage.map((object, index) => {
          const summary = summarize(object, index)
          return args.includeRaw === true ? { ...summary, raw: object } : summary
        }),
      }
    },
  },
  {
    name: 'pg_locate',
    description: '【文档容器层】把上游的**引用**（n1 / e1）与文档里的 **uuid** 精确对上。'
      + '做法是"类型 + 文本 + 坐标"三条同时相等且两边都唯一才配对 —— **不是**模糊匹配；'
      + '配不成双射就回 ok=false 并列出配不上的项（宁可说不确定，也不猜错对象）。',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
    run: async (args) => await locate(args.project),
  },
  {
    name: 'pg_move_node',
    description: '【文档容器层】**移动 / 缩放一个舞台对象** —— 上游 29 条里没有"移动"这条，'
      + '但文档规范里实体必有位置、也必须可以手动移动，所以这一层由本服务直接改 `.prg`。'
      + '改的是 `collisionBox.shapes[*].location / size`（文档里实体就是存在这儿的）。'
      + '对象用 `ref`（n1）或 `uuid` 指定；只给想改的那几项，其余保持原样。'
      + '⚠️ 文档层改动**不经过上游的所有权锁**：确保没有别的进程正在编辑同一个工程。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        target: { type: 'string', description: 'ref（如 n1）或舞台对象的 uuid' },
        x: { type: 'number', description: '新的 x（不给就不动）' },
        y: { type: 'number', description: '新的 y（不给就不动）' },
        width: { type: 'number', description: '新的宽（不给就不动）' },
        height: { type: 'number', description: '新的高（不给就不动）' },
      },
      required: ['project', 'target'],
      additionalProperties: false,
    },
    run: async (args) => {
      const x = numberOrNull(args.x); const y = numberOrNull(args.y)
      const width = numberOrNull(args.width); const height = numberOrNull(args.height)
      if (x === null && y === null && width === null && height === null) {
        return { ok: false, error: '至少要给 x / y / width / height 之一' }
      }
      const resolved = await resolveUuid(args.project, args.target)
      if (resolved.ok !== true) return resolved
      const loaded = loadDocument(args.project)
      if (loaded.ok !== true) return loaded
      const index = (loaded.doc.stage || []).findIndex((object) => object && object.uuid === resolved.uuid)
      if (index < 0) return { ok: false, error: `写之前又读了一遍，找不到 uuid ${resolved.uuid}（两次读之间文档被改过？）` }
      const object = loaded.doc.stage[index]
      const before = summarize(object, index)
      const moved = moveTarget(object, x, y, width, height)
      if (moved.ok !== true) return moved
      const written = writeDocument(loaded, loaded.doc.stage)
      if (written.ok !== true) return written
      const after = summarize(object, index)
      return {
        ok: true,
        file: loaded.file,
        uuid: after.uuid, type: after.type,
        before: { location: before.location, size: before.size },
        after: { location: after.location, size: after.size },
        bytes: written.bytes,
        note: '读回核对：用上游的 get_all_nodes 应能看到新坐标',
      }
    },
  },
  {
    name: 'pg_set_details',
    description: '【文档容器层】写 / 清空一个舞台对象的**详细信息**（`details` 字段）。'
      + '文档规范说"任何实体上都可以写详细信息"，但上游 29 条里没有任何一条能写它 —— '
      + '所以这一层由本服务直接改 `.prg`。'
      + '⚠️ `details` 在不同格式版本里**类型不一样**（本机 v2.7 的文档里是数组、旧导出里是字符串），'
      + '所以：**先读一次 `pg_document` 看现有 `details` 长什么样，再照那个形状写**。'
      + '本工具把 value **原样**存进去，不做任何转换。`target` 用 ref（n1）或 uuid。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        target: { type: 'string', description: 'ref（如 n1）或舞台对象的 uuid' },
        value: { description: '要写入 details 的值（字符串 / 数组 / 对象，原样存入）；给 null 表示清空' },
      },
      required: ['project', 'target'],
      additionalProperties: false,
    },
    run: async (args) => {
      const resolved = await resolveUuid(args.project, args.target)
      if (resolved.ok !== true) return resolved
      const loaded = loadDocument(args.project)
      if (loaded.ok !== true) return loaded
      const object = (loaded.doc.stage || []).find((item) => item && item.uuid === resolved.uuid)
      if (object === undefined) return { ok: false, error: `写之前又读了一遍，找不到 uuid ${resolved.uuid}（两次读之间文档被改过？）` }
      if (!Object.prototype.hasOwnProperty.call(object, 'details')) {
        return { ok: false, error: `这个对象（${object._}）上没有 details 字段，拒绝新造一个` }
      }
      const before = object.details
      object.details = args.value === undefined ? [] : args.value
      const written = writeDocument(loaded, loaded.doc.stage)
      if (written.ok !== true) return written
      return {
        ok: true,
        file: loaded.file, uuid: object.uuid, type: object._,
        before, after: object.details, bytes: written.bytes,
      }
    },
  },
]

/** 全量工具表：元工具 + 文档层 + （目录到位后的）上游 29 条。 */
async function allTools() {
  const list = await ensureCatalog()
  const upstream = Array.isArray(list) ? list.map(upstreamToolDefinition) : []
  return [...META_TOOLS, ...DOCUMENT_TOOLS, ...upstream]
}

/* ── JSON-RPC / MCP 传输（stdio，一行一个消息）──────────────────────────── */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

/** 工具回执：成功与失败都回一条 text content；失败带 isError:true（MCP 的约定）。 */
function toolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const failed = value !== null && typeof value === 'object' && value.ok === false
  return failed
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}

/** 上游工具作为 MCP 工具被调用：把 project / allowUpgrade 摘出来，其余原样透传。 */
async function callUpstream(name, args) {
  const { project, allowUpgrade, ...input } = args || {}
  return await invoke(name, project, input, allowUpgrade === true)
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
      instructions: '工程图（Project Graph）。工具分三层：'
        + '① 上游 29 条内置工具（create_text_node / edit_text_node / delete_node / create_edges …，'
        + '名字与入参和上游完全一致，另加 project）；'
        + '② 文档容器层（pg_document 读整份文档 · pg_locate 引用↔uuid 精确对照 · '
        + 'pg_move_node 移动实体 · pg_set_details 写详细信息）—— 这一层上游 CLI 没有；'
        + '③ 元工具（pg_status / pg_projects / pg_create / pg_rename / pg_delete / pg_tools / '
        + 'pg_describe / pg_graph / pg_invoke）。工程是工作区里的 .prg，用 pg_projects 列、pg_create 建。',
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (isNotification) return
  if (method === 'ping') { reply(id, {}); return }

  if (method === 'tools/list') {
    const tools = await allTools()
    reply(id, {
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    })
    return
  }

  if (method === 'tools/call') {
    const params = message.params || {}
    const name = String(params.name || '')
    const args = params.arguments || {}
    const tools = await allTools()
    const tool = tools.find((t) => t.name === name)
    if (tool === undefined) {
      replyError(id, -32602, `Unknown tool: ${name}`)
      return
    }
    try {
      const value = tool.upstream === true ? await callUpstream(name, args) : await tool.run(args)
      reply(id, toolResult(value))
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

log(`ready · workspace=${PG_HOME} · repo=${REPO} · meta=${META_TOOLS.length} doc=${DOCUMENT_TOOLS.length} upstream=on-demand`)
