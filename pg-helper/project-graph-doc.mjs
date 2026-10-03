/**
 * 工程图 · **文档层**（`.prg` 的对象级操作）—— 零依赖，只用 node: 内置
 *
 * 这一层回答的是"文档里有什么、能怎么改"。上游 CLI 只认**项目级引用**（`n1` / `e1`），
 * 管不到容器与"没有引用"的对象；画布交互（拖动、框选、连线、嵌套）需要的是**对象级**的读写，
 * 所以这一层由我们自己实现，MCP server 与插件 host 半段**共用这一份**。
 *
 * ── ⚠️ 这一层最容易写错的地方：`$` 下标 ──────────────────────────────────
 * Graphif 序列化器把"同一个实例第二次出现"写成 `{ $: "<路径>" }`，路径是**从文档根算的**。
 * `stage.msgpack` 的根就是舞台数组，所以实测 `associationList: [{"$":"/0"},{"$":"/1"}]`
 * 指的是 `stage[0]` 与 `stage[1]`。
 *
 * ⇒ **插入 / 删除舞台对象会改变所有后续对象的下标**，所有 `$` 路径必须一起重编号；
 *   否则连线会**静默接到别的对象上**（不报错、看不出来，最难查的一类 bug）。
 *   本模块把"重编号"做成插入/删除的**内建步骤**，并由 `verify-project-graph-doc.mjs`
 *   用"改完之后每条边的两端 uuid 必须不变"来守。
 *
 * 路径是**可能带后缀**的（同一个节点也可能被嵌在分区里，路径形如 `/3/children/1`），
 * 所以重编号只改**第一段数字**，后面的原样保留。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { readPrg, writePrg } from './project-graph-prg.mjs'

/* ── 读 / 写 ───────────────────────────────────────────────────────────── */

export function readDocument(file) {
  const doc = readPrg(readFileSync(file))
  return { doc, stage: doc.stage === null ? [] : doc.stage }
}

export function writeDocument(file, doc, stage) {
  const out = writePrg(doc, { stage })
  writeFileSync(file, out)
  return out.length
}

/* ── 看 ────────────────────────────────────────────────────────────────── */

/**
 * 实体的几何存在 `collisionBox.shapes[*].{location,size}`（实测）。
 *
 * ⚠️ **Section 不一样**：它序列化出来的是 `_collisionBoxNormal` ——
 * `collisionBox` 在 Section 上是个 **getter**，按 `isCollapsed` / `locked` 现算、不落盘
 * （见 `app/src/core/stage/stageObject/entity/Section.tsx`）。两种都要认，
 * 否则分区会被当成"没有几何"而画不出来。
 */
export function shapesOf(object) {
  if (object === null || object === undefined) return null
  const box = object.collisionBox || object._collisionBoxNormal
  return box && Array.isArray(box.shapes) ? box.shapes : null
}

export function locationOf(object) {
  const shapes = shapesOf(object)
  if (shapes === null || shapes.length === 0 || !shapes[0].location) return null
  return { x: shapes[0].location.x, y: shapes[0].location.y }
}

export function sizeOf(object) {
  const shapes = shapesOf(object)
  if (shapes === null || shapes.length === 0 || !shapes[0].size) return null
  return { width: shapes[0].size.x, height: shapes[0].size.y }
}

export function isEdge(object) {
  return String(object && object._) === 'LineEdge'
}

/**
 * 舞台对象 → 摘要（配合画布用：坐标、尺寸、文本、父子、连线两端）。
 *
 * `stage` 是可选的，但**解析 Section 的 children 时必须给** ——
 * children 里存的是 `{$:'/N'}` 这种**指向舞台下标的引用**，不给 stage 就解不出 uuid。
 * （实测：Section 的 `children: Entity[]`，见 Section.tsx 第 71 行。）
 */
export function summarize(object, index, stage = null) {
  if (object === null || typeof object !== 'object') return { index, broken: true }
  const location = locationOf(object)
  const size = sizeOf(object)
  const links = Array.isArray(object.associationList)
    ? object.associationList.map((entry) => (entry && typeof entry.$ === 'string' ? entry.$ : null))
    : undefined
  const childUuids = Array.isArray(object.children)
    ? object.children.map((child) => {
      if (child && typeof child.uuid === 'string') return child.uuid          // 内联对象
      const parsed = child && typeof child.$ === 'string' ? parseRefPath(child.$) : null
      if (parsed === null || stage === null) return null
      const target = stage[parsed.index]
      return target && typeof target.uuid === 'string' ? target.uuid : null
    }).filter((uuid) => uuid !== null)
    : undefined
  return {
    index,
    uuid: typeof object.uuid === 'string' ? object.uuid : null,
    type: typeof object._ === 'string' ? object._ : null,
    text: typeof object.text === 'string' ? object.text : undefined,
    details: object.details,
    location,
    size,
    links,
    // 分区（Section）的嵌套：子对象的 uuid 列表
    childUuids,
    // 分区自己的三个状态字段（Section.tsx 第 74/80/85 行）
    collapsed: typeof object.isCollapsed === 'boolean' ? object.isCollapsed : undefined,
    locked: typeof object.locked === 'boolean' ? object.locked : undefined,
    borderStyle: typeof object.borderStyle === 'string' ? object.borderStyle : undefined,
    fields: Object.keys(object),
  }
}

/* ── `$` 路径 ──────────────────────────────────────────────────────────── */

const PATH_RE = /^\/(\d+)(\/[\s\S]*)?$/

/** 一条 `$` 路径解析成 `{ index, rest }`；不是舞台下标就返回 null。 */
export function parseRefPath(path) {
  const m = PATH_RE.exec(String(path))
  if (m === null) return null
  return { index: Number(m[1]), rest: m[2] === undefined ? '' : m[2] }
}

/** 深度遍历一个对象树，把每条 `$` 路径交给 visitor（可原地改）。 */
function walkRefs(node, visit, seen = new Set()) {
  if (node === null || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, visit, seen)
    return
  }
  if (typeof node.$ === 'string') visit(node)
  for (const key of Object.keys(node)) {
    if (key === '$') continue
    walkRefs(node[key], visit, seen)
  }
}

/** 整个舞台里所有 `$` 路径（去重后按出现顺序）。 */
export function collectRefPaths(stage) {
  const out = new Set()
  walkRefs(stage, (holder) => { out.add(holder.$); holder.$ = holder.$ })
  return [...out]
}

/**
 * 给所有 `$` 路径重新编号。
 * `map(oldIndex) -> newIndex`；返回 null 表示"这条引用指向的对象被删了"。
 *
 * ⚠️ 返回被丢下的引用（orphans）而不是自己决定怎么办 —— 这是本模块最关键的一处：
 * 指向被删对象的 `$` 路径**未必越界**。实测踩到：删掉 `stage[0]` 之后，
 * 原来写 `/0` 的那条边没被改，而新数组的 `stage[0]` 已经是**另一个对象**了 ——
 * 越界检查一点都抓不到，连线就这么静默接到了别人身上。
 * 所以调用方必须拿 orphans 做判断，**不许静默留一个指向别人的下标**。
 *
 * `skip` = 整个对象都要被删掉的那些顶层下标：**它们内部的引用不算孤儿**
 * （对象本身都没了，里面的指针跟着消失，不该拦住这次删除）。实测踩到过这一条。
 */
function renumber(stage, from, to, map, skip = null) {
  const orphans = []
  stage.forEach((object, index) => {
    if (skip !== null && skip.has(index)) return
    walkRefs(object, (holder) => {
      const parsed = parseRefPath(holder.$)
      if (parsed === null) return
      if (parsed.index < from || parsed.index > to) return
      const next = map(parsed.index)
      if (next === null || next === undefined) { orphans.push({ path: holder.$, index: parsed.index }); return }
      holder.$ = `/${next}${parsed.rest}`
    })
  })
  return orphans
}

/** 有引用指向"已被删掉的对象"就抛；`orphans` 由 `renumber` 收集。 */
function assertNoOrphanRefs(orphans, what) {
  if (orphans.length === 0) return
  const samples = [...new Set(orphans.map((o) => o.path))].slice(0, 5).join(', ')
  throw new Error(
    `${what}：有 ${orphans.length} 条 $ 引用指向**已被删掉**的对象（${samples}）—— `
    + '这些下标现在会指向别的对象，必须连带删掉引用方（用 removeObjectsAndDanglingEdges），或改为不删。',
  )
}

/** 舞台里每条 `$` 路径 → 它指向的那个对象的 uuid（用于改动前后的对照断言）。 */
export function edgeEndpoints(stage) {
  const uuidAt = (index) => {
    const object = stage[index]
    return object && typeof object.uuid === 'string' ? object.uuid : null
  }
  const out = []
  stage.forEach((object, index) => {
    if (!isEdge(object)) return
    const links = Array.isArray(object.associationList) ? object.associationList : []
    const resolve = (entry) => {
      if (!entry || typeof entry.$ !== 'string') return null
      const parsed = parseRefPath(entry.$)
      if (parsed === null) return null
      if (parsed.rest === '') return uuidAt(parsed.index)
      // 带后缀的路径：指到那个对象的内部，仍然算"这条边连的是 stage[parsed.index] 那个对象"
      return uuidAt(parsed.index)
    }
    out.push({ edgeUuid: object.uuid, from: resolve(links[0]), to: resolve(links[1]) })
  })
  return out
}

/* ── 写：插入 / 删除 / 移动（都会照顾 `$` 下标）──────────────────────────── */

/**
 * 在 `at` 处插入若干对象。**先重编号、再插入** —— 顺序反了就会把新对象自己算进去。
 * 返回新的舞台数组。
 *
 * ⚠️ 必须**深拷贝**再改：`$` 路径就写在对象里，而 `stage.slice()` 是浅拷贝 ——
 * 直接改会让**调用方手上那个数组**一起变（实测踩到：连续两次 insert，第二次基于被改坏的 stage，
 * 连线接到自己身上）。拷完再重编号，调用方的数据不动。
 *
 * 插入的 `list` **不拷贝**：它们的内部 `$` 路径按"插入后"的下标书写，由调用方负责。
 */
export function insertObjects(stage, objects, at = null) {
  const list = Array.isArray(objects) ? objects : [objects]
  if (list.length === 0) return structuredClone(stage)
  const index = at === null || at === undefined ? stage.length : Number(at)
  if (!Number.isInteger(index) || index < 0 || index > stage.length) {
    throw new Error(`插入位置不合法：${at}（舞台长 ${stage.length}）`)
  }
  const next = structuredClone(stage)
  const orphans = renumber(next, index, next.length - 1, (old) => old + list.length)
  next.splice(index, 0, ...list)
  assertNoOrphanRefs(orphans, '插入对象')
  assertNoDanglingRefs(next)
  return next
}

/**
 * 删除若干下标处的对象。
 * ⚠️ 删完之后**必须校验**：任何 `$` 路径都不许再指向被删的对象。
 * 有悬空引用就直接抛（调用方应当连带删掉那条边，或改用 `removeObjectsAndDanglingEdges`）。
 */
export function removeObjects(stage, indexes) {
  const doomed = [...new Set((Array.isArray(indexes) ? indexes : [indexes]).map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 0 && n < stage.length)
    .sort((a, b) => a - b)
  if (doomed.length === 0) return structuredClone(stage)
  const doomedSet = new Set(doomed)
  const next = structuredClone(stage)
  const orphans = renumber(next, 0, next.length - 1, (old) => {
    if (doomedSet.has(old)) return null
    return old - doomed.filter((d) => d < old).length
  }, doomedSet)
  const kept = []
  next.forEach((object, i) => { if (!doomedSet.has(i)) kept.push(object) })
  assertNoOrphanRefs(orphans, '删除对象')
  assertNoDanglingRefs(kept)
  return kept
}

/**
 * 删除对象，并**连带删掉因此悬空的连线**（画布上"删节点"就是这个语义 ——
 * 上游 `delete_node` 的说明也是"删除节点及其关联连线"）。
 */
export function removeObjectsAndDanglingEdges(stage, indexes) {
  let doomed = [...new Set((Array.isArray(indexes) ? indexes : [indexes]).map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 0 && n < stage.length)
  if (doomed.length === 0) return structuredClone(stage)

  // 迭代到不动点：删掉一条边之后，如果那条边自己也被别的边指着，还要继续删（保守起见跑几轮）
  for (let round = 0; round < 8; round++) {
    const gone = new Set(doomed.map((i) => entityUuid(stage, i)))
    const extra = []
    stage.forEach((object, index) => {
      if (doomed.includes(index)) return
      if (!isEdge(object)) return
      const links = Array.isArray(object.associationList) ? object.associationList : []
      const dangling = links.some((entry) => {
        if (!entry || typeof entry.$ !== 'string') return false
        const parsed = parseRefPath(entry.$)
        if (parsed === null) return false
        return doomed.includes(parsed.index) || gone.has(entityUuid(stage, parsed.index))
      })
      if (dangling) extra.push(index)
    })
    if (extra.length === 0) break
    doomed = [...new Set([...doomed, ...extra])].sort((a, b) => a - b)
  }

  const doomedSet = new Set(doomed)
  const next = structuredClone(stage)
  const orphans = renumber(next, 0, next.length - 1, (old) => {
    if (doomedSet.has(old)) return null
    return old - doomed.filter((d) => d < old).length
  }, doomedSet)
  const kept = []
  next.forEach((object, index) => { if (!doomedSet.has(index)) kept.push(object) })
  // 这条路径**不该**留下孤儿引用 —— 真留下就说明上面那轮"悬空边"判定漏了东西，必须炸出来
  assertNoOrphanRefs(orphans, '连带删除悬空边')
  assertNoDanglingRefs(kept)
  return kept
}

function entityUuid(stage, index) {
  const object = stage[index]
  return object && typeof object.uuid === 'string' ? object.uuid : `#index:${index}`
}

/** 任何 `$` 路径指向的下标都必须还在范围内 —— 越界就是"接错对象"的前兆，直接抛。 */
export function assertNoDanglingRefs(stage) {
  const bad = []
  walkRefs(stage, (holder) => {
    const parsed = parseRefPath(holder.$)
    if (parsed === null) return
    if (parsed.index < 0 || parsed.index >= stage.length) bad.push(holder.$)
  })
  if (bad.length > 0) {
    throw new Error(`有 ${bad.length} 条 $ 引用指向舞台外（下标越界）：${[...new Set(bad)].slice(0, 5).join(', ')}`)
  }
}

/**
 * 批量改几何 —— **一次改完、一次写盘**。
 * 拖动多选时一次要动十几个对象；每个对象单独跑一次 CLI（3~5 秒）体验不可用，所以必须有这条。
 * `moves: [{ uuid, x?, y?, width?, height? }]`
 */
export function moveBatch(stage, moves) {
  const list = Array.isArray(moves) ? moves : [moves]
  const byUuid = new Map()
  stage.forEach((object, index) => {
    if (object && typeof object.uuid === 'string') byUuid.set(object.uuid, index)
  })
  const applied = []
  const missing = []
  for (const move of list) {
    const uuid = String((move && move.uuid) || '')
    const index = byUuid.get(uuid)
    if (index === undefined) { missing.push(uuid); continue }
    const object = stage[index]
    const shapes = shapesOf(object)
    if (shapes === null || shapes.length === 0) { missing.push(`${uuid}（无 collisionBox）`); continue }
    const touched = []
    for (const shape of shapes) {
      if (move.x !== undefined && move.x !== null) {
        if (!shape.location) throw new Error(`${uuid} 的 shape 上没有 location，拒绝新造一个`)
        shape.location.x = Number(move.x); touched.push('x')
      }
      if (move.y !== undefined && move.y !== null) {
        if (!shape.location) throw new Error(`${uuid} 的 shape 上没有 location，拒绝新造一个`)
        shape.location.y = Number(move.y); touched.push('y')
      }
      if (move.width !== undefined && move.width !== null) {
        if (!shape.size) throw new Error(`${uuid} 的 shape 上没有 size，拒绝新造一个`)
        shape.size.x = Number(move.width); touched.push('width')
      }
      if (move.height !== undefined && move.height !== null) {
        if (!shape.size) throw new Error(`${uuid} 的 shape 上没有 size，拒绝新造一个`)
        shape.size.y = Number(move.height); touched.push('height')
      }
    }
    applied.push({ uuid, index, touched: [...new Set(touched)] })
  }
  return { applied, missing, moved: applied.length }
}

/* ── 新建对象 ──────────────────────────────────────────────────────────── */

/**
 * 兜底模板 —— **只在新文档里连一个可克隆的同类对象都没有时**才用。
 *
 * 形状是照本机 `.prg` 2.7.0 实测抄的（见 §字段顺序不重要，键集合重要）：
 *   TextNode  11 个键：_ details uuid text collisionBox color fontScaleLevel
 *                       sizeAdjust fontFamily fontWeight borderStyle
 *   LineEdge   9 个键：_ associationList color targetRectangleRate sourceRectangleRate
 *                       uuid text lineType arrowType
 *
 * ⚠️ 这是"新工程画第一笔"必需的一条路：空工程只有一个根节点，**没有连线可克隆**，
 * 而画布上从节点拖出连线是基本操作。所以不是可选优化，是必须有的。
 * 它是否真被上游接受，由 `verify-project-graph-doc.mjs` 的端到端那几条**拿上游 CLI 验**。
 */
export const FALLBACK_TEXT_NODE = Object.freeze({
  _: 'TextNode',
  details: [],
  uuid: '',
  text: '',
  collisionBox: Object.freeze({
    _: 'CollisionBox',
    shapes: Object.freeze([Object.freeze({
      _: 'Rectangle',
      location: Object.freeze({ _: 'Vector', x: 0, y: 0 }),
      size: Object.freeze({ _: 'Vector', x: 200, y: 76 }),
    })]),
  }),
  color: Object.freeze({ _: 'Color', r: 0, g: 0, b: 0, a: 0 }),
  fontScaleLevel: 0,
  sizeAdjust: 'auto',
  fontFamily: '',
  fontWeight: '',
  borderStyle: 'solid',
})

export const FALLBACK_LINE_EDGE = Object.freeze({
  _: 'LineEdge',
  associationList: Object.freeze([Object.freeze({ $: '/0' }), Object.freeze({ $: '/0' })]),
  color: Object.freeze({ _: 'Color', r: 0, g: 0, b: 0, a: 0 }),
  targetRectangleRate: Object.freeze({ _: 'Vector', x: 0.01, y: 0.5 }),
  sourceRectangleRate: Object.freeze({ _: 'Vector', x: 0.99, y: 0.5 }),
  uuid: '',
  text: '',
  lineType: 'solid',
  arrowType: 'default',
})

/**
 * 造一个新的 TextNode —— **优先克隆文档里已有的一个**，只换 uuid / 文本 / 坐标 / 尺寸。
 *
 * 为什么不写死模板：`.prg` 的格式版本会变（本机 2.7.0 实测 TextNode 有 11 个字段）。
 * 写死的模板在别的版本上可能缺字段或多字段，**上游打不开就麻烦了**；
 * 克隆同文档里已有的同类对象，形状天然与这个版本一致。
 * 只有连一个同类对象都没有时才退回 `FALLBACK_TEXT_NODE`。
 *
 * 返回**新对象**（不插入）；插入请用 `insertObjects`。
 */
export function makeTextNode(stage, spec = {}) {
  const template = stage.find((object) => object && object._ === 'TextNode' && object.collisionBox)
  const node = structuredClone(template === undefined ? FALLBACK_TEXT_NODE : template)
  node.uuid = spec.uuid === undefined ? randomUUID() : String(spec.uuid)
  node.text = String(spec.text === undefined ? '新节点' : spec.text)
  if (Object.prototype.hasOwnProperty.call(node, 'details')) node.details = []
  const shapes = node.collisionBox && Array.isArray(node.collisionBox.shapes) ? node.collisionBox.shapes : null
  if (shapes === null || shapes.length === 0) return { ok: false, error: '模板 TextNode 没有 collisionBox.shapes' }
  const put = (field, key, value) => {
    if (value === undefined || value === null) return
    const number = Number(value)
    if (!Number.isFinite(number)) return
    if (!shapes[0][field]) throw new Error(`模板的 shape 上没有 ${field}，拒绝新造一个`)
    shapes[0][field][key] = number
  }
  try {
    put('location', 'x', spec.x)
    put('location', 'y', spec.y)
    put('size', 'x', spec.width)
    put('size', 'y', spec.height)
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  return { ok: true, node, cloned: template !== undefined }
}

/**
 * 造一条新的 LineEdge —— 同样优先克隆；没有可克隆的就退回 `FALLBACK_LINE_EDGE`。
 * `associationList` 里的 `$` 是**舞台下标**，所以 `sourceIndex` / `targetIndex` 应当是
 * **插入之后**那张舞台上的下标（`insertObjects` 会照顾既有对象的引用，但新对象自己
 * 内部的引用由调用方写准）。
 */
export function makeEdge(stage, sourceIndex, targetIndex, spec = {}) {
  const template = stage.find((object) => object && isEdge(object) && Array.isArray(object.associationList))
  const edge = structuredClone(template === undefined ? FALLBACK_LINE_EDGE : template)
  edge.uuid = spec.uuid === undefined ? randomUUID() : String(spec.uuid)
  edge.text = String(spec.text === undefined ? '' : spec.text)
  const links = edge.associationList
  if (!Array.isArray(links) || links.length < 2) return { ok: false, error: '模板 LineEdge 的 associationList 少于两项' }
  const wanted = [sourceIndex, targetIndex]
  for (let i = 0; i < links.length; i++) {
    const holder = links[i]
    if (!holder || typeof holder.$ !== 'string') return { ok: false, error: '模板 LineEdge 的 associationList 项不是 $ 引用' }
    if (i >= wanted.length) continue
    const parsed = parseRefPath(holder.$)
    holder.$ = `/${Number(wanted[i])}${parsed === null ? '' : parsed.rest}`
  }
  return { ok: true, edge, cloned: template !== undefined }
}

/**
 * 改一条已有连线的两端（画布上"拖端点改接线"）。
 *
 * ⚠️ 与 `insertObjects` 不同：**只改一个对象内部的 `$`，不动数组**，所以不需要重编号 ——
 * 这正是"拖端点"比"插对象"安全的地方。改完照样校验一遍引用不越界。
 * `sourceUuid` / `targetUuid` 给 null 表示那一端不动。
 */
export function reconnectEdge(stage, edgeUuid, sourceUuid, targetUuid) {
  const indexOf = (uuid) => stage.findIndex((object) => object && object.uuid === uuid)
  const edgeIndex = indexOf(String(edgeUuid))
  if (edgeIndex < 0) return { ok: false, error: `没有这条连线：${edgeUuid}` }
  const edge = stage[edgeIndex]
  if (!isEdge(edge)) return { ok: false, error: `${edgeUuid} 不是连线（是 ${edge && edge._}）` }
  const links = Array.isArray(edge.associationList) ? edge.associationList : null
  if (links === null || links.length < 2) return { ok: false, error: '这条连线的 associationList 少于两项' }

  const wanted = [sourceUuid, targetUuid]
  const next = structuredClone(stage)
  const nextEdge = next[edgeIndex]
  for (let i = 0; i < 2; i++) {
    const wantedUuid = wanted[i]
    if (wantedUuid === undefined || wantedUuid === null || wantedUuid === '') continue
    const target = indexOf(String(wantedUuid))
    if (target < 0) return { ok: false, error: `没有这个对象：${wantedUuid}` }
    const holder = nextEdge.associationList[i]
    if (!holder || typeof holder.$ !== 'string') return { ok: false, error: 'associationList 项不是 $ 引用' }
    const parsed = parseRefPath(holder.$)
    holder.$ = `/${target}${parsed === null ? '' : parsed.rest}`
  }
  try {
    assertNoDanglingRefs(next)
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  return { ok: true, stage: next, from: nextEdge.associationList[0].$, to: nextEdge.associationList[1].$ }
}

/* ── 分区（嵌套）──────────────────────────────────────────────────────── */

/**
 * 分区自己的三个开关（`Section.tsx`：`isCollapsed` / `locked` / `borderStyle`）。
 * **只改字段、不动数组**，所以不需要重编号。
 *
 * ⚠️ 折叠后的包围盒是**现算的**（`collapsedCollisionBox()`），不落盘；
 * 落盘的只有 `_collisionBoxNormal`。所以我们只需要把 `isCollapsed` 翻过去。
 */
export function setSectionFlags(stage, sectionUuid, patch = {}) {
  const index = stage.findIndex((object) => object && object.uuid === String(sectionUuid))
  if (index < 0) return { ok: false, error: `没有这个对象：${sectionUuid}` }
  const section = stage[index]
  if (String(section._) !== 'Section') return { ok: false, error: `${sectionUuid} 不是分区（是 ${section._}）` }
  const next = structuredClone(stage)
  const target = next[index]
  const applied = []
  const put = (key, value, check) => {
    if (value === undefined || value === null) return null
    if (!Object.prototype.hasOwnProperty.call(target, key)) return `这个分区上没有 ${key} 字段`
    if (check !== undefined && check(value) !== true) return `${key} 的取值不合法：${JSON.stringify(value)}`
    target[key] = value
    applied.push(key)
    return null
  }
  const errors = [
    put('isCollapsed', patch.collapsed === undefined ? undefined : patch.collapsed === true,
      (v) => typeof v === 'boolean'),
    put('locked', patch.locked === undefined ? undefined : patch.locked === true, (v) => typeof v === 'boolean'),
    put('borderStyle', patch.borderStyle === undefined ? undefined
      : (['solid', 'dashed', 'none'].includes(String(patch.borderStyle)) ? String(patch.borderStyle) : undefined),
    (v) => typeof v === 'string'),
  ].filter((item) => item !== null)
  if (errors.length > 0) return { ok: false, error: errors.join('；') }
  if (applied.length === 0) return { ok: false, error: '没有要给的东西（collapsed / locked / borderStyle）' }
  try {
    assertNoDanglingRefs(next)
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  return {
    ok: true, stage: next, applied,
    state: {
      collapsed: target.isCollapsed, locked: target.locked, borderStyle: target.borderStyle,
    },
  }
}

/**
 * 把某个对象**归入**一个分区，或从分区里拿出来（`sectionUuid` 给 null = 拿出来）。
 *
 * 关键：这只在分区的 `children` 数组里**加/减一条 `{$:'/N'}` 引用**，
 * **完全不动舞台数组** —— 所以不需要重编号（与 `reconnectEdge` 一样是安全的写法）。
 * 这正是序列化器用 `$` 的意义：同一个对象既在舞台上、又被分区引用着。
 *
 * 一个对象同时只归一个分区：加之前会把它从别的分区里摘掉。
 */
export function setParent(stage, childUuid, sectionUuid) {
  const indexOf = (uuid) => stage.findIndex((object) => object && object.uuid === uuid)
  const childIndex = indexOf(String(childUuid))
  if (childIndex < 0) return { ok: false, error: `没有这个对象：${childUuid}` }
  let sectionIndex = -1
  if (sectionUuid !== null && sectionUuid !== undefined && sectionUuid !== '') {
    sectionIndex = indexOf(String(sectionUuid))
    if (sectionIndex < 0) return { ok: false, error: `没有这个分区：${sectionUuid}` }
    if (sectionIndex === childIndex) return { ok: false, error: '分区不能把自己当子对象' }
    if (String(stage[sectionIndex]._) !== 'Section') {
      return { ok: false, error: `${sectionUuid} 不是分区（是 ${stage[sectionIndex]._}）` }
    }
  }
  const next = structuredClone(stage)
  const removedFrom = []
  const isChildEntry = (holder, i) => {
    if (!holder) return false
    if (typeof holder.uuid === 'string' && holder.uuid === String(childUuid)) return true
    if (typeof holder.$ !== 'string') return false
    const parsed = parseRefPath(holder.$)
    return parsed !== null && parsed.index === i
  }
  next.forEach((object, i) => {
    if (!object || !Array.isArray(object.children)) return
    const kept = object.children.filter((holder) => {
      const same = isChildEntry(holder, childIndex)
      if (same && i !== sectionIndex) removedFrom.push(object.uuid)
      return !same
    })
    if (kept.length !== object.children.length) object.children = kept
  })
  if (sectionIndex >= 0) {
    const section = next[sectionIndex]
    if (!Array.isArray(section.children)) return { ok: false, error: '这个分区上没有 children 字段' }
    section.children.push({ $: `/${childIndex}` })
  }
  try {
    assertNoDanglingRefs(next)
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  return { ok: true, stage: next, childIndex, sectionIndex, removedFrom }
}

/**
 * 造一个分区（Section），把若干已有对象装进去。
 *
 * 字段集照 `Section.tsx` 的构造函数抄（第 89-128 行）：
 *   `uuid / _collisionBoxNormal / color / text / locked / isCollapsed / children / details / borderStyle`
 * ⚠️ 与普通实体不同：分区的几何字段是 **`_collisionBoxNormal`**（`collisionBox` 是 getter，不落盘）。
 *
 * `children` 里放的是 `{$:'/N'}` —— **指向舞台上已有的那些对象**，不是复制一份。
 * 所以装进分区**不会**改变舞台数组，也就不需要重编号。
 *
 * 几何按子对象的包围盒算（留出标题栏与内边距），与原项目 `adjustLocationAndSize()` 的思路一致。
 */
export function makeSection(stage, spec = {}) {
  const children = Array.isArray(spec.children) ? spec.children : []
  const indexes = []
  for (const uuid of children) {
    const index = stage.findIndex((object) => object && object.uuid === uuid)
    if (index < 0) return { ok: false, error: `没有这个对象：${uuid}` }
    indexes.push(index)
  }
  const pad = 24
  const titleBar = spec.text === undefined || String(spec.text) === '' ? 0 : 44
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
  for (const index of indexes) {
    const location = locationOf(stage[index]); const size = sizeOf(stage[index])
    if (location === null || size === null) continue
    x0 = Math.min(x0, location.x); y0 = Math.min(y0, location.y)
    x1 = Math.max(x1, location.x + size.width); y1 = Math.max(y1, location.y + size.height)
  }
  const hasBox = Number.isFinite(x0) && Number.isFinite(y0)
  if (!hasBox) {
    const at = spec.location || { x: 0, y: 0 }
    x0 = Number(at.x) || 0; y0 = Number(at.y) || 0; x1 = x0 + 300; y1 = y0 + 200
  }
  const left = x0 - pad
  const top = y0 - pad - titleBar
  const width = Math.max(80, x1 - x0 + pad * 2)
  const height = Math.max(60, y1 - y0 + pad * 2 + titleBar)
  return {
    ok: true,
    section: {
      _: 'Section',
      uuid: spec.uuid === undefined ? randomUUID() : String(spec.uuid),
      _collisionBoxNormal: {
        _: 'CollisionBox',
        shapes: [{
          _: 'Rectangle',
          location: { _: 'Vector', x: left, y: top },
          size: { _: 'Vector', x: width, y: height },
        }],
      },
      color: { _: 'Color', r: 0, g: 0, b: 0, a: 0 },
      text: String(spec.text === undefined ? '分区' : spec.text),
      children: indexes.map((index) => ({ $: `/${index}` })),
      isCollapsed: false,
      locked: false,
      details: [],
      borderStyle: ['solid', 'dashed', 'none'].includes(String(spec.borderStyle))
        ? String(spec.borderStyle) : 'solid',
    },
    childIndexes: indexes,
    box: { x: left, y: top, width, height },
  }
}

/* ── 层级（z-order）────────────────────────────────────────────────────── */

/**
 * 调层级：舞台数组的**顺序就是绘制顺序**，所以"置顶" = 挪到数组末尾。
 *
 * ⚠️ 与插入/删除不同，位移**不改变"谁指向谁"** —— 每个 `$` 的下标按同一套**置换**改写即可，
 * 不可能产生孤儿引用（什么都没删），所以这里不碰 orphans 那套。
 * `where`: `front`（置顶）· `back`（置底）· `forward`（上移一层）· `backward`（下移一层）
 */
export function reorderObject(stage, uuid, where) {
  const from = stage.findIndex((object) => object && object.uuid === String(uuid))
  if (from < 0) return { ok: false, error: `没有这个对象：${uuid}` }
  const last = stage.length - 1
  let to = from
  if (where === 'front') to = last
  else if (where === 'back') to = 0
  else if (where === 'forward') to = Math.min(last, from + 1)
  else if (where === 'backward') to = Math.max(0, from - 1)
  else return { ok: false, error: `不认识的层级动作：${where}（可用 front / back / forward / backward）` }
  if (to === from) return { ok: true, stage: structuredClone(stage), moved: false, from, to }

  const next = structuredClone(stage)
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return { ok: false, error: `下标 ${from} 上没有对象` }
  next.splice(to, 0, moved)
  const map = (old) => {
    if (old === from) return to
    if (from < to) return (old > from && old <= to) ? old - 1 : old
    return (old >= to && old < from) ? old + 1 : old
  }
  const orphans = renumber(next, 0, next.length - 1, map)
  if (orphans.length > 0) {
    // 位移不该产生孤儿；真出现说明置换写错了 —— 当场炸，别写坏文件
    return { ok: false, error: `内部错误：位移产生了 ${orphans.length} 条孤儿引用，已放弃` }
  }
  try {
    assertNoDanglingRefs(next)
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  return { ok: true, stage: next, moved: true, from, to }
}

/* ── 引用 ↔ uuid 的桥 ─────────────────────────────────────────────────── */

/**
 * 上游那条引用（`n1`）与文档里的 `uuid` 的**精确对照**。
 * 实体按 类型+文本+坐标、连线按 两端uuid+文本，**两边都唯一才配对**；不做模糊匹配。
 * `cliObjects` 就是 `get_all_nodes` 回来的 `objects`。
 */
export function locateBridge(cliObjects, stage) {
  const pairs = []
  const unmatchedRefs = []
  const usedUuids = new Set()

  const entityKey = (type, text, location) => [
    String(type), String(text === undefined ? '' : text),
    location ? Number(location.x) : 'NaN', location ? Number(location.y) : 'NaN',
  ].join('\u0000')

  const docEntities = []
  stage.forEach((object, index) => {
    if (!object || isEdge(object)) return
    docEntities.push({ index, object, uuid: object.uuid, type: object._, text: object.text, location: locationOf(object) })
  })
  const cliEntities = cliObjects.filter((ref) => ref && !isEdge(ref))
  const refToUuid = new Map()

  const index1 = (list, keyOf) => {
    const map = new Map()
    const dup = new Set()
    for (const item of list) {
      const key = keyOf(item)
      if (map.has(key)) { dup.add(key); continue }
      map.set(key, item)
    }
    return { map, dup }
  }
  const docE = index1(docEntities, (item) => entityKey(item.type, item.text, item.location))
  const cliE = index1(cliEntities, (item) => entityKey(item.type, item.text, item.position || null))
  for (const [key, item] of cliE.map) {
    const target = docE.map.get(key)
    if (target === undefined || docE.dup.has(key) || cliE.dup.has(key)) { unmatchedRefs.push(item.ref); continue }
    refToUuid.set(item.ref, target.uuid)
    usedUuids.add(target.uuid)
    pairs.push({ ref: item.ref, uuid: target.uuid, type: target.type, index: target.index, text: target.text, kind: 'entity' })
  }

  const uuidAtIndex = (rawIndex) => {
    const object = stage[rawIndex]
    return object && typeof object.uuid === 'string' ? object.uuid : null
  }
  const docEdgeKey = (object) => {
    const links = Array.isArray(object.associationList) ? object.associationList : []
    const at = (entry) => {
      const parsed = entry && typeof entry.$ === 'string' ? parseRefPath(entry.$) : null
      return parsed === null ? null : uuidAtIndex(parsed.index)
    }
    return [at(links[0]), at(links[1]), String(object.text === undefined ? '' : object.text)].join('\u0000')
  }
  const cliEdgeKey = (ref) => [
    refToUuid.get(String(ref.sourceRef)) || null,
    refToUuid.get(String(ref.targetRef)) || null,
    String(ref.text === undefined ? '' : ref.text),
  ].join('\u0000')
  const docEdges = []
  stage.forEach((object, index) => { if (object && isEdge(object)) docEdges.push({ index, object }) })
  const cliEdges = cliObjects.filter((ref) => ref && isEdge(ref))
  const docG = index1(docEdges, (item) => docEdgeKey(item.object))
  const cliG = index1(cliEdges, (item) => cliEdgeKey(item))
  for (const [key, ref] of cliG.map) {
    const target = docG.map.get(key)
    if (target === undefined || docG.dup.has(key) || cliG.dup.has(key)) { unmatchedRefs.push(ref.ref); continue }
    usedUuids.add(target.object.uuid)
    pairs.push({ ref: ref.ref, uuid: target.object.uuid, type: target.object._, index: target.index, text: target.object.text, kind: 'edge' })
  }

  const unmatchedObjects = stage
    .map((object, index) => ({ object, index }))
    .filter(({ object }) => object && typeof object.uuid === 'string' && !usedUuids.has(object.uuid))
    .map(({ object, index }) => ({ uuid: object.uuid, type: object._, index, text: object.text }))

  return {
    ok: unmatchedRefs.length === 0 && unmatchedObjects.length === 0,
    refs: cliObjects.length,
    objects: stage.length,
    matched: pairs.length,
    pairs,
    unmatchedRefs,
    unmatchedObjects,
  }
}
