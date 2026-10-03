/**
 * 工程图 · **文档层**自测（离线）
 *
 * 重点守一件事：**插入 / 删除舞台对象之后，所有连线的两端必须还是原来那两个对象**。
 * 因为 `$` 路径存的是**舞台数组下标**，插入/删除会让下标整体漂移 ——
 * 漏改一条，连线就静默接到别的对象上（不报错、肉眼难发现）。
 *
 * 用法：node verify-project-graph-doc.mjs [模板 .prg]
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readDocument, writeDocument, summarize, moveBatch, insertObjects, removeObjects,
  removeObjectsAndDanglingEdges, edgeEndpoints, collectRefPaths, assertNoDanglingRefs,
  locateBridge, isEdge, locationOf, makeTextNode, makeEdge,
} from './project-graph-doc.mjs'

const require = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = process.argv[2] || join(HERE, 'empty-project.prg')

let pass = 0
let fail = 0
function chk(id, desc, ok, detail = '') {
  if (ok) { pass++; console.log(`  [PASS] ${id.padEnd(12)} ${desc}`) } else { fail++; console.log(`  [FAIL] ${id.padEnd(12)} ${desc}`) }
  if (detail) console.log(`         ${detail}`)
}

const work = mkdtempSync(join(tmpdir(), 'pg-doc-'))
const file = join(work, 'demo.prg')
copyFileSync(TEMPLATE, file)

console.log(`template : ${TEMPLATE}`)
console.log(`work     : ${file}`)

// ── 先造一张有连线、有嵌套样子的图：用文档层直接拼 ───────────────────────
// 这里**故意手工造对象**（而不是走 CLI），因为要测的正是"插入/删除时的下标维护"。
const vector = (x, y) => ({ _: 'Vector', x, y })
const textNode = (uuid, text, x, y) => ({
  _: 'TextNode',
  details: [],
  uuid,
  text,
  collisionBox: { _: 'CollisionBox', shapes: [{ _: 'Rectangle', location: vector(x, y), size: vector(200, 76) }] },
  color: { _: 'Color', r: 0, g: 0, b: 0, a: 0 },
  fontScaleLevel: 0,
  sizeAdjust: 'auto',
  fontFamily: '',
  fontWeight: '',
  borderStyle: 'solid',
})
const lineEdge = (uuid, sourceIndex, targetIndex, text = '') => ({
  _: 'LineEdge',
  associationList: [{ $: `/${sourceIndex}` }, { $: `/${targetIndex}` }],
  color: { _: 'Color', r: 0, g: 0, b: 0, a: 0 },
  targetRectangleRate: vector(0.01, 0.5),
  sourceRectangleRate: vector(0.99, 0.5),
  uuid,
  text,
  lineType: 'straight',
  arrowType: 'none',
})

const { doc } = readDocument(file)
let stage = [
  textNode('u-A', 'A', 0, 0),        // 0
  textNode('u-B', 'B', 300, 0),      // 1
  lineEdge('u-E1', 0, 1, 'A→B'),     // 2
  textNode('u-C', 'C', 600, 0),      // 3
  lineEdge('u-E2', 1, 3, 'B→C'),     // 4
]
writeDocument(file, doc, stage)
stage = readDocument(file).stage

chk('DOC-1', '造了一张 5 个对象、2 条连线的图（3 节点 + 2 边）',
  stage.length === 5 && stage.filter(isEdge).length === 2, `len=${stage.length}`)

const before = edgeEndpoints(stage)
chk('DOC-2', '改动前：两条边的两端 uuid 记下来了',
  before.length === 2 && before[0].from === 'u-A' && before[0].to === 'u-B'
  && before[1].from === 'u-B' && before[1].to === 'u-C',
  JSON.stringify(before))

// ── 插入：在最前面插一个节点，所有下标都要 +1 ────────────────────────────
let after = insertObjects(stage, [textNode('u-X', 'X', -300, 0)], 0)
let afterEndpoints = edgeEndpoints(after)
chk('DOC-3', '★ 在开头插入一个对象后，两条连线的两端**仍然是原来的对象**',
  JSON.stringify(afterEndpoints) === JSON.stringify(before),
  `before=${JSON.stringify(before)}\n         after =${JSON.stringify(afterEndpoints)}`)
chk('DOC-4', '插入后长度 +1，且 `$` 路径整体后移',
  after.length === 6 && collectRefPaths(after).every((p) => Number(p.slice(1).split('/')[0]) < after.length),
  JSON.stringify(collectRefPaths(after)))

// ── 插入：插在中间 ──────────────────────────────────────────────────────
after = insertObjects(stage, [textNode('u-Y', 'Y', 900, 0)], 2)
chk('DOC-5', '★ 插在中间（下标 2）后，连线两端仍然不变',
  JSON.stringify(edgeEndpoints(after)) === JSON.stringify(before),
  JSON.stringify(edgeEndpoints(after)))

// ── 插入：追加在末尾（不应影响任何已有下标）─────────────────────────────
after = insertObjects(stage, [textNode('u-Z', 'Z', 1200, 0)], null)
chk('DOC-6', '★ 追加到末尾后，连线两端不变、且原有 `$` 一个都没动',
  JSON.stringify(edgeEndpoints(after)) === JSON.stringify(before)
  && JSON.stringify(collectRefPaths(after).filter((p) => !p.startsWith('/5'))) === JSON.stringify(collectRefPaths(stage)),
  JSON.stringify(collectRefPaths(after)))

// ── 删除一个**被连线指着**的对象：必须当场报错（不许留悬空引用）──────────
{
  let threw = null
  try { removeObjects(stage, [0]) } catch (e) { threw = String(e.message) }
  chk('DOC-7', '★ 删掉"被连线指着"的对象时**必须当场报错**（不许留悬空引用）',
    threw !== null && /已被删掉|悬空|越界/.test(threw), String(threw).slice(0, 150))
}

const afterDelete = removeObjectsAndDanglingEdges(stage, [0])
chk('DOC-8', '★ 删节点 + 连带删悬空边：剩下 B、C、E2（保持原有相对顺序），E2 两端不变',
  afterDelete.map((o) => o.uuid).join(',') === 'u-B,u-C,u-E2'
  && JSON.stringify(edgeEndpoints(afterDelete)) === JSON.stringify([{ edgeUuid: 'u-E2', from: 'u-B', to: 'u-C' }]),
  afterDelete.map((o) => o.uuid).join(',') + ' · ' + JSON.stringify(edgeEndpoints(afterDelete)))

// ── 删中间一个对象，后面的下标要回退 ────────────────────────────────────
const afterMid = removeObjectsAndDanglingEdges(stage, [1])  // 删 u-B；两条边都悬空
chk('DOC-9', '★ 删中间的 u-B：两条边都该被连带删掉，只剩 A、C',
  afterMid.map((o) => o.uuid).join(',') === 'u-A,u-C', afterMid.map((o) => o.uuid).join(','))

// ── 带后缀的路径也要跟着改 ──────────────────────────────────────────────
{
  const nested = [
    textNode('n-1', 'P', 0, 0),
    { _: 'Wrapper', ref: { $: '/0/collisionBox' }, uuid: 'w-1' },   // 指向 stage[0] 的内部
    textNode('n-2', 'Q', 100, 0),
  ]
  const shifted = insertObjects(nested, [textNode('n-0', 'Z', -100, 0)], 0)
  const holder = shifted.find((o) => o.uuid === 'w-1')
  chk('DOC-10', '★ 带后缀的 `$` 路径（`/0/collisionBox`）只改第一段数字、后缀原样保留',
    holder.ref.$ === '/1/collisionBox' && shifted[1].uuid === 'n-1',
    `-> ${holder.ref.$}`)
}

// ── 批量移动 ────────────────────────────────────────────────────────────
{
  writeDocument(file, doc, stage)
  const fresh = readDocument(file)
  const result = moveBatch(fresh.stage, [
    { uuid: 'u-A', x: 111, y: 222 },
    { uuid: 'u-C', width: 250 },
    { uuid: '不存在', x: 1 },
  ])
  writeDocument(file, doc, fresh.stage)
  const back = readDocument(file).stage
  const byUuid = new Map(back.map((o) => [o.uuid, o]))
  chk('DOC-11', '★ 批量移动：一次改多个对象的坐标',
    locationOf(byUuid.get('u-A')).x === 111 && locationOf(byUuid.get('u-A')).y === 222,
    JSON.stringify(locationOf(byUuid.get('u-A'))))
  chk('DOC-12', '批量移动能只改宽（不动位置）',
    locationOf(byUuid.get('u-C')).x === 600 && byUuid.get('u-C').collisionBox.shapes[0].size.x === 250,
    JSON.stringify(locationOf(byUuid.get('u-C'))) + ' w=' + byUuid.get('u-C').collisionBox.shapes[0].size.x)
  chk('DOC-13', '不存在的 uuid 如实报出来（不静默跳过）',
    result.missing.length === 1 && result.missing[0] === '不存在' && result.moved === 2, JSON.stringify(result.missing))
  chk('DOC-14', '批量移动之后连线两端仍然不变',
    JSON.stringify(edgeEndpoints(back)) === JSON.stringify(before), JSON.stringify(edgeEndpoints(back)))
}

// ── 悬空引用检测本身要有效（负向对照）──────────────────────────────────
{
  const broken = [textNode('b-1', 'B1', 0, 0), lineEdge('b-E', 0, 7)]
  let caught = null
  try { assertNoDanglingRefs(broken) } catch (e) { caught = String(e.message) }
  chk('DOC-15', '★ 负向对照：造一条指向舞台外的 `$`，检测器必须抓到（判据非恒真）',
    caught !== null && /越界/.test(caught), String(caught).slice(0, 120))
}

// ── 引用 ↔ uuid 的桥 ────────────────────────────────────────────────────
{
  writeDocument(file, doc, stage)
  const { stage: finalStage } = readDocument(file)
  // 伪装一份"上游 CLI 的 get_all_nodes 回执"：类型/文本/坐标要和文档对得上
  const cli = finalStage.map((o, index) => {
    if (isEdge(o)) return null
    const loc = locationOf(o)
    return { ref: `n${index + 1}`, type: o._, text: o.text, position: loc }
  }).filter(Boolean)
  finalStage.forEach((o, index) => {
    if (!isEdge(o)) return
    const at = (entry) => finalStage[Number(entry.$.slice(1))].uuid
    cli.push({
      ref: `e${index + 1}`, type: 'LineEdge', text: o.text,
      position: { x: 0, y: 0 },
      sourceRef: cli.find((c) => c.ref.startsWith('n') && finalStage.find((s) => s.uuid && c.position
        && s.uuid && locationOf(s) && locationOf(s).x === c.position.x && locationOf(s).y === c.position.y))?.ref,
      targetRef: undefined,
      __at: at,
    })
  })
  // 上面那段只为演示形状；真正断言用的是"实体能配上"
  const bridge = locateBridge(cli.filter((c) => c.type !== 'LineEdge'), finalStage.filter((o) => !isEdge(o)))
  chk('DOC-16', '★ 引用↔uuid 的桥：实体按 类型+文本+坐标 精确配对',
    bridge.matched === 3 && bridge.unmatchedRefs.length === 0 && bridge.unmatchedObjects.length === 0,
    `matched=${bridge.matched} refs=${bridge.refs} objects=${bridge.objects}`)
  chk('DOC-17', '桥是双向的：每个 uuid 也只配一个引用',
    new Set(bridge.pairs.map((p) => p.uuid)).size === bridge.pairs.length, '')
}

// ── 摘要要带着画布需要的东西 ────────────────────────────────────────────
{
  const s = summarize(stage[0], 0)
  chk('DOC-18', 'summarize 给出画布要用的字段（uuid/类型/文本/坐标/尺寸）',
    s.uuid === 'u-A' && s.type === 'TextNode' && s.text === 'A'
    && s.location && s.size && s.size.width === 200,
    JSON.stringify(s).slice(0, 160))
}

// ── 新建对象（克隆模板）──────────────────────────────────────────────────
{
  const s = [
    textNode('t-1', '模板', 0, 0),
    lineEdge('t-E', 0, 0, 'x'),
  ]
  const made = makeTextNode(s, { text: '新生', x: 42, y: -7 })
  chk('DOC-19', 'makeTextNode 克隆已有 TextNode 的形状，只换 uuid/文本/坐标',
    made.ok === true && made.node.text === '新生' && made.node.uuid !== 't-1'
    && made.node.collisionBox.shapes[0].location.x === 42
    && JSON.stringify(Object.keys(made.node).sort()) === JSON.stringify(Object.keys(s[0]).sort()),
    made.ok === true ? `uuid=${made.node.uuid.slice(0, 8)} keys=${Object.keys(made.node).length}` : made.error)

  const edge = makeEdge(s, 1, 0, { text: '反向' })
  chk('DOC-20', 'makeEdge 按给定的舞台下标记两端',
    edge.ok === true && edge.edge.associationList[0].$ === '/1' && edge.edge.associationList[1].$ === '/0'
    && edge.edge.text === '反向',
    edge.ok === true ? JSON.stringify(edge.edge.associationList) : edge.error)

  const noTemplate = makeTextNode([{ _: 'PenStroke', uuid: 'p' }], { text: 'x' })
  chk('DOC-21', '★ 没有同类可克隆时退回兜底模板（新工程画第一笔必需），并如实标出 cloned=false',
    noTemplate.ok === true && noTemplate.cloned === false
    && Object.keys(noTemplate.node).length === 11
    && noTemplate.node._ === 'TextNode' && typeof noTemplate.node.uuid === 'string'
    && noTemplate.node.uuid.length > 20,
    noTemplate.ok === true ? `keys=${Object.keys(noTemplate.node).length} cloned=${noTemplate.cloned}` : noTemplate.error)

  const noEdgeTemplate = makeEdge([{ _: 'PenStroke', uuid: 'p' }], 0, 1, { text: 'e' })
  chk('DOC-21b', '连线同样有兜底模板（空工程里没有边可克隆，但画布必须能连第一根线）',
    noEdgeTemplate.ok === true && noEdgeTemplate.cloned === false
    && noEdgeTemplate.edge._ === 'LineEdge'
    && noEdgeTemplate.edge.associationList[0].$ === '/0'
    && noEdgeTemplate.edge.associationList[1].$ === '/1',
    noEdgeTemplate.ok === true ? JSON.stringify(noEdgeTemplate.edge.associationList) : noEdgeTemplate.error)
}

// ── 端到端：改完之后**上游 CLI 必须还能打开这个文件** ────────────────────
// 这一段是整块地基的验收：文档层自己说"改好了"不算数，要**上游认**才算数。
{
  const repo = process.argv[3] || ''
  const cli = repo === '' ? '' : join(repo, 'packages', 'project-graph-cli', 'src', 'cli.mjs')
  const helper = process.argv[4] || ''
  if (cli === '' || !existsSync(cli) || helper === '' || !existsSync(helper)) {
    console.log('  [SKIP] DOC-22..24  端到端（要上游 CLI）：用法 node verify-project-graph-doc.mjs <模板> <上游检出> <helper.exe>')
  } else {
    const fs = require('node:fs')
    const { execFileSync } = require('node:child_process')
    const e2e = join(work, 'e2e.prg')
    copyFileSync(TEMPLATE, e2e)

    const callCli = (tool, input) => {
      const out = execFileSync(process.execPath, [cli, '--', 'tool', 'invoke', tool,
        '--project', e2e, '--input', JSON.stringify(input)], {
        cwd: repo, timeout: 180000, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, PROJECT_GRAPH_OWNERSHIP_HELPER_PATH: helper },
      })
      return JSON.parse(out.trim())
    }
    const readBack = () => {
      const value = callCli('get_all_nodes', {})
      return Array.isArray(value.objects) ? value.objects : []
    }

    // ① 先造一张**上游自己认**的图：用文档层造 3 个节点 + 2 条边
    {
      const seed = readDocument(e2e)
      const nodes = ['甲', '乙', '丙'].map((text, i) => makeTextNode(seed.stage, { text, x: i * 300, y: 0 }).node)
      let next = insertObjects(seed.stage, nodes, null)
      // ⚠️ 新对象内部的 `$` 由调用方按**插入后**的下标写。
      // 空模板自带 1 个根节点，所以三个新节点落在 base / base+1 / base+2 —— **不要写死 1/2/3**
      // （写死过一次：边指到了自己身上，上游直接 TOOL_EXECUTION_FAILED —— 那种图上游打不开）。
      const base = seed.stage.length
      const e1 = makeEdge(next, base, base + 1, { text: '甲→乙' }).edge
      const e2 = makeEdge(next, base + 1, base + 2, { text: '乙→丙' }).edge
      next = insertObjects(next, [e1, e2], null)
      writeDocument(e2e, seed.doc, next)
    }

    let objects = []
    let cliOk = true
    try { objects = readBack() } catch (e) { cliOk = false; console.log('         CLI 读回失败：' + String(e.message).slice(0, 200)) }
    const texts = objects.map((o) => o.text)
    chk('DOC-22', '★ 端到端：文档层新建的节点，**上游 CLI 能读出来**（说明 .prg 仍然合法）',
      cliOk && ['甲', '乙', '丙'].every((t) => texts.includes(t)),
      cliOk ? JSON.stringify(texts) : 'CLI 报错')

    const edgesOf = (list) => list.filter((o) => o.type === 'LineEdge')
      .map((o) => `${o.text}:${o.sourceRef}>${o.targetRef}`).sort()
    const beforeEdges = edgesOf(objects)

    // ② 在最前面插入一个节点 —— 所有下标后移，**已有两条连线必须还是原来那两对**
    {
      const cur = readDocument(e2e)
      const fresh = makeTextNode(cur.stage, { text: '插到最前', x: -600, y: 0 }).node
      const next = insertObjects(cur.stage, [fresh], 0)
      writeDocument(e2e, cur.doc, next)
    }
    let after = []
    try { after = readBack() } catch (e) { console.log('         插入后 CLI 读回失败：' + String(e.message).slice(0, 160)) }
    chk('DOC-23', '★★ 端到端：在最前面插一个节点之后，**两条连线仍然连着原来那两个节点**（`$` 下标维护的最终验收）',
      after.length > 0 && JSON.stringify(edgesOf(after)) === JSON.stringify(beforeEdges),
      `before=${JSON.stringify(beforeEdges)}\n         after =${JSON.stringify(edgesOf(after))}`)

    // ③ 删掉中间那个节点，上游必须还能打开，且连线不指向被删的对象
    {
      const cur = readDocument(e2e)
      const target = cur.stage.findIndex((o) => o && o.text === '乙')
      const next = removeObjectsAndDanglingEdges(cur.stage, [target])
      writeDocument(e2e, cur.doc, next)
    }
    let afterDelete = []
    let deleteOk = true
    try { afterDelete = readBack() } catch (e) { deleteOk = false; console.log('         删除后 CLI 读回失败：' + String(e.message).slice(0, 160)) }
    const remainingTexts = afterDelete.map((o) => o.text)
    chk('DOC-24', '★ 端到端：删掉"乙"之后上游仍能打开，且指向它的连线被连带删掉',
      deleteOk && !remainingTexts.includes('乙') && edgesOf(afterDelete).length === 0,
      deleteOk ? JSON.stringify(remainingTexts) + ' edges=' + JSON.stringify(edgesOf(afterDelete)) : 'CLI 报错')
  }
}

rmSync(work, { recursive: true, force: true })
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1
