/**
 * 读一份工程图，当**只读探针**输出：每个对象的 uuid / 文本 / 世界坐标 / 归谁。
 *
 * 为什么套件要用它、而不是走 `/pg/document` 的 `parentUuid` 字段（2026-10-10）：
 * 那个字段是 `pg-helper/project-graph-doc.mjs` 里的代码，而**宿主进程启动时就把模块读进内存了** ——
 * 改完那个文件不重启宿主，HTTP 路由上是看不到新字段的。套件的断言不该被"要不要重启"绑架，
 * 所以直接读 `.prg`（跟文档层走的是同一个 `readDocument`/`parentUuidOf`，不是另写一套解析）。
 *
 * 用法：node pg-helper/pg-probe.mjs <工程名或绝对路径>
 * 输出：一行 JSON —— { ok, objects: { 文本: {uuid,type,x,y,parent} }, sections: {...} }
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readDocument, parentUuidOf, locationOf, sizeOf } from './project-graph-doc.mjs'

const WS = process.env.DSH_WORKDESKTOP_PROJECT_GRAPH_DIR || join(homedir(), '.dsh', '.dsh-project-graph')
const arg = process.argv[2] || ''
const file = arg === '' ? ''
  : (arg.includes('/') || arg.includes('\\') ? arg : join(WS, 'projects', arg.endsWith('.prg') ? arg : arg + '.prg'))

if (file === '' || !existsSync(file)) {
  console.log(JSON.stringify({ ok: false, error: '没有这个工程：' + file }))
  process.exit(0)
}

try {
  const { stage } = readDocument(file, readFileSync)
  const objects = {}
  stage.forEach((object, index) => {
    if (object === null || typeof object !== 'object') return
    // ⚠️ 坐标**不能直接读 object.location / object.size** —— 那个字段在对象自己的顶层，
    //    但上游真正用的是 `collisionBox.shapes[0].location|.size`（实体都存在那儿）。
    //    读错地方不会报错，只会安静地全给 0（2026-10-10 实测踩到：套件里框的差
    //    恒为 (-48,-92) 看着像边距算错了，其实是这里一个坐标都没读到）。
    const loc = locationOf(object) || { x: 0, y: 0 }
    const size = sizeOf(object) || { width: 0, height: 0 }
    const key = typeof object.text === 'string' && object.text !== '' ? object.text : ('#' + index)
    objects[key] = {
      uuid: typeof object.uuid === 'string' ? object.uuid : null,
      type: String(object._ || ''),
      x: Number(loc.x) || 0,
      y: Number(loc.y) || 0,
      w: Number(size.width) || 0,
      h: Number(size.height) || 0,
      collapsed: object.isCollapsed === true,
      // `null` = 确定不属于任何分区；`undefined` 在 JSON 里会消失，所以显式写成 '(说不清)'
      parent: (() => { const p = parentUuidOf(stage, object); return p === undefined ? '(说不清)' : p })(),
    }
  })
  console.log(JSON.stringify({ ok: true, count: stage.length, objects }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
}
