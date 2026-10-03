/**
 * dsh-coords 共用代数 —— host 与 client **同一份真相源**。
 *
 * 这份文件被 `scripts/build.mjs` 内联进两个产物：
 *   · `lib/index.js`（Node）：做落盘、导入解析、agent 工具的形状校验；
 *   · `lib/client.js`（浏览器）：做 SVG 绘制、投影、行列猜测、模板。
 * 所以这里**只能用纯函数**：不碰 fs、不碰 DOM、不碰任何一方独有的全局。
 *
 * 数据模型（一套坐标系 = 一个 JSON 文件）：
 *
 *   spec = {
 *     version, name, mode: '2d' | '3d', intent,
 *     createdAt, updatedAt,
 *     source: { kind: 'manual' | 'file' | 'agent' | 'sample', ref, brief },
 *     axes:   [ { key:'x'|'y'|'z', name, min, max, unit, desc } ],   // 2D 两根、3D 三根
 *     groups: [ { id, label, color } ],                              // 赛道/中心/分类
 *     quadrants: [ {id,label} ×4 ],                                  // 仅 2D 用
 *     points: [ { id, name, values:{x,y,z}, group, note, extra } ],
 *   }
 *
 * 轴槽位（key）固定为 x / y / z，**轴名/范围/分组都可改** —— 这就是「每根轴
 * 按内容自动匹配、也能手动改」的落点：自动匹配改的只是 name/min/max，槽位不变。
 */

/* ── 常量 ──────────────────────────────────────────────────────────────── */

/** 两种模式。2D 用 x/y，3D 用 x/y/z。 */
export const MODES = {
  '2d': { id: '2d', label: '2D', axisKeys: ['x', 'y'], desc: '平面四象限：一根轴横、一根轴纵' },
  '3d': { id: '3d', label: '3D', axisKeys: ['x', 'y', 'z'], desc: '三维坐标系：范围／成熟度／适用面 这类三轴打分' },
}

/** 轴槽位的固定顺序与显示名（轴的语义名由 spec.axes[].name 决定）。 */
export const AXIS_KEYS = ['x', 'y', 'z']
export const AXIS_LABELS = { x: 'X 轴', y: 'Y 轴', z: 'Z 轴' }

/** 轴颜色：与参考实现（coord3d / 价值坐标）保持同一套语义色。 */
export const AXIS_COLORS = {
  x: { light: '#1f6feb', dark: '#58a6ff' },
  y: { light: '#1a7f37', dark: '#38d878' },
  z: { light: '#bf8700', dark: '#fcb424' },
}

/** 分组调色板（按注册顺序取色；超出后循环）。 */
export const PALETTE = [
  '#4d6bfe', '#d97706', '#1a7f37', '#c2185b', '#7b61ff',
  '#0e7490', '#b45309', '#4d7c0f', '#9f1239', '#475569',
]

/** 默认取值范围（用户没给时用）。 */
export const DEFAULT_RANGE = { min: 0, max: 5 }

/** 结构上限（host 侧按同一份常量裁剪，避免两端口径漂移）。 */
export const LIMITS = {
  maxPoints: 2000,
  maxAxes: 3,
  maxGroups: 24,
  maxNameLen: 120,
  maxNoteLen: 2000,
  maxIntentLen: 400,
}

/** 3D 世界尺度（与参考实现一致：0–5 映射到 16 个单位）。 */
export const WORLD = 16

/** 默认 3D 机位（拖拽旋转时的初值）。 */
export const DEFAULT_VIEW = { yaw: -38 * Math.PI / 180, pitch: 24 * Math.PI / 180, zoom: 1, panX: 0, panY: 0, focal: 38 }

/** 2D 四象限的默认文案（参考「项目价值坐标」）。顺序：左上 / 右上 / 左下 / 右下。 */
export const DEFAULT_QUADRANTS = [
  { id: 'q1', label: 'Ⅰ 金矿区' },
  { id: 'q2', label: 'Ⅱ 战略投入区' },
  { id: 'q3', label: 'Ⅲ 观察区' },
  { id: 'q4', label: 'Ⅳ 死亡区' },
]

/* ── 小工具 ────────────────────────────────────────────────────────────── */

/** 夹取。 */
export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return n < min ? min : (n > max ? max : n)
}

/** 保留 n 位小数（去掉浮点尾巴）。 */
export function round(value, digits = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const factor = 10 ** digits
  return Math.round(n * factor) / factor
}

/** 取整到一个「好看」的边界（刻度用）。 */
export function niceBound(value, up) {
  const n = Number(value)
  if (!Number.isFinite(n)) return up ? 1 : 0
  const step = Math.abs(n) >= 100 ? 10 : (Math.abs(n) >= 10 ? 5 : (Math.abs(n) >= 1 ? 1 : 0.5))
  return up ? Math.ceil(n / step) * step : Math.floor(n / step) * step
}

/** 文本夹断。 */
export function clip(text, max) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

/** 名称 → 安全文件名（去掉分隔符与保留字符，挡住路径穿越）。 */
export function slugOf(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/]/g, '__')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80)
  return (cleaned === '' || cleaned === '.' || cleaned === '..') ? 'coords' : cleaned
}

/** 稳定的色：按分组序取调色板。 */
export function colorOfGroup(groups, groupId) {
  const index = groups.findIndex(group => group.id === groupId)
  return PALETTE[(index < 0 ? 0 : index) % PALETTE.length]
}

/* ── 归一化 ────────────────────────────────────────────────────────────── */

/** 轴槽位合法性。 */
export function axisKeyOf(key) {
  const k = String(key ?? '').toLowerCase()
  return AXIS_KEYS.includes(k) ? k : 'x'
}

/** 把任意输入整成一根合法轴。 */
export function normalizeAxis(input, key) {
  const source = (input !== null && typeof input === 'object') ? input : {}
  const min = Number(source.min)
  const max = Number(source.max)
  const lo = Number.isFinite(min) ? min : DEFAULT_RANGE.min
  const hiRaw = Number.isFinite(max) ? max : DEFAULT_RANGE.max
  // 空范围会让投影除以 0 —— 一律撑开，且保持 lo < hi。
  const hi = hiRaw > lo ? hiRaw : lo + 1
  return {
    key: axisKeyOf(key ?? source.key),
    name: clip(source.name ?? AXIS_LABELS[axisKeyOf(key ?? source.key)], LIMITS.maxNameLen),
    min: round(lo, 3),
    max: round(hi, 3),
    unit: clip(source.unit ?? '', 16),
    desc: clip(source.desc ?? '', 200),
  }
}

/** 该模式的默认轴（名/范围都是占位，等着被内容或用户改）。 */
export function defaultAxes(mode) {
  const keys = (MODES[mode] ?? MODES['2d']).axisKeys
  return keys.map((key, index) => normalizeAxis({
    name: index === 0 ? 'X 维度' : (index === 1 ? 'Y 维度' : 'Z 维度'),
    min: DEFAULT_RANGE.min,
    max: DEFAULT_RANGE.max,
  }, key))
}

/** 把任意输入整成一个合法分组。 */
export function normalizeGroup(input, index) {
  const source = (input !== null && typeof input === 'object') ? input : {}
  const rawId = String(source.id ?? source.label ?? `g${index + 1}`)
  return {
    id: clip(rawId, 40) || `g${index + 1}`,
    label: clip(source.label ?? rawId ?? `分组 ${index + 1}`, 60),
    color: clip(source.color ?? PALETTE[index % PALETTE.length], 24),
  }
}

/** 把任意输入整成一个合法点（values 只保留该模式用得到的槽位）。 */
export function normalizePoint(input, index, axes, groups) {
  const source = (input !== null && typeof input === 'object') ? input : {}
  const valuesIn = (source.values !== null && typeof source.values === 'object') ? source.values : source
  const values = {}
  for (const axis of axes) {
    const raw = Number(valuesIn[axis.key])
    // 缺值落在范围中点：宁可给一个明确的位置，也不要 NaN 消失在画布外。
    values[axis.key] = Number.isFinite(raw) ? clamp(raw, axis.min, axis.max) : round((axis.min + axis.max) / 2, 3)
  }
  const groupId = source.group === undefined || source.group === null || source.group === '' ? '' : String(source.group)
  const group = groups.some(item => item.id === groupId) ? groupId : (groupId === '' ? '' : '')
  return {
    id: clip(source.id ?? `p${index + 1}`, 60) || `p${index + 1}`,
    name: clip(source.name ?? source.label ?? `点 ${index + 1}`, LIMITS.maxNameLen),
    values,
    group,
    note: clip(source.note ?? source.desc ?? '', LIMITS.maxNoteLen),
    extra: (source.extra !== null && typeof source.extra === 'object') ? source.extra : {},
  }
}

/**
 * 归一化一整套坐标系。
 *
 * 这条函数是**唯一入口**：host 落盘前、client 渲染前都过它一遍，所以磁盘上
 * 与画面上的形状永远一致；脏数据（缺轴、越界值、未知分组）在这里收敛，不会
 * 一路渗到投影里变成 NaN。
 */
export function normalizeSpec(input, fallbackName) {
  const source = (input !== null && typeof input === 'object') ? input : {}
  const mode = MODES[source.mode] !== undefined ? source.mode : '2d'
  const keys = MODES[mode].axisKeys
  const axesIn = Array.isArray(source.axes) ? source.axes : []
  const axes = keys.map((key, index) => {
    const found = axesIn.find(axis => axisKeyOf(axis?.key) === key) ?? axesIn[index]
    return normalizeAxis(found, key)
  })
  const groupsIn = Array.isArray(source.groups) ? source.groups : []
  const groups = groupsIn.slice(0, LIMITS.maxGroups).map((group, index) => normalizeGroup(group, index))
  // 点里引用了不存在分组时，自动补一个分组，而不是把它的颜色悄悄丢掉。
  const pointsIn = Array.isArray(source.points) ? source.points : []
  for (const raw of pointsIn) {
    const id = raw?.group
    if (id === undefined || id === null || id === '') continue
    if (!groups.some(group => group.id === String(id))) groups.push(normalizeGroup({ id: String(id) }, groups.length))
  }
  const quadrantsIn = Array.isArray(source.quadrants) ? source.quadrants : []
  const quadrants = DEFAULT_QUADRANTS.map((fallback, index) => {
    const found = quadrantsIn[index]
    return { id: fallback.id, label: clip(found?.label ?? fallback.label, 40) }
  })
  const now = Date.now()
  const sourceMeta = (source.source !== null && typeof source.source === 'object') ? source.source : {}
  return {
    version: 1,
    name: clip(source.name ?? fallbackName ?? '未命名坐标系', LIMITS.maxNameLen) || '未命名坐标系',
    mode,
    intent: clip(source.intent ?? '', LIMITS.maxIntentLen),
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : now,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : now,
    source: {
      kind: ['manual', 'file', 'agent', 'sample'].includes(sourceMeta.kind) ? sourceMeta.kind : 'manual',
      ref: clip(sourceMeta.ref ?? '', 400),
      brief: clip(sourceMeta.brief ?? '', 2000),
    },
    axes,
    groups,
    quadrants,
    points: pointsIn.slice(0, LIMITS.maxPoints).map((point, index) => normalizePoint(point, index, axes, groups)),
  }
}

/** 空坐标系（新开一套时用）。 */
export function emptySpec(mode, name) {
  const spec = normalizeSpec({ mode, name, axes: defaultAxes(mode) }, name)
  return spec
}

/* ── 取值 / 刻度 / 象限 ────────────────────────────────────────────────── */

/** 轴上的取值域跨度（永远 > 0）。 */
export function spanOf(axis) {
  const span = Number(axis.max) - Number(axis.min)
  return span > 0 ? span : 1
}

/** 把某根轴上的原值映射到 0–1。 */
export function ratioOf(axis, value) {
  return clamp((Number(value) - axis.min) / spanOf(axis), 0, 1)
}

/** 刻度值（默认 0..max 每 1 一格，范围大时自动放宽）。 */
export function axisTicks(axis, target = 5) {
  const span = spanOf(axis)
  const rawStep = span / Math.max(2, target)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const step = (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude
  const out = []
  const start = Math.ceil(axis.min / step) * step
  for (let value = start; value <= axis.max + 1e-9; value += step) {
    out.push(round(value, step < 1 ? 2 : 1))
  }
  if (out.length === 0) out.push(axis.min, axis.max)
  return out
}

/** 数值显示（轴带单位时拼上单位）。 */
export function formatValue(axis, value) {
  if (value === undefined || value === null || value === '') return '—'
  const n = Number(value)
  const text = Number.isInteger(n) ? String(n) : String(round(n, 2))
  return axis !== undefined && axis.unit !== '' ? `${text}${axis.unit}` : text
}

/** 2D 象限：以两轴中点为界，返回 {id, label, index}。 */
export function quadrantOf(point, spec) {
  const xAxis = spec.axes.find(axis => axis.key === 'x') ?? spec.axes[0]
  const yAxis = spec.axes.find(axis => axis.key === 'y') ?? spec.axes[1]
  const high = ratioOf(xAxis, point.values[xAxis.key]) >= 0.5
  const top = ratioOf(yAxis, point.values[yAxis.key]) >= 0.5
  const index = top ? (high ? 1 : 0) : (high ? 3 : 2)
  const quad = spec.quadrants[index] ?? DEFAULT_QUADRANTS[index]
  return { id: quad.id, label: quad.label, index }
}

/* ── 投影 ──────────────────────────────────────────────────────────────── */

/** 轴值 → 世界坐标（把取值域映射到 ±WORLD/2）。 */
export function worldOf(value, axis) {
  return (ratioOf(axis, value) - 0.5) * WORLD
}

/** 2D：轴值 → 画布比例坐标（0–1，y 已翻成屏幕方向）。 */
export function project2d(point, spec) {
  const xAxis = spec.axes.find(axis => axis.key === 'x') ?? spec.axes[0]
  const yAxis = spec.axes.find(axis => axis.key === 'y') ?? spec.axes[1]
  return { x: ratioOf(xAxis, point.values[xAxis.key]), y: 1 - ratioOf(yAxis, point.values[yAxis.key]) }
}

/** 绕 Y 轴（yaw）再绕 X 轴（pitch）旋转一个世界点。 */
export function rotate3d(point, view) {
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw)
  const cx = Math.cos(view.pitch), sx = Math.sin(view.pitch)
  const x1 = point.x * cy + point.z * sy
  const z1 = -point.x * sy + point.z * cy
  const y2 = point.y * cx - z1 * sx
  const z2 = point.y * sx + z1 * cx
  return { x: x1, y: y2, z: z2 }
}

/**
 * 3D：世界点 → 视图坐标（未乘缩放/未平移）。
 * 带一点透视（focal 越大越接近正交），让远近有层次但不变形太狠。
 */
export function viewOf(worldPoint, view) {
  const rotated = rotate3d(worldPoint, view)
  const k = view.focal / Math.max(4, view.focal - rotated.z)
  return { x: rotated.x * k, y: rotated.y * k, depth: rotated.z, scale: k }
}

/** 一个点的世界坐标（三轴或两轴）。 */
export function worldPointOf(point, spec) {
  const out = { x: 0, y: 0, z: 0 }
  for (const axis of spec.axes) {
    out[axis.key] = worldOf(point.values[axis.key], axis)
  }
  // 2D 时把 y 轴当作屏幕的纵向：用 y 槽，z 恒 0。
  if (spec.mode === '2d') out.z = 0
  return out
}

/** 3D 投影：把世界点按当前机位投到 [-1,1] 的归一化画布坐标。 */
export function project3d(point, spec, view) {
  const viewPoint = viewOf(worldPointOf(point, spec), view)
  const half = WORLD / 2
  return {
    x: (viewPoint.x / half) * view.zoom + view.panX,
    y: -((viewPoint.y / half) * view.zoom) + view.panY,
    depth: viewPoint.depth,
  }
}

/** 3D 里的一个世界坐标点（不是数据点，是盒子角点）投到归一化画布。 */
export function projectWorld(worldPoint, view, halfWorld = WORLD / 2) {
  const viewPoint = viewOf(worldPoint, view)
  return {
    x: (viewPoint.x / halfWorld) * view.zoom + view.panX,
    y: -((viewPoint.y / halfWorld) * view.zoom) + view.panY,
    depth: viewPoint.depth,
  }
}

/**
 * 选中一个 3D 点后要画的坐标盒（与参考 coord3d 同构）：
 *   · 三条阶梯：从各轴锚点出发，先在坐标面内走到面拐点，再垂直折到点；
 *   · 三条闭合棱：把三段阶梯首尾相接，让盒子闭起来；
 * 全部返回**世界坐标**，由调用方投影后画红色虚线。
 */
export function guideBoxes(point, spec) {
  const p = worldPointOf(point, spec)
  const xAxis = spec.axes.find(axis => axis.key === 'x')
  const yAxis = spec.axes.find(axis => axis.key === 'y')
  const zAxis = spec.axes.find(axis => axis.key === 'z')
  const ox = worldOf(xAxis.min, xAxis)
  const oy = worldOf(yAxis.min, yAxis)
  const oz = zAxis === undefined ? 0 : worldOf(zAxis.min, zAxis)
  // 轴锚点（各轴上的落点）
  const Xa = { x: p.x, y: oy, z: oz }
  const Ya = { x: ox, y: p.y, z: oz }
  const Za = { x: ox, y: oy, z: p.z }
  // 面拐点
  const A = { x: p.x, y: p.y, z: oz }   // X-Y 面
  const B = { x: p.x, y: oy, z: p.z }   // X-Z 面
  const C = { x: ox, y: p.y, z: p.z }   // Y-Z 面
  return {
    stairs: [
      { axis: 'x', points: [Xa, B, p] },
      { axis: 'z', points: [Za, C, p] },
      { axis: 'y', points: [Ya, A, p] },
    ],
    closers: [
      { points: [A, Xa] },
      { points: [B, Za] },
      { points: [C, Ya] },
    ],
    anchors: { Xa, Ya, Za, A, B, C },
    origin: { x: ox, y: oy, z: oz },
  }
}

/** 3D 坐标系的三条轴（从原点出发到各轴最大值）。 */
export function axisRails(spec) {
  const rails = []
  for (const axis of spec.axes) {
    const origin = {}
    const end = {}
    for (const other of spec.axes) {
      origin[other.key] = other.min
      end[other.key] = other.key === axis.key ? axis.max : other.min
    }
    // 世界坐标：轴的 min 映射到 -WORLD/2（与 worldOf 保持一致）
    for (const key of AXIS_KEYS) {
      if (origin[key] === undefined) origin[key] = 0
      if (end[key] === undefined) end[key] = 0
    }
    rails.push({
      axis: axis.key,
      from: worldPointOfRaw(origin, spec),
      to: worldPointOfRaw(end, spec),
    })
  }
  return rails
}

/** 原始值对象（{x,y,z} 原值）→ 世界坐标。 */
export function worldPointOfRaw(values, spec) {
  const out = { x: 0, y: 0, z: 0 }
  for (const axis of spec.axes) out[axis.key] = worldOf(values[axis.key], axis)
  if (spec.mode === '2d') out.z = 0
  return out
}

/* ── 体检 ──────────────────────────────────────────────────────────────── */

/** 一套坐标系的体检结论（如实列出，不粉饰）。 */
export function auditSpec(spec) {
  const issues = []
  if (spec.points.length === 0) issues.push({ level: 'warn', text: '一个点都没有：先导入内容或手动加点' })
  const unnamed = spec.points.filter(point => /^点 \d+$/.test(point.name)).length
  if (unnamed > 0) issues.push({ level: 'info', text: `${unnamed} 个点还是默认名（"点 N"），建议改成业务名` })
  const noGroup = spec.points.filter(point => point.group === '').length
  if (noGroup > 0) issues.push({ level: 'info', text: `${noGroup} 个点没有分组` })
  for (const axis of spec.axes) {
    if (axis.name === '' || /维度$/.test(axis.name)) issues.push({ level: 'warn', text: `${AXIS_LABELS[axis.key]}还是占位名「${axis.name}」` })
    if (spanOf(axis) <= 0) issues.push({ level: 'warn', text: `${AXIS_LABELS[axis.key]}取值范围无效` })
  }
  const flat = spec.axes.filter(axis => {
    const values = spec.points.map(point => point.values[axis.key])
    return values.length > 1 && new Set(values).size === 1
  })
  if (flat.length === spec.axes.length && spec.points.length > 1) {
    issues.push({ level: 'warn', text: '所有点在同一处：内容里可能没识别出可比较的数值' })
  }
  return issues
}

/* ── 表格解析（json / csv / tsv）───────────────────────────────────────── */

/** 猜一列是不是数值列。 */
function numericRatio(values) {
  if (values.length === 0) return 0
  let hits = 0
  for (const value of values) {
    const text = String(value ?? '').trim().replace(/,/g, '')
    if (text === '') continue
    if (Number.isFinite(Number(text))) hits += 1
  }
  return hits / values.length
}

/**
 * 把 `[{…}, {…}]` 形式的行整成表格 `{ columns, rows }`。
 * 列顺序按首次出现顺序，缺的补空串 —— 不丢列也不凭空造列。
 */
export function tableFromRows(rows) {
  const columns = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  }
  const matrix = rows.map(row => columns.map(column => {
    const value = (row !== null && typeof row === 'object') ? row[column] : undefined
    if (value === undefined || value === null) return ''
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }))
  return { columns, rows: matrix }
}

/** 解析一行 CSV（支持双引号包裹、引号内逗号与转义双引号）。 */
export function splitCsvLine(line, delimiter) {
  const out = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1 } else { quoted = false }
      } else field += char
    } else if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      out.push(field); field = ''
    } else field += char
  }
  out.push(field)
  return out
}

/** 解析 CSV / TSV 文本（第一行当表头）。 */
export function tableFromDelimited(text, delimiter) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return { columns: [], rows: [] }
  const delimiterOf = delimiter ?? (lines[0].split('\t').length > lines[0].split(',').length ? '\t' : ',')
  const header = splitCsvLine(lines[0], delimiterOf).map((name, index) => name.trim() || `列${index + 1}`)
  const rows = lines.slice(1).map(line => {
    const cells = splitCsvLine(line, delimiterOf)
    return header.map((_, index) => (cells[index] ?? '').trim())
  })
  return { columns: header, rows }
}

/**
 * 任意文本 → 表格。JSON 支持三种形状：对象数组 / 单个对象（取数组字段）/
 * 二维数组。认不出来时返回 null（由调用方走「交给会话识别」）。
 */
export function parseTable(text, filename) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const lower = String(filename ?? '').toLowerCase()
  if (lower.endsWith('.json') || raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw)
      if (Array.isArray(data)) {
        if (data.length > 0 && Array.isArray(data[0])) {
          const header = data[0].map((name, index) => String(name ?? `列${index + 1}`))
          return { columns: header, rows: data.slice(1).map(row => header.map((_, index) => String(row?.[index] ?? ''))) }
        }
        return tableFromRows(data)
      }
      if (data !== null && typeof data === 'object') {
        for (const value of Object.values(data)) {
          if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') return tableFromRows(value)
        }
        return { columns: Object.keys(data), rows: [Object.values(data).map(value => (typeof value === 'object' ? JSON.stringify(value) : String(value)))] }
      }
    } catch {
      // 不是 JSON，继续按分隔符试
    }
  }
  if (lower.endsWith('.csv')) return tableFromDelimited(raw, ',')
  if (lower.endsWith('.tsv')) return tableFromDelimited(raw, '\t')
  if (/[,\t]/.test(raw.split('\n')[0] ?? '') && raw.split('\n').length > 1) return tableFromDelimited(raw, undefined)
  // Markdown 表格（|---| 分隔线）
  const mdLines = raw.split('\n').filter(line => line.trim() !== '')
  if (mdLines.length >= 2 && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(mdLines[1])) {
    const cells = line => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim())
    const header = cells(mdLines[0])
    return { columns: header, rows: mdLines.slice(2).map(cells) }
  }
  return null
}

/**
 * 表格画像：每列的类型、取值范围、去重数、样例值。
 * 「轴按内容自动匹配」的依据就是它。
 */
export function profileTable(table) {
  const columns = table.columns.map((name, index) => {
    const values = table.rows.map(row => row[index] ?? '').filter(value => String(value).trim() !== '')
    const numeric = values.map(value => Number(String(value).replace(/,/g, ''))).filter(value => Number.isFinite(value))
    const distinct = Array.from(new Set(values.map(value => String(value))))
    return {
      name,
      index,
      numeric: numericRatio(values) >= 0.8 && numeric.length > 0,
      count: values.length,
      min: numeric.length > 0 ? Math.min(...numeric) : null,
      max: numeric.length > 0 ? Math.max(...numeric) : null,
      distinct: distinct.length,
      /** 全部去重值（封顶 60，够分组用；别把几万行灌进内存）。 */
      values: distinct.slice(0, 60),
      samples: distinct.slice(0, 4),
    }
  })
  return { columns, rowCount: table.rows.length }
}

/**
 * 按表格画像猜轴、猜分组、猜点名（**自动匹配**的落点）。
 *
 * 规则（简单、可解释、可手动改）：
 *   · 轴 = 打分最高的前 N 个数值列（N = 该模式的轴数），name 取列名，min/max 取实际范围
 *     （向「好看」的边界对齐，别给出 0.83–4.17 这种轴）；
 *   · 分组 = 第一个非数值列，且去重数 2–12（太多就不是分类而是自由文本）；
 *   · 点名 = 第一个非数值列（不是分组列时）或第一列。
 *
 * 数值列要打分，不能"取前 N 个数值列"就完事（踩过：整张表第一列常是「编号」，
 * 它也是数值 —— 导入 coord3d 的 works.json 时 x 轴一度变成了 no）。
 * 打分见 {@link numericAxisScore}；挑完再**按原始列序**排，轴序仍跟表一致。
 */
export function numericAxisScore(column) {
  const isInteger = column.values.every(value => Number.isInteger(Number(String(value).replace(/,/g, ''))))
  const idLike = isInteger && column.count > 3 && column.distinct === column.count
  if (idLike) return 0                 // 编号/ID：整数且全不重复
  return isInteger ? 1 : 2             // 整数有重复（档位） < 带小数（真正的度量）
}

export function guessAxes(table, mode) {
  const profile = profileTable(table)
  const keys = (MODES[mode] ?? MODES['2d']).axisKeys
  const axisColumns = profile.columns
    .filter(column => column.numeric)
    .slice()
    .sort((a, b) => (numericAxisScore(b) - numericAxisScore(a)) || (a.index - b.index))
    .slice(0, keys.length)
    .sort((a, b) => a.index - b.index)
  const text = profile.columns.filter(column => !column.numeric)
  const axes = keys.map((key, index) => {
    const column = axisColumns[index]
    if (column === undefined) {
      return normalizeAxis({ name: text[index]?.name ?? (index === 0 ? 'X 维度' : index === 1 ? 'Y 维度' : 'Z 维度') }, key)
    }
    const min = niceBound(column.min, false)
    const maxRaw = niceBound(column.max, true)
    return normalizeAxis({ name: column.name, min, max: maxRaw > min ? maxRaw : min + 1 }, key)
  })
  // 点名 = 去重数最多的文本列（业务对象名通常每行都不同）；
  // 分组 = 剩下那个文本列里，去重数 2–12 且**最少**的（分类列取值少而重复）。
  // 两条都用「先定 name 再定 group」，避免分组列被误当成点名列（踩过：
  // 「场景,业务价值,实施难度,赛道」里点名取成了 A/B）。
  const nameColumn = text.slice().sort((a, b) => b.distinct - a.distinct)[0] ?? profile.columns[0] ?? null
  const groupColumn = text
    .filter(column => column !== nameColumn && column.distinct >= 2 && column.distinct <= 12)
    .sort((a, b) => a.distinct - b.distinct)[0] ?? null
  const groups = groupColumn === null ? [] : groupColumn.values.slice(0, LIMITS.maxGroups).map((label, index) => normalizeGroup({ id: label, label }, index))
  return { axes, axisColumns, groups, groupColumn, nameColumn, profile }
}

/** 表格 + 猜测结果 → 一套坐标系（导入后立刻能画）。 */
export function specFromTable(table, opts) {
  const options = opts ?? {}
  const mode = MODES[options.mode] !== undefined ? options.mode : '2d'
  const guess = guessAxes(table, mode)
  const keys = MODES[mode].axisKeys
  const points = table.rows.map((row, index) => {
    const values = {}
    keys.forEach((key, axisIndex) => {
      // 必须用**猜轴时选中的那几列**取值（不是"前 N 个数值列"），否则轴名与实际数值错位
      const column = guess.axisColumns[axisIndex]
      const raw = column === undefined ? '' : row[column.index]
      values[key] = raw === '' || raw === undefined ? null : Number(String(raw).replace(/,/g, ''))
    })
    const name = guess.nameColumn === null ? `点 ${index + 1}` : String(row[guess.nameColumn.index] ?? '').trim() || `点 ${index + 1}`
    const group = guess.groupColumn === null ? '' : String(row[guess.groupColumn.index] ?? '').trim()
    return { id: `p${index + 1}`, name, values, group, note: '', extra: {} }
  })
  return normalizeSpec({
    mode,
    name: options.name ?? '导入的坐标系',
    intent: options.intent ?? '',
    source: { kind: options.kind ?? 'file', ref: options.ref ?? '', brief: options.brief ?? '' },
    axes: guess.axes,
    groups: guess.groups,
    quadrants: options.quadrants,
    points,
  }, options.name)
}

/* ── 模板 ──────────────────────────────────────────────────────────────── */

/**
 * 预置模板：两套照参考页的语义（价值×难度四象限 / 范围×成熟度×适用面），
 * 用户存下来的模板与它们同构，列表里合并展示。
 */
export const TEMPLATES = [
  {
    id: 'value-difficulty',
    label: '价值 × 难度（2D 四象限）',
    mode: '2d',
    desc: '横轴难度、纵轴价值，四象限＝金矿区／战略投入区／观察区／死亡区',
    axes: [
      { key: 'x', name: '实施难度', min: 0, max: 5, unit: '', desc: '越高越难（数据就绪／跨系统）' },
      { key: 'y', name: '业务价值', min: 0, max: 5, unit: '', desc: '越高越值钱' },
    ],
    groups: [
      { id: 'A', label: 'A · Skill 赛道' },
      { id: 'B', label: 'B · 数字员工赛道' },
    ],
    quadrants: [
      { id: 'q1', label: 'Ⅰ 金矿区（高价值低难度）' },
      { id: 'q2', label: 'Ⅱ 战略投入区（高价值高难度）' },
      { id: 'q3', label: 'Ⅲ 观察区（低价值低难度）' },
      { id: 'q4', label: 'Ⅳ 死亡区（低价值高难度）' },
    ],
  },
  {
    id: 'scene-coord3d',
    label: '范围 × 成熟度 × 适用面（3D）',
    mode: '3d',
    desc: '三轴统一 0–5 取值域，点按赛道着色',
    axes: [
      { key: 'x', name: '范围 S', min: 0, max: 5, unit: '', desc: '跨系统／跨角色／场景闭环' },
      { key: 'y', name: '成熟度 M', min: 0, max: 5, unit: '', desc: '待澄清 → 已投产' },
      { key: 'z', name: '适用面 R', min: 0, max: 5, unit: '', desc: '仅本人 → 跨中心' },
    ],
    groups: [
      { id: 'A', label: 'A · Skill 赛道' },
      { id: 'B', label: 'B · 数字员工赛道' },
    ],
  },
  {
    id: 'priority-impact',
    label: '影响 × 可行性（2D 四象限）',
    mode: '2d',
    desc: '通用优先级矩阵：先做高影响高可行',
    axes: [
      { key: 'x', name: '可行性', min: 0, max: 5, unit: '', desc: '资源/数据/时间是否就位' },
      { key: 'y', name: '影响面', min: 0, max: 5, unit: '', desc: '影响多少人、多少钱、多少环节' },
    ],
    groups: [],
    quadrants: [
      { id: 'q1', label: 'Ⅰ 马上做' },
      { id: 'q2', label: 'Ⅱ 立项做' },
      { id: 'q3', label: 'Ⅲ 顺手做' },
      { id: 'q4', label: 'Ⅳ 先别做' },
    ],
  },
]

/** 模板 → 一套空坐标系（只取轴/分组/象限，不带点）。 */
export function specFromTemplate(template, name) {
  const source = typeof template === 'string' ? TEMPLATES.find(item => item.id === template) : template
  if (source === undefined || source === null) return emptySpec('2d', name)
  return normalizeSpec({
    mode: source.mode,
    name: name ?? source.label,
    intent: source.desc ?? '',
    source: { kind: 'manual', ref: `模板：${source.id}`, brief: '' },
    axes: source.axes,
    groups: source.groups,
    quadrants: source.quadrants,
    points: [],
  }, name)
}

/* ── 导出 ──────────────────────────────────────────────────────────────── */

/** 坐标系 → Markdown（点表 + 轴说明）。 */
export function toMarkdown(spec) {
  const heads = spec.axes.map(axis => `${axis.name}（${axis.min}–${axis.max}${axis.unit}）`)
  const lines = [`# ${spec.name}`, '']
  if (spec.intent !== '') lines.push(spec.intent, '')
  lines.push(`模式：${MODES[spec.mode].label}　点数：${spec.points.length}`, '')
  lines.push(`| 点 | ${heads.join(' | ')} | 分组 | 说明 |`)
  lines.push(`|---|${spec.axes.map(() => '---').join('|')}|---|---|`)
  for (const point of spec.points) {
    const cells = spec.axes.map(axis => formatValue(axis, point.values[axis.key]))
    lines.push(`| ${point.name} | ${cells.join(' | ')} | ${point.group || '—'} | ${point.note.replace(/\n/g, ' ')} |`)
  }
  return lines.join('\n')
}

/** 坐标系 → CSV。 */
export function toCsv(spec) {
  const head = ['点', ...spec.axes.map(axis => axis.name), '分组', '说明']
  const rows = spec.points.map(point => [
    point.name,
    ...spec.axes.map(axis => String(point.values[axis.key] ?? '')),
    point.group,
    point.note.replace(/\n/g, ' '),
  ])
  return [head, ...rows].map(row => row.map(cell => (/[",\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell))).join(',')).join('\n')
}

/** 示例数据（点「示例」时装载；不自动出现，免得用户以为是自己导进来的）。 */
export function sampleSpec(mode) {
  const spec = specFromTemplate(mode === '3d' ? 'scene-coord3d' : 'value-difficulty', mode === '3d' ? '示例 · 场景坐标系' : '示例 · 项目价值坐标')
  const rows2d = [
    ['自动核价', 2.0, 4.6, 'A'],
    ['订单跟踪', 3.6, 4.2, 'B'],
    ['BOM 翻译', 1.4, 3.2, 'A'],
    ['工价导入', 2.6, 3.8, 'A'],
    ['质量预警', 3.2, 4.4, 'B'],
    ['竞品情报', 1.8, 2.8, 'A'],
    ['招聘管道', 4.2, 3.4, 'B'],
    ['费用汇总', 2.2, 2.6, 'A'],
  ]
  const rows3d = [
    ['自动核价', 3.4, 4.2, 4.0, 'A'],
    ['订单跟踪', 4.6, 3.6, 3.2, 'B'],
    ['BOM 翻译', 1.6, 4.0, 4.6, 'A'],
    ['工价导入', 2.4, 3.6, 3.0, 'A'],
    ['质量预警', 3.8, 2.8, 2.6, 'B'],
    ['竞品情报', 2.2, 3.0, 4.2, 'A'],
    ['招聘管道', 3.0, 2.4, 3.4, 'B'],
    ['费用汇总', 2.8, 3.2, 2.2, 'A'],
  ]
  if (mode === '3d') {
    spec.points = rows3d.map((row, index) => normalizePoint({ id: `p${index + 1}`, name: row[0], values: { x: row[1], y: row[2], z: row[3] }, group: row[4] }, index, spec.axes, spec.groups))
  } else {
    spec.points = rows2d.map((row, index) => normalizePoint({ id: `p${index + 1}`, name: row[0], values: { x: row[1], y: row[2] }, group: row[3] }, index, spec.axes, spec.groups))
  }
  spec.source = { kind: 'sample', ref: '', brief: '' }
  return normalizeSpec(spec, spec.name)
}

/* ── 给 agent 看的提示词（host 侧工具用；放在共用文件的理由：client 也要能
      把同一段话塞进会话输入框，两边不能各写一份）────────────────────────── */

/** 组装「让会话里的 agent 识别这份内容」的提示词。 */
export function buildRecognizePrompt(options) {
  const opts = options ?? {}
  const mode = MODES[opts.mode] !== undefined ? opts.mode : '2d'
  const keys = MODES[mode].axisKeys
  const path = String(opts.path ?? '')
  return [
    `用「坐标系」卡片识别这份内容，落成 ${MODES[mode].label} 坐标系：${path}`,
    '',
    `要求：${keys.map(key => AXIS_LABELS[key]).join(' / ')} 三件事各自定出来——`,
    '1. 每根轴的**名称**（业务语义，别用 X/Y/Z）、**取值范围**（含单位）、**说明**；',
    '2. **分组**（赛道/中心/分类，没有就不分组）；',
    '3. 每个点的**名称**与各轴取值（取值必须落在轴范围内）。',
    '',
    `做完调 coords_save（mode=${mode}）落盘，卡片里就会出图；名字先给一个能认出来的。`,
  ].join('\n')
}

/** 从模型输出里抠出 JSON（容忍代码围栏与前后废话）。 */
export function extractJson(text) {
  let raw = String(text ?? '').trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence !== null) raw = fence[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('没有找到 JSON')
  return JSON.parse(raw.slice(start, end + 1))
}
