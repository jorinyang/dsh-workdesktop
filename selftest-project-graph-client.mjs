/**
 * dsh-workdesktop · 「工程图」浏览器半段的**源码级**契约自测（离线，不起浏览器）
 *
 * 为什么用源码级而不是真机：这一批断言的对象是**声明**，不是渲染结果 ——
 *   · 左侧栏底部那五行的**顺序**（工程图必须夹在「坐标系」与「建模中心」之间）；
 *   · 官方右侧栏的 tab 类型注册（`sidebarRightTabs.register` + `sidebar.right.pane.tab`）；
 *   · 指南页入口卡、图标、以及"两个入口指向同一个 id"。
 * 这些都能在一份文本上逐条判，而且**回归时一定跑**（真机套件要真实 DSH 运行时）。
 * 渲染与点击另由真机套件负责 —— 本文件不声称覆盖它。
 *
 * 用法：node selftest-project-graph-client.mjs
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
const lines = src.split(/\r?\n/)

let pass = 0
let fail = 0
function chk(id, desc, ok, detail = '') {
  if (ok) { pass++; console.log(`  [PASS] ${id.padEnd(12)} ${desc}`) } else { fail++; console.log(`  [FAIL] ${id.padEnd(12)} ${desc}`) }
  if (detail) console.log(`         ${detail}`)
}

/** 取 `const WORKSPACES = [ … ]` 那一段（按方括号配对，不靠正则猜结尾）。 */
function workpacesBlock() {
  const start = src.indexOf('const WORKSPACES = [')
  if (start < 0) return null
  let depth = 0
  for (let index = start; index < src.length; index++) {
    if (src[index] === '[') depth += 1
    else if (src[index] === ']') { depth -= 1; if (depth === 0) return src.slice(start, index + 1) }
  }
  return null
}

const block = workpacesBlock()

// ── PGC-1 左侧栏底部的行数与顺序 ──────────────────────────────────────────
// 2026-10-08：用户裁定把「遥控器」插在「驾驶舱」下方、「坐标系」上方 ⇒ 从 5 行变 6 行。
// 位置要求本身没变（工程图仍在坐标系下方、建模中心上方），这里把行数与顺序表一起跟上。
chk('PGC-1', '★ 左侧栏底部图标行是 6 行（工作台 · 驾驶舱 · 遥控器 · 坐标系 · 工程图 · 建模中心）',
  block !== null && (block.match(/\{ id:/g) || []).length === 6,
  block === null ? '没找到 WORKSPACES 段' : `行数=${(block.match(/\{ id:/g) || []).length}`)

/**
 * 顺序表：`label:` 后面既可能是字面量（`'坐标系'`）也可能是常量（`PG_TITLE`）。
 * 常量要**解出它的值**再比 —— 否则断言的是"变量名"，那证明不了用户看到的那一行叫什么。
 */
function resolveLabel(token) {
  if (!token.startsWith('«')) return token
  const name = token.slice(1, -1)
  const found = new RegExp(`const ${name} = '([^']*)'`).exec(src)
  return found === null ? token : found[1]
}
const order = block === null ? [] : [...block.matchAll(/label:\s*(?:'([^']*)'|([A-Z_]+))/g)]
  .map((m) => resolveLabel(m[1] || `«${m[2]}»`))
chk('PGC-2', '★ 顺序契约：工程图排在「坐标系」下方、「建模中心」上方（遥控器在驾驶舱与坐标系之间）',
  JSON.stringify(order) === JSON.stringify(['工作台', '驾驶舱', '遥控器', '坐标系', '工程图', '建模中心']),
  order.join(' → '))

const idxCoords = block === null ? -1 : block.indexOf("label: '坐标系'")
const idxPg = block === null ? -1 : block.indexOf('label: PG_TITLE')
const idxModeling = block === null ? -1 : block.indexOf("label: '建模中心'")
chk('PGC-2b', '顺序的三个下标严格递增（坐标系 < 工程图 < 建模中心）',
  idxCoords >= 0 && idxPg > idxCoords && idxModeling > idxPg,
  `坐标系@${idxCoords} 工程图@${idxPg} 建模中心@${idxModeling}`)

// ── PGC-3 两个入口指向同一个 id ──────────────────────────────────────────
chk('PGC-3', '★ 左侧栏那一行与官方右栏的 tab 类型是**同一个 id**（否则点了打不开）',
  src.includes("const PANEL_PROJECT_GRAPH = 'dsh-workdesktop:project-graph'")
  && block !== null && block.includes('{ id: PANEL_PROJECT_GRAPH, label: PG_TITLE, icon: iconProjectGraph }'),
  '')

// ── PGC-4 官方侧边栏（右侧栏）的注册 ─────────────────────────────────────
const regStart = src.indexOf('function tryRegisterSidebarTab()')
const regEnd = src.indexOf('// ③（已取消）', regStart)
const reg = regStart < 0 ? '' : src.slice(regStart, regEnd < 0 ? regStart + 6000 : regEnd)
chk('PGC-4', '★ 官方右栏：注册了 `dsh-workdesktop:project-graph` 这个 tab 类型',
  /tabs\.register\(\{\s*id: PANEL_PROJECT_GRAPH[\s\S]{0,120}kind: PANEL_PROJECT_GRAPH[\s\S]{0,120}title: \(\) => PG_TITLE/.test(reg),
  '')
chk('PGC-4b', '★ 官方右栏：正文挂进键控席位 `sidebar.right.pane.tab`，key 同 id',
  /ctx\.slots\.inject\('sidebar\.right\.pane\.tab'[\s\S]{0,220}name: 'sidebar\.right\.pane\.tab', key: PANEL_PROJECT_GRAPH/.test(reg),
  '')
chk('PGC-4c', '官方右栏：指南页里也有一张工程图入口卡（带彩色底板）',
  /id: 'project-graph'[\s\S]{0,200}guideOf\('project-graph', GUIDE_PLATE_TEAL, marksProjectGraph\(\)\)/.test(reg),
  '')
chk('PGC-4d', '正文组件是 ProjectGraphView（不是占位符）',
  /key: PANEL_PROJECT_GRAPH[\s\S]{0,160}React\.createElement\(ProjectGraphView/.test(reg),
  '')

// ── PGC-5 图标作图纪律（与另外四枚同一套，见 client.js 的作图纪律那段）──────
const iconStart = src.indexOf('const marksProjectGraph = ()')
const iconEnd = src.indexOf('function iconProjectGraph', iconStart)
const icon = iconStart < 0 ? '' : src.slice(iconStart, iconEnd < 0 ? iconStart + 900 : iconEnd)
chk('PGC-5', '图标：五枚图形共用 16×16 画布 / currentColor（不写死颜色）',
  icon.includes('React.createElement') && !/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})/.test(icon) && !/fill:\s*'rgb/.test(icon),
  '')
chk('PGC-5b', '图标：与「建模中心」不是同一枚图形（两处分别定义、不互相引用）',
  src.includes('function iconModeling(') && src.includes('function iconProjectGraph(')
  && icon.includes("d: 'M4.7 4.9 9.8 7.1'"),
  '')

// ── PGC-6 面板与 host 的接口面 ────────────────────────────────────────────
// 2026-10-03：面板改成**画布交互**之后，数据源从"上游 CLI 视角"（get_all_nodes / invoke）
// 换成**文档层**（直接读 .prg，标识是 uuid）。所以这里断言的是**新的**那条接口面 ——
// 不是把旧断言删掉了事：status / projects 照旧，另外必须真的接了那五条文档层路由。
const viewStart = src.indexOf('function ProjectGraphView()')
const viewEnd = src.indexOf('// ── 席位接线', viewStart)
// ⚠️ 上限要**够大**：画布交互那一版比原来的查看器长一倍多，20000 字符会把函数尾巴切掉，
//    于是"面板调了哪些东西"这类断言会假红（实测踩到）。
const view = viewStart < 0 ? '' : src.slice(viewStart, viewEnd < 0 ? viewStart + 80000 : viewEnd)
chk('PGC-6', '★ 面板接的是 host 的 `/workdesktop/api/pg/*`：status / projects + **五条文档层路由**',
  ["'/pg/status'", "'/pg/projects'", "'/pg/document?project='", "'/pg/move'", "'/pg/insert'", "'/pg/delete'", "'/pg/text'"]
    .every((p) => view.includes(p)),
  ["'/pg/document?project='", "'/pg/move'", "'/pg/insert'", "'/pg/delete'", "'/pg/text'"]
    .filter((p) => !view.includes(p)).join(', ') || 'ok')
// 2026-10-09 改：长出子树**不再绕上游命令行**（那条每调用一次要起一个进程，界面干等好几秒），
// 改走文档层的 /pg/grow（瞬时）。所以这条断言的落点也跟着变：
//   · 面板必须**确实走文档层**（/pg/grow）；
//   · 顺手仍然不许自己编上游工具名 —— 面板里凡出现 `tool: 'x'`，x 必须在真实目录里。
chk('PGC-6b', '★ 长出子树走**文档层**（/pg/grow，瞬时），不再绕上游命令行',
  src.includes("'/pg/grow'"),
  src.includes("'/pg/grow'") ? '/pg/grow 在位' : '面板里找不到 /pg/grow')
chk('PGC-6c', '面板写盘失败时**如实显示原因**，不吞成"成功"',
  /r\.ok !== true/.test(view) && /say\('bad'/.test(view) && /String\(r\.error \|\|/.test(view),
  '')
chk('PGC-6e', '★ 画布交互的五个件都在（选中集合 / 拖动 / 框选 / 右键菜单 / 键盘）',
  view.includes('setSelected') && view.includes("kind: 'move'") && view.includes("kind: 'marquee'")
  && view.includes('onContextMenu') && view.includes('onKeyDown'),
  '')
chk('PGC-6f', '★ 屏幕↔世界坐标只有一套换算（`(x - tx) / k`）—— 框选命中要靠它，写两套就会偏',
  view.includes('(event.clientX - rect.left - v.tx) / v.k')
  && view.includes("transform: 'translate(' + view.tx + ' ' + view.ty + ') scale(' + view.k + ')'"),
  '')
chk('PGC-6d', '面板把不可用的原因逐条写出来（缺检出 / 缺依赖 / 缺 helper 三态分开）',
  view.includes('status.repoReady !== true') && view.includes('status.dependenciesReady !== true')
  && view.includes('status.helperReady !== true'),
  '')
chk('PGC-6d', '面板把不可用的原因逐条写出来（缺检出 / 缺依赖 / 缺 helper 三态分开）',
  view.includes('status.repoReady !== true') && view.includes('status.dependenciesReady !== true')
  && view.includes('status.helperReady !== true'),
  '')

// ── PGC-7 生命周期：样式必须随插件卸载 ──────────────────────────────────
chk('PGC-7', '★ 面板自带的 `<style>` 挂在 ctx.effect 上（禁用/HMR 不留残留）',
  src.includes("pgStyle.setAttribute('data-dshw-pg', '')")
  && /ctx\.effect\(\(\) => \(\) => \{ try \{ pgStyle\.remove\(\)/.test(src),
  '')

// ── PGC-8 不许有 JSX / ESM（浏览器模块加载器只认这一种形状）────────────────
chk('PGC-8', '新增段没有 JSX（浏览器半体不经过编译器）',
  !/<[A-Z][A-Za-z]*[\s/>]/.test(view) && !view.includes('React.createElement'.replace('Element', 'element') + '<'),
  '')
chk('PGC-8b', '整个 client.js 仍无 ESM 语法（与既有契约一致）',
  !/^\s*(import|export)\b/m.test(src),
  '')

console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exitCode = fail === 0 ? 0 : 1
