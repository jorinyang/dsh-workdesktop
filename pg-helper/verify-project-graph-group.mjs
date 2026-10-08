/**
 * 工程图 · **群组第一块：创建与命名**（离线 + 上游 CLI 端到端）
 *
 * 用户 2026-10-09 裁定：群组用**上游已有的分区**实现（自建新类型会让文件上游读不了）。
 * 这一块要证三件事：
 *   ① 建出来的组合**把选中的圈住**（包围盒 + 边距），children 指向它们；
 *   ② **一个元素只能在一个组合里** —— 再建一个组合把同一个元素拉进去，旧组合里必须没了；
 *   ③ 全程之后**上游照样能打开**（用分区实现就是为了这个）。
 *
 * 用法：node verify-project-graph-group.mjs <模板 .prg> <上游检出> <helper.exe>
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  readDocument, writeDocument, insertObjects, makeTextNode, makeSection, fitSection,
  detachFromOtherSections, fitSectionsTouching, shapesOf, locationOf, sizeOf, parseRefPath,
  removeObjectsAndDanglingEdges, assertNoDanglingRefs,
} from './project-graph-doc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = process.argv[2] || join(HERE, 'empty-project.prg')
const REPO = process.argv[3] || ''
const HELPER = process.argv[4] || ''

let pass = 0
let fail = 0
function chk(id, desc, ok, detail = '') {
  if (ok) { pass++; console.log(`  [PASS] ${id.padEnd(10)} ${desc}`) } else { fail++; console.log(`  [FAIL] ${id.padEnd(10)} ${desc}`) }
  if (detail) console.log(`         ${String(detail).slice(0, 260)}`)
}

const work = mkdtempSync(join(tmpdir(), 'pg-group-'))
const file = join(work, 'g.prg')
copyFileSync(TEMPLATE, file)
const doc0 = readDocument(file)

// 三个节点，隔开一点，好看出包围盒
let stage = doc0.stage
const made = ['甲', '乙', '丙'].map((t, i) => makeTextNode(stage, { text: t, x: i * 300, y: 0 }).node)
stage = insertObjects(stage, made, null)
const idxOfText = (s, t) => s.findIndex((o) => o && o.text === t)
chk('GRP-1', '底图：三个节点', made.length === 3, `节点 ${made.length} 个`)

// ── ① 建组合：把甲乙圈起来 ───────────────────────────────────────────────
const box1 = makeSection(stage, { text: '第一组', children: [made[0].uuid, made[1].uuid] })
chk('GRP-2', '★ 建组合算出了包围盒', box1.ok === true && box1.childIndexes.length === 2,
  box1.ok === true ? JSON.stringify(box1.box) : box1.error)

if (box1.ok === true) {
  const a = locationOf(made[0]); const b = locationOf(made[1])
  const sa = sizeOf(made[0])
  const left = Math.min(a.x, b.x); const right = Math.max(a.x + sa.width, b.x + sa.width)
  chk('GRP-3', '★★ 包围盒**把选中的圈住了**（左右都留了边距）',
    box1.box.x < left && box1.box.x + box1.box.width > right,
    `框 [${box1.box.x.toFixed(0)}, ${(box1.box.x + box1.box.width).toFixed(0)}] vs 内容 [${left.toFixed(0)}, ${right.toFixed(0)}]`)
  chk('GRP-4', '★ children 指向的是那两个节点',
    box1.section.children.length === 2
    && box1.section.children.every((c) => {
      const p = parseRefPath(c.$)
      return p !== null && [made[0].uuid, made[1].uuid].includes(stage[p.index].uuid)
    }),
    JSON.stringify(box1.section.children))

  stage = insertObjects(stage, [box1.section], null)
  const secIndex = stage.findIndex((o) => o && o.uuid === box1.section.uuid)
  chk('GRP-5', '★ 组合进了舞台，children 仍然指得对',
    secIndex >= 0 && stage[secIndex].children.every((c) => {
      const p = parseRefPath(c.$)
      return p !== null && stage[p.index] !== undefined && stage[p.index].text !== undefined
    }),
    `组合在下标 ${secIndex}`)

  // ── ② 唯一归属：再建一组，把「甲」也拉进去 ───────────────────────────
  const box2 = makeSection(stage, { text: '第二组', children: [made[0].uuid, made[2].uuid] })
  const detached = detachFromOtherSections(stage, box2.childIndexes)
  const after = detached.stage
  const oldSec = after.find((o) => o && o.uuid === box1.section.uuid)
  chk('GRP-6', '★★ 唯一归属：再建一组把「甲」拉走之后，旧组合里**只剩「乙」**',
    oldSec.children.length === 1, `旧组合 children ${oldSec.children.length} 条（期望 1），摘掉 ${detached.removed} 条`)
  chk('GRP-7', '★ 而且摘的时候**没有动舞台顺序**（下标不变，引用不会指错）',
    after.length === stage.length && after.every((o, i) => o.uuid === stage[i].uuid),
    `长度 ${after.length} vs ${stage.length}`)

  const withTwo = insertObjects(after, [box2.section], null)
  const secs = withTwo.filter((o) => o && String(o._) === 'Section')
  chk('GRP-8', '★ 舞台上有两个组合', secs.length === 2, `组合 ${secs.length} 个`)
  // 每个非组合对象最多出现在一个组合里
  const owner = {}
  for (const sec of secs) {
    for (const c of sec.children) {
      const p = parseRefPath(c.$)
      if (p === null) continue
      owner[p.index] = (owner[p.index] === undefined ? 0 : owner[p.index]) + 1
    }
  }
  chk('GRP-9', '★★★ 没有任何元素同时属于两个组合',
    Object.values(owner).every((v) => v === 1),
    JSON.stringify(owner))
  writeDocument(file, doc0.doc, withTwo)

  // ── ③ 上游端到端 ──────────────────────────────────────────────────
  const cli = REPO === '' ? '' : join(REPO, 'packages', 'project-graph-cli', 'src', 'cli.mjs')
  if (cli === '' || !existsSync(cli) || HELPER === '' || !existsSync(HELPER)) {
    console.log('  [SKIP] GRP-10  端到端（要上游 CLI）')
  } else {
    let ok = true
    let objects = []
    try {
      const out = execFileSync(process.execPath, [cli, '--', 'tool', 'invoke', 'get_all_nodes',
        '--project', file, '--input', '{}'], {
        cwd: REPO, timeout: 180000, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, PROJECT_GRAPH_OWNERSHIP_HELPER_PATH: HELPER },
      })
      objects = JSON.parse(out.trim()).objects || []
    } catch (e) { ok = false; console.log('         CLI 报错：' + String(e.stderr || e.message).slice(0, 200)) }
    const secsUp = objects.filter((o) => o.type === 'Section')
    chk('GRP-10', '★★★ 用分区实现的目的达到了：**上游照样能打开**，而且它认识这两个组合',
      ok && secsUp.length === 2, ok ? `上游看到 ${secsUp.length} 个 Section` : 'CLI 报错')
  }
}

// ── ④ 自动贴合：成员挪远 ⇒ 框扩大；挪回来 ⇒ 框缩小，始终最小面积 ──────────
{
  const st0 = readDocument(file).stage
  // ⚠️ 要挑**成员最多的那个组合**：上一步"唯一归属"把第一组摘得只剩一个成员了，
  //    拿它测"挪远→扩大"没有意义（一个人的框本来就不会变大）。第一版就栽在这。
  const secs0 = st0.filter((o) => o && String(o._) === 'Section')
  const sec = secs0.slice().sort((a, b) => b.children.length - a.children.length)[0]
  const boxOfSection = (s, uuid) => {
    const t = s.find((o) => o && o.uuid === uuid)
    const sh = shapesOf(t)
    return { x: sh[0].location.x, y: sh[0].location.y, w: sh[0].size.x, h: sh[0].size.y }
  }
  // 先贴合一次拿基准（此刻框里可能还是建组时算的旧值）
  const st = fitSection(st0, sec.uuid).stage
  const before = boxOfSection(st, sec.uuid)
  chk('GRP-11a', '★ 基准：这个组合有 2 个以上成员，并先贴合一次',
    sec.children.length >= 2, `成员 ${sec.children.length} 个，框宽 ${before.w.toFixed(0)}`)
  const memberUuid = (() => {
    const p = parseRefPath(sec.children[0].$)
    return st[p.index].uuid
  })()
  const shift = (s, uuid, dx, dy) => {
    const next = structuredClone(s)
    const t = next.find((o) => o && o.uuid === uuid)
    const sh = shapesOf(t)
    sh[0].location.x += dx; sh[0].location.y += dy
    return next
  }

  // 挪远 2000：框必须跟着扩。
  // ⚠️ 增长幅度取决于成员原本在哪一边（从最左挪到最右只扩 800），所以这里只断言"**确实变大了**"——
  //    第一版写死 +1500，红得毫无道理。
  const far = fitSectionsTouching(shift(st, memberUuid, 2000, 0), [memberUuid])
  const grown = boxOfSection(far.stage, sec.uuid)
  chk('GRP-11', '★★ 成员被拖出边界 ⇒ 组合框**自动扩大**',
    grown.w > before.w + 100, `宽 ${before.w.toFixed(0)} -> ${grown.w.toFixed(0)}`)

  // 挪回来：框必须缩回去（最小面积，不留空地）。
  // ⚠️ 必须**真的把它挪回来**再贴合 —— 第一版只是又贴合了一次，成员还在远处，当然不会缩。
  const returned = fitSectionsTouching(shift(far.stage, memberUuid, -2000, 0), [memberUuid])
  const shrunk = boxOfSection(returned.stage, sec.uuid)
  chk('GRP-12', '★★ 成员拖拢 ⇒ 组合框**自动缩小**，回到最小面积',
    Math.abs(shrunk.w - before.w) < 2 && Math.abs(shrunk.x - before.x) < 2,
    `宽 ${grown.w.toFixed(0)} -> ${shrunk.w.toFixed(0)}（基准 ${before.w.toFixed(0)}），x ${shrunk.x.toFixed(0)} vs ${before.x.toFixed(0)}`)

  // 贴合之后，框必须真的把每个成员都圈住（不是只有尺寸凑巧对）
  const encloses = (s, uuid, box) => {
    const t = s.find((o) => o && o.uuid === uuid)
    const loc = locationOf(t); const size = sizeOf(t)
    return loc.x >= box.x - 0.5 && loc.y >= box.y - 0.5
      && loc.x + size.width <= box.x + box.w + 0.5 && loc.y + size.height <= box.y + box.h + 0.5
  }
  const secNow = returned.stage.find((o) => o && o.uuid === sec.uuid)
  const allIn = secNow.children.every((c) => {
    const p = parseRefPath(c.$)
    return p !== null && encloses(returned.stage, returned.stage[p.index].uuid, shrunk)
  })
  chk('GRP-13', '★★ 贴合之后，**每个成员都被圈在里面**（不是尺寸凑巧对）', allIn, '')
}

// ── ⑤ 右键剪断（删除）：删组内成员 / 删组合本身 ──────────────────────────
{
  const st = readDocument(file).stage
  const secs = st.filter((o) => o && String(o._) === 'Section')
  const sec = secs.slice().sort((a, b) => b.children.length - a.children.length)[0]
  const memberIdx = parseRefPath(sec.children[0].$).index
  const victimUuid = st[memberIdx].uuid

  // ① 删掉组内的一个成员 —— 以前这一步会**直接失败**（成员名单悬空，防线抛错）
  let threw = null
  let after = null
  try { after = removeObjectsAndDanglingEdges(st, [memberIdx]) } catch (e) { threw = String((e && e.message) || e) }
  chk('GRP-14', '★★ 删掉组内一个成员**不会失败**（以前会：名单悬空导致防线直接抛）',
    threw === null, String(threw).slice(0, 180))
  if (after !== null) {
    const sec2 = after.find((o) => o && o.uuid === sec.uuid)
    chk('GRP-15', '★★ 删完成员：**组合还在，名单里少了那一个**',
      sec2 !== undefined && sec2.children.length === sec.children.length - 1,
      sec2 === undefined ? '组合不见了' : `名单 ${sec.children.length} -> ${sec2.children.length}`)
    chk('GRP-16', '★ 被删的那个确实没了，长度正好少 1',
      after.every((o) => o.uuid !== victimUuid) && after.length === st.length - 1,
      `长度 ${st.length} -> ${after.length}`)
    chk('GRP-16b', '★★ 删完引用仍然自洽（没有悬空）',
      (() => { try { assertNoDanglingRefs(after); return true } catch { return false } })(), '')
  }

  // ② 删掉**组合本身** —— 成员必须活下来（只是不再属于任何组合）
  const secIdx = st.findIndex((o) => o && o.uuid === sec.uuid)
  const membersBefore = sec.children.map((c) => st[parseRefPath(c.$).index].uuid)
  const after2 = removeObjectsAndDanglingEdges(st, [secIdx])
  const survivors = membersBefore.every((u) => after2.some((o) => o.uuid === u))
  chk('GRP-17', '★★ 删掉**组合本身**：成员**一个都没少**（只是不再属于任何组合）',
    survivors && after2.length === st.length - 1,
    `长度 ${st.length} -> ${after2.length}，成员 ${membersBefore.length} 个都还在：${survivors}`)
  writeDocument(file, doc0.doc, after2)
}

rmSync(work, { recursive: true, force: true })
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1
