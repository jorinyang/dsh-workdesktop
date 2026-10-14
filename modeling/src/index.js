/**
 * dsh-modeling — host half（Node 侧）。
 *
 * 职责只有三件，全部经 `/modeling/api` 暴露给浏览器半段：
 *   1. **持久化**：把模型存成 `DSH_HOME/.dsh-modeling/<profile>/<slug>.json`，
 *      一个模型一个文件（进程重启不丢、可直接进 git、可直接手改）。
 *   2. **AI 生成**：走 `ctx.llm`（harness 已有的提供方无关模型服务）—— 不另配
 *      API Key、不猜协议；提供方与模型取 `ctx.agentDefaultModel` 的当前选择。
 *   3. **词汇下发**：把 `src/modeling.mjs` 里的档案/层/类型表原样下发，
 *      保证 host 与 client 用的是同一份真相源。
 *
 * 依赖刻意极少：`node:` 内置 + 本包自带模块，不 import 任何 @deepseek-ai 包，
 * 这样 checkout 运行时与打包运行时（版本不一致）都能跑。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  AI_LIMITS,
  ATTR_FIELDS,
  AXIS,
  EDGE_TYPES,
  LEVEL_COUNT,
  ORIENTATIONS,
  PROFILES,
  attrKeys,
  attrLabel,
  emptyModel,
  layerInfo,
  layoutModel,
  nodeTypeOf,
  normalizeModel,
  orientationOf,
  profileOf,
} from './modeling.mjs'

export const name = 'dsh-modeling'
export const inject = ['webServer']

/** 路由前缀（浏览器半段固定按这个前缀取数）。 */
const ROUTE = '/modeling/api'

/** 数据根：`DSH_MODELING_DIR` 覆盖，默认 `$DSH_HOME/.dsh-modeling`。 */
function dataRoot() {
  const explicit = process.env.DSH_MODELING_DIR
  if (explicit && explicit.trim() !== '') return resolve(explicit)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.dsh-modeling')
}

/** AI 生成的生成参数（env 可覆盖，便于换更便宜的模型或离线关掉）。 */
const AI_TIMEOUT_MS = Number(process.env.DSH_MODELING_AI_TIMEOUT_MS || 120000)
const AI_MAX_TOKENS = Number(process.env.DSH_MODELING_AI_MAX_TOKENS || 8000)

/** 档案 / 层 / 类型 id 都是 [a-z0-9_-]；用它挡住路径穿越。 */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** 文件名 → 模型名（`a__b.json` 还原成 `a/b`，避免名字里的斜杠变成目录）。 */
const FILE_ESCAPE = { '/': '__', '\\': '__' }

/**
 * 一个模型名对应的文件名（去掉路径分隔符，再挡住穿越）。
 * @param name 模型名（用户可见）
 * @returns 安全的文件名（不含 .json）
 */
function slugOf(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/]/g, '__')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80)
  const fallback = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'model' : cleaned
  return fallback
}

/** 模型名 → 绝对路径（并断言结果仍在根目录内）。 */
function pathOf(profileId, name) {
  const root = join(dataRoot(), slugOf(profileId))
  const file = join(root, `${slugOf(name)}.json`)
  const normalized = resolve(file)
  const wanted = resolve(root)
  if (normalized !== wanted && !normalized.startsWith(wanted + sep)) throw new Error('模型名不合法')
  return normalized
}

/** 一个档案目录下的全部模型（按更新时间倒序）。 */
async function listModels(profileId) {
  const dir = join(dataRoot(), slugOf(profileId))
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, entry.name), 'utf8')
      const model = normalizeModel(JSON.parse(raw), profileId)
      out.push({
        name: model.name,
        profile: model.profile,
        updatedAt: model.updatedAt,
        createdAt: model.createdAt,
        nodes: model.nodes.length,
        edges: model.edges.length,
        intent: model.intent,
      })
    } catch {
      out.push({ name: entry.name.replace(/\.json$/i, ''), profile: profileId, updatedAt: 0, createdAt: 0, nodes: 0, edges: 0, intent: '', broken: true })
    }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return out
}

/** 读一个模型（不存在返回 null）。 */
async function readModel(profileId, name) {
  try {
    const raw = await readFile(pathOf(profileId, name), 'utf8')
    return normalizeModel(JSON.parse(raw), profileId)
  } catch {
    return null
  }
}

/** 写一个模型（规范化后落盘；返回落盘后的模型）。 */
async function writeModel(input) {
  const model = normalizeModel(input, input?.profile)
  model.updatedAt = Date.now()
  const file = pathOf(model.profile, model.name)
  await mkdir(join(dataRoot(), slugOf(model.profile)), { recursive: true })
  await writeFile(file, JSON.stringify(model, null, 2), 'utf8')
  return model
}

/** 删一个模型。 */
async function deleteModel(profileId, name) {
  await rm(pathOf(profileId, name), { force: true })
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────

/** 读请求体（上限 4MB，够存很大的模型）。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > 4 * 1024 * 1024) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/** 统一 JSON 应答。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 从 URL 取查询参数。 */
function queryOf(url, base) {
  try {
    return new URL(url ?? '/', base).searchParams
  } catch {
    return new URLSearchParams()
  }
}

// ── AI 生成 ────────────────────────────────────────────────────────────────

/**
 * 组装生成用的系统提示：把**当前档案的真实词汇**整份交给模型，
 * 并要求它只输出 JSON。词汇来自同一份真相源，不会与画布渲染脱节。
 */
function buildSystemPrompt(profile, level) {
  const profileId = profile.id
  const layerLines = []
  for (let i = 0; i < LEVEL_COUNT; i += 1) {
    const info = layerInfo(profileId, i)
    const types = Object.entries(profile.nodeTypes)
      .filter(([, def]) => def.level === undefined || def.level === i)
      .map(([id, def]) => `${id}(${def.label}·${ORIENTATIONS[def.orientation].label}${def.attrs?.length ? '·可填:' + def.attrs.join('/') : ''})`)
      .join('、')
    layerLines.push(`L${i} 抽象层「${info.label}」（${info.desc}）：可选类型 ${types || '（任意）'}`)
  }
  const attrLines = Object.values(ATTR_FIELDS)
    .map(field => `${field.id}(${field.label}·${field.type === 'list' ? '字符串数组' : '短文本'})`)
    .join('、')
  const edgeLines = Object.values(EDGE_TYPES).map(type => `${type.id}(${type.label})`).join('、')
  return [
    '你是一个建模引擎。你的唯一输出是一段 JSON，不要任何解释、不要 Markdown 代码围栏。',
    '',
    '## 通用模型（所有建模领域共用的同一套代数）',
    '模型 = 节点集 + 连边集。节点 = (抽象层 level, 类型 type, 名称 name, 属性 attrs)。',
    `抽象层轴是固定的 5 层，任何领域都走这条轴：${AXIS.map(layer => `L${layer.level}${layer.name}(${layer.question})`).join(' → ')}。`,
    '每个节点有"朝向"：声明式回答"是什么"，过程式回答"怎么走"——两种朝向在**同一张图**上共存，不要把它们分成两张图。',
    '',
    `## 当前档案：${profile.label}（${profile.summary}）`,
    ...layerLines,
    '',
    `## 可填属性 facet（只能从这张表里选键）：${attrLines}`,
    'attrs 只填对该节点真正有信息量的项；没有就省略，不要写空值。',
    '',
    `## 连边类型：${edgeLines}`,
    '过程推进用 flows，分支条件用 guards，结构归属用 contains，下一层实现上一层用 realizes。',
    '',
    '## 输出格式（严格）',
    '{"name":"模型名","intent":"一句话说清这个模型要回答什么",',
    ' "nodes":[{"id":"n1","name":"…","level":0,"type":"…","desc":"…","attrs":{"principle":"…"}}],',
    ' "edges":[{"from":"n1","to":"n2","type":"flows","label":"…"}]}',
    '',
    `约束：节点 ${Math.min(6, AI_LIMITS.maxNodes)}–${Math.min(24, AI_LIMITS.maxNodes)} 个；level 只能是 0..${LEVEL_COUNT - 1}（整数）；`,
    'type 必须取自上面列出的类型 id；edges 的 from/to 必须是已出现的节点 id；',
    '不要输出 x/y（布局由画布负责）。宁可少而准，不要多而空。',
    level === undefined ? '' : `本次重点：第 L${level} 层「${layerInfo(profileId, level).label}」。`,
  ].filter(line => line !== '').join('\n')
}

/** 从模型输出里抠出 JSON（容忍代码围栏与前后废话）。 */
function extractJson(text) {
  let raw = String(text ?? '').trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence !== null) raw = fence[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('模型没有返回 JSON')
  return JSON.parse(raw.slice(start, end + 1))
}

/**
 * 构造一条 user 消息。
 *
 * 刻意**不 import `createUserMessage`**：那会把 `@deepseek-ai/dsh-llm` 变成
 * 硬依赖 —— 本插件装在 profile 目录下，而该包由 DSH 自己从 profiles 根解析，
 * 从插件目录 import 它会直接 MODULE_NOT_FOUND（实测踩过）。
 * dsh-llm 的 createMessage 只做两件事：`{...input, role, id}` 再 deep-freeze，
 * 这里按同一形状自建，不引入任何跨包依赖。
 */
function userMessage(text) {
  return Object.freeze({
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/**
 * 调一次模型并拿到完整文本。
 * 走 `ctx.llm.stream`（提供方无关的流式接口），只累积 text-delta。
 * @returns {{text:string, provider:string, model:string}}
 */
async function callModel(ctx, system, user, signal) {
  const llm = ctx.get?.('llm') ?? ctx.llm
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('本部署没有挂载 llm 服务（@deepseek-ai/dsh-llm），无法做 AI 生成')
  }
  const selection = (() => {
    try {
      const current = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (current !== undefined && current !== null && current.provider && current.model) return current
    } catch {
      // 回落 env / 内置默认
    }
    return {
      provider: process.env.DSH_MODELING_PROVIDER || 'deepseek-official',
      model: process.env.DSH_MODELING_MODEL || 'deepseek-v4-flash',
    }
  })()
  const messages = [userMessage(user)]
  let text = ''
  let failure
  for await (const chunk of llm.stream({
    provider: selection.provider,
    model: selection.model,
    system,
    messages,
    temperature: 0.2,
    maxTokens: AI_MAX_TOKENS,
    signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason !== 'stop' && chunk.reason !== 'length' && chunk.reason !== 'tool-calls') {
      failure = `模型以 ${String(chunk.reason)} 结束`
    }
  }
  if (failure !== undefined && text.trim() === '') throw new Error(failure)
  return { text, provider: selection.provider, model: selection.model }
}

// ── 路由 ───────────────────────────────────────────────────────────────────

/** 一条路由的实现表：method + 匹配器 → handler。 */
function handle(ctx, path, method) {
  return async (req, res) => {
    try {
      if (path === '/profiles' && method === 'GET') {
        sendJson(res, 200, {
          version: 1,
          axis: AXIS,
          orientations: ORIENTATIONS,
          attrFields: ATTR_FIELDS,
          edgeTypes: EDGE_TYPES,
          profiles: PROFILES,
          dataRoot: dataRoot(),
        })
        return
      }

      if (path === '/models' && method === 'GET') {
        const params = queryOf(req.url, 'http://127.0.0.1')
        const profileId = profileOf(params.get('profile') ?? '').id
        sendJson(res, 200, { profile: profileId, models: await listModels(profileId) })
        return
      }

      if (path === '/model' && method === 'GET') {
        const params = queryOf(req.url, 'http://127.0.0.1')
        const profileId = profileOf(params.get('profile') ?? '').id
        const modelName = params.get('name') ?? ''
        const model = await readModel(profileId, modelName)
        if (model === null) { sendJson(res, 404, { error: '模型不存在' }); return }
        sendJson(res, 200, { model })
        return
      }

      if (path === '/model' && method === 'POST') {
        const body = await readBody(req)
        const model = await writeModel(body.model ?? body)
        sendJson(res, 200, { model })
        return
      }

      if (path === '/model' && method === 'DELETE') {
        const params = queryOf(req.url, 'http://127.0.0.1')
        const profileId = profileOf(params.get('profile') ?? '').id
        await deleteModel(profileId, params.get('name') ?? '')
        sendJson(res, 200, { ok: true })
        return
      }

      if (path === '/meta' && method === 'GET') {
        const controller = new AbortController()
        const timer = setTimeout(() => { controller.abort() }, 4000)
        let provider = process.env.DSH_MODELING_PROVIDER || 'deepseek-official'
        let model = process.env.DSH_MODELING_MODEL || 'deepseek-v4-flash'
        let source = 'default'
        try {
          const current = ctx.get?.('agentDefaultModel')?.currentSelection?.()
          if (current?.provider && current?.model) { provider = current.provider; model = current.model; source = 'agent-default-model' }
        } catch { /* 保持默认 */ }
        let available = false
        try {
          available = (ctx.get?.('llm')?.listProviders?.() ?? []).length > 0
        } catch { available = false }
        clearTimeout(timer)
        sendJson(res, 200, { dataRoot: dataRoot(), ai: { available, provider, model, source } })
        return
      }

      if (path === '/generate' && method === 'POST') {
        const body = await readBody(req)
        const profile = profileOf(body.profile ?? '')
        const brief = String(body.brief ?? '').trim()
        if (brief === '') { sendJson(res, 400, { error: '先写一句要建模的内容（议题 / 方法论要点 / 系统说明）' }); return }
        const level = Number.isFinite(Number(body.level)) ? Math.max(0, Math.min(LEVEL_COUNT - 1, Math.round(Number(body.level)))) : undefined
        const controller = new AbortController()
        const timer = setTimeout(() => { controller.abort() }, AI_TIMEOUT_MS)
        try {
          const system = buildSystemPrompt(profile, level)
          const user = [
            `档案：${profile.label}`,
            body.name ? `模型名建议：${body.name}` : '',
            level === undefined ? '' : `重点层次：L${level} ${layerInfo(profile.id, level).label}`,
            '',
            '要建模的内容：',
            brief,
          ].filter(line => line !== '').join('\n')
          // 注意别把 `model` 这个名字用在模型 id 上：这附近已有 draft/model 两个概念，
          // 同名会让响应体里的 `model` 字段被 id 字符串顶替（踩过，症状是前端拿到
          // 一个字符串当模型用）。所以这里叫 modelId。
          const { text, provider, model: modelId } = await callModel(ctx, system, user, controller.signal)
          const parsed = extractJson(text)
          const draft = normalizeModel({
            profile: profile.id,
            name: String(parsed.name ?? body.name ?? 'AI 生成模型').slice(0, 80),
            intent: String(parsed.intent ?? '').slice(0, 400),
            nodes: (Array.isArray(parsed.nodes) ? parsed.nodes : []).slice(0, AI_LIMITS.maxNodes),
            edges: (Array.isArray(parsed.edges) ? parsed.edges : []).slice(0, AI_LIMITS.maxEdges),
          }, profile.id)
          const laid = layoutModel(draft, { force: true })
          for (const node of draft.nodes) {
            const point = laid.positions[node.id]
            node.x = point?.x ?? null
            node.y = point?.y ?? null
          }
          sendJson(res, 200, { model: draft, provider, modelId, dropped: countDropped(parsed, draft) })
        } finally {
          clearTimeout(timer)
        }
        return
      }

      if (path === '/draft' && method === 'GET') {
        const params = queryOf(req.url, 'http://127.0.0.1')
        const profile = profileOf(params.get('profile') ?? '')
        sendJson(res, 200, { brief: draftBrief(profile) })
        return
      }

      sendJson(res, 404, { error: `未知路由 ${method} ${path}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { error: message })
    }
  }
}

/** AI 输出里被规范化丢掉的节点/边条数（如实回报，不假装全部采纳）。 */
function countDropped(parsed, model) {
  const nodesIn = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0
  const edgesIn = Array.isArray(parsed.edges) ? parsed.edges.length : 0
  const droppedNodes = Math.max(0, Math.min(nodesIn, AI_LIMITS.maxNodes) - model.nodes.length)
  const droppedEdges = Math.max(0, Math.min(edgesIn, AI_LIMITS.maxEdges) - model.edges.length)
  return { nodes: droppedNodes, edges: droppedEdges }
}

/** 生成框的空白模板（如实告诉用户"什么才算够用的一句话"）。 */
function draftBrief(profile) {
  const first = layerInfo(profile.id, 0)
  return [
    `【议题】这次要建模的是……（边界：不包括……）`,
    `【${layerInfo(profile.id, 1).label}】必须成立的原则是……`,
    `【${layerInfo(profile.id, 2).label}】由哪几个阶段/模块构成……`,
    `【${layerInfo(profile.id, 4).label}】做出来长什么样、怎么算做到了……`,
    '',
    `（不必逐条填；至少写清「${first.label}」与「${layerInfo(profile.id, 4).label}」，其余交给模型补。）`,
  ].join('\n')
}

/**
 * host 半段入口：注册 `/modeling/api/*`。
 * @param ctx cordis 上下文（需要 webServer）。
 */
export function apply(ctx) {
  // webServer 路由表按 (kind, path) 判重：同一路径只能注册一个 handler，由
  // handler 自己按 req.method 分发 ——「一个方法一条注册」会让 /model 的第 2 条
  // 注册直接抛 duplicate exact route，整个插件树加载失败（启动崩溃）。
  // 所以这里按路径聚合，请求期用 req.method 选中对应分支。
  const routes = [
    ['/profiles', ['GET']],
    ['/meta', ['GET']],
    ['/draft', ['GET']],
    ['/models', ['GET']],
    ['/model', ['GET', 'POST', 'DELETE']],
    ['/generate', ['POST']],
  ]
  for (const [path, methods] of routes) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}${path}`,
      handler: (req, res) => {
        const method = String(req.method ?? 'GET').toUpperCase()
        if (!methods.includes(method)) {
          // 路径存在、方法不对 → 405（不是 404）：如实告诉调用方"路由在，动词错"
          sendJson(res, 405, { error: `${path} 不支持 ${method}，可用 ${methods.join(' / ')}` })
          return
        }
        return handle(ctx, path, method)(req, res)
      },
    }), `dsh-modeling: ${ROUTE}${path} [${methods.join(' ')}]`)
  }
  ctx.logger?.info?.('dsh-modeling: routes mounted at %s (data root %s)', ROUTE, dataRoot())
  void mkdir(dataRoot(), { recursive: true }).catch(() => {})
}

/** 供自测直接调用的内部面（不参与运行时加载契约）。 */
export const __internals = {
  ROUTE,
  dataRoot,
  pathOf,
  slugOf,
  listModels,
  readModel,
  writeModel,
  deleteModel,
  extractJson,
  buildSystemPrompt,
  draftBrief,
  emptyModel,
  nodeTypeOf,
  orientationOf,
  attrKeys,
  attrLabel,
}
