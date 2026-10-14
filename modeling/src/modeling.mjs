/**
 * dsh-modeling — 统一建模模型（host 与 client 共用的唯一真相源）。
 *
 * ── 为什么要"向上抽象一层" ────────────────────────────────────────────────
 * 参考实现（dsh-platform 建模中心）把建模分成数据建模（概念/逻辑/物理）与
 * 业务建模（业务流程/接口拓扑）两套并列的画布。两者其实是**同一个代数**：
 *
 *   模型 = 节点集 × 连边集
 *   节点 = (抽象层 level, 类型 type, 名称, 属性 attrs)
 *   连边 = (类型 type, 起点, 终点, 标签)
 *   布局 = f(level)                      —— 抽象层即列
 *
 * 差别只有两处，且都不是结构差别：
 *   ① 词汇（这个领域中 L0..L4 分别叫什么、有哪些节点类型）
 *   ② 朝向（declarative「是什么」 vs procedural「怎么走」）
 *
 * 所以这里只保留**一套引擎**，把差别全部下沉为数据：
 *
 *   AXIS        5 条抽象层 —— 定位 → 语义 → 结构 → 实现 → 产出
 *               （参考实现的"概念/逻辑/物理"是它 L1/L2/L3 的一次取用）
 *   PROFILES    领域档案 = 给这 5 层换词汇 + 声明本领域节点类型
 *   节点类型    声明自己的朝向；declarative 节点回答"是什么"，
 *               procedural 节点回答"怎么走"，因此**流程与结构可以在同一张图上**，
 *               无需为流程另开一套画布
 *   ATTR_FIELDS 属性facet 全集（原则/边界/判据/步骤/输入/产出/交付物/检查点…），
 *               任何节点都能挂任意 facet —— 方法论与架构共享同一张表
 *
 * 由此：数据建模 = 系统档案 × 结构图；接口拓扑 = 系统档案 × 声明朝向；
 * 业务流程 = 业务档案 × 过程朝向；方法论 = 方法论档案 × 全部。一套引擎全覆盖。
 *
 * 本文件是纯数据 + 纯函数，**不得 import 任何东西**：host 半段与 client 半段
 * 都直接依赖它，且客户端的 bundle 里它是被内联进 client.js 的那一份。
 */

/**
 * 抽象层轴（所有档案共用，5 条）。`name` 是轴上的通用语义名，档案只负责换本地词汇。
 * @type {ReadonlyArray<{level:number, id:string, name:string, question:string, desc:string}>}
 */
export const AXIS = [
  { level: 0, id: 'position', name: '定位', question: '在什么上下文里，边界在哪', desc: '议题 / 场景 / 范围：先划清"这次要解决什么、不解决什么"' },
  { level: 1, id: 'semantic', name: '语义', question: '什么是不变的原则', desc: '原理 / 概念：回答"是什么、为什么"，不随实现变化的部分' },
  { level: 2, id: 'structure', name: '结构', question: '怎么被组织起来', desc: '模块 / 阶段：谁和谁有关系、怎么分块、按什么顺序' },
  { level: 3, id: 'realize', name: '实现', question: '具体怎么做 / 怎么落', desc: '规程 / 实现：可执行的步骤、活动、接口、表、代码' },
  { level: 4, id: 'product', name: '产出', question: '怎么算做出来了', desc: '产物 / 运行：交付物、模板、度量与判据——验收就看这一层' },
]

/** 抽象层数（= AXIS.length，独立导出便于校验）。 */
export const LEVEL_COUNT = AXIS.length

/**
 * 朝向：节点回答的问题。
 *  - declarative 声明式：回答"是什么"（概念、模块、服务、表、原则、角色）
 *  - procedural  过程式：回答"怎么走"（阶段、活动、决策、判据、交付物）
 * 一张图里两种朝向可以共存 —— 这正是流程与结构不需要两套画布的原因。
 */
export const ORIENTATIONS = {
  declarative: { id: 'declarative', label: '声明式', question: '是什么' },
  procedural: { id: 'procedural', label: '过程式', question: '怎么走' },
}

/**
 * 属性 facet 全集。节点可挂任意若干项；表单按 type 渲染（text 单行 / list 逐行）。
 * @type {Readonly<Record<string,{id:string,label:string,type:'text'|'list',hint:string}>>}
 */
export const ATTR_FIELDS = {
  premise: { id: 'premise', label: '前提', type: 'text', hint: '必须先成立的条件' },
  principle: { id: 'principle', label: '原则', type: 'text', hint: '不变的约束（invariant）' },
  boundary: { id: 'boundary', label: '边界', type: 'text', hint: '明确不做什么' },
  criterion: { id: 'criterion', label: '判据', type: 'text', hint: '用来判定"做到了"的可判条件' },
  steps: { id: 'steps', label: '步骤', type: 'list', hint: '可执行的动作序列' },
  inputs: { id: 'inputs', label: '输入', type: 'list', hint: '开始前必须拿到什么' },
  outputs: { id: 'outputs', label: '产出', type: 'list', hint: '做完产生什么' },
  role: { id: 'role', label: '角色', type: 'text', hint: '谁负责 / 谁参与' },
  deliverable: { id: 'deliverable', label: '交付物', type: 'text', hint: '交付物的具体形态' },
  template: { id: 'template', label: '模板', type: 'list', hint: '可直接复用的骨架' },
  checkpoint: { id: 'checkpoint', label: '检查点', type: 'list', hint: '必须停下来核对什么' },
  metrics: { id: 'metrics', label: '度量', type: 'list', hint: '可观测的数字' },
  artifacts: { id: 'artifacts', label: '落点', type: 'list', hint: '落到哪个文件 / 表 / 接口 / 代码' },
  risk: { id: 'risk', label: '风险', type: 'list', hint: '可能崩在哪' },
  notes: { id: 'notes', label: '备注', type: 'text', hint: '其他要说的话' },
}

/** 属性 facet 的固定渲染顺序（不在表里的键排在最后，见 attrKeys）。 */
export const ATTR_ORDER = Object.keys(ATTR_FIELDS)

/**
 * 连边类型全集（结构类 / 过程类 / 注解类）。
 * 一份词汇覆盖"声明"与"过程"两种朝向，边类型不随档案变化。
 * @type {Readonly<Record<string,{id:string,label:string,kind:'struct'|'flow'|'note',hint:string}>>}
 */
export const EDGE_TYPES = {
  relates: { id: 'relates', label: '关联', kind: 'struct', hint: '一般关联' },
  depends: { id: 'depends', label: '依赖', kind: 'struct', hint: '前者成立/可用以后者为前提' },
  contains: { id: 'contains', label: '包含', kind: 'struct', hint: '整体—部分' },
  realizes: { id: 'realizes', label: '实现', kind: 'struct', hint: '下一层实现了上一层' },
  refines: { id: 'refines', label: '细化', kind: 'struct', hint: '同一层的更细版本' },
  conflicts: { id: 'conflicts', label: '冲突', kind: 'note', hint: '两者不能同时成立' },
  flows: { id: 'flows', label: '流转', kind: 'flow', hint: '过程推进' },
  guards: { id: 'guards', label: '判据', kind: 'flow', hint: '前者是后者的判定条件' },
  delegates: { id: 'delegates', label: '分派', kind: 'flow', hint: '交给谁做' },
  produces: { id: 'produces', label: '产生', kind: 'flow', hint: '过程产生产物' },
}

/**
 * 领域档案：给同一条抽象层轴换词汇，并声明本领域的节点类型。
 *
 * 档案只描述**词汇**，不含任何引擎逻辑 —— 新增一个建模领域 = 加一条数据，
 * 画布 / 检验器 / 导出 / AI 生成全部自动支持。
 *
 * @type {ReadonlyArray<{
 *   id:string, label:string, summary:string,
 *   layers: ReadonlyArray<{label:string, desc:string}>,
 *   nodeTypes: Readonly<Record<string,{label:string,orientation:'declarative'|'procedural',hint:string,attrs:readonly string[]}>>,
 * }>}
 */
export const PROFILES = [
  {
    id: 'methodology',
    label: '研究方法论',
    summary: '把一个方法论/工作流讲清楚：它的原理、结构、规程与产物',
    layers: [
      { label: '议题', desc: '这次要解决什么问题、上下文与边界' },
      { label: '原理', desc: '不随实现变化的原则与判据' },
      { label: '结构', desc: '方法论由哪些阶段 / 角色 / 模块构成' },
      { label: '规程', desc: '每个阶段具体怎么做：步骤、输入输出、检查点' },
      { label: '产物', desc: '交付物、模板、度量 —— 验收就看这一层' },
    ],
    nodeTypes: {
      issue: { label: '问题域', orientation: 'declarative', hint: '要解决的议题本身', attrs: ['premise', 'boundary', 'notes'] },
      context: { label: '约束情境', orientation: 'declarative', hint: '外部约束：资源、组织、法规', attrs: ['premise', 'risk', 'notes'] },
      principle: { label: '原理', orientation: 'declarative', hint: '不变的原则 / 定律', attrs: ['principle', 'boundary', 'notes'] },
      criterion: { label: '判据', orientation: 'declarative', hint: '判定"做到了"的可判条件', attrs: ['criterion', 'metrics', 'notes'] },
      stage: { label: '阶段', orientation: 'procedural', hint: '方法论的一个阶段', attrs: ['inputs', 'outputs', 'role', 'checkpoint'] },
      role: { label: '角色', orientation: 'declarative', hint: '谁负责谁参与', attrs: ['role', 'boundary', 'notes'] },
      activity: { label: '活动', orientation: 'procedural', hint: '可执行的活动', attrs: ['steps', 'inputs', 'outputs', 'role'] },
      decision: { label: '决策', orientation: 'procedural', hint: '需要选择的分叉点', attrs: ['criterion', 'steps', 'risk'] },
      tool: { label: '工具', orientation: 'declarative', hint: '方法落地依赖的工具 / 通道', attrs: ['artifacts', 'notes'] },
      deliverable: { label: '交付物', orientation: 'procedural', hint: '最终产物', attrs: ['deliverable', 'template', 'criterion'] },
      metric: { label: '度量', orientation: 'declarative', hint: '可观测的数字', attrs: ['metrics', 'criterion'] },
    },
  },
  {
    id: 'system',
    label: '系统架构',
    summary: '数据 / 服务架构建模：概念、模块、实现、运行四层贯通',
    layers: [
      { label: '场景', desc: '业务场景与系统边界' },
      { label: '概念', desc: '业务实体与领域概念' },
      { label: '结构', desc: '模块 / 服务 / 领域划分与调用关系' },
      { label: '实现', desc: '表结构、接口、代码落点' },
      { label: '运行', desc: '部署、SLO、可观测与产物' },
    ],
    nodeTypes: {
      domain: { label: '业务域', orientation: 'declarative', hint: '业务范围', attrs: ['boundary', 'notes'] },
      actor: { label: '参与者', orientation: 'declarative', hint: '人 / 外部系统', attrs: ['role', 'notes'] },
      entity: { label: '概念实体', orientation: 'declarative', hint: '领域概念（概念层实体）', attrs: ['principle', 'boundary', 'notes'] },
      rule: { label: '业务规则', orientation: 'declarative', hint: '约束 / 校验规则', attrs: ['principle', 'criterion'] },
      service: { label: '服务', orientation: 'declarative', hint: '微服务 / 模块', attrs: ['artifacts', 'notes'] },
      api: { label: '接口', orientation: 'declarative', hint: 'REST / RPC 接口', attrs: ['artifacts', 'inputs', 'outputs'] },
      table: { label: '表', orientation: 'declarative', hint: '物理表', attrs: ['artifacts', 'notes'] },
      job: { label: '任务', orientation: 'procedural', hint: '批处理 / 定时 / 流程任务', attrs: ['steps', 'criterion'] },
      infra: { label: '基础设施', orientation: 'declarative', hint: '中间件 / 部署单元', attrs: ['artifacts', 'risk'] },
      slo: { label: '运行指标', orientation: 'declarative', hint: 'SLO / 可观测指标', attrs: ['metrics', 'criterion'] },
    },
  },
  {
    id: 'process',
    label: '业务过程',
    summary: '端到端流程：触发、阶段、活动、结果，与角色系统绑定',
    layers: [
      { label: '触发', desc: '什么事件让流程开始、范围到哪' },
      { label: '规则', desc: '流程必须遵守的规则与判据' },
      { label: '阶段', desc: '流程分几个阶段、经谁的手' },
      { label: '活动', desc: '每个阶段里的具体活动' },
      { label: '结果', desc: '流程产出什么、怎么算走完' },
    ],
    nodeTypes: {
      trigger: { label: '触发事件', orientation: 'procedural', hint: '流程的起点', attrs: ['premise', 'role'] },
      scope: { label: '范围', orientation: 'declarative', hint: '流程覆盖的边界', attrs: ['boundary', 'notes'] },
      rule: { label: '规则', orientation: 'declarative', hint: '流程规则', attrs: ['principle', 'criterion'] },
      role: { label: '角色', orientation: 'declarative', hint: '流程中的责任人', attrs: ['role', 'notes'] },
      system: { label: '系统', orientation: 'declarative', hint: '流程中的承载系统', attrs: ['artifacts', 'notes'] },
      phase: { label: '阶段', orientation: 'procedural', hint: '流程阶段', attrs: ['inputs', 'outputs', 'role'] },
      activity: { label: '活动', orientation: 'procedural', hint: '阶段内的活动', attrs: ['steps', 'inputs', 'outputs', 'role'] },
      decision: { label: '决策点', orientation: 'procedural', hint: '分叉与判定', attrs: ['criterion', 'risk'] },
      outcome: { label: '结果', orientation: 'procedural', hint: '流程结束态 / 产出', attrs: ['deliverable', 'metrics', 'criterion'] },
    },
  },
]

/** 档案索引（id → profile）。 */
export const PROFILE_BY_ID = Object.fromEntries(PROFILES.map(profile => [profile.id, profile]))

/** 取一个档案；未知 id 回落第一个档案（UI 永不空白）。 */
export function profileOf(id) {
  return PROFILE_BY_ID[id] ?? PROFILES[0]
}

/**
 * 某一层的**本地词汇**（档案换词汇后的名字）。
 * @param profileId 档案 id
 * @param level 抽象层序号 0..4
 */
export function layerLabel(profileId, level) {
  const profile = profileOf(profileId)
  const layer = profile.layers[level] ?? AXIS[level]
  return layer === undefined ? `L${level}` : layer.label
}

/** 某一层的完整描述（档案优先，回落轴上的通用描述）。 */
export function layerInfo(profileId, level) {
  const profile = profileOf(profileId)
  const local = profile.layers[level]
  const axis = AXIS[level] ?? { level, id: `l${level}`, name: `L${level}`, question: '', desc: '' }
  return {
    level,
    id: axis.id,
    axisName: axis.name,
    question: axis.question,
    label: local?.label ?? axis.name,
    desc: local?.desc ?? axis.desc,
  }
}

/** 某一层的全部可选节点类型（[{id, ...def}]，按声明顺序）。 */
export function nodeTypesOf(profileId, level) {
  const profile = profileOf(profileId)
  const out = []
  for (const [id, def] of Object.entries(profile.nodeTypes)) {
    if (def.level === undefined || def.level === level) out.push({ id, ...def })
  }
  return out
}

/** 一个节点类型的定义（未知类型回落空定义，渲染不炸）。 */
export function nodeTypeOf(profileId, type) {
  const profile = profileOf(profileId)
  return profile.nodeTypes[type] ?? { label: type, orientation: 'declarative', hint: '', attrs: [] }
}

/** 节点朝向：类型决定，节点自身可覆盖（未在类型里声明过朝向时）。 */
export function orientationOf(profileId, type) {
  return nodeTypeOf(profileId, type).orientation === 'procedural' ? 'procedural' : 'declarative'
}

/** 一个节点应展示的属性键：类型声明的 + 实际已填的（后者补在末尾）。 */
export function attrKeys(profileId, type, attrs) {
  const declared = nodeTypeOf(profileId, type).attrs ?? []
  const extra = Object.keys(attrs ?? {}).filter(key => !declared.includes(key))
  const known = extra.filter(key => ATTR_FIELDS[key] !== undefined)
  const unknown = extra.filter(key => ATTR_FIELDS[key] === undefined)
  return [...declared, ...known, ...unknown]
}

/** 属性显示名（未知键回落键名）。 */
export function attrLabel(key) {
  return ATTR_FIELDS[key]?.label ?? key
}

/** 属性类型。 */
export function attrType(key) {
  return ATTR_FIELDS[key]?.type ?? 'text'
}

/** 该属性是否有内容（text 非空 / list 非空数组）。 */
export function attrHasValue(value) {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.some(item => String(item).trim() !== '')
  return String(value).trim() !== ''
}

/** 节点上已填属性的条数（画布卡片上的角标）。 */
export function attrCount(node) {
  const attrs = node?.attrs ?? {}
  let n = 0
  for (const value of Object.values(attrs)) if (attrHasValue(value)) n += 1
  return n
}

/** 生成一个短 id（节点 / 边）。 */
export function newId(prefix) {
  return `${prefix || 'n'}${Math.random().toString(36).slice(2, 8)}`
}

/** 该档案的默认节点类型（"新建节点"用第一类）。 */
export function defaultNodeType(profileId, level) {
  const types = nodeTypesOf(profileId, level)
  return types[0]?.id ?? Object.keys(profileOf(profileId).nodeTypes)[0] ?? 'entity'
}

/** 建一个空模型。 */
export function emptyModel(profileId, name) {
  const now = Date.now()
  return {
    id: newId('m'),
    profile: profileOf(profileId).id,
    name: name || '未命名模型',
    intent: '',
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
  }
}

/** 建一个节点（默认落在 L1 语义层）。 */
export function newNode(profileId, level, name, type) {
  const lv = typeof level === 'number' ? level : 1
  return {
    id: newId('n'),
    name: name || '新节点',
    level: lv,
    type: type || defaultNodeType(profileId, lv),
    desc: '',
    attrs: {},
    x: null,
    y: null,
  }
}

/** 建一条边。 */
export function newEdge(from, to, type, label) {
  return { id: newId('e'), from, to, type: type || 'relates', label: label || '' }
}

/** 把一个属性值规范成声明类型的形状（text → string；list → string[]）。 */
export function coerceAttr(key, value) {
  if (value === undefined || value === null) return ''
  if (attrType(key) === 'list') {
    if (Array.isArray(value)) return value.map(item => String(item)).filter(item => item.trim() !== '')
    return String(value).split(/\r?\n|;/).map(item => item.trim()).filter(item => item !== '')
  }
  return Array.isArray(value) ? value.join('；') : String(value)
}

/**
 * 规范化任意来源的模型对象（本地缓存 / 磁盘 / AI 输出都过这一道）。
 * 保证：profile 合法、level 收敛到 0..4、id 唯一、边两端存在、坐标是有限数或 null。
 * @param raw 任意输入
 * @param fallbackProfile 无档案信息时的回落档案 id
 */
export function normalizeModel(raw, fallbackProfile) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const profileId = profileOf(source.profile || fallbackProfile).id
  const seenNodeIds = new Set()
  const nodes = []
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : []
  for (const item of rawNodes) {
    if (item === null || typeof item !== 'object') continue
    let id = typeof item.id === 'string' && item.id !== '' ? item.id : newId('n')
    while (seenNodeIds.has(id)) id = newId('n')
    seenNodeIds.add(id)
    let level = Number(item.level)
    if (!Number.isFinite(level)) level = 1
    level = Math.max(0, Math.min(LEVEL_COUNT - 1, Math.round(level)))
    const type = typeof item.type === 'string' && profileOf(profileId).nodeTypes[item.type] !== undefined
      ? item.type
      : defaultNodeType(profileId, level)
    const attrs = {}
    const rawAttrs = item.attrs !== null && typeof item.attrs === 'object' ? item.attrs : {}
    for (const [key, value] of Object.entries(rawAttrs)) {
      const coerced = coerceAttr(key, value)
      if (attrHasValue(coerced)) attrs[key] = coerced
    }
    nodes.push({
      id,
      name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name : '未命名',
      level,
      type,
      desc: typeof item.desc === 'string' ? item.desc : '',
      attrs,
      x: Number.isFinite(Number(item.x)) ? Number(item.x) : null,
      y: Number.isFinite(Number(item.y)) ? Number(item.y) : null,
    })
  }
  const nodeIds = new Set(nodes.map(node => node.id))
  const seenEdgeIds = new Set()
  const edges = []
  const rawEdges = Array.isArray(source.edges) ? source.edges : []
  for (const item of rawEdges) {
    if (item === null || typeof item !== 'object') continue
    const from = String(item.from ?? '')
    const to = String(item.to ?? '')
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) continue
    let id = typeof item.id === 'string' && item.id !== '' ? item.id : newId('e')
    while (seenEdgeIds.has(id)) id = newId('e')
    seenEdgeIds.add(id)
    edges.push({
      id,
      from,
      to,
      type: EDGE_TYPES[item.type] !== undefined ? item.type : 'relates',
      label: typeof item.label === 'string' ? item.label : '',
    })
  }
  const createdAt = Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : Date.now()
  return {
    id: typeof source.id === 'string' && source.id !== '' ? source.id : newId('m'),
    profile: profileId,
    name: typeof source.name === 'string' && source.name.trim() !== '' ? source.name : '未命名模型',
    intent: typeof source.intent === 'string' ? source.intent : '',
    createdAt,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : createdAt,
    nodes,
    edges,
  }
}

/**
 * 自动布局：抽象层即列（L0 最左 → L4 最右），同层内居中竖排。
 *
 * **手工摆放过的节点（x/y 非 null）永远优先**：`layoutModel` 是画布热路径
 * （每次渲染都调），它一旦把手工坐标算掉，用户拖过的位置就会在下一帧被弹回
 * 自动格点 —— 那也是"整理布局"按钮彻底失效的方式。`force` 因此只作用于
 * **还没被摆过**的节点，语义是"给新节点补齐坐标"，不是"抹掉所有坐标"。
 *
 * @param model 模型
 * @param options.force 为未摆放的节点强制算坐标（默认就已经会给它们算）
 * @returns {{positions: Record<string,{x:number,y:number}>, width:number, height:number}}
 */
export function layoutModel(model, options) {
  const opts = options ?? {}
  const colWidth = opts.colWidth ?? 260
  const rowHeight = opts.rowHeight ?? 96
  const padX = opts.padX ?? 40
  const padY = opts.padY ?? 36
  const byLevel = new Map()
  for (const node of model.nodes) {
    const list = byLevel.get(node.level) ?? []
    list.push(node)
    byLevel.set(node.level, list)
  }
  // 层内排序：已摆放的按 y 排（保持相对次序稳定），未摆放的按声明顺序跟在后面。
  // 这样"整理布局"之后同层仍然是用户看到的顺序，而不是被重排成另一套。
  for (const list of byLevel.values()) {
    list.sort((a, b) => {
      const ay = Number.isFinite(a.y) ? a.y : Number.POSITIVE_INFINITY
      const by = Number.isFinite(b.y) ? b.y : Number.POSITIVE_INFINITY
      return ay - by
    })
  }
  let maxRows = 1
  for (const list of byLevel.values()) maxRows = Math.max(maxRows, list.length)
  const positions = {}
  for (const [level, list] of byLevel.entries()) {
    const total = list.length
    const offset = Math.round(((maxRows - total) * rowHeight) / 2)
    list.forEach((node, index) => {
      const auto = {
        x: padX + level * colWidth,
        y: padY + offset + index * rowHeight,
      }
      const hasManual = Number.isFinite(node.x) && Number.isFinite(node.y)
      positions[node.id] = hasManual ? { x: node.x, y: node.y } : auto
    })
  }
  let width = padX * 2
  let height = padY * 2
  for (const point of Object.values(positions)) {
    width = Math.max(width, point.x + colWidth)
    height = Math.max(height, point.y + rowHeight)
  }
  return { positions, width, height }
}

/** 一致性体检：返回问题清单（空数组 = 健康）。 */
export function auditModel(model) {
  const issues = []
  const profile = profileOf(model.profile)
  const levelUsed = new Set(model.nodes.map(node => node.level))
  for (const node of model.nodes) {
    if (profile.nodeTypes[node.type] === undefined) issues.push({ level: 'warn', text: `节点「${node.name}」的类型 ${node.type} 不在本档案词汇里` })
    if (!attrHasValue(node.attrs?.criterion) && (node.type === 'deliverable' || node.type === 'outcome' || node.type === 'metric' || node.type === 'slo')) {
      issues.push({ level: 'warn', text: `产出节点「${node.name}」没有判据（criterion）—— 无法验收` })
    }
    if (node.level === 3 && node.type === 'activity' && !attrHasValue(node.attrs?.steps)) {
      issues.push({ level: 'info', text: `活动「${node.name}」没有写步骤` })
    }
  }
  for (let level = 0; level < LEVEL_COUNT; level += 1) {
    if (!levelUsed.has(level)) issues.push({ level: 'info', text: `${layerLabel(model.profile, level)} 层还是空的` })
  }
  const reachable = new Set()
  for (const edge of model.edges) { reachable.add(edge.from); reachable.add(edge.to) }
  for (const node of model.nodes) {
    if (!reachable.has(node.id) && model.nodes.length > 1) issues.push({ level: 'info', text: `节点「${node.name}」是孤点` })
  }
  return issues
}

/** 一种节点类型在某档案下的调色（层色 + 朝向决定填充强度）。 */
export const LEVEL_COLORS = ['#6b7cff', '#2fbf9f', '#e0a02c', '#ef6f6c', '#8b6bd9']

/** 导出 Markdown：按抽象层分节，节点带属性，附连边清单。 */
export function toMarkdown(model) {
  const profile = profileOf(model.profile)
  const lines = []
  lines.push(`# ${model.name}`)
  if (model.intent) lines.push('', `> ${model.intent}`)
  lines.push('', `**建模档案**：${profile.label} · **节点** ${model.nodes.length} · **连边** ${model.edges.length}`)
  for (let level = 0; level < LEVEL_COUNT; level += 1) {
    const info = layerInfo(model.profile, level)
    const list = model.nodes.filter(node => node.level === level)
    lines.push('', `## L${level} ${info.label}`, '', `*${info.desc}*`)
    if (list.length === 0) { lines.push('', '_（空）_'); continue }
    for (const node of list) {
      lines.push('', `### ${node.name}`, '', `- 类型：${nodeTypeOf(model.profile, node.type).label}（${ORIENTATIONS[orientationOf(model.profile, node.type)].label}）`)
      if (node.desc) lines.push(`- 说明：${node.desc}`)
      for (const key of attrKeys(model.profile, node.type, node.attrs)) {
        const value = node.attrs?.[key]
        if (!attrHasValue(value)) continue
        lines.push(Array.isArray(value)
          ? `- ${attrLabel(key)}：`
          : `- ${attrLabel(key)}：${String(value)}`)
        if (Array.isArray(value)) for (const item of value) lines.push(`  - ${item}`)
      }
    }
  }
  if (model.edges.length > 0) {
    const nameOf = id => model.nodes.find(node => node.id === id)?.name ?? id
    lines.push('', '## 关系', '')
    for (const edge of model.edges) {
      const type = EDGE_TYPES[edge.type] ?? EDGE_TYPES.relates
      lines.push(`- **${nameOf(edge.from)}** —${type.label}${edge.label ? `（${edge.label}）` : ''}→ **${nameOf(edge.to)}**`)
    }
  }
  return lines.join('\n') + '\n'
}

/** 导出 Mermaid（便于嵌进任何 Markdown / 文档）。 */
export function toMermaid(model) {
  const profile = profileOf(model.profile)
  const safe = value => String(value).replace(/"/g, "'").replace(/[\r\n]+/g, ' ')
  const idOf = id => `n_${String(id).replace(/[^A-Za-z0-9_]/g, '_')}`
  const lines = ['flowchart LR']
  for (let level = 0; level < LEVEL_COUNT; level += 1) {
    const list = model.nodes.filter(node => node.level === level)
    if (list.length === 0) continue
    lines.push(`  subgraph L${level}["${safe(layerInfo(model.profile, level).label)}"]`)
    lines.push('    direction TB')
    for (const node of list) lines.push(`    ${idOf(node.id)}["${safe(node.name)}"]`)
    lines.push('  end')
  }
  for (const edge of model.edges) {
    const type = EDGE_TYPES[edge.type] ?? EDGE_TYPES.relates
    const arrow = type.kind === 'flow' ? '-->' : type.kind === 'note' ? '-.->' : '---'
    lines.push(`  ${idOf(edge.from)} ${arrow}|${safe(edge.label || type.label)}| ${idOf(edge.to)}`)
  }
  return lines.join('\n') + '\n'
}

/** 常量：AI 生成的兜底模型尺寸上限（超出的输出视为越界）。 */
export const AI_LIMITS = { maxNodes: 40, maxEdges: 80 }
