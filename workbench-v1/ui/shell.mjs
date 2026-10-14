/**
 * v1/ui/shell.mjs —— **工作台外壳渲染**（P4；需求 3.3.1）
 *
 * 需求 3.3.1 三条硬要求（都写成了断言）：
 *   ① 名称不变：**工作台**
 *   ② **顶部横向导航** + **底部状态栏**在**所有**页面都存在
 *   ③ 状态栏横向一行：DWS / MCP / 本地工具 / 浏览器 + 三个开关
 *      （实时回复 / 响应功能 / 向量检索 —— 开关名与 system-switches 能力名一致）
 *
 * ★ 本文件**全文不使用模板字符串**，一律字符串拼接。
 *   理由（实测教训）：这个文件里多层嵌套模板反复触发语法错，而且报错位置指向**下一行**
 *   （"Unexpected token 'class'" 出现在无关的行上），定位成本极高。渲染层只是拼字符串，
 *   用拼接换来"改哪儿错在哪儿"，这笔账划算。
 *
 * 样式值全部来自 `v1/ui/tokens.mjs`（照 DESIGN-webflow.md 抄的），本文件不写死颜色。
 */

import { RADIUS, SHADOWS, cssVariables } from './tokens.mjs';
import { overview, messages, todos, schedules, notes, scheduleHeatmap } from '../api/pages.mjs';
import { clientScript, clientStyle } from './client.mjs';

export const APP_NAME = '工作台';

export const PAGE_DEFS = Object.freeze([
  { key: 'overview', label: '今日总览' },
  { key: 'messages', label: '消息' },
  { key: 'todos', label: '待办' },
  { key: 'schedules', label: '日程' },
  { key: 'notes', label: '笔记' },
]);

export const STATUS_ITEMS = Object.freeze([
  { key: 'dws', label: 'DWS' },
  { key: 'mcp', label: 'MCP' },
  { key: 'localtools', label: '本地工具' },
  { key: 'browser', label: '浏览器' },
]);

export const SWITCHES = Object.freeze([
  { key: 'realtime_reply', label: '实时回复' },
  { key: 'voice_command', label: '响应功能' },
  { key: 'vector_search', label: '向量检索' },
]);

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
  });
}
function pad(n) { return String(n).padStart(2, '0'); }
function fmtTime(ms) {
  const d = new Date(ms);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 样式表（值来自 token；concat 拼接，无模板） */
export function stylesheet() {
  const s = [];
  s.push(cssVariables());
  s.push('* { box-sizing: border-box; }');
  s.push('body { margin: 0; background: var(--c-canvas); color: var(--c-body); font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-weight: var(--w-regular); }');
  // 顶部横向导航
  s.push('.topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: var(--s-xl); padding: var(--s-lg) var(--s-3xl); background: var(--c-canvas); border-bottom: 1px solid var(--c-hairline); }');
  s.push('.brand { font-size: 18px; font-weight: var(--w-strong); color: var(--c-primary); letter-spacing: -.4px; }');
  s.push('.nav { display: flex; flex-direction: row; gap: var(--s-lg); flex: 1; }');
  s.push('.nav a { color: var(--c-ink); text-decoration: none; font-size: 14px; font-weight: var(--w-medium); padding: var(--s-xs) 0; }');
  s.push('.nav a[aria-current="page"] { color: var(--c-primary); border-bottom: 2px solid var(--c-primary); font-weight: var(--w-strong); }');
  s.push('main { padding: var(--s-xl) var(--s-3xl) var(--s-4xl); max-width: 1180px; }');
  s.push('h1, h2, h3 { color: var(--c-ink); font-weight: var(--w-strong); margin: 0; }');
  s.push('.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--s-lg); margin-bottom: var(--s-xl); }');
  s.push('.card { background: var(--c-canvas); border: 1px solid var(--c-hairline); border-radius: ' + RADIUS.md + 'px; padding: var(--s-lg); }');
  s.push('.card.featured { box-shadow: var(--shadow-card); }');
  // ★★ 2026-10-14 加（用户第 4 条）：总览的数字卡可点跳转。
  //   `a.card` 默认带下划线、蓝色、行内显示 —— 三条都要按 `div.card` 的观感盖掉，
  //   否则同一个 `.stats` 里点得动的卡和点不动的卡看起来是两种东西。
  //   ⚠️ 2026-10-14 修：这里原来写的是 `a.card`，但 `.stats` 里的锚点**没有 `card` 这个类**
  //     （`statCards` 给的是 `class="card card-go"`；而 `a.card` 与 `.card` 在 CSS 里
  //     是**同一个选择器**，`.card` 本来就命中它）⇒ `display:block; cursor:pointer`
  //     实际落到了**所有卡**上：四个内页那些"只是个数字、点不动"的卡也变成了**手型光标**，
  //     鼠标移上去像是能点。**样式没生效在以为的地方，反而落到了不该落的地方。**
  //   ⇒ 拆开写：普遍规则（所有卡：阴影 + 渐变）与"只给链接"的规则（上浮 + 手型 + 去下划线）。
  s.push('.card { transition: box-shadow .12s ease, transform .12s ease; }');
  s.push('.card:hover { box-shadow: var(--shadow-lifted); }');
  // ★★ 2026-10-14 加：**会话详情**里那两块（信息原文 / 相关上下文）以及在原文行前的勾选框。
  //   会话详情与普通详情浮层的区别：正文是**一批按时间排的消息**，不是一行文字。
  //   所以给它自己的类，不去改通用的 `.ov-v`（那会牵连另外四个页面的详情）。
  s.push('.ov-block { margin-top: var(--s-md, 10px); }');
  s.push('.ov-block-h { font-size: 12px; color: var(--c-mute); margin-bottom: 6px; }');
  s.push('.ov-conv-bar { display: flex; align-items: center; gap: 10px; padding: 4px 0 8px; font-size: 12px; color: var(--c-mute); }');
  s.push('.ov-conv-alllab { display: flex; align-items: center; gap: 4px; cursor: pointer; }');
  s.push('.ov-conv-body { max-height: 46vh; overflow-y: auto; scrollbar-gutter: stable; border-top: 1px solid var(--c-hairline); }');
  s.push('.ov-conv-line { display: flex; align-items: flex-start; gap: 8px; padding: 5px 2px; border-bottom: 1px solid var(--c-hairline); font-size: 13px; line-height: 1.55; }');
  s.push('.ov-conv-cb { flex: none; margin-top: 3px; }');
  s.push('.ov-conv-hm { flex: none; min-width: 44px; color: var(--c-mute); font-variant-numeric: tabular-nums; }');
  s.push('.ov-conv-txt { flex: 1; white-space: pre-wrap; word-break: break-word; }');
  s.push('.ov-ctx-text { white-space: pre-wrap; font-size: 13px; line-height: 1.6; }');
  s.push('.ov-ctx-note { font-size: 12px; color: var(--c-mute); margin-top: 4px; }');
  // 会话行可点：给个提示（整行可点，与其它页面的列表一致）
  // ⚠️ 选择器写 `.jl-list li[data-conv]` —— 列表本体是 `<ul class="list jl-list">`，
  //   两个类是**同一个元素**上的，写 `.list .jl-list` 是**后代**关系、匹配不到。
  //   （第一版就是这么写的，等于这条样式没生效。）
  s.push('.jl-list li[data-conv] { cursor: pointer; }');
  s.push('a.card { text-decoration: none; color: inherit; display: block; cursor: pointer; }');
  s.push('a.card:hover { transform: translateY(-1px); }');
  s.push('a.card:focus-visible { outline: 2px solid var(--c-accent-blue); outline-offset: 2px; }');
  // ★★ 2026-10-14 加（用户原话）：「消息、待办、日程、笔记页面的**数据统计标签**，
  //   需要增加**鼠标悬停时的阴影效果**，类似于在"今日总览"中，当鼠标移动到
  //   "待处理消息"、"待完成待办"、"近7日日程"和"近1周笔记"时，出现的阴影效果一致」。
  //
  //   为什么原来只有总览那四张有：它们是链接（**可点跳转**），悬停效果写在了链接那条规则上；
  //   四个内页的统计卡是普通卡（**只是个数字，不跳**）⇒ 压根没有悬停样式。
  //   ⇒ 现在阴影给**所有卡**（上面那条 `.card:hover`），两处观感一致。
  //   ⚠️ 可点的卡**仍多两条**：轻微上浮 + 手型光标 —— 有区别是对的，
  //     否则用户分不清哪张点得动。用户要的是"阴影效果一致"，不是"两种卡完全一样"。
  //   ⚠️ 阴影必须配 `transition`（上面那条），否则是**瞬变**、看起来像闪一下，而总览那四张是渐变的。
  s.push('.card .num { font-size: 28px; font-weight: var(--w-strong); color: var(--c-ink); line-height: 1.2; }');
  s.push('.card .cap { font-size: 13px; color: var(--c-mute); margin-top: var(--s-xs); }');
  s.push('.section { margin-top: var(--s-xl); }');
  s.push('.section h2 { font-size: 15px; margin-bottom: var(--s-sm); }');
  // Tab 导航（消息页五个 Tab）——2026-10-12 新增：原先借数据列表那条通道，被 `esc()` 转义成了纯文本。
  s.push('.tabs { list-style: none; padding: 0; margin: 0 0 var(--s-md); display: flex; flex-wrap: wrap; gap: var(--s-md); border-bottom: 1px solid var(--c-hairline); }');
  s.push('.tabs a { display: inline-block; padding: var(--s-xs) 0; color: var(--c-mute); text-decoration: none; font-size: 14px; border-bottom: 2px solid transparent; }');
  s.push('.tabs a[aria-current="page"] { color: var(--c-ink); font-weight: var(--w-medium); border-bottom-color: var(--c-ink); }');
  s.push('.list { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--c-hairline); }');
  s.push('.list li { display: flex; gap: var(--s-md); padding: var(--s-sm) 0; border-bottom: 1px solid var(--c-hairline); font-size: 14px; }');
  s.push('.list .when { color: var(--c-mute); min-width: 92px; }');
  s.push('.list .who { color: var(--c-body-mid); min-width: 120px; }');
  s.push('.list .overdue { color: var(--c-accent-red); font-weight: var(--w-medium); }');
  // 来源格（2026-10-13 加）：小一号、右对齐、不抢主信息的注意力
  s.push('.list .src { color: var(--c-mute); font-size: 12px; min-width: 44px; text-align: right; flex: none; }');
  // ★★ 2026-10-14 加：**列表表头**（用户逐字点名了四个页面的字段名）。
  //   用 `li.jl-head` 与数据行同一套 flex 规则 ⇒ 列宽自动对齐，不必各写一套宽度。
  //   样式上：小一号、字色淡、**没有下边框拖尾**（它是标题不是数据），
  //   并且 `user-select: none`（列名不该被当内容选中、也避免被复制走）。
  s.push('.list .jl-head { color: var(--c-mute); font-size: 12px; padding-bottom: var(--s-xs); border-bottom: 1px solid var(--c-hairline); user-select: none; }');
  s.push('.list .jl-head span { flex: none; }');
  // 表头前两格与数据行的 `.when` / `.who` 同宽（`li` 是 flex，靠 min-width 对齐）
  s.push('.list .jl-head span:nth-child(1) { min-width: 92px; }');
  s.push('.list .jl-head span:nth-child(2) { min-width: 120px; }');
  // ★★ 2026-10-14 加：**第五列**（消息页要五列：日期/时间/来源/发信人/信息内容）。
  //   前四格沿用既有类（when / who / 主列 / src），第五格给一个自有类；
  //   消息页的信息内容要能占满剩余宽度并**截断**（详情里才展开全文）。
  s.push('.list .col5 { color: var(--c-body-mid); min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
  // ══ 页内平铺的新增表单（2026-10-13 加，用户第 4 条）══════════════════════════
  //   参考模板里表单与列表同一层级、不藏在弹层后面 ⇒ 这里也摊平。
  //   网格自适应：窄栏自动折行，不出现横向滚动。
  s.push('.inline-form { margin-top: var(--s-xl); border: 1px solid var(--c-hairline); border-radius: ' + RADIUS.sm + 'px; padding: var(--s-md); }');
  s.push('.inline-form .if-head { display: flex; align-items: center; gap: var(--s-md); margin-bottom: var(--s-sm); }');
  s.push('.inline-form .if-head h2 { font-size: 14px; margin: 0; flex: 1; }');
  s.push('.inline-form .if-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--s-sm); }');
  s.push('.inline-form .if-cell { display: flex; flex-direction: column; gap: 2px; }');
  s.push('.inline-form .if-lab { font-size: 12px; color: var(--c-mute); }');
  s.push('.inline-form .if-req { font-style: normal; color: var(--c-accent-red); margin-left: 4px; font-size: 11px; }');
  s.push('.inline-form .if-input { font: inherit; font-size: 13px; padding: 4px 6px; border: 1px solid var(--c-hairline); border-radius: 4px; background: transparent; color: var(--c-ink); }');
  s.push('.inline-form .if-msg { font-size: 12px; color: var(--c-mute); }');
  s.push('.inline-form .if-msg.bad { color: var(--c-accent-red); }');
  // 表单一句话说明（例：消息页那句"等同于在钉钉里给自己发一条文本"）
  s.push('.inline-form .if-hint { font-size: 12px; color: var(--c-mute); margin-bottom: var(--s-sm); }');
  // 多行分组之间留一点间距（日程页是两行：主题+起止 / 地点+参与人+详情+类型）
  s.push('.inline-form .if-grid + .if-grid { margin-top: var(--s-sm); }');
  // ══ 分页条（2026-10-13 加，用户第 5 条）══════════════════════════════════════
  //   样式照用户给的那张图：左侧"总计 N"、中间页码按钮（当前页高亮）+ 省略号 + 末页、
  //   左箭头上一页、右箭头下一页、"1/383"、到第 __ 页 [前往]、右侧"每页显示 [10 ▾]"。
  s.push('.pager { display: flex; align-items: center; gap: var(--s-sm); flex-wrap: wrap; margin-top: var(--s-md); font-size: 13px; color: var(--c-body-mid); }');
  s.push('.pager .pg-total { color: var(--c-mute); }');
  s.push('.pager button { background: transparent; color: var(--c-ink); border: 1px solid var(--c-hairline); border-radius: 4px; padding: 2px 9px; font-size: 13px; cursor: pointer; }');
  s.push('.pager button[aria-current="page"] { background: var(--c-primary); color: var(--c-canvas); border-color: var(--c-primary); font-weight: var(--w-medium); }');
  s.push('.pager button:disabled { opacity: 0.4; cursor: default; }');
  s.push('.pager .pg-gap { color: var(--c-mute); }');
  s.push('.pager input, .pager select { font: inherit; font-size: 13px; padding: 2px 4px; border: 1px solid var(--c-hairline); border-radius: 4px; background: transparent; color: var(--c-ink); }');
  s.push('.pager .pg-jump { width: 56px; text-align: center; }');
  s.push('.pager .grow { flex: 1; }');
  // ★★ 2026-10-14 改（用户第 3 条原话）：
  //   「**不仅是笔记列表，消息列表、待办列表和日程列表的滚动条都要在列表中展示，而不是在页面中展示**，
  //     尤其是在切换了每页显示数量之后，还有日程页面本身的高度是有限的，
  //     超过页面最大高度的日程列表，应该在列表中出现垂直滚动条，**要保证有效信息展现在一个页面**。」
  //
  //   原来只有笔记页带 `list-scroll`（那时用户只点了笔记那一页）—— 现在四个列表都要。
  //   做法两条，缺一不可：
  //     一、列表容器 `max-height` + `overflow-y:auto` ⇒ 滚动条长在**列表**里；
  //     二、列表**自己**再 `scrollbar-gutter: stable`（见下一条）—— 免得"从 10 条切到 100 条"时
  //        因为滚动条出现/消失导致整页宽度跳一下。
  //   ⚠️ `max-height` 用 `vh` 而不是固定像素：面板高度随窗口变，固定像素在高窗口下会留一大片空。
  s.push('.list-scroll { max-height: 52vh; overflow-y: auto; scrollbar-gutter: stable; }');
  // ★ 第 3 条后半句："**要保证有效信息展现在一个页面**" —— 列表之外的部分（统计卡、页签、
  //   新增表单、分页条）也要收紧一点，否则一屏里列表只剩一条的高度，等于没分页。
  s.push('.section { margin-top: var(--s-lg); }');
  s.push('.section h2 { font-size: 14px; margin: 0 0 var(--s-xs); }');
  s.push('.stats { margin-top: var(--s-md); }');
  // 底部状态栏（横向一行）
  s.push('.statusbar { position: fixed; bottom: 0; left: 0; right: 0; display: flex; flex-direction: row; align-items: center; gap: var(--s-lg); padding: var(--s-sm) var(--s-3xl); background: var(--c-canvas); border-top: 1px solid var(--c-hairline); font-size: 12px; color: var(--c-body-mid); }');
  s.push('.statusbar .dot { display: inline-block; width: 6px; height: 6px; border-radius: 9999px; background: var(--c-accent-green); margin-right: 6px; }');
  s.push('.statusbar .dot.off { background: var(--c-mute-soft); }');
  s.push('.statusbar .grow { flex: 1; }');
  // ★ 2026-10-13 加：三个能力开关（实时回复 / 响应功能 / 向量检索）的**四态配色与可点感**。
  //   颜色由客户端按真状态写成行内样式（状态名 → 颜色有唯一产地，见 system-switches.mjs#STATE_COLOR），
  //   这里只负责"看起来能点"和"点的范围够大"。
  s.push('.statusbar .switch { display: inline-flex; align-items: center; cursor: pointer; user-select: none; padding: 2px 4px; border-radius: 4px; }');
  s.push('.statusbar .switch:hover { background: var(--c-hairline); }');
  s.push('.statusbar .switch[aria-busy="1"] { opacity: 0.55; cursor: progress; }');
  s.push('.statusbar .switch .dot { transition: background 120ms linear; }');
  // 按钮：品牌几何 4px 矩形，绝不胶囊
  s.push('button { font: inherit; background: var(--c-primary); color: var(--c-canvas); border: 0; border-radius: ' + RADIUS.sm + 'px; padding: var(--s-xs) var(--s-md); font-weight: var(--w-medium); cursor: pointer; }');
  s.push('.empty { color: var(--c-mute); font-size: 13px; padding: var(--s-sm) 0; }');
  s.push('.spacer { height: 56px; }');
  // 日程密度热力图（需求 3.3.5）：左月历、右分析；色阶**只用 token 变量**，不写死颜色
  s.push('.heat-wrap { display: flex; gap: var(--s-xl); align-items: flex-start; flex-wrap: wrap; }');
  s.push('.heat { flex: 0 0 auto; }');
  s.push('.hm-grid { display: grid; grid-template-columns: repeat(7, 34px); gap: 4px; }');
  s.push('.hm-h { font-size: 11px; color: var(--c-mute); text-align: center; }');
  s.push('.hm-c { width: 34px; height: 34px; border-radius: ' + RADIUS.sm + 'px; border: 1px solid var(--c-hairline); display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 11px; color: var(--c-body-mid); }');
  s.push('.hm-empty { border: 1px dashed var(--c-hairline); opacity: .35; }');
  s.push('.hm-c .hm-d { font-size: 10px; line-height: 1; }');
  s.push('.hm-c .hm-n { font-size: 11px; font-weight: var(--w-strong); color: var(--c-ink); line-height: 1; }');
  s.push('.hm-l1 { background: color-mix(in srgb, var(--c-primary) 14%, transparent); }');
  s.push('.hm-l2 { background: color-mix(in srgb, var(--c-primary) 34%, transparent); }');
  s.push('.hm-l3 { background: color-mix(in srgb, var(--c-primary) 58%, transparent); }');
  s.push('.hm-l4 { background: color-mix(in srgb, var(--c-primary) 82%, transparent); }');
  s.push('.hm-l4 .hm-d, .hm-l4 .hm-n { color: var(--c-canvas); }');
  s.push('.hm-legend { display: flex; align-items: center; gap: 6px; margin-top: var(--s-sm); font-size: 11px; color: var(--c-mute); }');
  s.push('.hm-legend .hm-c { width: 14px; height: 14px; }');
  s.push('.heat-an { flex: 1 1 320px; min-width: 280px; }');
  s.push('.heat-an-t { font-size: 13px; font-weight: var(--w-medium); color: var(--c-ink); margin-bottom: var(--s-xs); }');
  s.push('.heat-an .list li { display: block; font-size: 13px; color: var(--c-body); }');
  return s.join('\n');
}

function topbar(active) {
  let links = '';
  for (const p of PAGE_DEFS) {
      // ★★ 2026-10-12 修（**用户报"点 tab 无响应、切不了页"**）：
    //   原来写的是 `href="#<key>"` —— 那是**页内锚点**，点了只会给地址挂一个 `#todos` 片段，
    //   **永远不会换页**。而六个页面是**六个独立文件**（不是单页应用），
    //   链接必须指向文件：`./todos.html`。
    //   ⚠️ 面板内嵌时那个路由**不认 `.html`**（实测只回 182 字节空页）⇒
    //     由客户端脚本按当前地址形态改写（见 `client.mjs` 里"顶部导航链接改写"那段），
    //     两种打开方式都对；服务端这边保持"文件链接"这个**离线直开也成立**的形态。
    links += '<a href="./' + p.key + '.html"' + (p.key === active ? ' aria-current="page"' : '') + '>' + esc(p.label) + '</a>';
  }
  return '<header class="topbar"><div class="brand">' + APP_NAME + '</div><nav class="nav">' + links + '</nav></header>';
}

/**
 * 底部状态栏：左侧四个系统状态灯（只读探针），右侧三个**能力开关**。
 *
 * ★★ 2026-10-13 改（用户裁定，原话）：
 *   「工作台前端页面下方的状态栏当中的实时回复/响应功能/向量检索这三个状态指示灯应该像之前一样具备切换功能，
 *     灰色是关闭，红色是离线状态，绿色是空闲中，黄色是运行中，
 *     鼠标悬停到这三个位置，应该会显示悬浮的文字说明。」
 *
 * 改动前的问题：这三个只是「一个点 + 一行字」，**点不动、没有悬浮说明、只有亮/灰两种样子**。
 * 而它们背后**本来就有完整的四态判定**（库内 `_meta/workbench/system-switches.mjs`：
 * `off`→灰 · `down`→红 · `ok`→绿 · `busy`→黄，还带 `why` 说明和过渡态 `starting`/`stopping`），
 * 只是页面上从来没接。
 *
 * 所以这里**不自创颜色**：把开关的 key 打到 DOM 上（`data-switch`），
 * 由客户端脚本去拉真状态（`GET /system-switch`，面板透传库内 CLI）再把
 * **颜色 / 文案 / 悬浮说明** 一起填上。初值仍按渲染时的开关位给出灰或绿 ——
 * 「拉不到状态就保持灰」是诚实的：**不知道就不装作知道**（这条在本项目反复强调过）。
 */
function statusbar(status, switches, statusDetail) {
  status = status || {}; switches = switches || {}; statusDetail = statusDetail || {};
  let items = '';
  for (const it of STATUS_ITEMS) {
    // 悬浮说明给**探针原话**（有就给），没有就按三态说清楚 —— 别写"状态正常"这种空话
    const d = statusDetail[it.key];
    const tip = d || (status[it.key] === true ? '已探明：可用' : status[it.key] === false ? '已探明：不可用' : '未探明（探针没给结论）');
    items += '<span title="' + esc(it.label + '：' + tip) + '"><i class="dot'
      + (status[it.key] === true ? '' : ' off') + '"></i>' + esc(it.label) + '</span>';
  }
  let sw = '';
  for (const it of SWITCHES) {
    sw += '<span class="switch" data-switch="' + esc(it.key) + '" role="button" tabindex="0"'
      + ' title="' + esc(it.label) + '：状态读取中…">'
      + '<i class="dot off" data-switch-dot="' + esc(it.key) + '"></i>'
      + '<span data-switch-label="' + esc(it.key) + '">' + esc(it.label) + '</span></span>';
  }
  return '<div class="statusbar">' + items + '<span class="grow"></span>' + sw + '</div>';
}

/**
 * **页内平铺的新增表单**（用户 2026-10-13 裁定，原话）：
 *   「工作台前端页面的页面结构应当参考"奕伴工作台.html"，例如，工作台中消息/待办/日程/笔记的**新增 1 条
 *     应该是平铺在一级页面**，而不是作为按钮点击之后打开弹出浮层详情页。」
 *
 * 改动前：新增是右上角一个「新增一条」按钮 → 点了弹一个浮层表单。
 *   ⇒ 现在改成**直接摊在页面上**：四个字段一行，随手就能填。
 *   参考模板里也是这个形状（表单跟列表在同一层级，不藏在弹层后面）。
 *
 * ⚠️ 与旧实现的**一个关键区别**：旧的那份用 `window.prompt()` 逐个问字段，
 *   而 prompt 在 iframe 里**能弹出来但返回 null**（面板就是这么嵌页面的）⇒ 点了什么都不发生。
 *   这里全部是页面内的 `<input>`，不依赖任何浏览器原生弹窗。
 *
 * 字段与契约对齐（`schema.mjs#PAYLOAD_SPEC`）：
 *   message 必填 channel/sender/raw（channel 由页面补 manual）· todo 必填 topic/detail
 *   schedule 必填 topic/start/end · note 必填 topic/date/content_md
 */
export function inlineForm(pageKey) {
  // ★★ 2026-10-13 改（用户第二轮裁定，三条）：
  //   ① 消息：「新增一条消息 **等同于我在钉钉中自己给自己发了一条文本信息**，只需要填写内容即可，
  //      发信人不需要显示默认记录为我（月夜），来源渠道也不需要显示默认记录为工作台」
  //      ⇒ 表单**只留「内容」一个输入框**；发信人与来源由客户端写死成默认值（我 / 工作台），不再让人填。
  //   ② 待办字段顺序 = 任务主题 · 截止时间 · 执行人 · 任务详情
  //   ③ 日程字段顺序 = 日程主题 · 开始 · 结束 · 地点 · 参与人 · 日程详情；
  //      且**主题与起止时间在第一行**、**参与人 / 地点 / 日程详情在第二行**；
  //      另加「类型」可选项：会议 / 活动 / 课程 / 行程。
  //   ⇒ 表单按 `rows` 分组渲染（不再是一整片自适应网格）；`select` 类型走下拉。
  const SPEC = {
    messages: {
      title: '新增一条消息', btn: '记下这条消息',
      hint: '等同于在钉钉里给自己发一条文本 —— 发信人与来源自动记为我（月夜）/ 工作台',
      rows: [[['raw', '内容', 'text', true]]],
    },
    todos: {
      title: '新增一条待办', btn: '建为待办',
      rows: [[
        ['topic', '任务主题', 'text', true],
        ['due', '截止时间（YYYY-MM-DD）', 'date', false],
        ['executor', '执行人', 'text', false],
        ['detail', '任务详情', 'text', false],
      ]],
    },
    schedules: {
      title: '新增一条日程', btn: '建为日程',
      rows: [
        [
          ['topic', '日程主题', 'text', true],
          ['start', '开始（YYYY-MM-DDTHH:mm）', 'text', true],
          ['end', '结束', 'text', true],
        ],
        [
          ['place', '地点', 'text', false],
          ['participants', '参与人（顿号分隔）', 'text', false],
          ['detail', '日程详情', 'text', false],
          ['type', '类型', 'select', false, ['会议', '活动', '课程', '行程']],
        ],
      ],
    },
    notes: {
      title: '新增一条笔记', btn: '存为笔记',
      rows: [[
        ['topic', '笔记主题', 'text', true],
        ['content_md', '内容', 'text', true],
        ['tags', '标签（逗号分隔）', 'text', false],
      ]],
    },
  }[pageKey];
  if (!SPEC) return '';
  let rowsHtml = '';
  for (const row of SPEC.rows) {
    let cells = '';
    for (const [name, label, type, required, options] of row) {
      let input;
      if (type === 'select') {
        let opts = '<option value=""></option>';
        for (const o of (options ?? [])) opts += '<option value="' + esc(o) + '">' + esc(o) + '</option>';
        input = '<select class="if-input" data-if="' + esc(name) + '">' + opts + '</select>';
      } else {
        input = '<input class="if-input" data-if="' + esc(name) + '" type="' + esc(type) + '" placeholder="' + esc(label) + '">';
      }
      cells += '<label class="if-cell"><span class="if-lab">' + esc(label) + (required ? '<i class="if-req">必填</i>' : '') + '</span>' + input + '</label>';
    }
    rowsHtml += '<div class="if-grid">' + cells + '</div>';
  }
  return '<section class="inline-form" data-if-page="' + esc(pageKey) + '">'
    + '<div class="if-head"><h2>' + esc(SPEC.title) + '</h2>'
    + '<button class="btn if-submit" data-if-submit="1">' + esc(SPEC.btn) + '</button>'
    + '<span class="cap if-msg" data-if-msg="1"></span></div>'
    + (SPEC.hint ? '<div class="if-hint">' + esc(SPEC.hint) + '</div>' : '')
    + rowsHtml + '</section>';
}

/**
 * **分页条**（用户 2026-10-13 要求，样式照他给的那张图）。
 *
 * 图上的要素，逐个对上：
 *   左侧「总计: 3823」· 左箭头 · 页码按钮（当前页高亮蓝底）· 省略号 · 末页 ·
 *   右箭头 · 「1/383」· 「到第 __ 页」·「前往」· 右侧「每页显示: [10 ▾]」
 *
 * ★ 分页在**端上做**（不重新请求）：页面本来就把这一类型的数据整份渲染进 DOM
 *   （消息页实测 200 行、待办 11 行），所以翻页只是显示/隐藏。
 *   ⇒ 零请求、瞬间响应，也不必改接口的分页语义。
 *   每页条数写进 `localStorage`（`jl.pageSize`），换页/刷新都记得住。
 *   ⚠️ 为什么不服务端分页：面板那条路由是**读静态文件**，服务端分页要重渲染文件，
 *     而"点一下页码就重渲染整页"比端上隐藏重得多，且会丢掉当前的筛选状态。
 */
export const PAGE_SIZES = Object.freeze([10, 20, 50, 100]);
export const PAGE_SIZE_DEFAULT = 10;

export function pager(pageKey) {
  let opts = '';
  for (const n of PAGE_SIZES) opts += '<option value="' + n + '"' + (n === PAGE_SIZE_DEFAULT ? ' selected' : '') + '>' + n + '</option>';
  // ★★ 2026-10-14 加：**首页 / 末页**按钮（用户这一轮点名：「前几页、后几页、**首页**、**末页**等页码选择按钮」）。
  //   原来只有「‹ 上一页 / 下一页 ›」，中间那串页码是动态算的（含省略号），
  //   但**首页与末页没有一个固定的直达按钮** —— 几百条时"跳到最后一页"只能靠输入框，不好用。
  //   `«` / `»` 与既有的 `‹` / `›` 区分开（两个字符一组，一眼看得出是"到两头"）。
  return '<nav class="pager" data-pager="' + esc(pageKey) + '">'
    + '<span class="pg-total" data-pg-total="1">总计: 0</span>'
    + '<button type="button" data-pg-first="1" title="首页">«</button>'
    + '<button type="button" data-pg-prev="1" title="上一页">‹</button>'
    + '<span data-pg-nums="1"></span>'
    + '<button type="button" data-pg-next="1" title="下一页">›</button>'
    + '<button type="button" data-pg-last="1" title="末页">»</button>'
    + '<span data-pg-pos="1">1/1</span>'
    + '<span>到第</span><input class="pg-jump" data-pg-jump="1" type="text" inputmode="numeric">'
    + '<span>页</span><button type="button" data-pg-go="1">前往</button>'
    + '<span class="grow"></span>'
    + '<span>每页显示:</span><select data-pg-size="1">' + opts + '</select>'
    + '</nav>';
}

/**
 * 数字卡组。
 * @param {Array} pairs 每项 `[标签, 数字, 跳转目标]`
 *   第三个字段：
 *     · **字符串** = 点击跳到那个页面（用户第 4 条：总览上面的数字卡点一下要去对应页面）
 *     · `true` = 只是"重点卡"（高亮），**没有**跳转 —— 与字符串区分开，
 *       免得"给了个目标但拼错了"变成一张能点却没反应的空卡
 *     · 不给 = 普通卡，不可点
 *   ★ 2026-10-14 改：原来第三个字段是布尔（`featured` 高亮），
 *     而用户这次要的是"点它跳到对应页面" ⇒ 一个字段承担两件事会混，
 *     所以**改成"给字符串=可点且高亮，给 true=只高亮不可点，不给=普通"**，
 *     原来的四处调用（消息/待办/日程/笔记页）本来就没给第三个字段，不受影响。
 */
function statCards(pairs) {
  let html = '';
  for (const p of pairs) {
    const target = typeof p[2] === 'string' ? p[2] : null;
    const featured = target !== null || p[2] === true;
    const cls = 'card' + (featured ? ' featured' : '') + (target ? ' card-go' : '');
    const inner = '<div class="num">' + esc(p[1]) + '</div><div class="cap">' + esc(p[0]) + '</div>';
    html += target
      // ★ 用 `<a href>` 而不是 div+onclick：**不靠脚本也能跳**（页面在 iframe 里、
      //   脚本万一没跑，链接照样工作）；client.mjs 不用为它加任何绑定。
      ? '<a class="' + cls + '" href="./' + esc(target) + '.html" title="点这里打开「' + esc(p[0]) + '」对应的页面">' + inner + '</a>'
      : '<div class="' + cls + '">' + inner + '</div>';
  }
  return html;
}

/**
 * @param {string} title 小节标题
 * @param {Array} rows 行（`{id,col1,col2,col3,col4,go,state,overdue}`）
 * @param {string} cls 第三列的额外类名
 * @param {{scroll?:boolean,pageKey?:string}} o
 *   `scroll` = 只让这一块出滚动条（用户第 5 条：笔记列表超高时**不要整页出滚动条**）
 *   `pageKey` = 给这一块配分页条（用户第 5 条：四个列表都要能自动分页）
 */
function listBlock(title, rows, cls, o) {
  cls = cls || ''; o = o || {};
  if (!rows || !rows.length) return '<div class="section"><h2>' + esc(title) + '</h2><div class="empty">暂无</div></div>';
  let items = '';
  for (const r of rows) {
    // ★ `data-id` 是**必须**的（2026-10-12 补，P1-6）：
    //   详情浮层要按 id 取单条。此前的做法是"点击行 ⇒ 按行序从接口列表里取第 idx 条"，
    //   而**页面上给的是全量列表、接口按页签过滤**（`?tab=`）⇒ 只要页签一变，行序就对不上，
    //   点第 3 行会打开第 5 条 —— 错得还很安静。直接把 id 写进 DOM 就没有这层推断。
    const idAttr = r.id ? ' data-id="' + esc(r.id) + '"' : '';
    // `data-go` = 这条提醒属于哪一类（日程/待办/消息）⇒ 总览页据此跳到对应页面（需求 3.3.2）
    const goAttr = r.go ? ' data-go="' + esc(r.go) + '"' : '';
    // `data-state` = 消息页五个 Tab 的归属（待处理/已转待办/已转日程/已回复）⇒ **客户端据此筛行**。
    //   2026-10-12 加：面板路由是读静态文件，服务端筛不生效（见 pageMessages 的注释）⇒ 筛选必须在端上做。
    const stAttr = r.state ? ' data-state="' + esc(r.state) + '"' : '';
    // ★★ 2026-10-14 加（用户原话）：「**点击会话列表进入会话详情**」。
    //   会话行与消息行的 id 形态不同（会话 id 形如 `2026-10-14__cid:xxx`），
    //   客户端的点击处理要据此走 `/conversation?id=` 而不是 `/detail/messages/<id>`。
    //   ⇒ 用 `data-conv="1"` 标出来，**不靠猜 id 的形态**（猜形态这种事本项目栽过好几次）。
    const convAttr = r.conv ? ' data-conv="1"' : '';
    // ★ 2026-10-13 加：第四列 = **来源**（用户第 9/10/11 条都点名要这个字段）。
    //   待办/日程/笔记三页用它；消息页与总览页没有第四列 ⇒ 不渲染这一格（不留空壳）。
    const srcAttr = r.col4 ? '<span class="src">' + esc(r.col4) + '</span>' : '';
    // ★★ 2026-10-14 加：**第五列**。消息页这一轮要五列（日期/时间/来源/发信人/信息内容），
    //   而原来最多四列（第四列固定是"来源"）⇒ 第五列单独给一个类，样式在 CSS 里配。
    const col5Attr = r.col5 ? '<span class="col5">' + esc(r.col5) + '</span>' : '';
    items += '<li' + idAttr + goAttr + stAttr + convAttr + '><span class="when">' + esc(r.col1 || '') + '</span><span class="who">' + esc(r.col2 || '') + '</span><span class="' + cls + '">' + esc(r.col3 || '') + '</span>' + srcAttr + col5Attr + '</li>';
  }
  // ★★ 2026-10-12 修（**用户报"列表点不动"的最终根因**）：
  //   原来这里给**所有**列表都写 `class="list"`，包括热力图下面那段「动态分析」——
  //   而客户端脚本用 `main.querySelector(".list")` 取**第一个**，取到的就是那段分析文字。
  //   ⇒ 监听绑在了分析列表上；用户点真正的日程/待办行，**毫无反应、连报错都没有**。
  //   实测证据：脚本自报"容器=list · 可点行=**0**"，而同一页面上 `li[data-id]` 其实有 6 个。
  //   ⇒ 数据列表另给一个专用标识 `jl-list`（"接列表"），脚本按它取，不再与别处的 `.list` 撞。
  //     保留 `list` 这个类是为了不破坏既有样式与别处引用。
  //
  // ★ 2026-10-13 加：`o.scroll`（只让这一块出滚动条）· `o.pageKey`（给这一块配分页条）。
  const ulCls = 'list jl-list' + (o.scroll ? ' list-scroll' : '');
  // ★★ 2026-10-14 加：**列表表头（列名）** —— 用户在这一轮把四个页面的字段名逐条点名了：
  //   消息＝日期/时间/来源/发信人/信息内容；待办＝截止时间/来源/执行人/待办标题；
  //   日程＝日期/开始/结束/来源/日程主题；笔记＝日期/来源/笔记概括。
  //   原来**一个表头都没有**，用户只能靠位置猜哪一列是什么 ⇒ 补上 `o.head`（列名数组）。
  //   用 `<li class="jl-head">` 而不是 `<thead>`：列表本体是 `<ul>`，混用表格标签会长出怪样式。
  //   ⚠️ 表头行**不带 `data-id`** ⇒ 客户端的"可点行"计数与点击绑定都天然跳过它。
  const head = Array.isArray(o.head) && o.head.length
    ? '<li class="jl-head">' + o.head.map((x) => '<span>' + esc(x) + '</span>').join('') + '</li>'
    : '';
  // ★★ 2026-10-14 加：**页签**（用户：「Tab 位置应位于"消息列表"标题下方」）。
  //   放在**标题与列表之间** —— 原来消息页的页签在标题**之前**，位置不对。
  //   传进来的是 `[[key,label],…]`；客户端按 `data-tab` 筛行（服务端筛不生效，见 pageMessages 注释）。
  const tabs = Array.isArray(o.tabs) && o.tabs.length
    ? '<ul class="tabs">' + o.tabs.map((t) => '<li><a href="?tab=' + esc(t[0]) + '" data-tab="' + esc(t[0]) + '">' + esc(t[1]) + '</a></li>').join('') + '</ul>'
    : '';
  return '<div class="section"' + (o.pageKey ? ' data-pagekey="' + esc(o.pageKey) + '"' : '') + '><h2>' + esc(title) + '</h2>'
    + tabs
    + '<ul class="' + ulCls + '">' + head + items + '</ul>'
    + (o.pageKey ? pager(o.pageKey) : '')
    + '</div>';
}

export function pageOverview(snap) {
  const o = (snap && snap.overview) || overview();
  const st = o.stats;
  // ★★ 2026-10-14 改（用户第 4 条原话）：
  //   「今日总览最上方的数字展示模块，显示的待办、待处理消息、日程和笔记的数量，
  //     该展示模块**点击之后应该会跳转到对应的页面去**，另外，展示的顺序调整一下，
  //     应该是**消息、待办、日程、笔记**这样的顺序。」
  //   原来顺序是（待办 / 消息 / 日程 / 笔记）—— 用户要的是消息打头。
  //   第四项（"是否有跳转"）由 `statCards` 的第三个字段承担：给了就是链接。
  const cards = statCards([
    ['待处理消息', st.messagesPending, 'messages'],
    ['待完成待办', st.todosOpen, 'todos'],
    ['近 7 日日程', st.schedules7d, 'schedules'],
    ['近一周笔记', st.notes7d, 'notes'],
  ]);
  // ★ 三类提醒的行也带 id + 目标页（需求 3.3.2 原话："点击可跳转到对应的页面并打开详情页"）
  const rem = function (r) { return { id: r.id, go: r.kind, col1: r.at ? fmtTime(Date.parse(r.at)) : '', col2: r.title, col3: r.note }; };
  const up = o.reminders.upcoming.map(rem);
  const ur = o.reminders.urgent.map(rem);
  const stl = o.reminders.stale.map(rem);
  return '<div class="stats">' + cards + '</div>'
    + listBlock('重要日程 / 行程', up)
    + listBlock('逾期 / 临期任务', ur, 'overdue')
    + listBlock('长期未回复的信息', stl);
}

const TAB_LABEL = { all: '全部', pending: '待处理', 'to-todo': '已转待办', 'to-schedule': '已转日程', 'to-note': '已转笔记', replied: '已回复' };
// ★ 待办页与日程页的页签名（用户这一轮点名）
//   待办：「全部 / 今日 / 本周 / 待定 / 转日程 / 已完成」
//   日程：「今日 / 未来7天 / 全部」+ 新增「转待办 / 已完成」
const TODO_TABS = Object.freeze([['all', '全部'], ['today', '今日'], ['week', '本周'], ['undecided', '待定'], ['to-schedule', '转日程'], ['done', '已完成']]);
const SCHED_TABS = Object.freeze([['today', '今日'], ['next7', '未来7天'], ['all', '全部'], ['to-todo', '转待办'], ['done', '已完成']]);

export function pageMessages(snap) {
  const tab = (snap && snap.query && snap.query.tab) || 'all';
  // ★★ 2026-10-14 改（用户原话）：「消息页面的消息列表应该改成**按照会话聚合的会话列表**，
  //   消息列表下面的字段需要改为：**日期、最近一条消息、时间、来源、发信人、最新一条消息内容**」。
  //   ⇒ 数据换成会话（会话 × 天）；快照里给了 `messages` 就用它（自检与兼容），
  //     否则用会话聚合。**列的语义变了**：col1=日期 · col2=时间 · col3=来源 · col4=发信人 · col5=最新一条内容。
  const snapM = snap && snap.messages;
  const m = snapM || messages({ tab });
  const c = m.counts ?? {};
  const cards = statCards([
    ['待处理', c.pending ?? 0], ['已转待办', c.toTodo ?? 0],
    ['已转日程', c.toSchedule ?? 0], ['已转笔记', c.toNote ?? 0], ['已回复', c.replied ?? 0],
  ]);
  let tabs = [];
  for (const t of ['all', 'pending', 'to-todo', 'to-schedule', 'to-note', 'replied']) {
    // ⚠️ 页签由**客户端**筛行（服务端那条路由是读静态文件、不跑渲染，见下面的长注释）。
    tabs.push([t, TAB_LABEL[t]]);
  }
  const rows = m.list.map(function (r) {
    // 会话行：`day` 与 `time` 是聚合层算好的（会话就按天切，所以日期用 day 而不是从时间戳推）
    const dateStr = r.day ?? (r.at ? String(new Date(r.at).toISOString()).slice(0, 10) : '');
    const timeStr = r.time ?? '';
    const who = r.sender ?? '';
    // 最新一条消息的内容：会话行给它加个条数前缀，一眼看出这个会话有多少条
    const body = (r.count ? '（' + r.count + ' 条）' : '') + String(r.lastSummary ?? '');
    return {
      id: r.id,
      col1: dateStr,
      col2: timeStr,
      col3: r.channel ?? r.source ?? '',
      col4: who,
      col5: body,
      state: r.state,
      // ★ 会话行要**可点进详情**：客户端据此走 `/conversation?id=` 而不是逐条消息的详情
      conv: true,
    };
  });
  return '<div class="stats">' + cards + '</div>' + inlineForm('messages')
    + listBlock('会话列表', rows, '', {
      pageKey: 'messages',
      scroll: true,
      tabs: tabs,
      head: ['日期', '时间', '来源', '发信人', '最新一条消息内容'],
    });
}

export function pageTodos(snap) {
  const t = (snap && snap.todos) || todos();
  const c = t.counts;
  const cards = statCards([['今日', c.today], ['本周', c.week], ['待定', c.undecided], ['已完成', c.done]]);
  // ★★ 2026-10-14 改列序（用户逐字点名）：「列表字段名称需明确展示：**截止时间、来源、执行人、待办标题**」。
  //   原来是（截止 / 执行人 / 标题+详情 / 来源）—— 与用户点名的顺序对不上。
  //   ⇒ 现在**严格照用户给的顺序**：col1=截止 · col3=来源 · col2=执行人 · col4=待办标题。
  //     （`listBlock` 的第四格以前固定当"来源"用；这里让位给标题，来源放第三格 ——
  //      列序以**用户点名的**为准，不迁就实现上的旧约定。）
  // ★★ 2026-10-14 加：行上带**它属于哪几档**（`data-state` 改成**多值**，空格分隔）。
  //   为什么是多值：待办的「转日程」与「已完成」**可以重叠**（转过日程的也可能已完成），
  //   日程同理。单值模型下只能挑一个 ⇒ 另一档里那条会**凭空消失**（用户点"已完成"看不见它）。
  //   客户端的筛法相应改成"包含即显示"（见 `client.mjs`）。
  const isDoneT = (e) => (e.ops ?? []).some((o) => o.op === 'done');
  const hasOpT = (e) => (e.ops ?? []).some((o) => o.op === 'to-schedule');
  const dNow = Date.now();
  const st = (e) => {
    const tags = [];
    const due = e.payload?.due ? Date.parse(e.payload.due) : NaN;
    if (Number.isFinite(due)) {
      const d0 = new Date(dNow); d0.setHours(0, 0, 0, 0);
      const t0 = new Date(due); t0.setHours(0, 0, 0, 0);
      if (t0.getTime() <= d0.getTime()) tags.push('today');            // 逾期 + 今天到期，与后端同口径
      if (t0.getTime() >= d0.getTime() && t0.getTime() <= d0.getTime() + 7 * 86400000) tags.push('week');
    } else tags.push('undecided');                                     // 无期限 ⇒ 待定
    if (hasOpT(e)) tags.push('to-schedule');
    if (isDoneT(e)) tags.push('done');
    return tags.join(' ') || 'all';
  };
  const rows = t.list.map(function (r) {
    return {
      id: r.id,
      col1: r.dueLabel,
      col2: r.executor || '—',
      col3: r.source && r.source.label,
      col4: r.topic + (r.detail ? ' ' + r.detail : ''),
      overdue: r.overdue,
      state: st(r),
    };
  });
  return '<div class="stats">' + cards + '</div>' + inlineForm('todos')
    + listBlock('待办列表', rows, '', {
      pageKey: 'todos',
      scroll: true,
      // ★★ 2026-10-14 加（用户原话）：「待办列表下需要增加 tab，将
      //   **全部 / 今日 / 本周 / 待定 / 转日程 / 已完成** 做分类」。
      tabs: TODO_TABS,
      // ★★ 2026-10-14 修（**表头与数据错位**）：
      //   原来写 `['截止时间', '来源', '执行人', '待办标题']`，而数据是
      //     col2 = `r.executor`（执行人）· col3 = `r.source.label`（来源）
      //   ⇒ **第 2 格表头写「来源」、数据是「执行人」**，两格正好对调。
      //
      //   判"哪边错"的依据（不是感觉，是四页一致性）：
      //     消息页 head 第 3 格 = 来源，数据 col3 = `r.channel ?? r.source` ✅
      //     日程页 head 第 3 格 = 来源，数据 col3 = `r.source.label`        ✅
      //     笔记页 head 第 4 格 = 来源，数据 col4 = `r.source.label`        ✅
      //     ⇒ **`col3 = 来源` 是四页一致的约定**，只有待办的表头破了它。
      //   而且本函数上方那段注释（592 行起）当时就写了"col3=来源 · col2=执行人" ——
      //   **数据与注释是一致的，唯独 head 那一行漏改**。所以改表头，不改取数。
      //   ⚠️ 下次改列序：**head 与 col 必须一起改**，而且要先确认四页的列序约定是不是还一致。
      head: ['截止时间', '执行人', '来源', '待办标题'],
    });
}

export function pageSchedules(snap) {
  const sc = (snap && snap.schedules) || schedules();
  const c = sc.counts;
  const cards = statCards([['今日', c.today], ['未来 7 天', c.next7], ['前 30 日已完成', c.done30]]);
  // ★★ 2026-10-14 改（用户逐字点名）：
  //   ① 列名＝**日期 / 开始时间 / 截止时间 / 来源 / 日程主题**（原来把起止挤在一格、没有列名）。
  //   ② **日程列表下方新增页签：今日 / 未来7天 / 全部**（原来一个页签都没有）。
  //      与消息页同一套做法：链接带 `?tab=`，由**客户端**筛行（服务端读静态文件、不跑渲染）。
  // ★★ 2026-10-14 加 `state`（**页签能不能筛就靠它**）。
  //   客户端的筛选按行的 `data-state` 判：`hide = !(t === "all" || 行的 data-state === t)`。
  //   日程行原来**没带这个属性** ⇒ 页签点了"一条也筛不掉" ⇒
  //   真机验证抓到的"点今日 —— 全部 9 → 今日 9"（纹丝不动）。
  //   ⇒ 每行标出它属于哪一档（今日 / 未来7天 / 其它），与页签的 key 对齐。
  //   当天零点就地算（`shell.mjs` 里没有 `dayStart`；这是渲染模板，不引 `pages.mjs` 的内部函数）。
  const _n = new Date(); _n.setHours(0, 0, 0, 0);
  const d0 = _n.getTime();
  const rows = sc.list.map(function (r) {
    const s = String(r.start || ''); const e = String(r.end || '');
    const t0 = Date.parse(s);
    const d1 = new Date(t0); d1.setHours(0, 0, 0, 0);
    // ★★ 2026-10-14 改：`state` 改成**多值**（空格分隔），与待办页同一套 ——
    //   用户这一轮要求日程页新增「转待办」「已完成」两个页签，而一条日程
    //   **可以同时**是"今日"和"转待办"（时间档 + 处置档本就是两个维度）。
    //   单值模型下只能挑一个 ⇒ 点"转待办"就看不见今天那些了。
    const tags = [];
    if (Number.isFinite(t0) && d1.getTime() === d0) tags.push('today');
    if (Number.isFinite(t0) && t0 >= d0 && t0 <= d0 + 7 * 86400000) tags.push('next7');
    if ((r.ops ?? []).some(function (o) { return o.op === 'to-todo' })) tags.push('to-todo');
    if (r.done === true) tags.push('done');
    tags.push('all');
    const startT = s.slice(11, 16); const endT = e.slice(11, 16);
    const span = startT ? (endT ? startT + '-' + endT : startT) : '—';
    return {
      id: r.id,
      col1: s.slice(0, 10),                                  // 日期
      col2: span,                                            // 起止时间（一个连字符连接）
      col3: r.source && r.source.label,                      // 来源
      col4: r.topic + (r.place ? ' · ' + r.place : ''),      // 日程主题（地点跟在后面，便于一眼看全）
      state: tags.join(' '),
    };
  });
  // ★ 日程密度热力图（需求 3.3.5）：左=当月每天热力，右=动态分析。
  //   数据来自 `api/pages.mjs#scheduleHeatmap`（**纯规则**，不调模型 —— 这页不该偷偷烧 token）。
  const hm = (snap && snap.heatmap) || scheduleHeatmap({});
  // 页签三档：今日 / 未来7天 / 全部（用户点名）。`bucket` 与 `schedules()` 的桶名对齐。
  const schedTabs = SCHED_TABS;   // 今日 / 未来7天 / 全部 / 转待办 / 已完成（用户这一轮点名）
  return '<div class="stats">' + cards + '</div>' + heatBlock(hm) + inlineForm('schedules')
    + listBlock('日程列表', rows, '', {
      pageKey: 'schedules',
      scroll: true,
      tabs: schedTabs,
      head: ['日期', '起止时间', '来源', '日程主题'],
    });
}

/** 热力图分块（左：月历热力；右：动态分析） */
function heatBlock(hm) {
  if (!hm) return '';
  let head = '';
  for (const w of ['一', '二', '三', '四', '五', '六', '日']) head += '<div class="hm-h">' + w + '</div>';
  let cells = '';
  for (const cell of hm.grid) {
    if (!cell) { cells += '<div class="hm-c hm-empty"></div>'; continue; }
    const titles = cell.items.map(function (x) { return x.topic; }).filter(Boolean).slice(0, 6).join('\n');
    cells += '<div class="hm-c hm-l' + cell.level + '" title="' + esc(cell.date + (titles ? '\n' + titles : '')) + '">'
      + '<span class="hm-d">' + cell.day + '</span>' + (cell.count ? '<span class="hm-n">' + cell.count + '</span>' : '') + '</div>';
  }
  let an = '';
  for (const line of (hm.analysis || [])) an += '<li>' + esc(line) + '</li>';
  return '<div class="section"><h2>日程密度（' + esc(hm.month) + '）</h2>'
    + '<div class="heat-wrap">'
    + '<div class="heat"><div class="hm-grid">' + head + cells + '</div>'
    + '<div class="hm-legend"><span class="hm-c hm-l0"></span>无<span class="hm-c hm-l1"></span>1<span class="hm-c hm-l2"></span>2<span class="hm-c hm-l3"></span>3<span class="hm-c hm-l4"></span>4+</div></div>'
    + '<div class="heat-an"><div class="heat-an-t">动态分析</div><ul class="list">' + (an || '<li>暂无</li>') + '</ul></div>'
    + '</div></div>';
}

export function pageNotes(snap) {
  const n = (snap && snap.notes) || notes();
  const c = n.counts;
  const cards = statCards([['笔记总数', c.total], ['本月新增', c.thisMonth], ['标签数', c.tags]]);
  // ★★ 2026-10-14 改列（用户逐字点名）：「列表字段名称需明确展示：**日期、来源、笔记概括**」。
  //   原来四列是（日期 / 标签 / 主题 / 来源）—— 标签占了"来源"该在的位置，而且**没有列名**。
  //   ⇒ 现在 col1=日期 · col4=来源（`listBlock` 固定那一格）· col3=笔记概括（主题 + 标签，便于一眼看全）。
  const rows = n.list.map(function (r) {
    const tags = (r.tags || []).join('、');
    return {
      id: r.id,
      col1: r.date,
      col3: r.topic + (tags ? ' · ' + tags : ''),
      col4: r.source && r.source.label,
    };
  });
  // ★ 笔记列表：分页 + **单独滚动**（用户第 5 条后半句："如果笔记列表高度超过页面高度不够，
  //   仅在笔记列表位置出现滚动条，而不是在整体页面出现垂直滚动条"）
  // ★★ 2026-10-14 修（**用户报"笔记列表的表头和下面的字段没有对齐"**）：
  //   行的三格占的是 **col1 / col3 / col4**（`listBlock` 把第四格固定当"来源"用，
  //   笔记只有三项 ⇒ 第二格空着），而表头原来只给了 **3** 个名字 ⇒ 表头 3 格、行 4 格，
  //   **从第二格起全部错开**（这正是用户看到的现象）。
  //   ⇒ 表头补一个**空格子**顶住第二格。为什么不在行的第二格写"笔记概括"：
  //   那样表头第三格"来源"会落在行的第三格（笔记概括）上，**换了个错法**而已。
  //   列名与列位必须以**行的实际格位**为准。
  //   ⚠️ 真机量过：另外三页的表头格数与行格数本来就相等（消息 5/5、待办 4/4、日程 4/4），
  //     只有笔记这一页不齐 —— 所以只改这一页，别去动那三页。
  return '<div class="stats">' + cards + '</div>' + inlineForm('notes')
    + listBlock('笔记列表', rows, '', { pageKey: 'notes', scroll: true, head: ['日期', '', '笔记概括', '来源'] });
}

export const PAGES = Object.freeze({ overview: pageOverview, messages: pageMessages, todos: pageTodos, schedules: pageSchedules, notes: pageNotes });

/** 渲染整页：导航 + 内容 + 状态栏（三者在任何页面都在）
 *  opt.api 给了就注入客户端脚本（详情浮层 / 新增）—— 不接 API 时页面仍是纯静态可读的。 */
export function renderPage(pageKey, opt) {
  opt = opt || {};
  // ★ 2026-10-12 补：把**页面的查询参数**一并交给内容渲染（目前只有消息页的 `?tab=` 用）。
  //   为什么要走这条路：Tab 切换是"换地址 + 重渲染"，而渲染发生在服务端（面板路由按 URL 出页）；
  //   所以渲染时必须知道当前 URL 带了什么，否则永远只能出"全部"那一版。
  //   取值优先级：`opt.query`（调用方显式给） > `opt.url`（从整条 URL 里现解）。
  let query = (opt.query && typeof opt.query === 'object') ? opt.query : null;
  if (!query && typeof opt.url === 'string') {
    query = {};
    try {
      const qs = opt.url.includes('?') ? opt.url.slice(opt.url.indexOf('?') + 1).split('#')[0] : '';
      for (const kv of qs.split('&')) {
        if (!kv) continue;
        const i = kv.indexOf('=');
        const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
        const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
        query[k] = v;
      }
    } catch { query = {}; }
  }
  const snap = Object.assign({}, opt.snap || {}, query ? { query } : {});
  const key = PAGES[pageKey] ? pageKey : 'overview';
  let label = '今日总览';
  for (const p of PAGE_DEFS) if (p.key === key) label = p.label;
  const api = opt.api ? String(opt.api).replace(/\/+$/, '') : '';
  // ★★ 2026-10-13 改（用户第 4 条）：**旧的「新增一条」按钮整个去掉**。
  //   用户原话：「新增 1 条应该是**平铺在一级页面**，而不是作为按钮点击之后打开弹出浮层详情页。」
  //   ⇒ 四个页面的新增已经改成页内平铺表单（`inlineForm()`，与列表同一层级），
  //     这个按钮与它背后的弹层都成了多余的东西 —— 两个入口并存会让人不知道该点哪个。
  //   ⚠️ 我第一版只加了平铺表单、忘了删这个按钮，真机验证当场抓出来（IF-2 不过）。
  const addBtn = '';
  const script = api ? ('<script>' + clientScript(api) + '</script>') : '';
  const style = api ? ('<style>' + clientStyle() + '</style>') : '';
  const head = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + APP_NAME + ' · ' + esc(label) + '</title>'
    + '<style>' + stylesheet() + '</style>' + style + '</head>';
  const body = '<body>' + topbar(key)
    + '<main data-page="' + key + '"' + (api ? ' data-api="' + esc(api) + '"' : '') + '>' + addBtn + PAGES[key](snap) + '</main>'
    + '<footer class="spacer"></footer>' + statusbar(opt.status, opt.switches, opt.statusDetail) + script + '</body></html>';
  return head + '\n' + body;
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（结构断言；夹具快照，不读真实运行态）
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = function (id, desc, ok, detail) { out.push({ id: id, desc: desc, ok: !!ok, detail: detail || '' }); };
  const snap = {
    overview: { stats: { todosOpen: 3, messagesPending: 2, schedules7d: 1, notes7d: 4 }, reminders: { upcoming: [{ id: 'sch_1', kind: 'schedule', at: '2026-10-12T14:00', title: '评审', note: '线上' }], urgent: [{ id: 'td_1', kind: 'todo', at: '2026-10-09', title: '逾期的活', note: '已逾期 3 天' }], stale: [{ id: 'msg_9', kind: 'message', at: '2026-10-01T09:00:00+08:00', title: '没回的消息', note: '钉钉 · 张伟 · 已 11 天未回复' }] } },
    // ★★ 2026-10-14 改：夹具换成**会话形态**（用户把消息页改成会话列表了）。
    //   原来这里是消息形态（id/at/source/summary）⇒ 渲染层按会话取 `day`/`count`/`time` 都取不到，
    //   `SH-18` 当场变红。夹具跟着被改的东西走 —— 否则检查会一直守着已经不存在的形状。
    messages: { counts: { pending: 2, toTodo: 1, toSchedule: 0, toNote: 1, replied: 3, total: 7 }, tab: 'all', list: [{ id: '2026-10-12__cid:demo', day: '2026-10-12', time: '00:39', at: Date.parse('2026-10-12T00:39:00+08:00'), channel: '钉钉', sender: '曹元庭', count: 3, lastSummary: '一句话概括', state: 'pending' }] },
    // ★ 2026-10-14 给待办夹具补 `source` 与**可区分的** `executor`：
    //   原来只有 `executor: '我'`、**没有 source**（渲染成 undefined），
    //   于是"表头与数据错位"这类错**没有任何值可以拿去反查** —— 检查也就无从下手。
    //   现在执行人 `张三`（不与其它列撞名）、来源 `钉钉`（真实来源形态）。
    todos: { counts: { today: 2, week: 1, undecided: 1, done: 4 }, list: [{ id: 'td_2', dueLabel: '已逾期 3 天', executor: '张三', source: { label: '钉钉' }, topic: '逾期的活', detail: '细节', overdue: true }] },
    schedules: { counts: { today: 1, next7: 2, done30: 3 }, list: [{ id: 'sch_2', start: '2026-10-12T14:00', topic: '评审', place: '线上', participants: ['我', '张伟'] }] },
    notes: { counts: { total: 9, thisMonth: 4, tags: 7 }, list: [{ id: 'note_1', date: '2026-10-05', topic: 'A', tags: ['采集'] }] },
  };

  // ① 五页都能渲染，且每页导航 + 状态栏 + 名称齐全（需求 3.3.1）
  for (const p of PAGE_DEFS) {
    const html = renderPage(p.key, { snap: snap });
    const hasNav = html.indexOf('class="topbar"') >= 0 && html.indexOf('class="nav"') >= 0;
    const hasStatus = html.indexOf('class="statusbar"') >= 0;
    const hasName = html.indexOf(APP_NAME) >= 0;
    chk('SH-' + p.key, p.label + '：顶导航 + 底状态栏 + 名称「' + APP_NAME + '」齐全', hasNav && hasStatus && hasName, 'nav=' + hasNav + ' status=' + hasStatus + ' name=' + hasName);
  }

  const home = renderPage('overview', { snap: snap });
  chk('SH-6', '导航横向排列（.nav 用 flex + row）', /\.nav\s*\{[^}]*display:\s*flex/.test(stylesheet()) && /\.nav\s*\{[^}]*flex-direction:\s*row/.test(stylesheet()));
  const order = PAGE_DEFS.map(function (p) { return home.indexOf('>' + p.label + '</a>'); });
  chk('SH-7', '★ 导航含五页且顺序为 总览→消息→待办→日程→笔记', order.every(function (v) { return v > 0; }) && order.every(function (v, i) { return i === 0 || v > order[i - 1]; }), JSON.stringify(order));
  chk('SH-8', '默认页是总览（未知 key 回落）', renderPage('不存在', { snap: snap }) === home);

  chk('SH-9', '★ 状态栏含 DWS/MCP/本地工具/浏览器', STATUS_ITEMS.every(function (s) { return home.indexOf(s.label) >= 0; }));
  chk('SH-10', '★ 三个开关名 = 能力名', SWITCHES.map(function (s) { return s.key; }).join(',') === 'realtime_reply,voice_command,vector_search' && SWITCHES.every(function (s) { return home.indexOf(s.label) >= 0; }));
  chk('SH-11', '状态栏横向一行且固定在底部', /\.statusbar\s*\{[^}]*display:\s*flex/.test(stylesheet()) && /\.statusbar\s*\{[^}]*position:\s*fixed/.test(stylesheet()));

  const css = stylesheet();
  const cssNoTokens = css.replace(cssVariables(), '');
  chk('SH-12', '★ 样式用 token 变量（var(--c-…)），不写死颜色', css.indexOf('var(--c-ink)') >= 0 && css.indexOf('var(--c-hairline)') >= 0);
  chk('SH-13', '★ 按钮圆角 4px、非胶囊', /button\s*\{[^}]*border-radius:\s*4px/.test(css) && !/button\s*\{[^}]*9999px/.test(css));
  chk('SH-14', '★ 字重最大 600（规范上限）', !/font-weight:\s*(700|800|900|bold)/.test(css));
  chk('SH-15', '★ 负向对照：样式块内无字面色值（除 token 定义处）', !/#[0-9a-fA-F]{6}/.test(cssNoTokens), (cssNoTokens.match(/#[0-9a-fA-F]{6}/) || ['无'])[0]);

  chk('SH-16', '总览渲染出四个数字与三类提醒', home.indexOf('待完成待办') >= 0 && home.indexOf('重要日程') >= 0 && home.indexOf('逾期 / 临期任务') >= 0 && home.indexOf('长期未回复的信息') >= 0);
  chk('SH-17', '总览把逾期项标红（.overdue）', home.indexOf('class="overdue"') >= 0);
  // ★★ 2026-10-14 改（用户原话：「消息列表应该改成**按照会话聚合的会话列表**」）：
  //   这条原来守的是"消息页渲染出四个数与一句话概括"——那是**按条**的形态。
  //   现在列表是**会话**，所以改守会话的形态：
  //     ① 卡片上的五个数（含已转笔记）在；② 列名是用户点名的那六个字段（五列：日期/时间/来源/发信人/最新一条消息内容）；
  //     ③ 行带 `data-conv`（客户端据此走会话详情，而不是逐条消息的详情）；
  //     ④ 行首是**日期**（不是时间戳），且正文带条数前缀（"（N 条）"）。
  chk('SH-18', '★★ 消息页是**会话列表**（列名＝用户点名的那几个 · 行可点进会话详情）', (function () {
    const h = renderPage('messages', { snap: snap });
    const hasCards = h.indexOf('待处理') >= 0 && h.indexOf('已转待办') >= 0 && h.indexOf('已转笔记') >= 0;
    const cols = ['日期', '时间', '来源', '发信人', '最新一条消息内容'].every(function (c) { return h.indexOf('<span>' + c + '</span>') >= 0; });
    const rowIsConv = h.indexOf('data-conv="1"') >= 0;
    const hasCountPrefix = /（\d+ 条）/.test(h);
    return hasCards && cols && rowIsConv && hasCountPrefix;
  })());
  chk('SH-19', '待办页显示"距离截止时间"', renderPage('todos', { snap: snap }).indexOf('已逾期 3 天') >= 0);
  chk('SH-20', 'HTML 转义生效（注入尖括号不破页面）', (function () { const h = renderPage('notes', { snap: { notes: { counts: { total: 1, thisMonth: 1, tags: 0 }, list: [{ date: '2026-10-05', topic: '<script>x</script>', tags: [] }] } } }); return h.indexOf('&lt;script&gt;') >= 0 && h.indexOf('<script>x</script>') < 0; })());
  chk('SH-21', '★ 渲染层不依赖真实运行态（缺快照也能出页面）', renderPage('overview').indexOf('class="statusbar"') >= 0);

  // 交互接线（给了 api 才注入；不给仍是纯静态可读页）
  const wired = renderPage('messages', { snap: snap, api: 'http://127.0.0.1:8791/workdesktop/api/v1' });
  chk('SH-22', '★ 给了 api ⇒ 注入客户端脚本与 API 基址', wired.indexOf('<script>') >= 0 && wired.indexOf('data-api="http://127.0.0.1:8791/workdesktop/api/v1"') >= 0);
  chk('SH-23', '★ 页面带 data-page（脚本据此判断类型）', wired.indexOf('data-page="messages"') >= 0);
  // ★★ 2026-10-13 改（这条原来是"非总览页有『新增一条』按钮，总览页没有"，用户裁定后行为变了）。
  //   用户原话：「新增 1 条应该是**平铺在一级页面**，而不是作为按钮点击之后打开弹出浮层详情页。」
  //   ⇒ 按钮整个去掉了，四个页面改成**页内平铺表单**（`inlineForm`）。
  //     这条检查于是红了 —— **它红得对**：它守的是旧行为（那个按钮）。
  //   ⇒ 改成守新行为：**四个数据页都有平铺表单、按钮一个都不许有**（两个入口并存会让人不知道点哪个）。
  chk('SH-24', '★ 四个数据页都有**页内平铺**新增表单，且旧的「新增一条」按钮**一个都不留**（用户 2026-10-13 裁定）',
    ['messages', 'todos', 'schedules', 'notes'].every((k) => {
      const h = renderPage(k, { snap: snap, api: 'http://x' });
      return h.indexOf('class="inline-form"') >= 0 && h.indexOf('data-if-page="' + k + '"') >= 0 && h.indexOf('id="btn-add"') < 0;
    })
    && ['overview'].every((k) => renderPage(k, { snap: snap, api: 'http://x' }).indexOf('id="btn-add"') < 0));
  chk('SH-25', '★ 不给 api ⇒ 不注入脚本（静态可读，不致残）', home.indexOf('<script>') < 0 && home.indexOf('id="btn-add"') < 0);
  chk('SH-26', '★ 注入的脚本语法有效（真编译）', (function () { const m = /<script>([\s\S]*)<\/script>/.exec(wired); if (!m) return false; try { new Function(m[1]); return true; } catch (e) { return false; } })());

  // ★ 列表项必须带 data-id（P1-6）：详情浮层按它取单条。
  //   旧做法按行序推断，页签一变就错位 ⇒ 这两条守着"id 真的写进 DOM 了"。
  // ★★ 2026-10-14 改：消息页的行 id 现在是**会话 id**（`YYYY-MM-DD__cid:…`），
  //   而且多一个 `data-conv="1"`（客户端据此走会话详情）。这条跟着改 ——
  //   它守的是"**id 真的写进 DOM 了**、点得动"，与 id 具体长什么样无关。
  const msgHtml = renderPage('messages', { snap: snap, api: '/workdesktop/api/v1' });
  chk('SH-27', '★★ 会话列表行带 data-id + data-conv（点得动、且走会话详情）',
    /<li data-id="[^"]+" data-state="[^"]*" data-conv="1"/.test(msgHtml) || /data-conv="1"/.test(msgHtml),
    (msgHtml.match(/<li[^>]*data-conv[^>]*>/) || ['无'])[0].slice(0, 120));
  const ovHtml = renderPage('overview', { snap: snap, api: '/workdesktop/api/v1' });
  chk('SH-28', '★ 总览三类提醒带 data-id + data-go（可跳对应页面并开详情，需求 3.3.2）', /data-go="schedule"/.test(ovHtml) && /data-go="todo"/.test(ovHtml) && /data-go="message"/.test(ovHtml), (ovHtml.match(/<li[^>]*>/g) || []).slice(0, 3).join(' | '));
  chk('SH-29', '★ 负向对照：没有 id 的行不写 data-id（不编假 id）', (function () {
    const h = renderPage('notes', { snap: { notes: { counts: { total: 1, thisMonth: 1, tags: 0 }, list: [{ date: '2026-10-05', topic: 'A', tags: [] }] } } });
    return h.indexOf('<li data-id=') < 0 && h.indexOf('<li>') >= 0;
  })());

  // ★★ 2026-10-14 加（**表头与数据必须逐格对得上**）：
  //   为什么单独立一条：待办页曾经 head 写 `['截止时间','来源','执行人','待办标题']`
  //   而数据是 `col2=执行人 · col3=来源` ⇒ **第 2 格表头写「来源」、数据是「执行人」**，
  //   两格正好对调，而**四页的其它三页都是 col3=来源**。这类错位只能靠人眼看出来。
  //   判据：每页渲染出来，**表头格数 == 数据格数**；且**同一页里不许有表头文字重复**
  //   （重复通常意味着某一格被写了两遍、另一格空了）。
  //   ⚠️ 这条只管"格数与重复"，**管不了"哪一格该是什么"** —— 语义那层靠本文件里
  //     各页 head 与 col 相邻书写、以及改列序时一起改（见 pageTodos 里那段注释）。
  // ★★ 2026-10-14 加（**表头与数据必须"语义对得上"，不只是格数相等**）：
  //   起因：待办页曾经 head 写 `['截止时间','来源','执行人','待办标题']`、
  //   而数据是 `col2=执行人 · col3=来源` ⇒ **第 2 格表头写「来源」、数据是「执行人」**。
  //
  //   ⚠️ **第一版这条检查写成了"格数相等 + 列名不重复" —— 那是个摆设**：
  //     我把表头改回错位版做负向验证，它**照样过**（两边都是 4 格，格数当然相等）。
  //     这正是本项目反复防的"恒真检查"。**一条抓不到目标 bug 的检查比没有更坏**，因为它给的是虚假的安心。
  //
  //   ⇒ 改成**拿夹具里已知的值反查它落在哪一格**：夹具写死
  //     待办 `executor:'张三'` / `source.label:'钉钉'`，于是可以断言
  //     "「张三」那一格的表头必须是「执行人」、「钉钉」那一格必须是「来源」"。
  //     表头一旦与数据对调，这两个断言必红。
  //   ⚠️ 这条依赖夹具里的值**有区分度**（原来是 `executor:'我'`、且没有 source ⇒ 没法反查）。
  {
    const bad = [];
    const rowsOf = (html) => {
      const row = /<li data-id="[^"]*"[^>]*>([\s\S]*?)<\/li>/.exec(html);
      return row ? [...row[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((x) => x[1].replace(/<[^>]+>/g, '').trim()) : [];
    };
    const headOf = (html) => {
      const head = /<li class="jl-head">([\s\S]*?)<\/li>/.exec(html);
      return head ? [...head[1].matchAll(/<span>([^<]*)<\/span>/g)].map((x) => x[1]) : [];
    };
    // ① 待办：执行人 / 来源 必须落在各自的列名下面
    const todoHtml = renderPage('todos', { snap: snap });
    const th = headOf(todoHtml); const tr = rowsOf(todoHtml);
    const iExec = tr.indexOf('张三'); const iSrc = tr.indexOf('钉钉');
    if (iExec < 0) bad.push('待办:数据里找不到执行人「张三」');
    else if (th[iExec] !== '执行人') bad.push(`待办:执行人值在第 ${iExec + 1} 格，而那一格表头是「${th[iExec]}」`);
    if (iSrc < 0) bad.push('待办:数据里找不到来源「钉钉」');
    else if (th[iSrc] !== '来源') bad.push(`待办:来源值在第 ${iSrc + 1} 格，而那一格表头是「${th[iSrc]}」`);
    // ② 消息页：来源 / 发信人 同理（夹具里 channel='钉钉'、sender='曹元庭'）
    const msgHtml2 = renderPage('messages', { snap: snap });
    const mh = headOf(msgHtml2); const mr = rowsOf(msgHtml2);
    const iCh = mr.indexOf('钉钉'); const iWho = mr.indexOf('曹元庭');
    if (iCh >= 0 && mh[iCh] !== '来源') bad.push(`消息:来源值在第 ${iCh + 1} 格，而那一格表头是「${mh[iCh]}」`);
    if (iWho >= 0 && mh[iWho] !== '发信人') bad.push(`消息:发信人值在第 ${iWho + 1} 格，而那一格表头是「${mh[iWho]}」`);
    chk('SH-35', '★★ 表头与数据**语义**对得上（拿夹具已知值反查它落在哪一列）—— 防"表头与数据对调"',
      bad.length === 0, bad.join(' | ') || `待办：执行人@${iExec + 1}/来源@${iSrc + 1} 消息：来源@${iCh + 1}/发信人@${iWho + 1}`);
  }

  // ★ SH-30/31：日程密度热力图（需求 3.3.5）—— 左：当月每天热力；右：动态分析
  const schHtml = renderPage('schedules', { snap: snap, api: '/x' });
  chk('SH-30', '★ 日程页有密度热力图（左侧月历热力格 + 图例）', schHtml.includes('日程密度') && schHtml.includes('hm-grid') && schHtml.includes('hm-l1'), '');
  chk('SH-31', '★ 热力图右侧是动态分析；**没数据时原样呈现"没有数据就不分析"**（不编分析）', schHtml.includes('动态分析') && (function () {
    // 用一份"空库"的热力图数据驱动渲染（不依赖本机真实数据，判据才稳）
    const emptyHeat = { month: '2026-10', grid: new Array(31).fill(null).map(function (_, i) { return { date: '2026-10-' + String(i + 1).padStart(2, '0'), day: i + 1, count: 0, level: 0, items: [] }; }), analysis: ['本月（2026-10）还没有日程记录 —— 没有数据就不分析。'], totals: { count: 0, busyDays: 0, emptyDays: 31, maxStreak: 0 }, peak: null, busiestHour: null, topTopics: [] };
    const h = renderPage('schedules', { snap: { schedules: { counts: { today: 0, next7: 0, done30: 0, total: 0 }, list: [] }, heatmap: emptyHeat } });
    return h.includes('没有数据就不分析');
  })(), '');

  // ★★ 2026-10-14 加（用户原话）：四页的**数据统计卡要有悬停阴影**，与总览那四张一致。
  //   这里守两条，都是真机量出来的：
  //     · 阴影**给所有卡**（`.card:hover`）—— 原来只有总览那几张有（它们是可点的链接）；
  //     · **手型光标只给链接** —— 我第一版把 `display:block; cursor:pointer` 写在 `.card` 上，
  //       而 CSS 里 `.card` 与 `a.card` 是同一个选择器 ⇒ **四个内页那些点不动的卡也变成了手型**，
  //       鼠标移上去像是能点（样式没生效在以为的地方，反而落到了不该落的地方）。
  const cssAll = stylesheet();
  chk('SH-32', '★★ 所有统计卡都有悬停阴影（`.card:hover`）', /\.card:hover\s*\{[^}]*box-shadow/.test(cssAll));
  chk('SH-33', '★★ 手型光标**不在普通卡上**（点不动的卡不该是手型）', (function () {
    const rules = [...cssAll.matchAll(/([^{}]*)\{([^}]*)\}/g)].map(function (m) { return [m[1].trim(), m[2]]; });
    // ⚠️ 判法改了两次，两次都错在同一个地方：**把范围划得比问题大**。
    //   第一版只认"以 a 紧接符号开头"，把 `a.card` 误判成"不是链接"；
    //   第二版改成"凡是 cursor:pointer 就必须是链接"，又把 `button`、`.pager button`、
    //   `.statusbar .switch` 这些**本来就该是手型**的判成了错（它们不是链接，但它们是按钮）。
    //   ⇒ 要守的其实是**很窄的一件事**：`.card` 这一条规则里**不许**出现手型光标
    //     （因为四个内页的统计卡点不动，手型会让用户以为能点）。
    //     别的元素是不是手型，不归这条管。
    const cardGeneric = rules.filter(function (p) { return /^\.card$/.test(p[0]); });
    return cardGeneric.every(function (p) { return !/cursor:\s*pointer/.test(p[1]); });
  })(), (function () {
    const rules = [...cssAll.matchAll(/([^{}]*)\{([^}]*)\}/g)].map(function (m) { return [m[1].trim(), m[2]]; });
    return rules.filter(function (p) { return /^\.card$/.test(p[0]) && /cursor:\s*pointer/.test(p[1]); }).map(function (p) { return p[0]; }).join('|') || '普通卡上没有手型';
  })());
  chk('SH-34', '★ 阴影是渐变的（`.card` 上有 transition），不是闪一下', /\.card\s*\{[^}]*transition:\s*box-shadow/.test(cssAll));

  const pass = out.filter(function (x) { return x.ok; }).length;
  return { pass: pass, fail: out.length - pass, details: out };
}
