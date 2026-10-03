/**
 * 工程图 · **文档层路由**自测（打活的宿主，HTTP 级）
 *
 * 考的是"面板能不能真的靠这几条路由画画"：
 *   /pg/document · /pg/locate · /pg/move · /pg/insert · /pg/delete · /pg/details
 *
 * ⚠️ 每写一次之后，都用 `/pg/graph`（= 上游 `get_all_nodes`）**读回核对** ——
 * 路由自己说改好了不算数，要上游认。最后把测试工程删掉，不留垃圾。
 *
 * 用法：node verify-project-graph-routes.mjs [baseUrl]
 *   baseUrl 默认 http://127.0.0.1:3080（跑在桌面端 19387 的会话里就别打自己那个）
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:3080').replace(/\/$/, '')
const PROJECT = '路由自测临时工程'

let pass = 0
let fail = 0
function chk(id, desc, ok, detail = '') {
  if (ok) { pass++; console.log(`  [PASS] ${id.padEnd(12)} ${desc}`) } else { fail++; console.log(`  [FAIL] ${id.padEnd(12)} ${desc}`) }
  if (detail) console.log(`         ${String(detail).slice(0, 300)}`)
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`)
  return await r.json()
}
async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await r.json()
}

console.log(`base    : ${BASE}`)
console.log(`project : ${PROJECT}\n`)

// ── 0. 宿主可达 + 工程图就绪 ────────────────────────────────────────────
{
  let s = null
  try { s = await get('/workdesktop/api/pg/status') } catch (error) {
    console.log(`连不上 ${BASE}：${String(error.message).slice(0, 120)}`)
    process.exit(2)
  }
  chk('RT-0', '宿主可达且工程图就绪', s.ok === true && s.cliReady === true && s.helperReady === true,
    `ok=${s.ok} cli=${s.cliReady} helper=${s.helperReady}`)
  if (s.ok !== true) { console.log('\n前置换不了，后面的不用跑了。'); process.exit(1) }
}

// ── 0b. 六条新路由**必须在**（这是本轮的重点：模块代码要重启宿主才生效）────
{
  const doc = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent('__不存在的工程__')}`)
  chk('RT-1', '★ /pg/document 已注册（不是 404），且对不存在的工程如实报错',
    doc !== null && typeof doc === 'object' && doc.ok === false && /没有这个工程/.test(String(doc.error)),
    JSON.stringify(doc).slice(0, 160))
  const loc = await get(`/workdesktop/api/pg/locate?project=${encodeURIComponent('__不存在的工程__')}`)
  chk('RT-2', '★ /pg/locate 已注册', loc !== null && loc.ok === false, JSON.stringify(loc).slice(0, 120))
  for (const [path, label] of [['/pg/move', 'RT-3'], ['/pg/insert', 'RT-4'], ['/pg/delete', 'RT-5'], ['/pg/details', 'RT-6']]) {
    const r = await post(`/workdesktop/api${path}`, { project: '__不存在的工程__' })
    chk(label, `★ ${path} 已注册（不是 404）`, r !== null && r.ok === false && /没有这个工程/.test(String(r.error)),
      JSON.stringify(r).slice(0, 140))
  }
}

// ── 建一个临时工程（用完删掉）────────────────────────────────────────────
await post('/workdesktop/api/pg/project', { action: 'delete', name: PROJECT })  // 上次跑剩的先清掉
const created = await post('/workdesktop/api/pg/project', { action: 'create', name: PROJECT })
chk('RT-7', '建临时工程', created.ok === true, JSON.stringify(created).slice(0, 160))
if (created.ok !== true) { console.log('\n建不出来，后面的不用跑了。'); process.exit(1) }

const graph = async () => {
  const g = await get(`/workdesktop/api/pg/graph?project=${encodeURIComponent(PROJECT)}`)
  return g.ok === true && Array.isArray(g.objects) ? g.objects : []
}

try {
  // ── 1. 读整份文档 ────────────────────────────────────────────────────
  let doc = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
  chk('RT-8', '★ /pg/document 读出元数据 + 每个对象的摘要',
    doc.ok === true && doc.metadata && typeof doc.metadata.version === 'string'
    && Array.isArray(doc.objects) && doc.objects.length > 0
    && doc.objects.every((o) => typeof o.uuid === 'string' && typeof o.type === 'string'),
    `version=${doc.metadata && doc.metadata.version} objects=${doc.objects.length} types=${JSON.stringify(doc.types)}`)
  const rootUuid = doc.objects[0].uuid

  // ── 2. 新建节点 ──────────────────────────────────────────────────────
  const ins = await post('/workdesktop/api/pg/insert', {
    project: PROJECT,
    nodes: [{ text: '甲', x: 0, y: 0 }, { text: '乙', x: 400, y: 0 }],
  })
  chk('RT-9', '★ /pg/insert 新建两个节点', ins.ok === true && Array.isArray(ins.created) && ins.created.length === 2,
    JSON.stringify(ins).slice(0, 220))
  const docAfterInsert = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
  chk('RT-9b', '新建的节点在文档里读得到',
    docAfterInsert.objects.filter((o) => o.text === '甲' || o.text === '乙').length === 2,
    JSON.stringify(docAfterInsert.objects.map((o) => o.text)))
  // 上游认不认（.prg 还合法吗）
  const gAfterInsert = await graph()
  chk('RT-9c', '★★ 新建之后**上游 CLI 能读出来**（.prg 仍然合法）',
    ['甲', '乙'].every((t) => gAfterInsert.map((o) => o.text).includes(t)),
    JSON.stringify(gAfterInsert.map((o) => o.text)))

  // ── 3. 引用 ↔ uuid ──────────────────────────────────────────────────
  const locate = await get(`/workdesktop/api/pg/locate?project=${encodeURIComponent(PROJECT)}`)
  chk('RT-10', '★ /pg/locate 把引用与 uuid 配成双射',
    locate.ok === true && locate.matched === locate.refs && locate.unmatchedRefs.length === 0,
    `refs=${locate.refs} objects=${locate.objects} matched=${locate.matched}`)

  // ── 4. 批量移动 ──────────────────────────────────────────────────────
  const jia = docAfterInsert.objects.find((o) => o.text === '甲')
  const yi = docAfterInsert.objects.find((o) => o.text === '乙')
  const mv = await post('/workdesktop/api/pg/move', {
    project: PROJECT,
    moves: [{ uuid: jia.uuid, x: 111.5, y: -222.25 }, { uuid: yi.uuid, x: 999, y: 0 }],
  })
  chk('RT-11', '★ /pg/move 一次改两个对象的坐标', mv.ok === true && mv.moved === 2,
    JSON.stringify(mv).slice(0, 220))
  const gMoved = await graph()
  const movedJia = gMoved.find((o) => o.text === '甲')
  chk('RT-11b', '★★ 移动后的坐标能被**上游 CLI 读回**（证明真的写进去了）',
    movedJia && Math.abs(movedJia.position.x - 111.5) < 0.01 && Math.abs(movedJia.position.y + 222.25) < 0.01,
    JSON.stringify(movedJia && movedJia.position))

  // ── 5. 写详细信息 ────────────────────────────────────────────────────
  const dt = await post('/workdesktop/api/pg/details', { project: PROJECT, uuid: jia.uuid, value: ['自测写入的详细信息'] })
  chk('RT-12', '★ /pg/details 写详细信息', dt.ok === true, JSON.stringify(dt).slice(0, 180))
  const docDetails = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
  chk('RT-12b', '详细信息读回可见',
    JSON.stringify((docDetails.objects.find((o) => o.uuid === jia.uuid) || {}).details) === JSON.stringify(['自测写入的详细信息']), '')

  // ── 6. 删除（连带删悬空连线）─────────────────────────────────────────
  const before = docDetails.objects.length
  const del = await post('/workdesktop/api/pg/delete', { project: PROJECT, uuids: [yi.uuid] })
  chk('RT-13', '★ /pg/delete 按 uuid 删对象', del.ok === true && del.removed >= 1, JSON.stringify(del).slice(0, 180))
  const gAfterDelete = await graph()
  chk('RT-13b', '★★ 删完之后上游仍能打开，且被删的对象不在了',
    !gAfterDelete.map((o) => o.text).includes('乙') && gAfterDelete.length === before - del.removed,
    JSON.stringify(gAfterDelete.map((o) => o.text)))

  // ── 7. 不存在的 uuid 要如实报，不许静默成功 ──────────────────────────
  const bogus = await post('/workdesktop/api/pg/move', { project: PROJECT, moves: [{ uuid: 'no-such-uuid', x: 1, y: 1 }] })
  chk('RT-14', '★ 移动不存在的 uuid：如实报 missing（不静默成功）',
    bogus.ok === true && bogus.moved === 0 && bogus.missing.length === 1,
    JSON.stringify(bogus).slice(0, 160))
  const bogusDel = await post('/workdesktop/api/pg/delete', { project: PROJECT, uuids: ['no-such-uuid'] })
  chk('RT-14b', '删不存在的 uuid：如实报错', bogusDel.ok === false, JSON.stringify(bogusDel).slice(0, 140))

  // ── 7b. 连线：建 / 改接线（P2）──────────────────────────────────────
  // ⚠️ 这一段**自己造一个节点**再用，不依赖前面留下的东西：RT-13 已经把「乙」删了，
  //    直接拿它当终点会得到 `undefined`（实测踩到）。
  {
    const madeDing = await post('/workdesktop/api/pg/insert', { project: PROJECT, nodes: [{ text: '丁', x: 800, y: 300 }] })
    chk('RT-16a', '为连线测试造一个节点「丁」', madeDing.ok === true && madeDing.created.length === 1,
      JSON.stringify(madeDing).slice(0, 160))
    const now = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
    const pick = (text) => (now.objects.find((o) => o.text === text) || {}).uuid
    const jiaU = pick('甲'); const dingU = pick('丁'); const rootU = pick('根节点')
    chk('RT-16a2', '三个 uuid 都拿到了（甲 / 丁 / 根节点）',
      typeof jiaU === 'string' && typeof dingU === 'string' && typeof rootU === 'string',
      `甲=${String(jiaU).slice(0, 8)} 丁=${String(dingU).slice(0, 8)} 根=${String(rootU).slice(0, 8)}`)

    const conn = await post('/workdesktop/api/pg/connect', { project: PROJECT, source: jiaU, target: dingU })
    chk('RT-16', '★ /pg/connect 连一条线', conn.ok === true && typeof conn.uuid === 'string',
      JSON.stringify(conn).slice(0, 200))

    const gConn = await graph()
    const newEdge = gConn.find((o) => o.type === 'LineEdge')
    const textOfRef = (ref) => (gConn.find((o) => o.ref === ref) || {}).text
    // 引用编号是上游分配的，不是我们定的 ⇒ 按**文本**核对连的是不是对的人，别断言 "n2>n3"
    chk('RT-16b', '★★ 上游 CLI 读到这条线，且两端正是「甲 → 丁」',
      newEdge !== undefined && textOfRef(newEdge.sourceRef) === '甲' && textOfRef(newEdge.targetRef) === '丁',
      newEdge === undefined ? '上游没看到连线' : `${textOfRef(newEdge.sourceRef)} -> ${textOfRef(newEdge.targetRef)}`)

    const re = await post('/workdesktop/api/pg/reconnect', { project: PROJECT, uuid: conn.uuid, source: rootU })
    chk('RT-17', '★ /pg/reconnect 把起点改到「根节点」', re.ok === true, JSON.stringify(re).slice(0, 180))
    const gRe = await graph()
    const rewired = gRe.find((o) => o.type === 'LineEdge')
    const textOf2 = (ref) => (gRe.find((o) => o.ref === ref) || {}).text
    chk('RT-17b', '★★ 改接线后上游读到的起点真的变了、终点没动',
      rewired !== undefined && textOf2(rewired.sourceRef) === '根节点' && textOf2(rewired.targetRef) === '丁',
      rewired === undefined ? '' : `${textOf2(rewired.sourceRef)} -> ${textOf2(rewired.targetRef)}`)

    const selfLoop = await post('/workdesktop/api/pg/connect', { project: PROJECT, source: jiaU, target: jiaU })
    chk('RT-18', '★ 连自环（起点=终点）被拒，并说清原因',
      selfLoop.ok === false && /自环/.test(String(selfLoop.error)), JSON.stringify(selfLoop).slice(0, 140))
    const ghost = await post('/workdesktop/api/pg/connect', { project: PROJECT, source: jiaU, target: 'no-such-uuid' })
    chk('RT-18b', '连到不存在的对象被拒', ghost.ok === false, JSON.stringify(ghost).slice(0, 140))

    // 删掉「丁」时，挂在它上面的那条线必须一起走
    const delWithEdge = await post('/workdesktop/api/pg/delete', { project: PROJECT, uuids: [dingU] })
    chk('RT-18c', '★★ 删掉被连线挂着的节点时，那条线被**连带删掉**（不是留一条断线）',
      delWithEdge.ok === true && delWithEdge.removedEdges >= 1,
      `removed=${delWithEdge.removed} removedEdges=${delWithEdge.removedEdges}`)
    const gClean = await graph()
    chk('RT-18d', '上游读回：一条连线都不剩，且文件仍然合法',
      gClean.filter((o) => o.type === 'LineEdge').length === 0,
      JSON.stringify(gClean.map((o) => o.text)))
  }

  // ── 7c. 分区：建 / 折叠 / 拖出（P3）────────────────────────────────
  {
    const now = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
    const ents = now.objects.filter((o) => o.type !== 'LineEdge')
    const kidA = ents[0].uuid
    const kidB = ents[1].uuid
    chk('RT-19a', '拿两个对象准备装进分区', typeof kidA === 'string' && typeof kidB === 'string',
      `共 ${ents.length} 个实体`)

    const pack = await post('/workdesktop/api/pg/section', {
      project: PROJECT, create: { text: '我的分区', children: [kidA, kidB] },
    })
    chk('RT-19', '★ /pg/section create 建一个分区把两个对象装进去',
      pack.ok === true && typeof pack.uuid === 'string' && pack.picked === 2, JSON.stringify(pack).slice(0, 200))

    const docAfter = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
    const section = docAfter.objects.find((o) => o.type === 'Section')
    chk('RT-19b', '★ 文档层读到这个分区，childUuids 正是那两个对象',
      section !== undefined && Array.isArray(section.childUuids) && section.childUuids.length === 2
      && section.childUuids.includes(kidA) && section.childUuids.includes(kidB),
      JSON.stringify(section && section.childUuids))

    const gPack = await graph()
    const gSection = gPack.find((o) => o.type === 'Section')
    chk('RT-19c', '★★ 上游 CLI 也读到这个分区，且 childRefs 是两条（嵌套写对了）',
      gSection !== undefined && Array.isArray(gSection.childRefs) && gSection.childRefs.length === 2,
      JSON.stringify(gSection && gSection.childRefs))

    const collapsed = await post('/workdesktop/api/pg/section', { project: PROJECT, uuid: pack.uuid, collapsed: true })
    chk('RT-20', '★ /pg/section 折叠', collapsed.ok === true && collapsed.state.collapsed === true,
      JSON.stringify(collapsed).slice(0, 160))
    const docCollapsed = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
    chk('RT-20b', '折叠状态读回可见',
      (docCollapsed.objects.find((o) => o.uuid === pack.uuid) || {}).collapsed === true, '')
    const gCollapsed = await graph()
    chk('RT-20c', '★★ 折叠之后上游仍能打开（折叠只翻一个布尔，不改结构）',
      gCollapsed.some((o) => o.type === 'Section'), JSON.stringify(gCollapsed.map((o) => o.type)))

    const out = await post('/workdesktop/api/pg/reparent', { project: PROJECT, child: kidB, section: null })
    chk('RT-21', '★ /pg/reparent 把一个对象从分区里拿出来', out.ok === true, JSON.stringify(out).slice(0, 180))
    const docOut = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
    const secOut = docOut.objects.find((o) => o.type === 'Section')
    chk('RT-21b', '★★ 拿出来之后 childUuids 只剩一个（改的是 children 引用，没动舞台数组）',
      secOut !== undefined && secOut.childUuids.length === 1 && secOut.childUuids[0] === kidA,
      JSON.stringify(secOut && secOut.childUuids))
    const gOut = await graph()
    chk('RT-21c', '★★ 上游读回的 childRefs 也只剩一条',
      ((gOut.find((o) => o.type === 'Section') || {}).childRefs || []).length === 1,
      JSON.stringify((gOut.find((o) => o.type === 'Section') || {}).childRefs))
  }

  // ── 7d. 撤销 / 重做（P4）─────────────────────────────────────────────
  {
    const h0 = await get(`/workdesktop/api/pg/history?project=${encodeURIComponent(PROJECT)}`)
    chk('RT-22a', '★ /pg/history 报出有没有得撤（前面已经写过好几次 ⇒ 应该有）',
      h0.ok === true && h0.canUndo === true && h0.past > 0, JSON.stringify(h0))

    const beforeDoc = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
    const countBefore = beforeDoc.objects.length
    const ins2 = await post('/workdesktop/api/pg/insert', { project: PROJECT, nodes: [{ text: '待撤销', x: 0, y: 900 }] })
    chk('RT-22b', '先插一个节点', ins2.ok === true, JSON.stringify(ins2).slice(0, 120))
    const afterIns = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
    chk('RT-22c', '插进去了', afterIns.objects.length === countBefore + 1,
      `${countBefore} -> ${afterIns.objects.length}`)

    const undo = await post('/workdesktop/api/pg/undo', { project: PROJECT })
    chk('RT-22', '★ /pg/undo 撤销一步', undo.ok === true, JSON.stringify(undo).slice(0, 160))
    const afterUndo = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
    chk('RT-22d', '★★ 撤销之后文档回到插入之前（对象数变回去了）',
      afterUndo.objects.length === countBefore && !afterUndo.objects.some((o) => o.text === '待撤销'),
      `${afterIns.objects.length} -> ${afterUndo.objects.length}`)
    const gUndo = await graph()
    chk('RT-22e', '★★ 撤销之后上游仍能打开这个文件',
      gUndo.length > 0 && !gUndo.some((o) => o.text === '待撤销'), JSON.stringify(gUndo.map((o) => o.text)))

    const redo = await post('/workdesktop/api/pg/redo', { project: PROJECT })
    chk('RT-23', '★ /pg/redo 重做一步', redo.ok === true, JSON.stringify(redo).slice(0, 160))
    const afterRedo = await get(`/workdesktop/api/pg/document?project=${encodeURIComponent(PROJECT)}`)
    chk('RT-23b', '★★ 重做之后那个节点又回来了',
      afterRedo.objects.some((o) => o.text === '待撤销'),
      JSON.stringify(afterRedo.objects.map((o) => o.text)))
    await post('/workdesktop/api/pg/undo', { project: PROJECT })

    // 撤销到头要如实说"没得撤了"，不许静默成功
    let guard = 0
    let last = null
    while (guard < 80) {
      last = await post('/workdesktop/api/pg/undo', { project: PROJECT })
      if (last.ok !== true) break
      guard += 1
    }
    chk('RT-24', '★ 撤到底如实报「没有可撤销的了」（不静默成功）',
      last !== null && last.ok === false && /没有可撤销/.test(String(last.error)),
      `撤了 ${guard} 步后：${JSON.stringify(last).slice(0, 120)}`)
    const gEmpty = await graph()
    chk('RT-24b', '撤到底之后文件仍然合法（上游能打开）', gEmpty.length > 0,
      JSON.stringify(gEmpty.map((o) => o.text)))
  }

  // ── 8. 空工程也能画第一笔（兜底模板那条路）───────────────────────────
  chk('RT-15', '★ 空工程上"新建节点"成功 ⇒ 兜底模板那条路是通的（新工程没有可克隆的对象）',
    ins.ok === true && ins.created.length === 2, `created=${ins.created && ins.created.length}`)
} finally {
  const removed = await post('/workdesktop/api/pg/project', { action: 'delete', name: PROJECT })
  console.log(`\n清理：${removed.ok === true ? '临时工程已删除' : JSON.stringify(removed).slice(0, 140)}`)
}

console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1
