/**
 * 工程图 · **图片节点**自测（离线 + 上游 CLI 端到端）
 *
 * 考的是三件事：
 *   ① 往容器里塞附件（`attachments/<id>.<ext>`）之后，文件仍然合法；
 *   ② 手工造的 ImageNode **上游认识**（和分区那次一样，自己说好不算数）；
 *   ③ 附件读得回来、content-type 认得对。
 *
 * 用法：node verify-project-graph-image.mjs <模板 .prg> <上游检出> <helper.exe>
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  readDocument, writeDocument, insertObjects, makeImageNode, addAttachment, readAttachment, summarize,
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

// 1×1 的透明 PNG（67 字节）—— 真图，不是占位字符串，这样 content-type 与字节数都可核
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const work = mkdtempSync(join(tmpdir(), 'pg-img-'))
const file = join(work, 'img.prg')
copyFileSync(TEMPLATE, file)
console.log(`template : ${TEMPLATE}`)
console.log(`work     : ${file}\n`)

// ── ① 建模：塞附件 + 造 ImageNode ────────────────────────────────────────
const added = addAttachment(file, 'att-0001', 'png', PNG_1X1)
chk('IMG-1', '★ 往 .prg 里塞一个 PNG 附件', added.ok === true && added.name === 'attachments/att-0001.png',
  JSON.stringify(added))

const remade = addAttachment(file, 'att-0001', 'png', PNG_1X1)
chk('IMG-1b', '同名附件不许重复塞（如实报错，不静默覆盖）',
  remade.ok === false && /已存在/.test(String(remade.error)), String(remade.error))

{
  const loaded = readDocument(file)
  const made = makeImageNode({ attachmentId: 'att-0001', x: 100, y: 50, width: 320, height: 240 })
  chk('IMG-2', 'makeImageNode 造一个图片节点', made.ok === true && made.node._ === 'ImageNode',
    made.ok === true ? JSON.stringify(Object.keys(made.node)).slice(0, 160) : made.error)
  const next = insertObjects(loaded.stage, [made.node], null)
  writeDocument(file, loaded.doc, next)
  const back = readDocument(file)
  const node = back.stage.find((o) => o && o._ === 'ImageNode')
  const sum = summarize(node, back.stage.indexOf(node), back.stage)
  chk('IMG-2b', '★ 读回来时摘要里带着 attachmentId / scale / isBackground 与几何',
    sum.type === 'ImageNode' && sum.attachmentId === 'att-0001' && sum.scale === 1
    && sum.location && sum.location.x === 100 && sum.size.width === 320,
    JSON.stringify(sum).slice(0, 220))
}

// ── ② 附件读得回来 ──────────────────────────────────────────────────────
{
  const got = readAttachment(file, 'att-0001')
  chk('IMG-3', '★ 附件按 id 读出字节，content-type 认成 image/png',
    got.ok === true && got.contentType === 'image/png' && got.bytes === PNG_1X1.length
    && Buffer.compare(got.data, PNG_1X1) === 0,
    got.ok === true ? `${got.bytes} 字节 · ${got.contentType}` : got.error)
  const missing = readAttachment(file, '没有这个附件')
  chk('IMG-3b', '★ 附件不存在时如实报错并列出有哪些（不给空图）',
    missing.ok === false && missing.code === 'ATTACHMENT_NOT_FOUND' && /att-0001/.test(String(missing.error)),
    String(missing.error).slice(0, 160))
}

// ── ③ 上游认不认 ────────────────────────────────────────────────────────
{
  const cli = REPO === '' ? '' : join(REPO, 'packages', 'project-graph-cli', 'src', 'cli.mjs')
  if (cli === '' || !existsSync(cli) || HELPER === '' || !existsSync(HELPER)) {
    console.log('  [SKIP] IMG-4..5  端到端（要上游 CLI）：用法 node verify-project-graph-image.mjs <模板> <上游检出> <helper.exe>')
  } else {
    const run = (tool, input) => {
      const out = execFileSync(process.execPath, [cli, '--', 'tool', 'invoke', tool,
        '--project', file, '--input', JSON.stringify(input)], {
        cwd: REPO, timeout: 180000, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, PROJECT_GRAPH_OWNERSHIP_HELPER_PATH: HELPER },
      })
      return JSON.parse(out.trim())
    }
    let objects = []
    let cliOk = true
    try { objects = run('get_all_nodes', {}).objects || [] } catch (e) {
      cliOk = false
      console.log('         CLI 读回失败：' + String(e.stderr || e.message).slice(0, 220))
    }
    const img = objects.find((o) => o && o.type === 'ImageNode')
    chk('IMG-4', '★★ 端到端：上游 CLI 认这个图片节点（说明 .prg 仍然合法）',
      cliOk && img !== undefined,
      cliOk ? JSON.stringify(objects.map((o) => o.type)) : 'CLI 报错')
    chk('IMG-4b', '★ 上游报的位置/尺寸与我们写进去的一致',
      img !== undefined && Math.abs(img.position.x - 100) < 1 && Math.abs(img.size.width - 320) < 1,
      img === undefined ? '(没有图片节点)' : JSON.stringify({ p: img.position, s: img.size }))

    // 带附件的工程，上游改一次（拖动）之后附件必须还在 —— 这是我们写盘时"原样搬运其它条目"的验收
    let moved = true
    try {
      run('edit_text_node', { ref: objects[0].ref, data: { text: '根节点' } })
    } catch (e) { moved = false }
    const after = readAttachment(file, 'att-0001')
    chk('IMG-5', '★★ 上游写过一次之后，附件**仍在且字节没变**（写盘时没有重打包附件）',
      moved && after.ok === true && Buffer.compare(after.data, PNG_1X1) === 0,
      after.ok === true ? `${after.bytes} 字节` : String(after.error))
  }
}

rmSync(work, { recursive: true, force: true })
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1
