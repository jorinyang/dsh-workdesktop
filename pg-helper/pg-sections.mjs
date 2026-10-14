/**
 * 组合诊断：把一个工程里**所有组合**的状态一次打清楚。
 *
 * 什么时候用它：界面上出现「某个组合折不了」「成员的框和组合分家了」这类现象时，
 * 先跑这个把**磁盘上的真实状态**取下来 —— 归属、折叠标记、框的位置尺寸、谁套在谁里面。
 * 光看界面只能猜；这份输出能直接回答"是归属坏了、还是折叠标记坏了、还是只是没画出来"。
 *
 * 用法：
 *   node pg-helper/pg-sections.mjs 工作台.prg
 *   node pg-helper/pg-sections.mjs            （不给名字就列全部工程，各打一份）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readDocument, parentUuidOf, locationOf, sizeOf, parseRefPath, findSectionCycles } from './project-graph-doc.mjs'

const WS = process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_DIR || join(homedir(), '.dsh', '.dsh-project-graph')
const PROJECTS = join(WS, 'projects')
const arg = process.argv[2] || ''

function one(name) {
  const file = arg.includes('/') || arg.includes('\\') ? arg : join(PROJECTS, name.endsWith('.prg') ? name : name + '.prg')
  if (!existsSync(file)) return { name, ok: false, error: '没有这个工程：' + file }
  const { stage } = readDocument(file, readFileSync)
  const nameOf = {}
  const info = {}
  stage.forEach((o, i) => {
    if (o === null || typeof o !== 'object') return
    const key = typeof o.text === 'string' && o.text !== '' ? o.text : ('#' + i)
    nameOf[o.uuid] = key
    const loc = locationOf(o) || { x: 0, y: 0 }
    const size = sizeOf(o) || { width: 0, height: 0 }
    info[o.uuid] = {
      key, type: String(o._ || ''), loc, size,
      collapsed: o.isCollapsed === true,
      parent: parentUuidOf(stage, o),
      kids: Array.isArray(o.children) ? o.children : null,
    }
  })
  const sections = Object.entries(info).filter(([, v]) => v.type === 'Section')
  // ⚠️ 成员按 **uuid** 判归属，**不能按显示名** —— 2026-10-10 实测栽过：
  //    「采集器」这个组合里有一个**普通节点也叫「采集器」**（#0 是 TextNode），
  //    我第一版按名字列成员、又顺手拿名字比，于是把那条正常成员读成了"组合自己装自己"，
  //    还据此写下"发现自环"的结论去报给用户。**那是误报，文件当时是好的。**
  //    这一版：成员一律输出 `名字(类型)`，判断只用 uuid。
  const label = (v) => v.key + (v.type === 'Section' ? '(组合)' : '')
  const out = {
    name, ok: true, objects: stage.length, sections: sections.length,
    detail: sections.map(([uuid, v]) => ({
      名字: v.key,
      折叠: v.collapsed,
      框: [Math.round(v.loc.x), Math.round(v.loc.y), Math.round(v.size.width), Math.round(v.size.height)],
      归谁: v.parent === undefined ? '(说不清)' : (v.parent === null ? '(不属任何组合)' : (nameOf[v.parent] || String(v.parent).slice(0, 8))),
      成员: Object.entries(info).filter(([k]) => info[k].parent === uuid).map(([k]) => label(info[k])),
    })),
  }
  // 自指 / 环一律交给文档层那把**同一个**函数判（`findSectionCycles`），
  // 不在这里手算 —— 手算过一版，因为按**显示名**比，把"有个同名普通节点"
  // 误读成了"组合装着自己"（假警报）。判定归属只能按 uuid / 下标。
  const warn = []
  for (const c of findSectionCycles(stage)) {
    warn.push(`组合「${c.name}」（#${c.section}）成环：${c.path.join(' → ')}`)
  }
  for (const [uuid, v] of sections) {
    const kids = Object.entries(info).filter(([k]) => info[k].parent === uuid)
    if (kids.length === 0 && v.kids !== null && v.kids.length > 0) {
      warn.push(`组合「${v.key}」的 children 里有引用，但**解不出任何成员** —— 引用可能指空了`)
    }
    if (kids.length > 0) {
      const x0 = Math.min(...kids.map(([, k]) => k.loc.x)); const y0 = Math.min(...kids.map(([, k]) => k.loc.y))
      const x1 = Math.max(...kids.map(([, k]) => k.loc.x + k.size.width)); const y1 = Math.max(...kids.map(([, k]) => k.loc.y + k.size.height))
      const dw = Math.abs((x1 - x0 + 48) - v.size.width); const dh = Math.abs((y1 - y0 + 48 + 44) - v.size.height)
      if (dw > 12 || dh > 12) {
        warn.push(`组合「${v.key}」的框与成员包围盒对不上（宽差 ${dw.toFixed(0)}、高差 ${dh.toFixed(0)}）—— 可能"分家"了`)
      }
    }
  }
  out.诊断 = warn.length === 0 ? ['没有发现异常'] : warn
  return out
}

if (arg) {
  console.log(JSON.stringify(one(arg), null, 1))
} else {
  const list = existsSync(PROJECTS) ? readdirSync(PROJECTS).filter((n) => n.toLowerCase().endsWith('.prg')) : []
  for (const n of list) console.log(JSON.stringify(one(n), null, 1))
}
