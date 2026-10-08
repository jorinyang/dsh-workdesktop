/**
 * 工程图 · **复制 / 剪切 / 粘贴**自测（离线 + 上游 CLI 端到端）
 *
 * 这块唯一真正危险的地方是**引用**：连线两端、分区 children 存的都是**舞台下标**。
 * 所以这里死盯三件事：
 *   ① 复制出来的连线必须连着**副本**，不能连着原件；
 *   ② 剪切（下标整体前移）之后，不允许出现"指到别人身上"的引用；
 *   ③ 剪贴板里指向选区之外的引用必须**被丢掉并如实报数**，不能悄悄带出去。
 *
 * 用法：node verify-project-graph-clipboard.mjs <模板 .prg> <上游检出> <helper.exe>
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  readDocument, writeDocument, insertObjects, makeTextNode, makeEdge, makeSection,
  extractForClipboard, pasteClipboard, locationOf,
  removeObjectsAndDanglingEdges, assertNoDanglingRefs,
} from './project-graph-doc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = process.argv[2] || join(HERE, 'empty-project.prg')
const REPO = process.argv[3] || ''
const HELPER = process.argv[4] || ''

let pass = 0
let fail = 0
function chk(id, desc, ok, detail = '') {
  if (ok) { pass++; console.log(`  [PASS] ${id.padEnd(12)} ${desc}`) } else { fail++; console.log(`  [FAIL] ${id.padEnd(12)} ${desc}`) }
  if (detail) console.log(`         ${String(detail).slice(0, 300)}`)
}

const work = mkdtempSync(join(tmpdir(), 'pg-clip-'))
const file = join(work, 'clip.prg')
copyFileSync(TEMPLATE, file)
const doc0 = readDocument(file)

// ── 造一张图：甲 → 乙（一条线），丙 孤立 ─────────────────────────────────
let stage = doc0.stage
const mk = (text, x, y) => makeTextNode(stage, { text, x, y }).node
const jia = mk('甲', 0, 0)
const yi = mk('乙', 300, 0)
const bing = mk('丙', 600, 0)
stage = insertObjects(stage, [jia, yi, bing], null)
const idxOf = (uuid) => stage.findIndex((o) => o && o.uuid === uuid)
const e1 = makeEdge(stage, idxOf(jia.uuid), idxOf(yi.uuid), { text: '甲→乙' }).edge
stage = insertObjects(stage, [e1], null)
writeDocument(file, doc0.doc, stage)

const readStage = () => readDocument(file).stage
const uuidOfText = (s, text) => (s.find((o) => o && o.text === text) || {}).uuid

chk('CLIP-1', '造好底图：甲、乙、丙 三个节点 + 一条 甲→乙',
  stage.filter((o) => o && o._ === 'TextNode').length === 4 && stage.filter((o) => o && o._ === 'LineEdge').length === 1,
  `实体 ${stage.filter((o) => o && o._ === 'TextNode').length} · 连线 ${stage.filter((o) => o && o._ === 'LineEdge').length}`)

// ── ① 复制两个节点（含它们之间的线）→ 粘贴 ────────────────────────────────
{
  const s = readStage()
  const got = extractForClipboard(s, [uuidOfText(s, '甲'), uuidOfText(s, '乙')])
  chk('CLIP-2', '★ 抽取：两个节点 + 它们之间的那条线（线自己没被选中也一起带走）',
    got.ok === true && got.clip.entities === 2 && got.clip.edges === 1 && got.clip.droppedRefs === 0,
    got.ok === true ? JSON.stringify({ e: got.clip.entities, l: got.clip.edges, dropped: got.clip.droppedRefs }) : got.error)

  const pasted = pasteClipboard(s, got.clip, 40, 40)
  chk('CLIP-3', '★ 粘贴：多出两个节点 + 一条线', pasted.ok === true && pasted.count === 3, pasted.ok ? '' : pasted.error)

  const after = pasted.stage
  const newTexts = ['甲', '乙']
  const copyJia = after.filter((o) => o && o._ === 'TextNode' && o.text === '甲')
  chk('CLIP-3b', '★★ 副本是**新的 uuid**，不是把原件又插了一遍',
    copyJia.length === 2 && copyJia[0].uuid !== copyJia[1].uuid,
    copyJia.map((o) => String(o.uuid).slice(0, 8)).join(' / '))
  chk('CLIP-3c', '★ 副本的几何整体偏移了 (40,40)',
    locationOf(copyJia[1]) && locationOf(copyJia[1]).x === 40 && locationOf(copyJia[1]).y === 40,
    JSON.stringify(locationOf(copyJia[1])))

  // ★★ 关键：新那条线连的必须是**副本**
  const lines = after.filter((o) => o && o._ === 'LineEdge')
  chk('CLIP-4', '★ 粘贴后一共两条线（原一条 + 副本一条）', lines.length === 2, `线 ${lines.length}`)
  const resolveEdge = (edge) => edge.associationList.map((entry) => {
    const m = /^\/(\d+)/.exec(String(entry && entry.$))
    return m === null ? null : after[Number(m[1])]
  })
  const copyLine = lines.find((o) => o.uuid !== e1.uuid)
  const ends = copyLine === undefined ? [] : resolveEdge(copyLine)
  chk('CLIP-4b', '★★ 副本那条线连的是**副本自己**，不是原件（复制最要命的地方）',
    ends.length === 2 && ends[0] !== undefined && ends[1] !== undefined
    && ends[0].uuid === copyJia[1].uuid
    && ends[1].uuid === after.filter((o) => o && o._ === 'TextNode' && o.text === '乙')[1].uuid,
    ends.map((o) => (o === undefined ? '?' : String(o.text) + '@' + String(o.uuid).slice(0, 6))).join(' -> '))
  chk('CLIP-4c', '原件那条线**仍然是原来那对**（复制没有反过来污染原件）',
    (() => { const a = resolveEdge(lines.find((o) => o.uuid === e1.uuid)); return a.length === 2 && a[0].text === '甲' && a[1].text === '乙' && a[0].uuid === uuidOfText(s, '甲') })(),
    '')
}

// ── ② 只复制一个端点：线**不该**跟着走 ──────────────────────────────────
{
  const s = readStage()
  const got = extractForClipboard(s, [uuidOfText(s, '甲')])
  chk('CLIP-5', '★ 只选一个端点时，那条线**不跟着走**（否则复制出来是连回原件的线）',
    got.ok === true && got.clip.entities === 1 && got.clip.edges === 0,
    got.ok === true ? JSON.stringify({ e: got.clip.entities, l: got.clip.edges }) : got.error)
}

// ── ③ 分区里的批外引用要被丢掉并报数 ────────────────────────────────────
{
  const s = readStage()
  const sec = makeSection(s, { text: '区', children: [uuidOfText(s, '甲'), uuidOfText(s, '乙')] })
  const withSec = insertObjects(s, [sec.section], null)
  const got = extractForClipboard(withSec, [sec.section.uuid])
  chk('CLIP-6', '★★ 只复制分区时，指向批外子对象的引用**被丢掉并如实报数**',
    got.ok === true && got.clip.entities === 1 && got.clip.droppedRefs === 2,
    got.ok === true ? `droppedRefs=${got.clip.droppedRefs}（期望 2）` : got.error)
  const pasted = pasteClipboard(withSec, got.clip, 10, 10)
  const copySec = pasted.stage[pasted.stage.length - 1]
  chk('CLIP-6b', '★ 粘出来的那个分区 children 是空的（只包含选中的部分）',
    pasted.ok === true && Array.isArray(copySec.children) && copySec.children.length === 0,
    JSON.stringify(copySec.children))
}

// ── ④ 剪切：下标整体前移之后，引用不许指错 ──────────────────────────────
{
  const s = readStage()
  const got = extractForClipboard(s, [uuidOfText(s, '甲')])
  const cut = removeObjectsAndDanglingEdges(s, got.clip.indexes)
  chk('CLIP-7', '★ 剪切「甲」：甲没了，挂在上面的线被连带清掉',
    cut.every((o) => o.text !== '甲') && cut.filter((o) => o && o._ === 'LineEdge').length === 0,
    JSON.stringify(cut.map((o) => o.text)))

  // 剪完之后再粘回来：应该重新出现（剪贴板里存的是当初那份内容，不是一串 uuid）
  const back = pasteClipboard(cut, got.clip, 0, 0)
  chk('CLIP-7b', '★★ 剪贴之后再粘贴：对象回来、且是**新 uuid**',
    back.ok === true && back.stage.filter((o) => o.text === '甲').length === 1
    && back.stage.filter((o) => o.text === '甲')[0].uuid !== uuidOfText(s, '甲'),
    back.ok === true ? `count=${back.count}` : back.error)
  let dangling = null
  try { assertNoDanglingRefs(back.stage) } catch (e) { dangling = String(e.message) }
  chk('CLIP-7c', '★★ 粘回来之后**没有越界引用**（剪切让下标整体前移，最容易在这里露出来）',
    dangling === null, String(dangling).slice(0, 150))
}

// ── ⑤ 上游端到端：造完这些之后文件仍然合法 ──────────────────────────────
{
  const cli = REPO === '' ? '' : join(REPO, 'packages', 'project-graph-cli', 'src', 'cli.mjs')
  if (cli === '' || !existsSync(cli) || HELPER === '' || !existsSync(HELPER)) {
    console.log('  [SKIP] CLIP-8  端到端（要上游 CLI）：用法 node verify-project-graph-clipboard.mjs <模板> <上游检出> <helper.exe>')
  } else {
    const s = readStage()
    const got = extractForClipboard(s, [uuidOfText(s, '甲'), uuidOfText(s, '乙')])
    const pasted = pasteClipboard(s, got.clip, 40, 40)
    writeDocument(file, doc0.doc, pasted.stage)
    let objects = []
    let ok = true
    try {
      const out = execFileSync(process.execPath, [cli, '--', 'tool', 'invoke', 'get_all_nodes',
        '--project', file, '--input', '{}'], {
        cwd: REPO, timeout: 180000, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, PROJECT_GRAPH_OWNERSHIP_HELPER_PATH: HELPER },
      })
      objects = JSON.parse(out.trim()).objects || []
    } catch (e) { ok = false; console.log('         CLI 读回失败：' + String(e.stderr || e.message).slice(0, 200)) }
    const lines = objects.filter((o) => o.type === 'LineEdge')
    const textOf = (ref) => (objects.find((o) => o.ref === ref) || {}).text
    // 模板自带一个「根节点」：4 个原件（根/甲/乙/丙）+ 粘出来的 2 个 = 6
    chk('CLIP-8', '★★ 端到端：粘贴之后**上游照样能打开**，且两条线各自连着甲乙',
      ok && objects.filter((o) => o.type === 'TextNode').length === 6 && lines.length === 2,
      ok ? `实体 ${objects.filter((o) => o.type === 'TextNode').length} · 线 ${lines.length}` : 'CLI 报错')
    chk('CLIP-8b', '★★ 上游读回：两条线都是「甲 → 乙」（副本没有连歪）',
      lines.length === 2 && lines.every((l) => textOf(l.sourceRef) === '甲' && textOf(l.targetRef) === '乙'),
      lines.map((l) => textOf(l.sourceRef) + '->' + textOf(l.targetRef)).join(' | '))
  }
}

rmSync(work, { recursive: true, force: true })
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1
