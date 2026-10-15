/**
 * dsh-modeling 浏览器半段 —— 由 scripts/build.mjs 从 src/ 生成，**请勿手改**。
 *
 * 要改行为请改对应源码然后重跑构建：
 *   src/client.js / src/client.dom.js / src/modeling.mjs
 *   node scripts/build.mjs
 */
/**
 * dsh-modeling 浏览器半段 —— `lib/client.js` 的**源码模板**，不直接运行。
 *
 * 由 `scripts/build.mjs` 生成 `lib/client.js`：把
 *   · `src/modeling.mjs`（共用模型，剥掉 export 关键字）
 *   · `src/client.dom.js`（画布与面板）
 * 内联进下面这个 `window.__ModuleLoader__.load({ factory })` 工厂里。
 *
 * 形状与 DSH 客户端模块加载器约定一致（与 dsh-workbench 同款）：
 *   factory(require) → { apply, inject, name }
 * React 从模块表 require（本插件不需要 portal，所以不 require react-dom）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-modeling',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

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
const AXIS = [
  { level: 0, id: 'position', name: '定位', question: '在什么上下文里，边界在哪', desc: '议题 / 场景 / 范围：先划清"这次要解决什么、不解决什么"' },
  { level: 1, id: 'semantic', name: '语义', question: '什么是不变的原则', desc: '原理 / 概念：回答"是什么、为什么"，不随实现变化的部分' },
  { level: 2, id: 'structure', name: '结构', question: '怎么被组织起来', desc: '模块 / 阶段：谁和谁有关系、怎么分块、按什么顺序' },
  { level: 3, id: 'realize', name: '实现', question: '具体怎么做 / 怎么落', desc: '规程 / 实现：可执行的步骤、活动、接口、表、代码' },
  { level: 4, id: 'product', name: '产出', question: '怎么算做出来了', desc: '产物 / 运行：交付物、模板、度量与判据——验收就看这一层' },
]

/** 抽象层数（= AXIS.length，独立导出便于校验）。 */
const LEVEL_COUNT = AXIS.length

/**
 * 朝向：节点回答的问题。
 *  - declarative 声明式：回答"是什么"（概念、模块、服务、表、原则、角色）
 *  - procedural  过程式：回答"怎么走"（阶段、活动、决策、判据、交付物）
 * 一张图里两种朝向可以共存 —— 这正是流程与结构不需要两套画布的原因。
 */
const ORIENTATIONS = {
  declarative: { id: 'declarative', label: '声明式', question: '是什么' },
  procedural: { id: 'procedural', label: '过程式', question: '怎么走' },
}

/**
 * 属性 facet 全集。节点可挂任意若干项；表单按 type 渲染（text 单行 / list 逐行）。
 * @type {Readonly<Record<string,{id:string,label:string,type:'text'|'list',hint:string}>>}
 */
const ATTR_FIELDS = {
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
const ATTR_ORDER = Object.keys(ATTR_FIELDS)

/**
 * 连边类型全集（结构类 / 过程类 / 注解类）。
 * 一份词汇覆盖"声明"与"过程"两种朝向，边类型不随档案变化。
 * @type {Readonly<Record<string,{id:string,label:string,kind:'struct'|'flow'|'note',hint:string}>>}
 */
const EDGE_TYPES = {
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
const PROFILES = [
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
const PROFILE_BY_ID = Object.fromEntries(PROFILES.map(profile => [profile.id, profile]))

/** 取一个档案；未知 id 回落第一个档案（UI 永不空白）。 */
function profileOf(id) {
  return PROFILE_BY_ID[id] ?? PROFILES[0]
}

/**
 * 某一层的**本地词汇**（档案换词汇后的名字）。
 * @param profileId 档案 id
 * @param level 抽象层序号 0..4
 */
function layerLabel(profileId, level) {
  const profile = profileOf(profileId)
  const layer = profile.layers[level] ?? AXIS[level]
  return layer === undefined ? `L${level}` : layer.label
}

/** 某一层的完整描述（档案优先，回落轴上的通用描述）。 */
function layerInfo(profileId, level) {
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
function nodeTypesOf(profileId, level) {
  const profile = profileOf(profileId)
  const out = []
  for (const [id, def] of Object.entries(profile.nodeTypes)) {
    if (def.level === undefined || def.level === level) out.push({ id, ...def })
  }
  return out
}

/** 一个节点类型的定义（未知类型回落空定义，渲染不炸）。 */
function nodeTypeOf(profileId, type) {
  const profile = profileOf(profileId)
  return profile.nodeTypes[type] ?? { label: type, orientation: 'declarative', hint: '', attrs: [] }
}

/** 节点朝向：类型决定，节点自身可覆盖（未在类型里声明过朝向时）。 */
function orientationOf(profileId, type) {
  return nodeTypeOf(profileId, type).orientation === 'procedural' ? 'procedural' : 'declarative'
}

/** 一个节点应展示的属性键：类型声明的 + 实际已填的（后者补在末尾）。 */
function attrKeys(profileId, type, attrs) {
  const declared = nodeTypeOf(profileId, type).attrs ?? []
  const extra = Object.keys(attrs ?? {}).filter(key => !declared.includes(key))
  const known = extra.filter(key => ATTR_FIELDS[key] !== undefined)
  const unknown = extra.filter(key => ATTR_FIELDS[key] === undefined)
  return [...declared, ...known, ...unknown]
}

/** 属性显示名（未知键回落键名）。 */
function attrLabel(key) {
  return ATTR_FIELDS[key]?.label ?? key
}

/** 属性类型。 */
function attrType(key) {
  return ATTR_FIELDS[key]?.type ?? 'text'
}

/** 该属性是否有内容（text 非空 / list 非空数组）。 */
function attrHasValue(value) {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.some(item => String(item).trim() !== '')
  return String(value).trim() !== ''
}

/** 节点上已填属性的条数（画布卡片上的角标）。 */
function attrCount(node) {
  const attrs = node?.attrs ?? {}
  let n = 0
  for (const value of Object.values(attrs)) if (attrHasValue(value)) n += 1
  return n
}

/** 生成一个短 id（节点 / 边）。 */
function newId(prefix) {
  return `${prefix || 'n'}${Math.random().toString(36).slice(2, 8)}`
}

/** 该档案的默认节点类型（"新建节点"用第一类）。 */
function defaultNodeType(profileId, level) {
  const types = nodeTypesOf(profileId, level)
  return types[0]?.id ?? Object.keys(profileOf(profileId).nodeTypes)[0] ?? 'entity'
}

/** 建一个空模型。 */
function emptyModel(profileId, name) {
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
function newNode(profileId, level, name, type) {
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
function newEdge(from, to, type, label) {
  return { id: newId('e'), from, to, type: type || 'relates', label: label || '' }
}

/** 把一个属性值规范成声明类型的形状（text → string；list → string[]）。 */
function coerceAttr(key, value) {
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
function normalizeModel(raw, fallbackProfile) {
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
function layoutModel(model, options) {
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
function auditModel(model) {
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
const LEVEL_COLORS = ['#6b7cff', '#2fbf9f', '#e0a02c', '#ef6f6c', '#8b6bd9']

/** 导出 Markdown：按抽象层分节，节点带属性，附连边清单。 */
function toMarkdown(model) {
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
function toMermaid(model) {
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
const AI_LIMITS = { maxNodes: 40, maxEdges: 80 }

    /**
 * dsh-modeling — 画布与面板的 DOM/React 代码（工厂内联用）。
 *
 * 本文件**不是模块**：`scripts/build-client.mjs` 把它与 `modeling.mjs`
 * 一起内联进 `lib/client.js` 的 `window.__ModuleLoader__.load({factory})`
 * 里，所以：
 *   · 只用 `React` / `ReactDOM` 两个外部量（工厂从模块表 require 进来）；
 *   · 不写 import / export（内联后就是同一个函数作用域）；
 *   · 所有样式自带 `dshmo-` 前缀并在 apply 时注入一次，卸载即移除。
 *
 * 结构上就是三栏：左＝模型库，中＝画布，右＝检验器（属性编辑）。
 * 画布是纯 SVG（不用画布库）：抽象层即列，节点是圆角矩形，边是三阶贝塞尔。
 */

/* ── 样式 ──────────────────────────────────────────────────────────────── */

const CSS = `
/* 根容器：**留在文档流里**，不要 absolute + inset:0。
   better-sidebar 的面板结构是 .panel（position:absolute，flex column）：
       .panel
         ├── .tabBar      34px 标签条（flex:none）
         └── .panelBody   flex:1 —— **自身没有 position**
   本组件挂在 .panelBody 里。根容器一旦写 absolute+inset:0，包含块会一路上溯到
   .panel，于是从**面板顶端**开始铺 —— 正好盖住那 34px 的 tab 条（标签点不到、
   看起来像被遮挡）。留在流里 + flex:1，就只占 .panelBody 这一段。
   自测 C-29 守这条契约。 */
/* ★ 根容器还得**占满那一栏的高度**：只写 flex:1 1 auto 时父容器（官方右栏的 pane）不是 flex
   ⇒ 根高变成内容高，短内容时整页只有一百多像素（2026-09-24 真机实测：建模中心 1080×185）。
   补 height:100% 与 pane 的高度契约对齐；内部画布本来就是 flex:1 + overflow:auto，不会挤坏。 */
.dshmo-root{position:relative;flex:1 1 auto;height:100%;display:flex;flex-direction:column;min-height:0;min-width:0;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font:var(--dsw-font-xxs-12,12px/1.5 system-ui,sans-serif);overflow:hidden}
.dshmo-root *{box-sizing:border-box}
.dshmo-bar{display:flex;align-items:center;gap:6px;padding:6px 8px;flex:0 0 auto;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dshmo-title{font:var(--dsw-font-xxs-strong-12,600 12px/1.4 system-ui);white-space:nowrap}
.dshmo-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:0 0 auto}
.dshmo-dot.off{background:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dshmo-dot.busy{background:var(--dsw-alias-state-warn-primary)}
.dshmo-status{margin-left:auto;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshmo-btn{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font:inherit;white-space:nowrap}
.dshmo-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1))}
.dshmo-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshmo-btn.on{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(77,107,254,.14))}
.dshmo-btn:disabled{opacity:.45;cursor:default}
.dshmo-btn.sm{height:19px;padding:0 6px;font-size:11px}
.dshmo-sec{border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 7px}
.dshmo-sec:last-child{border-bottom:0}
.dshmo-sech{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));
  font-size:11px;font-weight:600;letter-spacing:.02em;margin-bottom:4px}
.dshmo-sech span.count{margin-left:auto;font-weight:400;opacity:.7}
.dshmo-doc{display:flex;align-items:center;gap:4px;padding:4px 6px;border-radius:6px;cursor:pointer;
  color:var(--dsw-alias-label-secondary)}
.dshmo-doc:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dshmo-doc.on{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(77,107,254,.12));color:var(--dsw-alias-label-primary)}
.dshmo-doc span{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshmo-doc em{font-style:normal;opacity:.6;font-size:11px}
.dshmo-x{border:0;background:none;color:inherit;opacity:.5;cursor:pointer;padding:0 2px;font:inherit;line-height:1}
.dshmo-x:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}
.dshmo-hint{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:1.5}
.dshmo-tools{display:flex;align-items:center;gap:5px;padding:5px 7px;flex:0 0 auto;
  border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dshmo-name{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);
  font:var(--dsw-font-xxs-strong-12,600 12px/1.4 system-ui);padding:2px 5px;border-radius:6px;min-width:60px;flex:1 1 90px}
.dshmo-name:hover{border-color:var(--dsw-alias-border-l1)}
.dshmo-name:focus{outline:none;border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.dshmo-canvas{flex:1 1 auto;min-height:0;position:relative;overflow:auto;background:
  linear-gradient(var(--dsw-alias-border-l1) 1px,transparent 1px) 0 0/100% 24px,
  linear-gradient(90deg,var(--dsw-alias-border-l1) 1px,transparent 1px) 0 0/24px 100%,
  var(--dsw-alias-bg-base)}
.dshmo-canvas.pan{cursor:grab}
.dshmo-canvas.pan.grabbing{cursor:grabbing}
.dshmo-canvas.connect{cursor:crosshair}
.dshmo-svg{display:block}
.dshmo-colhead{fill:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:600 10px/1 system-ui}
.dshmo-coldesc{fill:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:10px/1 system-ui;opacity:.8}
.dshmo-node{cursor:grab}
.dshmo-node.sel .dshmo-nbox{stroke:var(--dsw-alias-brand-primary);stroke-width:2}
.dshmo-node.link .dshmo-nbox{stroke:var(--dsw-alias-state-success-primary);stroke-width:2;stroke-dasharray:4 3}
.dshmo-nbox{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l2);stroke-width:1;rx:8}
.dshmo-nname{fill:var(--dsw-alias-label-primary);font:600 12px/1 system-ui}
.dshmo-ntype{fill:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:10px/1 system-ui}
.dshmo-nmeta{fill:var(--dsw-alias-label-secondary);font:10px/1 system-ui;opacity:.85}
.dshmo-badge{fill:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:9px/1 system-ui}
.dshmo-edge{stroke:var(--dsw-alias-border-l2);stroke-width:1.4;fill:none}
.dshmo-edge.flow{stroke:var(--dsw-alias-brand-primary);opacity:.9}
.dshmo-edge.note{stroke-dasharray:4 3;opacity:.75}
.dshmo-edge.same{stroke-dasharray:3 2}
.dshmo-edge.back{opacity:.75}
/* 命中区：透明、加宽，让细线也好点中。
   ⚠️ 类名必须与渲染写出的**完全一致** —— 这里曾经写成 .dshmo-edge.hit，
   而渲染给的是 dshmo-hit，于是命中区只有 1.4px 宽：连线几乎点不到。
   规则与产出必须能对上，自测 C-28 守这条。
   （注意：这段在模板字符串里，注释中不要出现反引号，会提前结束模板。） */
.dshmo-hit{stroke:transparent;stroke-width:14;fill:none;cursor:pointer}
.dshmo-edge.sel{stroke-width:2.6;opacity:1}
.dshmo-elabel{fill:var(--dsw-alias-label-secondary);font:9px/1 system-ui;text-anchor:middle}
.dshmo-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:8px;text-align:center;padding:18px;pointer-events:none}
.dshmo-empty .dshmo-btn{pointer-events:auto}
/* 层导航条：五层横向铺满（每段宽度 ∝ 该层节点数），当前视窗落在哪一段就高亮哪一段。
   窄侧边栏里一屏装不下五列，没有这条就等于读者不知道"自己在第几层"。 */
.dshmo-layers{display:flex;gap:3px;padding:4px 7px;flex:0 0 auto;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dshmo-layer{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:1px;
  padding:3px 2px;border:0;border-radius:6px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);font:inherit}
.dshmo-layer:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1))}
.dshmo-layer .k{font-size:10px;font-weight:600;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.dshmo-layer .n{font-size:9px;opacity:.75;line-height:1.1}
.dshmo-layer .bar{width:100%;height:3px;border-radius:2px;background:var(--dsw-alias-border-l2)}
.dshmo-layer.empty{opacity:.55}
.dshmo-layer.on{background:var(--dshmo-layer-tint,var(--dsw-alias-interactive-bg-hover-accent,rgba(77,107,254,.14)));
  color:var(--dsw-alias-label-primary);outline:1px solid var(--dshmo-layer-color,var(--dsw-alias-brand-primary))}
/* ── 上带：档案 / 模型库 / 按层加节点（原来竖着的左栏，横过来）────────────── */
.dshmo-strip{display:flex;align-items:center;gap:4px;padding:4px 7px;flex:0 0 auto;
  overflow-x:auto;overflow-y:hidden;white-space:nowrap;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dshmo-strip::-webkit-scrollbar{height:6px}
.dshmo-strip-sep{flex:0 0 auto;width:1px;height:14px;background:var(--dsw-alias-border-l1);margin:0 2px}
.dshmo-strip-label{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:10px}
.dshmo-pill{flex:0 0 auto;height:20px;padding:0 8px;border-radius:10px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);font:inherit;white-space:nowrap}
.dshmo-pill:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1))}
.dshmo-pill.on{color:var(--dsw-alias-label-primary);border-color:var(--dshmo-pill-color,var(--dsw-alias-brand-primary));
  background:color-mix(in srgb, var(--dshmo-pill-color,var(--dsw-alias-brand-primary)) 14%, transparent)}
.dshmo-chip{flex:0 0 auto;display:inline-flex;align-items:stretch;height:20px;border-radius:6px;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dshmo-chip.on{border-color:var(--dsw-alias-brand-primary)}
.dshmo-chip-b{border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;
  padding:0 6px;cursor:pointer;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshmo-chip.on .dshmo-chip-b{color:var(--dsw-alias-label-primary)}
.dshmo-chip-b:hover{color:var(--dsw-alias-label-primary)}
.dshmo-chip-x{border:0;border-left:1px solid var(--dsw-alias-border-l1);background:none;cursor:pointer;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:inherit;padding:0 4px;line-height:1}
.dshmo-chip-x:hover{color:var(--dsw-alias-state-error-primary)}
.dshmo-layer-chip{flex:0 0 auto;height:20px;padding:0 6px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);font:inherit;white-space:nowrap;
  border-left:3px solid var(--dshmo-chip-color,var(--dsw-alias-brand-primary))}
.dshmo-layer-chip:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1))}
/* ── 下带：四张并排卡片（检验器 / 体检 / 导出 / 环境）────────────────────── */
.dshmo-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));column-gap:0;row-gap:6px;
  grid-auto-rows:minmax(0,1fr);padding:6px 7px;flex:0 0 auto;min-height:0;overflow:auto;
  border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dshmo-cards.grid2{grid-template-columns:repeat(2,minmax(0,1fr));column-gap:6px}
.dshmo-card{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
/* ── 三段高度可拖 + 四张卡宽度可拖（2026-09-25 用户裁定，与坐标系同一套手感）──
   上带 = 栏 + 工具栏 + 档案/模型/加节点条；中带 = 画布（吃掉剩下的高度）；下带 = 四张卡。
   两条**横**分隔条是布局里的真元素（7px 高，占位不遮挡）；三条**竖**分隔条是网格里的
   7px 列（当卡片之间的 gutter 用，宽度不需要绝对定位去算）。 */
.dshmo-top{display:flex;flex-direction:column;flex:0 0 auto;min-height:0;overflow:hidden}
.dshmo-hsplit{flex:0 0 auto;height:7px;cursor:row-resize;touch-action:none;position:relative;z-index:6;
  background:transparent}
.dshmo-hsplit:hover,.dshmo-hsplit.on,.dshmo-vsplit:hover,.dshmo-vsplit.on{
  background:var(--dsw-alias-brand-primary);opacity:.35}
.dshmo-vsplit{cursor:col-resize;touch-action:none;border-radius:3px;min-height:0;align-self:stretch}
body.dshmo-dragging{user-select:none}
.dshmo-card.ok{border-color:var(--dsw-alias-state-success-primary,var(--dsw-alias-border-l1))}
.dshmo-card-h{display:flex;align-items:center;gap:4px;padding:4px 7px;
  border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10px}
.dshmo-card-h .t{font-weight:600}
.dshmo-card-h .b{margin-left:auto;padding:0 5px;border-radius:8px;font-size:9px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshmo-card-b{padding:5px 7px;overflow:auto;min-height:34px}
.dshmo-kv{display:flex;gap:5px;align-items:baseline;font-size:10px;line-height:1.5}
.dshmo-kv span{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dshmo-kv code{font:10px/1.4 ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary);
  word-break:break-all}
.dshmo-field{display:flex;flex-direction:column;gap:3px;margin-bottom:6px}
.dshmo-field label{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px}
.dshmo-in,.dshmo-ta,.dshmo-sel{width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;padding:4px 6px}
.dshmo-in:focus,.dshmo-ta:focus,.dshmo-sel:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshmo-ta{resize:vertical;min-height:52px;font:11px/1.5 ui-monospace,Consolas,monospace}
.dshmo-row{display:flex;gap:4px;align-items:center}
.dshmo-issue{display:flex;gap:5px;align-items:flex-start;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.45}
.dshmo-issue i{width:5px;height:5px;border-radius:50%;margin-top:5px;flex:0 0 auto}
.dshmo-issue.warn i{background:var(--dsw-alias-state-warn-primary)}
.dshmo-issue.info i{background:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dshmo-modal{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));padding:18px}
.dshmo-dialog{width:min(560px,92vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);
  box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.35))}
.dshmo-dialog h3{margin:0;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  font:var(--dsw-font-xs-strong-13,600 13px/1.4 system-ui)}
.dshmo-dialog .body{padding:10px 12px;overflow:auto;min-height:0}
.dshmo-dialog .foot{display:flex;gap:6px;align-items:center;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshmo-dialog .foot .push{margin-left:auto}
.dshmo-err{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.5;word-break:break-word}
.dshmo-warn{color:var(--dsw-alias-state-warn-primary);font-size:11px}
`

/* ── 小组件 ────────────────────────────────────────────────────────────── */

const h = React.createElement

const ORIENT_MARK = { declarative: '◇', procedural: '▷' }

/** 常量：节点卡片尺寸与画布栅格（默认用于宽态；窄态用 metrics(false) 的那一套）。 */
const NODE_W = 186
const NODE_H = 74
const COL_W = 258
const ROW_H = 96
const PAD_X = 56
const PAD_Y = 46

/**
 * 画布度量：同一套概念在两种宽度下取不同数值。
 *
 * 为什么要有窄态：本卡片住在右侧栏里，实际宽度只有 340~420px。若左栏 168 +
 * 右栏 244 固定占位，中间画布只剩 ~100px —— 而本模型的读法是"抽象层即列"
 * （五层从左到右），一旦画布没有横向空间，整张图就读成竖着的一条，等于废掉。
 * 所以窄态下：① 左右栏改抽屉压在画布上；② 节点与列距整体缩小。
 *
 * @param wide 是否宽态（面板内部宽度 ≥ COMPACT_MAX）
 */
function metrics(wide) {
  return wide
    ? { nodeW: NODE_W, nodeH: NODE_H, colW: COL_W, rowH: ROW_H, padX: PAD_X, padY: PAD_Y }
    : { nodeW: 150, nodeH: 64, colW: 176, rowH: 84, padX: 26, padY: 40 }
}

/** 窄态阈值：低于它就把左右栏改成抽屉（两个固定栏的合计宽度加一点余量）。 */
const COMPACT_MAX = 620

/** 截断文本（SVG 不做省略号，自己算）。 */
function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : value.slice(0, Math.max(1, max - 1)) + '…'
}

/** 层列头那行小字的截断宽度（列越窄截得越短，避免两列文字叠在一起）。 */
function compactHint(colW) {
  return Math.max(10, Math.round(colW / 8))
}

/**
 * 由画布的视窗中心推算"当前在第几层"。
 *
 * 层导航条靠它高亮：窄侧边栏一屏装不下五列，读者需要知道自己在轴上哪儿。
 * 注意三个量都在**显示坐标**（已乘缩放系数）里，所以减 padX 之前要先除掉 scale。
 *
 * @param left 画布 scrollLeft（显示坐标）
 * @param viewportW 画布可见宽度（显示坐标）
 * @param padX 左边距（布局坐标）
 * @param colW 列距（布局坐标）
 * @param scale 缩放系数（适应宽度时 <1，否则 1）
 */
function viewLevelOf(left, viewportW, padX, colW, scale) {
  const s = scale > 0 ? scale : 1
  const centerInLayout = (left + viewportW / 2) / s
  const guess = Math.round((centerInLayout - padX) / colW)
  return Math.max(0, Math.min(LEVEL_COUNT - 1, guess))
}

/** 该节点卡片的显示行（类型 · 朝向 / 摘要 / 属性条数）。 */
function nodeLines(model, node) {
  const type = nodeTypeOf(model.profile, node.type)
  const orient = ORIENTATIONS[orientationOf(model.profile, node.type)]
  const lines = [`${ORIENT_MARK[orient.id] ?? ''} ${type.label} · ${orient.label}`.trim()]
  if (node.desc) lines.push(clip(node.desc, 26))
  const filled = attrKeys(model.profile, node.type, node.attrs)
    .filter(key => attrHasValue(node.attrs?.[key]))
    .map(key => attrLabel(key))
  lines.push(filled.length === 0 ? '未填属性' : clip(filled.join(' · '), 26))
  return lines
}

/** 节点卡片在画布上的左上角（无坐标时按层自动落位）。 */
function positionMap(model, m) {
  const g = m ?? metrics(true)
  return layoutModel(model, { colWidth: g.colW, rowHeight: g.rowH, padX: g.padX, padY: g.padY })
}

/**
 * 一条连边的走法（含端口与标签位）。
 *
 * 三种情形分开处理，这是修掉"连线压在节点上/箭头被卡片埋住"的关键：
 *
 *  - **forward**（目标在起点右侧一列以上）：源右缘 → 目标左缘，横向 S 曲线。
 *  - **same**（同一列上下，含 dx 极小）：竖线连上下缘。
 *    同列时左右端口在**同一个 x**上，横着连会变成一条穿过两张卡片的 S 线；
 *    而 seed 模型里 16 条边有 6 条属于这种，所以必须单独走竖线。
 *  - **back**（目标在起点左侧）：绕下方走 —— 源底部 → 向下 → 横向 → 目标底部，
 *    避免直接从目标卡片身上穿过去。
 *
 * @param a 源节点左上角
 * @param b 目标节点左上角
 * @param m 画布度量
 * @returns {{d:string, mid:{x:number,y:number}, marker:boolean, shape:'forward'|'same'|'back'}}
 */
function edgeRoute(a, b, m) {
  const g = m ?? metrics(true)
  const { nodeW: w, nodeH: h } = g
  const ax = a.x + w / 2
  const bx = b.x + w / 2
  const dx = b.x - a.x

  // 同列：竖线（源下缘中点 → 目标上缘中点）
  if (Math.abs(dx) < w) {
    const x1 = ax
    const y1 = a.y + h
    const x2 = bx
    const y2 = b.y
    // 两者中线错开一点：两张卡片正对时线条不至于和边缘糊在一起
    const off = Math.abs(x1 - x2) < 1 ? 14 : 0
    const x1o = x1 + off
    const x2o = x2 + off
    const bend = Math.max(16, Math.abs(y2 - y1) * 0.4)
    return {
      d: `M ${x1o} ${y1} C ${x1o} ${y1 + bend}, ${x2o} ${y2 - bend}, ${x2o} ${y2}`,
      mid: { x: (x1o + x2o) / 2, y: (y1 + y2) / 2 },
      marker: false,
      shape: 'same',
    }
  }

  // 反向：绕下方走（横向拐点取两卡之间，纵向拐点落在两张卡片下缘之下）
  if (dx < 0) {
    const bottom = Math.max(a.y + h, b.y + h) + 24
    const midX = (ax + bx) / 2
    return {
      d: `M ${ax} ${a.y + h} C ${ax} ${bottom}, ${midX} ${bottom}, ${midX} ${bottom}`
        + ` C ${midX} ${bottom}, ${bx} ${bottom}, ${bx} ${b.y + h}`,
      mid: { x: midX, y: bottom - 2 },
      marker: false,
      shape: 'back',
    }
  }

  // 正向：右缘 → 左缘
  const x1 = a.x + w
  const y1 = a.y + h / 2
  const x2 = b.x
  const y2 = b.y + h / 2
  const gap = Math.max(24, Math.abs(x2 - x1) * 0.5)
  return {
    d: `M ${x1} ${y1} C ${x1 + gap} ${y1}, ${x2 - gap} ${y2}, ${x2} ${y2}`,
    mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
    marker: true,
    shape: 'forward',
  }
}

/**
 * 边的路径字符串（保留旧签名，自测与外部调用在用）。
 * @deprecated 新代码请用 `edgeRoute`，它同时给出端口、标签位与是否需要箭头。
 */
function edgePath(a, b, m) {
  return edgeRoute(a, b, m).d
}

/**
 * 边的标签位置（放线上）。
 * 正向取路径中点；同列取竖线中点；反向取绕行段的中点。
 * @deprecated 新代码请用 `edgeRoute().mid`。
 */
function edgeMid(a, b, m) {
  return edgeRoute(a, b, m).mid
}

/**
 * 图标：节点—连边—节点（与"结构/关系"语义对应；折叠态只显示它）。
 *
 * ⚠️ 必须返回 **React 元素**，不能返回 DOM 节点。
 * `TabDescriptor.icon` 的契约是 `ReactNode | (size) => ReactNode`：侧边栏的
 * tab 条把它当 React child 渲染，而侧卡片设置页（SideCardSection）还会再调一次
 * 同一个函数来画"侧边栏内容"清单。返回 `document.createElementNS(...)` 出来的
 * 真 SVG 节点会当场炸：
 *   Minified React error #31 …
 *   args[]=%5Bobject%20SVGSVGElement%5D   ← 收到的是一个 SVGSVGElement
 * 所以这里全部走 React.createElement（SVG 属性用 React 的驼峰命名）。
 *
 * @param size 边长（px），默认 16
 */
function iconModeling(size, className, glyph) {
  const s = size || 16
  return h('svg', {
    width: s,
    height: s,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    className: className || undefined,
    'data-dshmo-glyph': glyph || undefined,
  },
  h('rect', { key: 'tl', x: 0.9, y: 2.1, width: 4.4, height: 3.4, rx: 1.1 }),
  h('rect', { key: 'tr', x: 10.7, y: 2.1, width: 4.4, height: 3.4, rx: 1.1 }),
  h('rect', { key: 'b', x: 5.8, y: 10.5, width: 4.4, height: 3.4, rx: 1.1 }),
  h('path', { key: 'e1', d: 'M3.1 5.5v2.1a1.2 1.2 0 0 0 1.2 1.2h3.7a1.2 1.2 0 0 0 1.2-1.2V5.5' }),
  h('path', { key: 'e2', d: 'M12.9 5.5v2.1a1.2 1.2 0 0 1-1.2 1.2H8v1.7' }))
}

/**
 * 指南页入口卡上的**彩色**图标（官方 `IconProps`：`{size, className}`）。
 *
 * 官方那两张卡就是这么画的 —— `FileTypeIcon kind="folder"` = 金色文件夹 + 白线，
 * `TerminalGuideIcon` = 深色圆角卡 + 白色提示符：**实色圆角底板 + 上面的图形画成白色**。
 * 四个工作台卡沿用同一套形状语法（28×28 画布，与官方同），只换底板颜色：
 * 工作台=蓝 · 驾驶舱=绿 · 坐标系=紫 · 建模中心=橙（蓝/绿/橙都取官方设计变量）。
 *
 * ⚠️ tab 标题条 / 左侧栏那几处仍是上面那枚 16×16 单色 `currentColor` —— 与官方一致：
 *    官方也是两套（`TerminalIcon` 单色给标题条、`TerminalGuideIcon` 彩色给指南卡）。
 */
function guideModeling(props) {
  const given = props === null || props === undefined ? {} : props
  const size = Number.isFinite(given.size) ? given.size : 26
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 28 28',
    fill: 'none',
    'aria-hidden': 'true',
    className: given.className || undefined,
    'data-dshmo-glyph': 'modeling',
    'data-dshmo-guide': 'modeling',
  },
  h('rect', {
    key: 'plate', x: 1.2, y: 1.2, width: 25.6, height: 25.6, rx: 7, fill: 'var(--dsw-static-amber-500)',
  }),
  h('g', {
    key: 'marks',
    transform: 'translate(4.8 4.8) scale(1.15)',
    stroke: '#fff',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { color: '#fff' },
  },
  h('rect', { key: 'tl', x: 0.9, y: 2.1, width: 4.4, height: 3.4, rx: 1.1 }),
  h('rect', { key: 'tr', x: 10.7, y: 2.1, width: 4.4, height: 3.4, rx: 1.1 }),
  h('rect', { key: 'b', x: 5.8, y: 10.5, width: 4.4, height: 3.4, rx: 1.1 }),
  h('path', { key: 'e1', d: 'M3.1 5.5v2.1a1.2 1.2 0 0 0 1.2 1.2h3.7a1.2 1.2 0 0 0 1.2-1.2V5.5' }),
  h('path', { key: 'e2', d: 'M12.9 5.5v2.1a1.2 1.2 0 0 1-1.2 1.2H8v1.7' })))
}

/* ── 主组件 ────────────────────────────────────────────────────────────── */

/**
 * 「建模中心」tab 主体。
 *
 * @param props.embedded 侧边栏嵌入态（true）；false 时用于独立浮窗（当前未用）
 */
function ModelingCenter(props) {
  const embedded = props?.embedded === true
  const [boot, setBoot] = React.useState(() => ({ state: 'loading', error: '', meta: null, catalog: null }))
  const [profileId, setProfileId] = React.useState(() => lsGet('dshmo.profile') || 'methodology')
  const [model, setModel] = React.useState(null)
  const [docs, setDocs] = React.useState([])
  const [rev, setRev] = React.useState(0)
  const [selected, setSelected] = React.useState(null)
  const [connectFrom, setConnectFrom] = React.useState(null)
  const [panMode, setPanMode] = React.useState(false)
  const [saveState, setSaveState] = React.useState('idle')
  const [notice, setNotice] = React.useState('')
  const [aiOpen, setAiOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const dragRef = React.useRef(null)
  const canvasRef = React.useRef(null)
  const rootRef = React.useRef(null)
  // 本卡片住在右侧栏里（实际 340~420px），宽度不足时要把左右栏改成抽屉，
  // 否则中间画布被固定列挤成竖条，「抽象层即列」的横向读法就没了。
  const [compact, setCompact] = React.useState(false)
  // 面板内部宽度（缩放「适应宽度」与层导航条都用它）
  const [panelWidth, setPanelWidth] = React.useState(0)
  // 平铺总览：把五层缩进当前宽度一屏看完（文字变小，看的是结构不是细节）
  const [fitWidth, setFitWidth] = React.useState(false)
  // 当前视窗落在第几层（层导航条高亮）
  const [activeLevel, setActiveLevel] = React.useState(0)
  // 下带（检验器/体检/导出/环境 四张卡片）默认展开；收起可把高度让给画布
  const [bottomOpen, setBottomOpen] = React.useState(true)
  // 三段高度比例（上带 / 下带各一个百分比，画布吃掉剩下的）与下带四张卡的宽度权重
  const [bands, setBands] = React.useState(() => readBands())
  const [cardFr, setCardFr] = React.useState(() => readCardFr())
  const bandsRef = React.useRef(bands)
  const cardFrRef = React.useRef(cardFr)
  bandsRef.current = bands
  cardFrRef.current = cardFr
  const splitDragRef = React.useRef(null)

  // ── 分隔条拖动（与坐标系是同一套手感：按住记起点、按百分比换算、夹像素下限、松手落盘）──
  React.useEffect(() => {
    const onMove = (event) => {
      const drag = splitDragRef.current
      if (drag === null) return
      const pct = (px, whole) => (whole > 0 ? (px / whole) * 100 : 0)
      if (drag.kind === 'row') {
        const delta = pct(event.clientY - drag.y0, drag.height)
        if (drag.which === 'top') {
          const max = 100 - drag.bands.bot - pct(BAND_MID_MIN_PX, drag.height)
          setBands({ top: clampNum(drag.bands.top + delta, pct(BAND_TOP_MIN_PX, drag.height), max), bot: drag.bands.bot })
        } else {
          const max = 100 - drag.bands.top - pct(BAND_MID_MIN_PX, drag.height)
          setBands({ top: drag.bands.top, bot: clampNum(drag.bands.bot - delta, pct(BAND_BOT_MIN_PX, drag.height), max) })
        }
      } else {
        // 卡宽用 **fr 权重**换算：这一拖等于把 d 份权重从左边那张挪给右边那张，总权重不变。
        // ⚠️ 每 fr 对应多少像素要用**全部四张**的总权重算（曾经只拿相邻两张的和算，
        //    于是拖 130px 只挪了 65px —— 手感差一半，真机探针实测抓到的）。
        const index = drag.index
        const a = drag.cardFr[index]
        const b = drag.cardFr[index + 1]
        const pxPerFr = drag.width > 0 && drag.totalFr > 0 ? drag.width / drag.totalFr : 0
        if (pxPerFr <= 0) return
        const minFr = CARD_MIN_PX / pxPerFr
        if (a + b <= minFr * 2) return          // 两张都到下限了：这一拖不动
        const left = clampNum(a + (event.clientX - drag.x0) / pxPerFr, minFr, a + b - minFr)
        const next = drag.cardFr.slice()
        next[index] = left
        next[index + 1] = a + b - left
        setCardFr(next)
      }
    }
    const onUp = () => {
      if (splitDragRef.current === null) return
      splitDragRef.current = null
      document.body.classList.remove('dshmo-dragging')
      // 落盘放在**松手**这一下（拖动过程中每帧写 localStorage 没必要，也拖慢手感）
      try {
        lsSetJSON('dshmo.bands', bandsRef.current)
        lsSetJSON('dshmo.cardFr', cardFrRef.current)
      } catch { /* 写不进去就只当本次有效 */ }
    }
    // ⚠️ 自测里本组件的树是用**桩 React** 渲染的（没有真 window）⇒ 先确认这两个方法在，
    //    否则 useEffect 一跑就抛，把整族判据判成"组件坏了"。
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      if (typeof window.removeEventListener !== 'function') return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  /** 按住一条分隔条：记下起点、容器尺寸与当前比例（比例走 ref，避免闭包里拿到过期值）。 */
  const startSplitDrag = (which, index) => (event) => {
    const root = rootRef.current
    if (root === null) return
    const rect = root.getBoundingClientRect()
    const grid = event.currentTarget === null || event.currentTarget === undefined
      ? null : event.currentTarget.parentElement
    event.preventDefault()
    splitDragRef.current = {
      which,
      kind: which === 'cols' ? 'col' : 'row',
      index: index ?? 0,
      y0: event.clientY,
      x0: event.clientX,
      height: rect.height,
      // 竖分隔条按**网格内容宽**换算（减掉左右 padding 与三条分隔条自身）；
      // `totalFr` 是四张卡权重之和 —— 少了它每 fr 的像素数会算成两倍，拖动就跟不上鼠标。
      width: grid === null ? 0 : Math.max(0, grid.clientWidth - 14 - CARD_SPLIT_PX * 3),
      totalFr: cardFrRef.current.reduce((sum, n) => sum + n, 0),
      bands: { ...bandsRef.current },
      cardFr: cardFrRef.current.slice(),
    }
    document.body.classList.add('dshmo-dragging')
  }
  /** 双击复位：三段回默认比例、四张卡回等宽 */
  const resetBands = () => {
    setBands({ top: BAND_TOP_PCT, bot: BAND_BOT_PCT })
    try { lsRemove('dshmo.bands') } catch { /* 忽略 */ }
  }
  const resetCards = () => {
    setCardFr(CARD_FR.slice())
    try { lsRemove('dshmo.cardFr') } catch { /* 忽略 */ }
  }

  React.useEffect(() => {
    const element = rootRef.current
    if (element === null || element === undefined) return undefined
    // 先用已挂载元素的宽度判断一次：没有 ResizeObserver 的环境（老浏览器、
    // 只跑函数组件的测试替身）也能得到正确的宽/窄判定，而不是永远按宽态渲染。
    const measured = element.clientWidth
    if (Number.isFinite(measured) && measured > 0) {
      setPanelWidth(measured)
      setCompact(measured < COMPACT_MAX)
    }
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? element.clientWidth ?? 0
      if (width > 0) {
        setPanelWidth(width)
        setCompact(width < COMPACT_MAX)
      }
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const g = metrics(!compact)

  const catalog = boot.catalog
  const profile = catalog === null ? null : profileOf(profileId)

  // ── 启动：取词汇表 + 本机 AI 现状，再拉该档案的模型库 ──────────────────
  React.useEffect(() => {
    let alive = true
    const off = []
    ;(async () => {
      try {
        const data = await api('/profiles')
        if (!alive) return
        setBoot({ state: 'ready', error: '', meta: null, catalog: data })
        const meta = await api('/meta').catch(() => null)
        if (!alive) return
        setBoot({ state: 'ready', error: '', meta, catalog: data })
      } catch (error) {
        if (!alive) return
        // host 不可达时不留白屏：用最近一次成功的本地缓存渲染（只读 + 可继续编辑）
        const cached = lsGetJSON('dshmo.catalog')
        setBoot({
          state: cached === null ? 'failed' : 'offline',
          error: error instanceof Error ? error.message : String(error),
          meta: null,
          catalog: cached,
        })
      }
    })()
    return () => { alive = false; off.forEach(fn => { try { fn() } catch { /* 已卸载 */ } }) }
  }, [])

  const refreshDocs = React.useCallback(async (pid) => {
    const cached = lsGetJSON(`dshmo.docs.${pid}`) || []
    let list = cached
    try {
      const data = await api(`/models?profile=${encodeURIComponent(pid)}`)
      list = data.models || []
      lsSetJSON(`dshmo.docs.${pid}`, list)
    } catch { /* 离线：用缓存列表 */ }
    setDocs(list)
    return list
  }, [])

  const openModel = React.useCallback(async (pid, name) => {
    const cached = lsGetJSON(`dshmo.doc.${pid}.${name}`)
    if (cached !== null) setModel(normalizeModel(cached, pid))
    try {
      const data = await api(`/model?profile=${encodeURIComponent(pid)}&name=${encodeURIComponent(name)}`)
      if (data?.model) {
        setModel(normalizeModel(data.model, pid))
        lsSetJSON(`dshmo.doc.${pid}.${name}`, data.model)
      }
    } catch {
      if (cached === null) setNotice('读不到这个模型（host 未响应，且本地没有缓存）')
    }
    setSelected(null)
    setConnectFrom(null)
    setRev(r => r + 1)
  }, [])

  /** 切档案：先刷新模型库，再打开第一个（没有就建一个空模型）。 */
  React.useEffect(() => {
    if (catalog === null) return
    let alive = true
    ;(async () => {
      // 档案一换，上一条模型立刻失效 —— 先清空，避免"画的是 A 档案、
      // 标题栏显示 A 的名字、右边却是 B 的词汇"这种半截状态。
      setModel(null)
      setSelected(null)
      setConnectFrom(null)
      const list = await refreshDocs(profileId)
      if (!alive) return
      if (list.length > 0) await openModel(profileId, list[0].name)
      else if (alive) { setModel(emptyModel(profileId)); setSelected(null); setRev(r => r + 1) }
    })()
    return () => { alive = false }
  }, [catalog, profileId, refreshDocs, openModel])

  React.useEffect(() => { lsSet('dshmo.profile', profileId) }, [profileId])
  React.useEffect(() => { if (catalog !== null) lsSetJSON('dshmo.catalog', catalog) }, [catalog])

  /** 一律经本函数改模型：改完 rev+1（驱动自动保存与重渲染）。 */
  const mutate = React.useCallback((fn) => {
    setModel(prev => {
      if (prev === null) return prev
      const draft = { ...prev, nodes: prev.nodes.map(n => ({ ...n })), edges: prev.edges.map(e => ({ ...e })) }
      const next = fn(draft) || draft
      return next
    })
    setRev(r => r + 1)
  }, [])

  // ── 自动保存（本地缓存即时、host 防抖 800ms）──────────────────────────
  //
  // ⚠️ 快照必须走 ref，不能读闭包里的 `model`：这个 effect 只声明 `[rev]`，
  // 但 effect 回调是在**它被调度的那次渲染**里创建的。同一帧里多次 mutate
  // （或 React 批处理后的追加重渲染）会让它在稍晚才执行，闭包里的 model 就
  // 落后一版 —— 实测症状：点了"加节点"，落盘载荷里少一个节点。
  const modelRef = React.useRef(model)
  modelRef.current = model
  React.useEffect(() => {
    const snapshot = modelRef.current
    if (snapshot === null || rev === 0) return
    lsSetJSON(`dshmo.doc.${snapshot.profile}.${snapshot.name}`, snapshot)
    setSaveState('dirty')
    const timer = setTimeout(() => {
      // 定时到点再取一次：这 800ms 内的改动都算在这一次写入里
      const latest = modelRef.current ?? snapshot
      setSaveState('saving')
      api('/model', { method: 'POST', body: JSON.stringify({ model: latest }) })
        .then(() => {
          setSaveState('saved')
          return refreshDocs(latest.profile)
        })
        .then(() => { setNotice('') })
        .catch((error) => {
          setSaveState('local')
          setNotice(`只存在本地：${error instanceof Error ? error.message : String(error)}`)
        })
    }, 800)
    return () => { clearTimeout(timer) }
    // rev 是唯一的变更信号；model/profile 在 rev 变化时已是最新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev])

  /**
   * 滚到某一层（层导航条用）。
   * 目标位置 = 该列左缘 - 列宽的一半（留一点上一列的余光，读者知道从哪来）。
   */
  const scrollToLevel = (level) => {
    const element = canvasRef.current
    if (element === null || element === undefined) return
    const target = Math.max(0, g.padX + level * g.colW - g.colW * 0.4 - 20)
    try {
      element.scrollTo({ left: target * (fitWidth ? scale : 1), behavior: 'smooth' })
    } catch {
      element.scrollLeft = target * (fitWidth ? scale : 1)
    }
    setActiveLevel(level)
  }

  /** 画布滚动时更新"当前在第几层"（用于层导航条高亮）。 */
  const onCanvasScroll = (event) => {
    const element = event.currentTarget
    setActiveLevel(viewLevelOf(element.scrollLeft, element.clientWidth, g.padX, g.colW, fitWidth ? scale : 1))
  }

  // ── 画布交互 ───────────────────────────────────────────────────────────
  const laid = model === null ? { positions: {}, width: 0, height: 0 } : positionMap(model, g)
  // 「适应宽度」：把整张五层图缩放进当前面板宽度，一屏看完（文字变小，是总览不是精读）
  const scale = fitWidth && laid.width > 0 && panelWidth > 0
    ? Math.max(0.24, Math.min(1, (panelWidth - 10) / laid.width))
    : 1
  const posOf = (node) => laid.positions[node.id] ?? { x: 0, y: 0 }

  const onNodeDown = (event, node) => {
    if (panMode) return
    event.stopPropagation()
    const point = posOf(node)
    dragRef.current = {
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: point.x,
      originY: point.y,
      moved: false,
    }
    setSelected(node.id)
    if (connectFrom === null) {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
  }

  const onPointerMove = React.useCallback((event) => {
    const drag = dragRef.current
    if (drag === null || model === null) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    if (!drag.moved) {
      drag.moved = true
    }
    setModel(prev => {
      if (prev === null) return prev
      return {
        ...prev,
        nodes: prev.nodes.map(n => (n.id === drag.id ? { ...n, x: Math.round(drag.originX + dx), y: Math.round(drag.originY + dy) } : n)),
      }
    })
  }, [model])

  const onPointerUp = React.useCallback(() => {
    if (dragRef.current !== null && dragRef.current.moved) setRev(r => r + 1)
    dragRef.current = null
  }, [])

  React.useEffect(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [onPointerMove, onPointerUp])

  const onNodeClick = (node) => {
    if (connectFrom === null) { setSelected(node.id); return }
    if (connectFrom === node.id) { setConnectFrom(null); return }
    mutate(draft => {
      draft.edges.push(newEdge(connectFrom, node.id, 'relates', ''))
    })
    setConnectFrom(null)
    setNotice('已连线（在右侧检验器里改类型与标签）')
  }

  const onCanvasClick = (event) => {
    if (event.target === event.currentTarget) { setSelected(null); setConnectFrom(null) }
  }

  // ── 操作 ───────────────────────────────────────────────────────────────
  const addNode = (level) => {
    const node = newNode(profileId, level, `${layerLabel(profileId, level)}节点`)
    mutate(draft => { draft.nodes.push(node) })
    setSelected(node.id)
  }

  const deleteNode = (id) => {
    mutate(draft => {
      draft.nodes = draft.nodes.filter(n => n.id !== id)
      draft.edges = draft.edges.filter(e => e.from !== id && e.to !== id)
    })
    setSelected(null)
  }

  const deleteEdge = (id) => {
    mutate(draft => { draft.edges = draft.edges.filter(e => e.id !== id) })
    setSelected(null)
  }

  const patchNode = (id, patch) => {
    mutate(draft => {
      draft.nodes = draft.nodes.map(n => (n.id === id ? { ...n, ...patch } : n))
    })
  }

  const patchAttr = (id, key, value) => {
    mutate(draft => {
      draft.nodes = draft.nodes.map(n => {
        if (n.id !== id) return n
        const attrs = { ...n.attrs }
        const coerced = coerceAttr(key, value)
        if (attrHasValue(coerced)) attrs[key] = coerced
        else delete attrs[key]
        return { ...n, attrs }
      })
    })
  }

  const patchEdge = (id, patch) => {
    mutate(draft => {
      draft.edges = draft.edges.map(e => (e.id === id ? { ...e, ...patch } : e))
    })
  }

  const autoLayout = () => {
    mutate(draft => {
      // 整理布局 = **显式**重排：先把坐标清空（连拖过的位置一起让出），再让
      // layoutModel 按层重算。layoutModel 自身永远优先手工坐标（画布是热路径，
      // 靠这一点保住每帧的拖拽结果），所以"整张图重排"必须由调用方显式表达。
      const cleared = { ...draft, nodes: draft.nodes.map(node => ({ ...node, x: null, y: null })) }
      const result = layoutModel(cleared, { force: true, colWidth: g.colW, rowHeight: g.rowH, padX: g.padX, padY: g.padY })
      draft.nodes = draft.nodes.map(n => ({ ...n, x: result.positions[n.id]?.x ?? null, y: result.positions[n.id]?.y ?? null }))
    })
    setNotice('已按抽象层重排')
  }

  const saveNow = () => {
    if (model === null) return
    setSaveState('saving')
    api('/model', { method: 'POST', body: JSON.stringify({ model }) })
      .then(() => { setSaveState('saved'); setNotice('已保存'); return refreshDocs(model.profile) })
      .catch(error => { setSaveState('local'); setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`) })
  }

  const newModel = async () => {
    const base = `新模型 ${new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`
    const fresh = emptyModel(profileId, base)
    setModel(fresh)
    setSelected(null)
    setRev(r => r + 1)
    lsSetJSON(`dshmo.doc.${profileId}.${base}`, fresh)
    try {
      await api('/model', { method: 'POST', body: JSON.stringify({ model: fresh }) })
      await refreshDocs(profileId)
      setNotice('已新建（空画布）')
    } catch { setNotice('新建只存在本地：host 未响应') }
  }

  const removeModel = async (name) => {
    try {
      await api(`/model?profile=${encodeURIComponent(profileId)}&name=${encodeURIComponent(name)}`, { method: 'DELETE' })
    } catch { /* 离线也允许从本地清掉 */ }
    lsRemove(`dshmo.doc.${profileId}.${name}`)
    const list = await refreshDocs(profileId)
    if (model !== null && model.name === name) {
      if (list.length > 0) await openModel(profileId, list[0].name)
      else { setModel(emptyModel(profileId)); setSelected(null); setRev(r => r + 1) }
    }
    setNotice('已删除')
  }

  const renameModel = (name) => {
    if (model === null) return
    const old = model.name
    const trimmed = String(name ?? '').slice(0, 80)
    setModel(prev => ({ ...prev, name: trimmed }))
    setRev(r => r + 1)
    // 改名 = 另存为新文件：旧文件必须清掉，否则模型库里会多一条同名旧版。
    if (trimmed !== old && trimmed.trim() !== '') {
      lsRemove(`dshmo.doc.${profileId}.${old}`)
      void api(`/model?profile=${encodeURIComponent(profileId)}&name=${encodeURIComponent(old)}`, { method: 'DELETE' })
        .catch(() => { /* host 未响应：下次连上时再清理 */ })
    }
  }

  /** 导出：真实落盘 + 复制到剪贴板 + 浏览器下载，三选一都可用。 */
  const exportAs = async (format) => {
    if (model === null) return
    const safe = model.name.replace(/[\\/:*?"<>|]/g, '_')
    const content = format === 'json' ? JSON.stringify(model, null, 2) : format === 'mermaid' ? toMermaid(model) : toMarkdown(model)
    const ext = format === 'json' ? 'json' : format === 'mermaid' ? 'mmd' : 'md'
    try {
      await navigator.clipboard.writeText(content)
      setNotice(`已复制 ${ext.toUpperCase()} 到剪贴板`)
    } catch {
      setNotice('剪贴板不可用，已改为下载')
    }
    try {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${safe}.${ext}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch { /* 下载失败时剪贴板已兜住 */ }
  }

  // ── 渲染 ───────────────────────────────────────────────────────────────
  if (boot.state === 'loading') {
    return h('div', { className: 'dshmo-root' },
      h('div', { className: 'dshmo-bar' }, h('span', { className: 'dshmo-title' }, '建模中心'), h('span', { className: 'dshmo-status' }, '正在读取词汇表…')),
      h('div', { className: 'dshmo-hint', style: { padding: '12px' } }, '正在连接 /modeling/api …'))
  }
  if (boot.state === 'failed') {
    return h('div', { className: 'dshmo-root' },
      h('div', { className: 'dshmo-bar' }, h('span', { className: 'dshmo-title' }, '建模中心'), h('span', { className: 'dshmo-dot off' }), h('span', { className: 'dshmo-status' }, 'host 未就绪')),
      h('div', { style: { padding: '12px' } },
        h('div', { className: 'dshmo-err' }, '读不到 /modeling/api/profiles：', boot.error),
        h('div', { className: 'dshmo-hint', style: { marginTop: '8px' } },
          'host 半段由 dsh-modeling 插件提供。若它是刚装上的，需要重启 DSH 才会加载（Node 会缓存已加载的 ESM 模块）。')))
  }

  const offline = boot.state === 'offline'
  const online = boot.meta?.ai?.available === true
  const selectedNode = selected !== null && model !== null ? model.nodes.find(n => n.id === selected) : undefined
  const selectedEdge = selected !== null && model !== null && selectedNode === undefined ? model.edges.find(e => e.id === selected) : undefined
  const issues = model === null ? [] : auditModel(model)

  const saveLabel = saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : saveState === 'local' ? '仅本地' : saveState === 'dirty' ? '未保存' : ''
  const dotClass = 'dshmo-dot' + (offline ? ' off' : saveState === 'saving' ? ' busy' : '')

  // ── 上带：档案 + 模型库 + 按层加节点 ────────────────────────────────────
  // 原来是竖着的左栏（三栏布局），在右侧栏里会把画布挤成竖条。
  // 现在横过来：档案做成胶囊按钮、模型做成横排 chip、五层做成五个色条按钮，整行放不下就横向滚动。
  const topStrip = (catalog.profiles || []).length > 0 && h('div', { className: 'dshmo-strip' },
    (catalog.profiles || []).map(profileRow => h('button', {
      key: profileRow.id,
      type: 'button',
      className: 'dshmo-pill' + (profileRow.id === profileId ? ' on' : ''),
      title: profileRow.summary,
      style: profileRow.id === profileId ? { '--dshmo-pill-color': LEVEL_COLORS[profileRow.id === 'methodology' ? 4 : profileRow.id === 'system' ? 0 : 1] } : undefined,
      onClick: () => setProfileId(profileRow.id),
    }, profileRow.label)),

    h('span', { className: 'dshmo-strip-sep' }),

    h('span', { className: 'dshmo-strip-label' }, '模型'),
    docs.length === 0
      ? h('span', { className: 'dshmo-hint' }, '（空）')
      : docs.map(doc => h('span', {
        key: doc.name,
        className: 'dshmo-chip' + (model !== null && model.name === doc.name ? ' on' : ''),
      },
      h('button', {
        type: 'button', className: 'dshmo-chip-b', title: `打开 ${doc.name}（${doc.nodes} 节点）`,
        onClick: () => { void openModel(profileId, doc.name) },
      }, doc.name),
      h('button', {
        type: 'button', className: 'dshmo-chip-x', title: '删除',
        onClick: () => { void removeModel(doc.name) },
      }, '×'))),
    h('button', { className: 'dshmo-btn sm', type: 'button', onClick: newModel, title: '新建空模型' }, '＋'),

    h('span', { className: 'dshmo-strip-sep' }),

    h('span', { className: 'dshmo-strip-label' }, '加节点'),
    (catalog.axis || AXIS).map(layer => h('button', {
      key: layer.level,
      className: 'dshmo-layer-chip', type: 'button',
      title: `${layer.name}：${layer.question}`,
      style: { '--dshmo-chip-color': LEVEL_COLORS[layer.level] },
      onClick: () => addNode(layer.level),
    }, `L${layer.level} ${layerLabel(profileId, layer.level)}`)))

  // ── 下带：四张卡片并排（检验器 / 体检 / 导出 / 环境）────────────────────
  // `key` 是必需的：这四张卡会以**数组**作为孩子渲染，且中间要插入三条竖分隔条
  // （见 cardGutters）—— 没有 key 时 React 会按数组下标对账，拖完宽度后卡片内容会串位。
  const card = (key, title, badge, body, extra) => h('div', { key, className: 'dshmo-card' + (extra ? ' ' + extra : '') },
    h('div', { className: 'dshmo-card-h' },
      h('span', { className: 't' }, title),
      badge !== null && badge !== undefined && h('span', { className: 'b' }, badge)),
    h('div', { className: 'dshmo-card-b' }, body))

  const inspectorBody = selectedNode !== undefined && selectedNode !== null
    ? h(NodeInspector, {
      model, node: selectedNode, catalog,
      onPatch: patch => patchNode(selectedNode.id, patch),
      onAttr: (key, value) => patchAttr(selectedNode.id, key, value),
      onDelete: () => deleteNode(selectedNode.id),
      onDeleteEdge: id => deleteEdge(id),
    })
    : selectedEdge !== undefined && selectedEdge !== null
      ? h(EdgeInspector, { model, edge: selectedEdge, onPatch: patch => patchEdge(selectedEdge.id, patch), onDelete: () => deleteEdge(selectedEdge.id) })
      : h('div', null,
        h('div', { className: 'dshmo-hint' }, '选中画布上的节点或连线，在这里编辑它。'),
        model !== null && h('div', { className: 'dshmo-field', style: { marginTop: '4px' } },
          h('label', null, '模型意图（一句话说清它要回答什么）'),
          h('textarea', {
            className: 'dshmo-ta', rows: 2, value: model.intent,
            placeholder: '例如：把「从零到交付」的这套做法讲清楚，让第二个人能照着做',
            onChange: event => { const value = event.currentTarget.value; mutate(draft => { draft.intent = value }) },
          })),
        h('div', { className: 'dshmo-hint' }, '依次点两个节点 → 生成一条边'))

  const bottomCards = [
    card('inspector', '检验器',
      // 选中对象的显示名（节点名 / 「连线」），没有选中就不显示角标
      selectedNode !== undefined && selectedNode !== null
        ? String(selectedNode.name ?? '')
        : (selectedEdge !== undefined && selectedEdge !== null ? '连线' : null),
      inspectorBody),
    card('audit', '体检', issues.length === 0 ? '通过' : String(issues.length), issues.length === 0
      ? h('div', { className: 'dshmo-hint' }, '五层都有内容、没有孤点、产出节点都有判据。')
      : issues.slice(0, 8).map((issue, index) => h('div', { key: String(index), className: `dshmo-issue ${issue.level}` }, h('i'), h('span', null, issue.text))),
    issues.length === 0 ? null : 'ok'),
    card('export', '导出', null, h('div', null,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
        h('button', { className: 'dshmo-btn sm', type: 'button', onClick: () => void exportAs('md') }, 'Markdown'),
        h('button', { className: 'dshmo-btn sm', type: 'button', onClick: () => void exportAs('mermaid') }, 'Mermaid'),
        h('button', { className: 'dshmo-btn sm', type: 'button', onClick: () => void exportAs('json') }, 'JSON')),
      h('div', { className: 'dshmo-hint', style: { marginTop: '4px' } },
        offline ? 'host 未响应：改动只在本机浏览器缓存里。' : '同时写剪贴板与下载'))),
    card('env', '环境', null, boot.meta === null
      ? h('div', { className: 'dshmo-hint' }, '未取到环境信息')
      : h('div', null,
        h('div', { className: 'dshmo-kv' }, h('span', null, '数据目录'), h('code', null, boot.meta.dataRoot)),
        h('div', { className: 'dshmo-kv' }, h('span', null, 'AI'),
          h('code', null, boot.meta.ai.available ? `${boot.meta.ai.provider} · ${boot.meta.ai.model}` : '不可用')) )),
  ]

  /**
   * 在四张卡之间插三条**竖**分隔条（下带宽度可拖）。
   *
   * 为什么把分隔条当网格里的列（而不是绝对定位覆盖）：卡的宽度是 fr 权重，边界位置随容器宽度
   * 连续变化，用绝对定位就得每帧自己算像素；当列放进去后浏览器自己排，拖动只改两个相邻权重。
   * 紧凑态（面板 < 620px，卡片排成两列）下不挂 —— 两列时"卡与卡之间"不是一条线，挂了会误导。
   */
  const cardGutters = cards => cards.flatMap((node, index) => (index === 0 ? [node] : [
    h('div', {
      key: 'vs' + index,
      className: 'dshmo-vsplit',
      'data-dshmo-split': 'cols',
      'data-dshmo-split-index': String(index - 1),
      role: 'separator',
      'aria-orientation': 'vertical',
      title: '拖动调整左右两张卡的宽度（双击恢复等宽）',
      onPointerDown: startSplitDrag('cols', index - 1),
      onDoubleClick: resetCards,
    }),
    node,
  ]))

  return h('div', { className: 'dshmo-root', 'data-dsh-modeling': '', ref: rootRef },
    // ── 上带：身份 + 工具栏 + 档案 / 模型库 / 按层加节点（**高度可拖**）──────
    h('div', {
      className: 'dshmo-top', 'data-dshmo-band': 'top',
      style: { flex: '0 0 ' + bands.top + '%' },
    },
    h('div', { className: 'dshmo-bar' },
      h('span', { className: 'dshmo-title' }, '建模中心'),
      h('span', { className: dotClass, title: offline ? 'host 未响应（本地缓存模式）' : online ? 'AI 可用' : 'AI 不可用（未挂 llm 服务）' }),
      model !== null && h('input', {
        className: 'dshmo-name',
        value: model.name,
        title: '模型名（改名即另存为新模型）',
        onChange: event => renameModel(event.currentTarget.value),
      }),
      saveLabel !== '' && h('span', { className: 'dshmo-status', style: { marginLeft: '0', flex: '0 0 auto' } }, saveLabel),
      h('span', { className: 'dshmo-status', style: { marginLeft: 'auto' } },
        notice || (model === null ? '' : `${model.nodes.length} 节点 · ${model.edges.length} 连边`))),

    h('div', { className: 'dshmo-tools' },
      h('button', { className: 'dshmo-btn primary', type: 'button', disabled: !online || busy, title: online ? '用当前会话的模型生成整张图' : '本部署没有挂 llm 服务', onClick: () => setAiOpen(true) }, '✦ AI 生成'),
      h('button', { className: 'dshmo-btn', type: 'button', onClick: autoLayout, title: '按抽象层重排所有节点' }, '整理布局'),
      h('button', {
        className: 'dshmo-btn' + (fitWidth ? ' on' : ''), type: 'button',
        title: fitWidth ? '恢复 1:1（可精读，横向滚动）' : '把五层缩进当前宽度，一屏看完（总览）',
        onClick: () => setFitWidth(v => !v),
      }, fitWidth ? '总览中' : '总览'),
      h('button', {
        className: 'dshmo-btn' + (panMode ? ' on' : ''), type: 'button',
        title: '平移模式（或按住空格拖画布）', onClick: () => setPanMode(v => !v),
      }, panMode ? '平移中' : '平移'),
      h('button', { className: 'dshmo-btn', type: 'button', onClick: saveNow }, '保存'),
      h('button', {
        className: 'dshmo-btn' + (bottomOpen ? ' on' : ''), type: 'button',
        title: bottomOpen ? '收起下带（把高度让给画布）' : '展开下带（检验器/体检/导出/环境）',
        onClick: () => setBottomOpen(v => !v),
      }, bottomOpen ? '收起下带' : '展开下带')),

    topStrip),

    // ── 上/中 之间的分隔条（拖动改上带高度；双击复位）───────────────────────
    h('div', {
      className: 'dshmo-hsplit', 'data-dshmo-split': 'top',
      role: 'separator', 'aria-orientation': 'horizontal',
      title: '拖动调整上带高度（双击复位）',
      onPointerDown: startSplitDrag('top'), onDoubleClick: resetBands,
    }),

    // ── 中带：画布（层导航条在它里面；吃掉剩下的高度）──────────────────────
    h('div', {
      className: 'dshmo-canvas' + (panMode ? ' pan' : '') ,
      'data-dshmo-band': 'mid',
      ref: canvasRef,
      onClick: onCanvasClick,
      onScroll: onCanvasScroll,
      onContextMenu: (event) => { event.preventDefault(); setConnectFrom(null) },
    },
    model !== null && model.nodes.length > 0 && h('div', { className: 'dshmo-layers' },
      (catalog.axis || AXIS).map(layer => {
        const count = model.nodes.filter(node => node.level === layer.level).length
        const color = LEVEL_COLORS[layer.level]
        return h('button', {
          key: layer.level,
          type: 'button',
          className: 'dshmo-layer' + (count === 0 ? ' empty' : '') + (activeLevel === layer.level ? ' on' : ''),
          title: `${layer.name}：${layer.question}（${count} 个节点）`,
          style: activeLevel === layer.level ? { '--dshmo-layer-color': color } : undefined,
          onClick: () => scrollToLevel(layer.level),
        },
        h('span', { className: 'k' }, `L${layer.level}`),
        h('span', { className: 'k' }, layerLabel(profileId, layer.level)),
        h('span', { className: 'n' }, count === 0 ? '空' : String(count)),
        h('span', { className: 'bar', style: { background: count === 0 ? undefined : color, opacity: count === 0 ? .35 : 1 } }))
      })),
    model === null || model.nodes.length === 0
      ? h('div', { className: 'dshmo-empty' },
        h('div', { style: { fontSize: '22px', opacity: .5 } }, '▢'),
        h('div', { className: 'dshmo-hint' },
          '空画布。三条路：上带「加节点」手搭；工具栏「✦ AI 生成」让模型起草；或点层导航条里任一层。'),
        h('div', { className: 'dshmo-hint' }, `当前档案：${profile?.label ?? profileId} —— ${profile?.summary ?? ''}`))
      : h(Canvas, {
        model, laid, selected, connectFrom, panMode, g, scale,
        onNodeDown, onNodeClick, onCanvasClick,
        onSelectEdge: (id) => setSelected(id),
      })),

    // ── 中/下 之间的分隔条 + 下带：四张卡片并排（高度、卡宽都能拖）──────────
    bottomOpen && h('div', {
      className: 'dshmo-hsplit', 'data-dshmo-split': 'bot',
      role: 'separator', 'aria-orientation': 'horizontal',
      title: '拖动调整下带高度（双击复位）',
      onPointerDown: startSplitDrag('bot'), onDoubleClick: resetBands,
    }),

    bottomOpen && h('div', {
      className: 'dshmo-cards' + (compact ? ' grid2' : ''),
      'data-dshmo-band': 'bot',
      style: compact
        ? { flex: '0 0 ' + bands.bot + '%' }
        : { flex: '0 0 ' + bands.bot + '%', gridTemplateColumns: frColumns(cardFr) },
    }, compact ? bottomCards : cardGutters(bottomCards)),

    aiOpen && h(AiDialog, {
      profile, profileId, online, catalog,
      onClose: () => setAiOpen(false),
      onBusy: setBusy,
      onApply: (draft) => {
        setModel(draft)
        setSelected(null)
        setConnectFrom(null)
        setRev(r => r + 1)
        setNotice(`已应用 AI 草稿（${draft.nodes.length} 节点 / ${draft.edges.length} 连边）`)
        setAiOpen(false)
      },
      onError: (message) => setNotice(message),
    }))
}
/* ── 画布（纯 SVG）──────────────────────────────────────────────────────── */

/** 画布：层列头 + 三阶贝塞尔连边 + 节点卡片。`g` 是本帧的画布度量（宽/窄态不同）。 */
function Canvas(props) {
  const { model, laid, selected, connectFrom, panMode, onNodeDown, onNodeClick, onCanvasClick } = props
  // 度量缺省即宽态：这个组件可被外部直接渲染（浮窗/自测），不该因为调用方忘了传 g 就崩
  const g = props.g ?? metrics(true)
  // 「总览」缩放：<1 时把整张图缩进面板宽度（SVG 外层尺寸跟着缩，内层整体 transform）
  const scale = Number.isFinite(props.scale) && props.scale > 0 ? props.scale : 1
  const svgWidth = Math.max(laid.width, g.colW * 2)
  const svgHeight = Math.max(laid.height, 360)
  const width = Math.round(svgWidth * scale)
  const height = Math.round(svgHeight * scale)
  const byId = {}
  for (const node of model.nodes) byId[node.id] = laid.positions[node.id] ?? { x: 0, y: 0 }

  return h('svg', {
    className: 'dshmo-svg',
    width, height,
    style: { minWidth: '100%', minHeight: '100%' },
    onClick: onCanvasClick,
  },
  // 缩放层：所有内容按布局坐标绘制，整体 transform —— 缩放不改变任何几何计算
  h('g', { transform: scale === 1 ? undefined : `scale(${scale})` },
  // 层列头（画布即"抽象层轴"的可视化）
  AXIS.map(layer => {
    const info = layerInfo(model.profile, layer.level)
    return h('g', { key: `head-${layer.level}` },
      h('line', {
        x1: g.padX + layer.level * g.colW - 16, y1: 8,
        x2: g.padX + layer.level * g.colW - 16, y2: height - 8,
        stroke: 'var(--dsw-alias-border-l1)', 'stroke-width': 1,
      }),
      h('text', { className: 'dshmo-colhead', x: g.padX + layer.level * g.colW, y: 16 },
        `L${layer.level} ${info.label}`),
      h('text', { className: 'dshmo-coldesc', x: g.padX + layer.level * g.colW, y: 28 },
        clip(info.question, compactHint(g.colW))))
  }),

  // 连边（先画，压在节点下面）
  model.edges.map(edge => {
    const from = byId[edge.from]
    const to = byId[edge.to]
    if (from === undefined || to === undefined) return null
    const type = EDGE_TYPES[edge.type] ?? EDGE_TYPES.relates
    const route = edgeRoute(from, to, g)
    const isSel = selected === edge.id
    // 方向必须看得见：只有 flow 画箭头的话，本模型 16 条边里会有 12 条是光秃秃的
    // 一条线，"依赖"与"产生"读起来完全没有方向。所以按关系语义给箭头：
    //   struct/flow → 终点箭头；conflicts（互相冲突）→ 两端箭头；relates → 无向。
    const headed = type.id !== 'relates'
    return h('g', { key: edge.id },
      h('path', {
        className: `dshmo-edge ${type.kind} ${route.shape}${isSel ? ' sel' : ''}`,
        d: route.d,
        'marker-end': headed ? 'url(#dshmo-arrow)' : undefined,
        'marker-start': type.id === 'conflicts' ? 'url(#dshmo-arrow)' : undefined,
      }),
      h('path', {
        // 命中区与可见线**同一份路径**：早先用 edgePath(...) 各算一次，等于两遍几何
        className: 'dshmo-hit',
        d: route.d,
        onClick: (event) => { event.stopPropagation(); props.onSelectEdge?.(edge.id) },
      }),
      h('text', { className: 'dshmo-elabel', x: route.mid.x, y: route.mid.y - 3 },
        clip(edge.label || type.label, 14)))
  }),

  h('defs', null,
    // 箭头：orient=auto-start-reverse 让同一个标记既能当终点箭头、也能被
    // marker-start 旋转 180° 当起点箭头（conflicts 两头都要）。
    // refX 取箭头尖端，标记才会正好落在路径端点上、而不是偏出去一截。
    h('marker', {
      id: 'dshmo-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    },
    h('path', { key: 'tip', d: 'M1,1 L9,5 L1,9 z', fill: 'currentColor', stroke: 'none' }))),

  // 节点
  model.nodes.map(node => {
    const point = byId[node.id]
    const color = LEVEL_COLORS[node.level] ?? LEVEL_COLORS[0]
    const lines = nodeLines(model, node)
    const attrN = attrCount(node)
    const isSel = selected === node.id
    const isLink = connectFrom === node.id
    // 窄态节点更矮，卡片内的行距与截断宽度都要跟着缩，否则文字会压出框外
    const compactNode = g.nodeW < NODE_W
    const chars = compactNode ? 16 : 20
    return h('g', {
      key: node.id,
      className: `dshmo-node${isSel ? ' sel' : ''}${isLink ? ' link' : ''}`,
      transform: `translate(${point.x},${point.y})`,
      onPointerDown: (event) => onNodeDown(event, node),
      onClick: (event) => { event.stopPropagation(); onNodeClick(node) },
    },
    h('rect', { className: 'dshmo-nbox', x: 0, y: 0, width: g.nodeW, height: g.nodeH, rx: 8 }),
    h('rect', { x: 0.5, y: 0.5, width: 3, height: g.nodeH - 1, rx: 1.5, fill: color }),
    h('text', { className: 'dshmo-nname', x: 12, y: compactNode ? 18 : 20 }, clip(node.name, chars)),
    h('text', { className: 'dshmo-ntype', x: 12, y: compactNode ? 32 : 35 }, clip(lines[0], chars + 10)),
    h('text', { className: 'dshmo-nmeta', x: 12, y: compactNode ? 46 : 51 }, clip(lines[1] ?? '', chars + 10)),
    !compactNode && h('text', { className: 'dshmo-nmeta', x: 12, y: 66 }, clip(lines[2] ?? '', chars + 10)),
    attrN > 0 && h('g', null,
      h('circle', { cx: g.nodeW - 15, cy: 14, r: 8, fill: color, opacity: .18 }),
      h('text', { className: 'dshmo-badge', x: g.nodeW - 15, y: 17, textAnchor: 'middle' }, String(attrN))))
  }))
  )
}

/* ── 检验器（右侧属性编辑）────────────────────────────────────────────── */

/** 节点检验器：名称 / 层 / 类型 / 说明 + 本类型声明的属性 facet。 */
function NodeInspector(props) {
  const { model, node, catalog, onPatch, onAttr, onDelete } = props
  const types = nodeTypesOf(model.profile, node.level)
  const declared = attrKeys(model.profile, node.type, node.attrs)
  const axis = (catalog.axis || AXIS)
  const info = layerInfo(model.profile, node.level)

  return h('div', null,
    h('div', { className: 'dshmo-sec' },
      h('div', { className: 'dshmo-sech' },
        h('span', null, '节点'),
        h('button', { className: 'dshmo-btn sm', type: 'button', style: { marginLeft: 'auto' }, onClick: onDelete, title: '删除节点及其连边' }, '删除')),
      h('div', { className: 'dshmo-field' },
        h('label', null, '名称'),
        h('input', { className: 'dshmo-in', value: node.name, onChange: event => onPatch({ name: event.currentTarget.value }) })),
      h('div', { className: 'dshmo-field' },
        h('label', null, `抽象层 L${node.level} ${info.label}`),
        h('select', {
          className: 'dshmo-sel', value: String(node.level),
          onChange: (event) => {
            const level = Number(event.currentTarget.value)
            const list = nodeTypesOf(model.profile, level)
            const keep = list.some(item => item.id === node.type) ? node.type : (list[0]?.id ?? node.type)
            onPatch({ level, type: keep })
          },
        }, axis.map(layer => h('option', { key: layer.level, value: String(layer.level) },
          `L${layer.level} ${layerLabel(model.profile, layer.level)}`)))) ,
      h('div', { className: 'dshmo-field' },
        h('label', null, '类型（决定朝向与可填属性）'),
        h('select', { className: 'dshmo-sel', value: node.type, onChange: event => onPatch({ type: event.currentTarget.value }) },
          types.map(item => h('option', { key: item.id, value: item.id },
            `${item.label}（${ORIENTATIONS[item.orientation].label}）`)))),
      h('div', { className: 'dshmo-hint' }, nodeTypeOf(model.profile, node.type).hint),
      h('div', { className: 'dshmo-field', style: { marginTop: '6px' } },
        h('label', null, '说明'),
        h('textarea', { className: 'dshmo-ta', rows: 2, value: node.desc, onChange: event => onPatch({ desc: event.currentTarget.value }) }))),

    h('div', { className: 'dshmo-sec' },
      h('div', { className: 'dshmo-sech' }, h('span', null, '属性'), h('span', { className: 'count' }, String(attrCount(node)))),
      h('div', { className: 'dshmo-hint', style: { marginBottom: '6px' } }, '留空即视为未填；数组类一行一条。'),
      declared.map(key => {
        const value = node.attrs?.[key]
        const list = attrType(key) === 'list'
        return h('div', { className: 'dshmo-field', key },
          h('label', null, `${attrLabel(key)}${ATTR_FIELDS[key]?.hint ? ` · ${ATTR_FIELDS[key].hint}` : ''}`),
          list
            ? h('textarea', {
              className: 'dshmo-ta', rows: 3,
              value: Array.isArray(value) ? value.join('\n') : (value ?? ''),
              onChange: event => onAttr(key, event.currentTarget.value.split('\n')),
            })
            : h('input', {
              className: 'dshmo-in', value: value ?? '',
              onChange: event => onAttr(key, event.currentTarget.value),
            }))
      }),
      // 未在类型里声明但已填的属性也要能改（不静默丢弃）
      Object.keys(node.attrs ?? {}).filter(key => !declared.includes(key)).map(key => h('div', { className: 'dshmo-field', key },
        h('label', null, attrLabel(key)),
        h('input', { className: 'dshmo-in', value: String(node.attrs[key] ?? ''), onChange: event => onAttr(key, event.currentTarget.value) }))),

      h('div', { className: 'dshmo-row', style: { marginTop: '4px' } },
        h('select', {
          className: 'dshmo-sel', value: '', onChange: event => { const key = event.currentTarget.value; if (key) onAttr(key, '') },
        },
        h('option', { value: '' }, '＋ 追加属性…'),
        Object.keys(ATTR_FIELDS).filter(key => !declared.includes(key))
          .map(key => h('option', { key, value: key }, `${ATTR_FIELDS[key].label}（${ATTR_FIELDS[key].type === 'list' ? '多行' : '单行'}）`)))) ),

    h('div', { className: 'dshmo-sec' },
      h('div', { className: 'dshmo-sech' }, h('span', null, '连边'), h('span', { className: 'count' }, String(model.edges.filter(e => e.from === node.id || e.to === node.id).length))),
      model.edges.filter(e => e.from === node.id || e.to === node.id).map(edge => {
        const other = model.nodes.find(n => n.id === (edge.from === node.id ? edge.to : edge.from))
        const type = EDGE_TYPES[edge.type] ?? EDGE_TYPES.relates
        return h('div', { key: edge.id, className: 'dshmo-doc' },
          h('span', null, `${edge.from === node.id ? '→' : '←'} ${other?.name ?? '?'} · ${type.label}`),
          h('button', { className: 'dshmo-x', type: 'button', onClick: () => props.onDeleteEdge?.(edge.id) }, '×'))
      })))
}

/** 连线检验器：类型 / 标签 / 端点 / 删除。 */
function EdgeInspector(props) {
  const { model, edge, onPatch, onDelete } = props
  const from = model.nodes.find(n => n.id === edge.from)
  const to = model.nodes.find(n => n.id === edge.to)
  return h('div', { className: 'dshmo-sec' },
    h('div', { className: 'dshmo-sech' },
      h('span', null, '连线'),
      h('button', { className: 'dshmo-btn sm', type: 'button', style: { marginLeft: 'auto' }, onClick: onDelete }, '删除')),
    h('div', { className: 'dshmo-hint', style: { marginBottom: '6px' } },
      `${from?.name ?? edge.from} → ${to?.name ?? edge.to}`),
    h('div', { className: 'dshmo-field' },
      h('label', null, '类型'),
      h('select', {
        className: 'dshmo-sel', value: edge.type,
        onChange: event => onPatch({ type: event.currentTarget.value }),
      }, Object.values(EDGE_TYPES).map(type => h('option', { key: type.id, value: type.id },
        `${type.label} · ${type.kind === 'flow' ? '过程' : type.kind === 'note' ? '注解' : '结构'}`)))),
    h('div', { className: 'dshmo-field' },
      h('label', null, '标签'),
      h('input', { className: 'dshmo-in', value: edge.label, onChange: event => onPatch({ label: event.currentTarget.value }) })),
    h('div', { className: 'dshmo-hint' }, (EDGE_TYPES[edge.type] ?? EDGE_TYPES.relates).hint))
}

/* ── AI 生成弹窗 ───────────────────────────────────────────────────────── */

/**
 * 生成草稿：把"要建模的内容"交给宿主当前会话所用的模型，回一张图**先预览后应用**。
 * 预览是硬要求 —— AI 输出永远不当场覆盖用户已有的图。
 */
function AiDialog(props) {
  const { profile, profileId, online, catalog, onClose, onApply, onError, onBusy } = props
  const [brief, setBrief] = React.useState('')
  const [name, setName] = React.useState('')
  const [level, setLevel] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [draft, setDraft] = React.useState(null)
  const [usage, setUsage] = React.useState('')

  React.useEffect(() => {
    let alive = true
    api(`/draft?profile=${encodeURIComponent(profileId)}`)
      .then(data => { if (alive && typeof data.brief === 'string') setBrief(data.brief) })
      .catch(() => { /* 模板取不到就留空 */ })
    return () => { alive = false }
  }, [profileId])

  const run = () => {
    if (brief.trim() === '') { setError('先写要建模的内容'); return }
    setBusy(true)
    setError('')
    onBusy?.(true)
    api('/generate', {
      method: 'POST',
      body: JSON.stringify({ profile: profileId, brief, name: name || undefined, level: level === '' ? undefined : Number(level) }),
    })
      .then(data => {
        if (data?.error) throw new Error(data.error)
        setDraft(normalizeModel(data.model, profileId))
        const dropped = data.dropped && (data.dropped.nodes > 0 || data.dropped.edges > 0)
          ? ` · 丢弃 ${data.dropped.nodes} 节点 / ${data.dropped.edges} 连边` : ''
        setUsage(`${data.provider || '?'} · ${data.modelId || '?'}${dropped}`)
      })
      .catch(caught => {
        const message = caught instanceof Error ? caught.message : String(caught)
        setError(message)
        onError?.(`AI 生成失败：${message}`)
      })
      .finally(() => { setBusy(false); onBusy?.(false) })
  }

  return h('div', { className: 'dshmo-modal', onMouseDown: event => { if (event.target === event.currentTarget) onClose() } },
    h('div', { className: 'dshmo-dialog' },
      h('h3', null, `✦ AI 生成 · ${profile?.label ?? profileId}`),
      h('div', { className: 'body' },
        !online && h('div', { className: 'dshmo-warn', style: { marginBottom: '8px' } },
          '本部署没有挂 llm 服务，生成不可用。可先手搭，或把下面这段要点贴给会话里的 agent 让它按同一套 JSON 产出。'),
        h('div', { className: 'dshmo-field' },
          h('label', null, '模型名（可留空，由模型命名）'),
          h('input', { className: 'dshmo-in', value: name, onChange: event => setName(event.currentTarget.value) })),
        h('div', { className: 'dshmo-field' },
          h('label', null, '重点层次（可留空）'),
          h('select', { className: 'dshmo-sel', value: level, onChange: event => setLevel(event.currentTarget.value) },
            h('option', { value: '' }, '全五层'),
            (catalog.axis || AXIS).map(layer => h('option', { key: layer.level, value: String(layer.level) },
              `L${layer.level} ${layerLabel(profileId, layer.level)}`)))),
        h('div', { className: 'dshmo-field' },
          h('label', null, '要建模的内容（越具体越好：议题、边界、必须成立的原则、已有做法）'),
          h('textarea', { className: 'dshmo-ta', rows: 9, value: brief, onChange: event => setBrief(event.currentTarget.value) })),
        error !== '' && h('div', { className: 'dshmo-err' }, error),
        usage !== '' && h('div', { className: 'dshmo-hint' }, `已生成：${usage}`),
        draft !== null && h('div', { className: 'dshmo-sec', style: { padding: '6px 0' } },
          h('div', { className: 'dshmo-sech' }, h('span', null, '预览'), h('span', { className: 'count' }, `${draft.nodes.length} 节点 / ${draft.edges.length} 连边`)),
          draft.nodes.map(node => h('div', { key: node.id, className: 'dshmo-doc' },
            h('i', { style: { width: '8px', height: '8px', borderRadius: '2px', background: LEVEL_COLORS[node.level] } }),
            h('span', null, node.name),
            h('em', null, `L${node.level} ${nodeTypeOf(draft.profile, node.type).label}`))))),
      h('div', { className: 'foot' },
        h('button', { className: 'dshmo-btn primary', type: 'button', disabled: busy || !online, onClick: run }, busy ? '生成中…' : '生成草稿'),
        draft !== null && h('button', { className: 'dshmo-btn', type: 'button', onClick: () => onApply(draft) }, '应用到画布'),
        h('button', { className: 'dshmo-btn push', type: 'button', onClick: onClose }, '关闭'))))
}

/* ── 小工具 ────────────────────────────────────────────────────────────── */

/** 浏览器存储／网络面。刻意不做特性探测：本组件只在浏览器里跑（模块加载器
 *  就是浏览器才有的东西），Node 自测会给 globalThis 补替身。 */
const browser = {
  fetch: (...args) => globalThis.fetch(...args),
  localStorage: () => globalThis.localStorage,
}

/** 调 host 路由，非 2xx / 带 error 一律 throw（调用点统一走 catch 分支）。 */
function api(path, init) {
  const options = init ?? {}
  return browser.fetch('/modeling/api' + path, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body,
  }).then(async (response) => {
    const text = await response.text()
    let data = null
    try { data = text === '' ? null : JSON.parse(text) } catch { throw new Error(`host 返回了非 JSON（${response.status}）`) }
    if (!response.ok) throw new Error((data && data.error) || `HTTP ${response.status}`)
    return data
  })
}

function lsGet(key) { try { return browser.localStorage()?.getItem(key) ?? null } catch { return null } }
function lsSet(key, value) { try { browser.localStorage()?.setItem(key, value) } catch { /* 隐私模式 */ } }
function lsRemove(key) { try { browser.localStorage()?.removeItem(key) } catch { /* 同上 */ } }
function lsGetJSON(key) {
  const raw = lsGet(key)
  if (raw === null) return null
  try { return JSON.parse(raw) } catch { return null }
}
function lsSetJSON(key, value) {
  try { lsSet(key, JSON.stringify(value)) } catch { /* 配额满：忽略，host 仍是真相源 */ }
}

/* ── 三段高度 / 四张卡宽度（2026-09-25 用户裁定，与坐标系同一套手感）────────────
 *
 * 上带（栏 + 工具栏 + 档案/模型/加节点条）与下带（四张卡）各自记一个**百分比**，
 * 中带（画布）吃掉剩下的高度 —— 这样"拖动"只改一个边界，画布自己伸缩，
 * 不会像"三段都写死百分比"那样在某些高度下把画布挤没。
 *
 * 默认值不是拍脑袋：实测用户正在用的实例（右侧栏 1080×1062）上，上带 99px（9.3%）、
 * 下带 168px（15.8%）、画布 795px —— 默认就取这两个数，第一眼与改造前**一模一样**。
 */
const BAND_TOP_PCT = 9.3
const BAND_BOT_PCT = 15.8
/** 拖动时的像素下限：上带 ≥70（栏+工具栏）、画布 ≥120（还能看图）、下带 ≥96（卡片还能读） */
const BAND_TOP_MIN_PX = 70
const BAND_MID_MIN_PX = 120
const BAND_BOT_MIN_PX = 96
/** 下带四张卡：网格列 = 卡 / 7px 分隔条 / 卡 / 7px / 卡 / 7px / 卡 */
const CARD_SPLIT_PX = 7
const CARD_FR = [1, 1, 1, 1]
const CARD_MIN_PX = 140

/** 夹到区间里（NaN / 非数一律回落到 min） */
function clampNum(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(n, min), max)
}

/** 读落盘的三段比例；缺字段 / 脏数据一律回落默认值。 */
function readBands() {
  const raw = lsGetJSON('dshmo.bands')
  if (raw === null || typeof raw !== 'object') return { top: BAND_TOP_PCT, bot: BAND_BOT_PCT }
  return { top: clampNum(raw.top, 0, 90), bot: clampNum(raw.bot, 0, 90) }
}

/** 读落盘的四张卡权重；数量不对 / 有非正数就整组回落等宽。 */
function readCardFr() {
  const raw = lsGetJSON('dshmo.cardFr')
  if (!Array.isArray(raw) || raw.length !== CARD_FR.length) return CARD_FR.slice()
  const nums = raw.map(n => Number(n))
  if (nums.some(n => !Number.isFinite(n) || n <= 0)) return CARD_FR.slice()
  return nums
}

/** 四张卡 + 三条分隔条的 `grid-template-columns`。 */
function frColumns(fr) {
  const list = Array.isArray(fr) && fr.length === CARD_FR.length ? fr : CARD_FR
  return list.map((n, i) => (i === 0 ? `${n}fr` : `${CARD_SPLIT_PX}px ${n}fr`)).join(' ')
}

    /** 主面板 id（`main` 键控席位；同一 id 的面板只会有一个实例）。 */
    const PANEL_ID = 'dsh-modeling:center'
    /** 旧名保留：既有套件按这个出口读值，值就是主面板 id。 */
    const SIDEBAR_TAB_ID = PANEL_ID

    /**
     * 客户端需要的服务。
     *
     * ⚠️ `timer` **必须声明**。`ctx.interval()`（连同 timeout / throttle /
     * debounce）是 `@deepseek-ai/cordis-plugin-timer` 的 TimerService 通过
     * `ctx.mixin` 混进 Context 的，cordis 要求先列进 `inject` 才允许读：
     * 少了它运行时直接抛 `cannot get property "interval" without inject`，
     * 整个客户端插件树报 "Failed to load plugins"（实测踩过）。
     * 同理，**今后任何 `ctx.<名字>` 的直读都必须先在这里声明**。
     *
     * `betterSidebar` 已随席位迁移一并撤掉（2026-09-24 用户裁定：四个工作台改挂 DSH
     * WebUI 自带的席位）。现在只用官方服务：`ctx.slots`（主面板 = `main` 键控席位）。
     */
    const inject = ['slots', 'timer']

    /**
     * 客户端插件入口。
     *
     * 入口在左侧栏底部的图标行里（由 dsh-workbench 统一渲染三枚图标），本插件只负责
     * 把主面板注册上；图标形状由该图标行自己画（同图两份，改一起改）。
     *
     * @param ctx 客户端 cordis 上下文（slots / timer）
     */
    function apply(ctx) {
      // 样式随插件生命周期挂载 / 卸载（HMR 与禁用都不留残留）。
      const style = document.createElement('style')
      style.setAttribute('data-dsh-modeling', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { try { style.remove() } catch (e) { /* 已摘除 */ } })

      // ── 席位接线（2026-09-24 用户裁定）：建模中心 = **DSH 自带右侧栏的一个 Tab** ——
      //    类型进 `ctx.sidebarRightTabs`，正文进键控席位 `sidebar.right.pane.tab`（key = 类型 id），
      //    与官方 `ui-sidebar-documentpreview` / `ui-sidebar-files` 同一条公开路径。
      //    这样"全屏 / 双栏分屏 / 拖拽"直接吃官方那条栏自带的一套；左侧栏底部那一行只负责把它打开。
      //    ⚠️ 不再注册 `main` 主面板（那会把中间的对话页换下去）。
      let registered = false
      function tryRegister() {
        if (registered) return
        // 非 WebUI 环境（没有渲染器）时静默降级：宁可什么都不注册，也不要让插件整体加载失败
        if (typeof ctx.slots?.inject !== 'function') return
        let tabs
        try { tabs = ctx.get('sidebarRightTabs') } catch (e) { tabs = undefined }
        if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return
        registered = true
        ctx.effect(() => tabs.register({
          id: PANEL_ID,
          kind: PANEL_ID,
          title: () => '建模中心',
          guide: [{
            // ★ 2026-10-15 改 41 → 35（统一顺序：
            //   工作台 31 → 驾驶舱 32 → 坐标系 33 → 工程图 34 → **建模中心 35** → 遥控器 36）。
            id: 'modeling', order: 35,
            title: () => '建模中心',
            description: () => '数据/服务架构与方法论建模（五层画布）',
            // 指南页入口卡上的图标（官方 IconProps：{size, className}）——没给的话官方画方块占位符。
            // 卡上用**彩色**那枚（官方那两张卡也是彩色）；单色的 iconModeling 留给标题条/左侧栏。
            icon: guideModeling,
          }],
        }))
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: PANEL_ID },
          () => React.createElement(ModelingCenter, { embedded: true }),
        )))
      }

      tryRegister()
      if (!registered) {
        // 官方右栏服务晚到位（激活顺序不保证）→ 每秒重试，最多 30 次；仍没有就静默降级（不报错）。
        let tries = 0
        const stopRetry = ctx.interval(() => {
          tries += 1
          tryRegister()
          if (registered || tries >= 30) { try { stopRetry() } catch (e) { /* 已停 */ } }
        }, 1000)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-modeling'
    // 测试钩子（selftest-client.mjs 在 Node 里直接验证建模代数与组件树，
    // 无需浏览器、无需真 React）
    exports.__test = {
      AXIS, LEVEL_COUNT, PROFILES, ATTR_FIELDS, EDGE_TYPES, ORIENTATIONS, LEVEL_COLORS,
      profileOf, layerInfo, layerLabel, nodeTypesOf, nodeTypeOf, orientationOf,
      attrKeys, attrLabel, attrType, attrHasValue, attrCount,
      normalizeModel, layoutModel, auditModel, toMarkdown, toMermaid,
      newId, newNode, newEdge, emptyModel, defaultNodeType, coerceAttr,
      clip, nodeLines, edgePath, edgeMid, edgeRoute, api, CSS,
      metrics, COMPACT_MAX, positionMap, compactHint, viewLevelOf,
      ModelingCenter, Canvas, NodeInspector, EdgeInspector, AiDialog, iconModeling, guideModeling,
      SIDEBAR_TAB_ID,
      // 三段高度 / 四张卡宽度那套（自测 C-30/C-31 直接读这些名字，不靠 grep 渲染代码猜）
      BAND_TOP_PCT, BAND_BOT_PCT, BAND_TOP_MIN_PX, BAND_MID_MIN_PX, BAND_BOT_MIN_PX,
      CARD_SPLIT_PX, CARD_FR, CARD_MIN_PX, clampNum, readBands, readCardFr, frColumns,
    }
    return module.exports
  },
})
