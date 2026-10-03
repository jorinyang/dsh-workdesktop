/**
 * dsh-coords — host 半段（Node 侧）。
 *
 * 职责四件，全部经 `/coords/api` 暴露给浏览器半段：
 *   1. **落盘**：一套坐标系一个 JSON —— `$DSH_HOME/.dsh-coords/<名字>.json`；
 *      导入的原始内容放 `_sources/`，用户模板放 `_templates/`。
 *   2. **导入解析**：md / txt / json / csv / tsv / **xlsx** 读成表格并给出
 *      「轴/分组/点名」的初步匹配（确定性规则，不调模型）。
 *   3. **事件**：内存里一条很小的事件表（open / save），供浏览器半段轮询 ——
 *      agent 落盘后卡片能自己刷新，`coords_open` 能让卡片自己弹出来。
 *   4. **DSH 工具**：`coords_*` 六个，让会话里的 agent 直接建/读/列坐标系。
 *
 * 依赖刻意极少：`node:` 内置 + 本包自带的共用代数，不 import 任何
 * `@deepseek-ai/*` 包 —— 插件目录解析不到它们的 exports，import 会直接
 * MODULE_NOT_FOUND（dsh-modeling 实测踩过同一个坑）。
 */

export const name = 'dsh-coords'
export const inject = ['webServer']

/** 路由前缀（浏览器半段固定按这个前缀取数）。 */
const ROUTE = '/coords/api'

/** 数据根：`DSH_COORDS_DIR` 覆盖，默认 `$DSH_HOME/.dsh-coords`。 */
function dataRoot() {
  const explicit = process.env.DSH_COORDS_DIR
  if (explicit && explicit.trim() !== '') return resolve(explicit)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.dsh-coords')
}

const MAX_BYTES = Number(process.env.DSH_COORDS_MAX_BYTES || 8 * 1024 * 1024)

/* ── 路径 ──────────────────────────────────────────────────────────────── */

/** 断言结果落在根目录内（挡住 `..` 与绝对路径穿越）。 */
function inside(root, target) {
  const wanted = resolve(root)
  const normalized = resolve(target)
  if (normalized !== wanted && !normalized.startsWith(wanted + sep)) throw new Error('名字不合法（越出数据目录）')
  return normalized
}

/** 一套坐标系的文件路径。 */
function setPath(name) {
  return inside(dataRoot(), join(dataRoot(), `${slugOf(name)}.json`))
}

/** 一个用户模板的文件路径。 */
function templatePath(id) {
  const dir = join(dataRoot(), '_templates')
  return inside(dir, join(dir, `${slugOf(id)}.json`))
}

/** 导入内容的落地路径（保留原扩展名，便于日后再读）。 */
function sourcePath(filename) {
  const dir = join(dataRoot(), '_sources')
  const ext = (String(filename ?? '').match(/\.[A-Za-z0-9]{1,8}$/) ?? [''])[0].toLowerCase()
  const stem = slugOf(String(filename ?? '').replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'source')
  return inside(dir, join(dir, `${stem}-${Date.now().toString(36)}${ext}`))
}

/* ── 读写 ──────────────────────────────────────────────────────────────── */

/** 目录下所有 .json（读不动的一律如实回报 broken，不静默丢）。 */
async function listJson(dir) {
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
      out.push({ file: entry.name, data: JSON.parse(raw) })
    } catch {
      out.push({ file: entry.name, data: null, broken: true })
    }
  }
  return out
}

/** 坐标系库（按更新时间倒序）。 */
async function listSets() {
  const rows = await listJson(dataRoot())
  return rows.map(row => {
    if (row.data === null) return { name: row.file.replace(/\.json$/i, ''), broken: true, points: 0, updatedAt: 0 }
    let spec
    try {
      spec = normalizeSpec(row.data, row.file.replace(/\.json$/i, ''))
    } catch {
      return { name: row.file.replace(/\.json$/i, ''), broken: true, points: 0, updatedAt: 0 }
    }
    return {
      name: spec.name,
      mode: spec.mode,
      points: spec.points.length,
      groups: spec.groups.map(group => group.label),
      axes: spec.axes.map(axis => axis.name),
      createdAt: spec.createdAt,
      updatedAt: spec.updatedAt,
      intent: spec.intent,
    }
  }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/** 读一套坐标系（不存在返回 null）。 */
async function readSet(name) {
  try {
    const raw = await readFile(setPath(name), 'utf8')
    return normalizeSpec(JSON.parse(raw), name)
  } catch {
    return null
  }
}

/** 写一套坐标系（规范化后落盘，返回落盘结果）。 */
async function writeSet(input) {
  const spec = normalizeSpec(input, input?.name)
  spec.updatedAt = Date.now()
  const file = setPath(spec.name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(spec, null, 2), 'utf8')
  return spec
}

/** 删一套坐标系。 */
async function deleteSet(name) {
  await rm(setPath(name), { force: true })
}

/** 用户模板（预置模板在共用代数里，这里只读磁盘上的）。 */
async function listUserTemplates() {
  const rows = await listJson(join(dataRoot(), '_templates'))
  const out = []
  for (const row of rows) {
    if (row.data === null) continue
    const template = row.data
    if (typeof template?.id !== 'string' || typeof template?.mode !== 'string') continue
    out.push({
      id: template.id,
      label: String(template.label ?? template.id),
      mode: template.mode === '3d' ? '3d' : '2d',
      desc: String(template.desc ?? ''),
      axes: Array.isArray(template.axes) ? template.axes : [],
      groups: Array.isArray(template.groups) ? template.groups : [],
      quadrants: Array.isArray(template.quadrants) ? template.quadrants : [],
      user: true,
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'zh'))
}

/** 存一个用户模板。 */
async function writeTemplate(input) {
  const source = (input !== null && typeof input === 'object') ? input : {}
  const spec = normalizeSpec(source.spec ?? source, source.label ?? source.id)
  const template = {
    id: slugOf(source.id ?? spec.name),
    label: clip(source.label ?? spec.name, 60),
    mode: spec.mode,
    desc: clip(source.desc ?? spec.intent, 200),
    axes: spec.axes,
    groups: spec.groups,
    quadrants: spec.quadrants,
    savedAt: Date.now(),
  }
  const file = templatePath(template.id)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(template, null, 2), 'utf8')
  return template
}

/** 删一个用户模板。 */
async function deleteTemplate(id) {
  await rm(templatePath(id), { force: true })
}

/* ── xlsx：最小可用的读法（zip + sharedStrings + sheet1）───────────────── */

/** 解一个 zip（只认 stored 与 deflate，够 xlsx 用）。 */
function unzip(buffer) {
  const files = new Map()
  const eocd = (() => {
    const min = Math.max(0, buffer.length - 66000)
    for (let i = buffer.length - 22; i >= min; i -= 1) {
      if (buffer.readUInt32LE(i) === 0x06054b50) return i
    }
    return -1
  })()
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 目录）')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const entryName = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    // 本地头的 extra 长度可能与中央目录不同 —— 必须按本地头重新算数据起点。
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) files.set(entryName, Buffer.from(raw))
    else if (method === 8) files.set(entryName, inflateRawSync(raw))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return files
}

/** XML 文本里的基本实体还原。 */
function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
}

/** 一列字母（A / AB）→ 列序号（0 起）。 */
function columnIndexOf(ref) {
  const letters = String(ref ?? '').match(/^[A-Z]+/)?.[0] ?? 'A'
  let index = 0
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

/** 把 xlsx 的 sheet1 读成表格。 */
function tableFromXlsx(buffer) {
  const files = unzip(buffer)
  const shared = []
  const sharedXml = files.get('xl/sharedStrings.xml')
  if (sharedXml !== undefined) {
    const text = sharedXml.toString('utf8')
    for (const si of text.match(/<si\b[\s\S]*?<\/si>|<si\/>/g) ?? []) {
      const parts = si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []
      shared.push(parts.map(part => unescapeXml(part.replace(/<[^>]+>/g, ''))).join(''))
    }
  }
  const sheetName = files.has('xl/worksheets/sheet1.xml')
    ? 'xl/worksheets/sheet1.xml'
    : Array.from(files.keys()).find(key => /^xl\/worksheets\/sheet\d+\.xml$/.test(key))
  if (sheetName === undefined) throw new Error('xlsx 里找不到工作表')
  const sheet = files.get(sheetName).toString('utf8')
  const matrix = []
  for (const rowXml of sheet.match(/<row\b[\s\S]*?<\/row>|<row\/>/g) ?? []) {
    const rowIndex = Number(rowXml.match(/\br="(\d+)"/)?.[1] ?? (matrix.length + 1)) - 1
    const row = matrix[rowIndex] ?? (matrix[rowIndex] = [])
    for (const cellXml of rowXml.match(/<c\b[\s\S]*?<\/c>|<c\b[^>]*\/>/g) ?? []) {
      const ref = cellXml.match(/\br="([A-Z]+\d+)"/)?.[1]
      const type = cellXml.match(/\bt="([^"]+)"/)?.[1] ?? 'n'
      const index = ref === undefined ? row.length : columnIndexOf(ref)
      let value = ''
      if (type === 'inlineStr') {
        value = unescapeXml((cellXml.match(/<t\b[^>]*>([\s\S]*?)<\/t>/) ?? ['', ''])[1] ?? '')
      } else {
        const raw = (cellXml.match(/<v>([\s\S]*?)<\/v>/) ?? ['', ''])[1] ?? ''
        value = type === 's' ? (shared[Number(raw)] ?? '') : unescapeXml(raw)
      }
      row[index] = value
    }
  }
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0)
  const rows = matrix.map(row => Array.from({ length: width }, (_, index) => String(row?.[index] ?? '')))
  const header = rows.shift() ?? []
  return {
    columns: header.map((name, index) => String(name ?? '').trim() || `列${index + 1}`),
    rows: rows.filter(row => row.some(cell => String(cell).trim() !== '')),
  }
}

/**
 * 任意导入内容 → 表格 + 画像 + 初步坐标系。
 * 认不出来时 table=null（由调用方走「交给会话识别」），**不假装成功**。
 */
function analyze(filename, text, base64) {
  const lower = String(filename ?? '').toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    if (typeof base64 !== 'string' || base64 === '') throw new Error('xlsx 需要以 base64 提交内容')
    const table = tableFromXlsx(Buffer.from(base64, 'base64'))
    return { kind: 'xlsx', table, profile: profileTable(table) }
  }
  const content = String(text ?? '')
  const table = parseTable(content, filename)
  return { kind: table === null ? 'text' : 'table', table, profile: table === null ? null : profileTable(table) }
}

/* ── HTTP 小工具 ───────────────────────────────────────────────────────── */

/** 读请求体（上限由 DSH_COORDS_MAX_BYTES 决定；base64 的 xlsx 也走这里）。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > MAX_BYTES) throw new Error(`请求体过大（上限 ${Math.round(MAX_BYTES / 1024 / 1024)}MB）`)
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

/* ── 事件（内存）──────────────────────────────────────────────────────────
   agent 落盘 / 请求开卡时各推一条，浏览器半段按 rev 轮询取走。刻意不落盘：
   事件只服务"这次运行"，重启后卡片自己拉一次全量即可。 */
const events = { rev: 0, list: [] }

function pushEvent(type, detail) {
  events.rev += 1
  events.list.push({ rev: events.rev, type, at: Date.now(), ...detail })
  if (events.list.length > 50) events.list.splice(0, events.list.length - 50)
}

/* ── DSH 工具 ──────────────────────────────────────────────────────────── */

/** 工具返回值的统一渲染（纯文本 JSON，模型读得动、人看得懂）。 */
const plainOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

/** 精简一套坐标系（工具回给模型时不倾泻整份数据）。 */
function briefSet(spec) {
  return {
    name: spec.name,
    mode: spec.mode,
    axes: spec.axes.map(axis => ({ key: axis.key, name: axis.name, min: axis.min, max: axis.max, unit: axis.unit })),
    groups: spec.groups.map(group => group.label),
    points: spec.points.map(point => ({ name: point.name, values: point.values, group: point.group })),
  }
}

/** 注册六个工具（tools 服务缺失时静默跳过：宿主没挂工具系统也不该报错）。 */
function registerTools(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    ctx.logger?.warn?.('dsh-coords: 没有 tools 服务，coords_* 工具未注册（卡片仍可用）')
    return
  }

  ctx.effect(() => tools.register({
    name: 'coords_open',
    description: '把「坐标系」卡片（better-sidebar 右侧栏）打开并置前 —— agent 落图后用它让图出现在用户眼前。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '可选：顺带切到这套坐标系的名字' } },
    },
    output: plainOutput,
    timeoutMs: 15000,
    async execute(args) {
      pushEvent('open', { name: String(args?.name ?? '') })
      return { ok: true, opened: true, name: String(args?.name ?? '') }
    },
  }))

  ctx.effect(() => tools.register({
    name: 'coords_save',
    description: '把一套坐标系落盘（落完卡片会自己刷新）。2D 给 x/y 两根轴，3D 给 x/y/z 三根轴；'
      + '轴名/范围/单位、分组、点位都由调用方决定。取值会被夹到轴范围内并如实回报被改了什么。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '坐标系名字（同名即覆盖，落成 $DSH_HOME/.dsh-coords/<名字>.json）' },
        mode: { type: 'string', enum: ['2d', '3d'], description: '2d=平面四象限 · 3d=三维坐标系' },
        intent: { type: 'string', description: '一句话说清这套坐标系在回答什么问题' },
        axes: {
          type: 'array',
          description: '轴定义（2D 给 2 根、3D 给 3 根，顺序即 x→y→z）',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', enum: ['x', 'y', 'z'] },
              name: { type: 'string' },
              min: { type: 'number' },
              max: { type: 'number' },
              unit: { type: 'string' },
              desc: { type: 'string' },
            },
          },
        },
        groups: {
          type: 'array',
          description: '分组（赛道/中心/分类），没有就不给',
          items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, color: { type: 'string' } } },
        },
        points: {
          type: 'array',
          description: '数据点',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'object', description: '各轴取值，键为 x/y/z', additionalProperties: true },
              group: { type: 'string', description: '分组 id（要与 groups[].id 对得上）' },
              note: { type: 'string' },
            },
          },
        },
        source_ref: { type: 'string', description: '溯源自哪份内容（文件路径 / 用户原话摘要）' },
      },
      required: ['name', 'mode', 'points'],
    },
    output: plainOutput,
    timeoutMs: 30000,
    async execute(args) {
      const spec = await writeSet({
        name: args?.name,
        mode: args?.mode,
        intent: args?.intent,
        axes: args?.axes,
        groups: args?.groups,
        points: args?.points,
        source: { kind: 'agent', ref: String(args?.source_ref ?? ''), brief: '' },
      })
      pushEvent('save', { name: spec.name })
      const issues = auditSpec(spec)
      return { ok: true, name: spec.name, mode: spec.mode, points: spec.points.length, axes: spec.axes.map(axis => axis.name), issues, file: setPath(spec.name) }
    },
  }))

  ctx.effect(() => tools.register({
    name: 'coords_list',
    description: '列出已经落盘的坐标系（名字/模式/点数/轴名/更新时间）。',
    parameters: { type: 'object', properties: {} },
    output: plainOutput,
    timeoutMs: 15000,
    async execute() {
      return { ok: true, dataRoot: dataRoot(), sets: await listSets() }
    },
  }))

  ctx.effect(() => tools.register({
    name: 'coords_get',
    description: '读一套已落盘的坐标系（轴、分组、全部点）。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '坐标系名字' } },
      required: ['name'],
    },
    output: plainOutput,
    timeoutMs: 15000,
    async execute(args) {
      const spec = await readSet(String(args?.name ?? ''))
      if (spec === null) return { ok: false, error: `没有这套坐标系：${String(args?.name ?? '')}` }
      return { ok: true, set: briefSet(spec) }
    },
  }))

  ctx.effect(() => tools.register({
    name: 'coords_read',
    description: '读一份本机文件（md / txt / json / csv / tsv / xlsx）并给出表格画像与初步的轴/分组匹配 —— '
      + '识别内容建坐标系前先用它取数，比让模型猜列名可靠。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '绝对路径，或相对当前会话工作目录的路径（拿不到会话目录时按宿主进程目录解析，所以绝对路径最稳）' },
        mode: { type: 'string', enum: ['2d', '3d'], description: '按哪种模式给初步匹配（默认 2d）' },
        max_rows: { type: 'number', description: '最多回多少行（默认 60，避免把整张表灌进上下文）' },
      },
      required: ['path'],
    },
    output: plainOutput,
    timeoutMs: 30000,
    async execute(args, exec) {
      // 相对路径按**会话工作目录**解析（工具调用上下文里有就取，没有才退回宿主进程目录）——
      // 实测踩过：直接用 process.cwd() 时，agent 传 "Work/xxx/works.json" 会被解析到
      // 宿主进程的目录下，报"读不到这个文件"，而文件其实就在会话工作区里。
      const raw = String(args?.path ?? '')
      const sessionCwd = exec?.agent?.session?.header?.cwd
        ?? exec?.agent?.cwd
        ?? exec?.cwd
      const base = typeof sessionCwd === 'string' && sessionCwd !== '' ? sessionCwd : process.cwd()
      const file = resolve(base, raw)
      const info = await stat(file).catch(() => null)
      if (info === null || !info.isFile()) {
        return { ok: false, error: `读不到这个文件：${file}（相对路径按 ${base} 解析；传绝对路径最稳）` }
      }
      if (info.size > MAX_BYTES) return { ok: false, error: `文件太大（${Math.round(info.size / 1024 / 1024)}MB，上限 ${Math.round(MAX_BYTES / 1024 / 1024)}MB）` }
      const buffer = await readFile(file)
      const lower = file.toLowerCase()
      const isXlsx = lower.endsWith('.xlsx') || lower.endsWith('.xlsm')
      const analyzed = analyze(file, isXlsx ? '' : buffer.toString('utf8'), isXlsx ? buffer.toString('base64') : undefined)
      const mode = args?.mode === '3d' ? '3d' : '2d'
      const maxRows = Number.isFinite(Number(args?.max_rows)) ? clamp(Number(args.max_rows), 1, 500) : 60
      if (analyzed.table === null) {
        return {
          ok: true,
          path: file,
          kind: 'text',
          note: '不是表格（md/txt 这类自由文本）—— 内容摘录如下，语义判定交给模型',
          excerpt: String(buffer.toString('utf8')).slice(0, 4000),
        }
      }
      const table = analyzed.table
      const spec = specFromTable(table, { mode, name: file.split(/[\\/]/).pop(), ref: file })
      return {
        ok: true,
        path: file,
        kind: 'table',
        columns: analyzed.profile.columns,
        rowCount: table.rows.length,
        rows: table.rows.slice(0, maxRows),
        truncated: table.rows.length > maxRows,
        guessed: { mode, axes: spec.axes, groups: spec.groups.map(group => group.label), samplePoints: spec.points.slice(0, 5) },
      }
    },
  }))

  ctx.effect(() => tools.register({
    name: 'coords_template',
    description: '坐标系模板：list 列出（含预置与用户存的）/ save 把一套轴·分组·象限存成模板 / delete 删掉用户模板。'
      + '模板只存「轴 + 分组 + 象限」，不存点。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'delete'], description: '默认 list' },
        id: { type: 'string', description: 'save/delete 的模板 id' },
        label: { type: 'string', description: 'save 的显示名' },
        spec: { type: 'object', description: 'save 时给一套坐标系（取其轴/分组/象限），或直接用 name 指向已落盘的一套', additionalProperties: true },
        name: { type: 'string', description: 'save 时用已落盘坐标系的名字' },
      },
    },
    output: plainOutput,
    timeoutMs: 15000,
    async execute(args) {
      const action = String(args?.action ?? 'list')
      if (action === 'save') {
        let spec = args?.spec
        if (spec === undefined && typeof args?.name === 'string') spec = await readSet(args.name)
        if (spec === undefined || spec === null) return { ok: false, error: 'save 需要 spec，或一个已落盘的 name' }
        const template = await writeTemplate({ ...spec, id: args?.id ?? args?.label ?? spec.name, label: args?.label ?? spec.name, spec })
        return { ok: true, template }
      }
      if (action === 'delete') {
        if (typeof args?.id !== 'string' || args.id.trim() === '') return { ok: false, error: 'delete 需要 id' }
        await deleteTemplate(args.id)
        return { ok: true, deleted: args.id }
      }
      return { ok: true, templates: [...TEMPLATES.map(item => ({ id: item.id, label: item.label, mode: item.mode, desc: item.desc, user: false })), ...await listUserTemplates()] }
    },
  }))
}

/* ── 路由 ──────────────────────────────────────────────────────────────── */

function handle(ctx, path, method) {
  return async (req, res) => {
    try {
      const params = queryOf(req.url, 'http://127.0.0.1')

      if (path === '/meta' && method === 'GET') {
        let provider = '', model = '', source = 'default', available = false
        try {
          const current = ctx.get?.('agentDefaultModel')?.currentSelection?.()
          if (current?.provider && current?.model) { provider = current.provider; model = current.model; source = 'agent-default-model' }
        } catch { /* 保持空 */ }
        try {
          available = (ctx.get?.('llm')?.listProviders?.() ?? []).length > 0
        } catch { available = false }
        sendJson(res, 200, {
          version: 1,
          dataRoot: dataRoot(),
          modes: MODES,
          axisColors: AXIS_COLORS,
          limits: LIMITS,
          templates: TEMPLATES.map(item => ({ id: item.id, label: item.label, mode: item.mode, desc: item.desc, user: false })),
          ai: { available, provider, model, source },
        })
        return
      }

      if (path === '/sets' && method === 'GET') {
        sendJson(res, 200, { dataRoot: dataRoot(), sets: await listSets() })
        return
      }

      if (path === '/set' && method === 'GET') {
        const spec = await readSet(params.get('name') ?? '')
        if (spec === null) { sendJson(res, 404, { error: '没有这套坐标系' }); return }
        sendJson(res, 200, { spec })
        return
      }

      if (path === '/set' && method === 'POST') {
        const body = await readBody(req)
        const spec = await writeSet(body.spec ?? body)
        pushEvent('save', { name: spec.name })
        sendJson(res, 200, { spec, issues: auditSpec(spec) })
        return
      }

      if (path === '/set' && method === 'DELETE') {
        await deleteSet(params.get('name') ?? '')
        pushEvent('save', { name: params.get('name') ?? '' })
        sendJson(res, 200, { ok: true })
        return
      }

      if (path === '/templates' && method === 'GET') {
        sendJson(res, 200, {
          templates: [
            ...TEMPLATES.map(item => ({ id: item.id, label: item.label, mode: item.mode, desc: item.desc, user: false })),
            ...await listUserTemplates(),
          ],
        })
        return
      }

      if (path === '/template' && method === 'GET') {
        const id = params.get('id') ?? ''
        const preset = TEMPLATES.find(item => item.id === id)
        if (preset !== undefined) { sendJson(res, 200, { template: { ...preset, user: false } }); return }
        const user = (await listUserTemplates()).find(item => item.id === id)
        if (user === undefined) { sendJson(res, 404, { error: '没有这个模板' }); return }
        sendJson(res, 200, { template: user })
        return
      }

      if (path === '/template' && method === 'POST') {
        const body = await readBody(req)
        const template = await writeTemplate(body.template ?? body)
        sendJson(res, 200, { template })
        return
      }

      if (path === '/template' && method === 'DELETE') {
        await deleteTemplate(params.get('id') ?? '')
        sendJson(res, 200, { ok: true })
        return
      }

      if (path === '/parse' && method === 'POST') {
        const body = await readBody(req)
        const analyzed = analyze(body.filename, body.text, body.base64)
        const mode = MODES[body.mode] !== undefined ? body.mode : '2d'
        if (analyzed.table === null) {
          sendJson(res, 200, { kind: analyzed.kind, table: null, note: '不是表格：按自由文本处理，语义交给会话识别' })
          return
        }
        const spec = specFromTable(analyzed.table, { mode, name: body.name ?? String(body.filename ?? '').replace(/\.[^.]+$/, ''), ref: String(body.filename ?? '') })
        sendJson(res, 200, {
          kind: analyzed.kind,
          columns: analyzed.profile.columns,
          rowCount: analyzed.table.rows.length,
          rows: analyzed.table.rows.slice(0, 100),
          spec,
          issues: auditSpec(spec),
        })
        return
      }

      if (path === '/intake' && method === 'POST') {
        const body = await readBody(req)
        const isBinary = typeof body.base64 === 'string' && body.base64 !== ''
        const file = sourcePath(body.filename)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, isBinary ? Buffer.from(body.base64, 'base64') : String(body.text ?? ''), isBinary ? undefined : 'utf8')
        pushEvent('intake', { name: file })
        sendJson(res, 200, { ok: true, path: file, filename: body.filename ?? '', bytes: isBinary ? Buffer.from(body.base64, 'base64').length : Buffer.byteLength(String(body.text ?? ''), 'utf8') })
        return
      }

      if (path === '/events' && method === 'GET') {
        const since = Number(params.get('since') ?? 0)
        const list = events.list.filter(item => item.rev > (Number.isFinite(since) ? since : 0))
        sendJson(res, 200, { rev: events.rev, events: list })
        return
      }

      // 让卡片弹出来（与 agent 工具 coords_open 同一条事件通道）。
      // 用途：脚本 / 别的插件 / 排障时把卡片唤到眼前；只推一条事件，不动数据。
      if (path === '/open' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        pushEvent('open', { name: String(body?.name ?? '') })
        sendJson(res, 200, { ok: true, rev: events.rev })
        return
      }

      if (path === '/sample' && method === 'GET') {
        const mode = MODES[params.get('mode')] !== undefined ? params.get('mode') : '2d'
        sendJson(res, 200, { spec: sampleSpec(mode) })
        return
      }

      sendJson(res, 404, { error: `未知路由 ${method} ${path}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { error: message })
    }
  }
}

/**
 * host 半段入口：注册 `/coords/api/*` 与 coords_* 工具。
 *
 * webServer 路由表按 (kind, path) 判重 —— 同一路径只能注册一个 handler，
 * 由 handler 自己按 req.method 分发；「一个方法一条注册」第二条就会抛
 * duplicate exact route，整个插件树加载失败。
 */
export function apply(ctx) {
  const routes = [
    ['/meta', ['GET']],
    ['/sets', ['GET']],
    ['/set', ['GET', 'POST', 'DELETE']],
    ['/templates', ['GET']],
    ['/template', ['GET', 'POST', 'DELETE']],
    ['/parse', ['POST']],
    ['/intake', ['POST']],
    ['/events', ['GET']],
    ['/open', ['POST']],
    ['/sample', ['GET']],
  ]
  for (const [path, methods] of routes) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}${path}`,
      handler: (req, res) => {
        const method = String(req.method ?? 'GET').toUpperCase()
        if (!methods.includes(method)) {
          sendJson(res, 405, { error: `${path} 不支持 ${method}，可用 ${methods.join(' / ')}` })
          return
        }
        return handle(ctx, path, method)(req, res)
      },
    }), `dsh-coords: ${ROUTE}${path} [${methods.join(' ')}]`)
  }

  registerTools(ctx)

  ctx.logger?.info?.('dsh-coords: routes mounted at %s (data root %s)', ROUTE, dataRoot())
  void mkdir(dataRoot(), { recursive: true }).catch(() => { })
}

/** 供自测直接调用的内部面（不参与运行时加载契约）。 */
export const __internals = {
  ROUTE,
  dataRoot,
  setPath,
  templatePath,
  sourcePath,
  listSets,
  readSet,
  writeSet,
  deleteSet,
  writeTemplate,
  deleteTemplate,
  listUserTemplates,
  analyze,
  tableFromXlsx,
  unzip,
  pushEvent,
  events,
  // 共用代数里被测到的那几个（host 侧同一个作用域，直接透出即可）
  normalizeSpec,
  auditSpec,
  specFromTable,
  guessAxes,
  profileTable,
  parseTable,
  emptySpec,
}
