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
  // 笔记列表单独滚动（用户第 5 条后半句）：**只在列表内出滚动条，整页不出垂直滚动条**。
  //   做法：给笔记页的列表容器一个最大高度 + overflow-y。为什么只给笔记页：
  //   用户只点了笔记这一页（别的页先按同样规则留出接口，不擅自改它们的呈现）。
  s.push('.list-scroll { max-height: 52vh; overflow-y: auto; }');
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
  return '<nav class="pager" data-pager="' + esc(pageKey) + '">'
    + '<span class="pg-total" data-pg-total="1">总计: 0</span>'
    + '<button type="button" data-pg-prev="1" title="上一页">‹</button>'
    + '<span data-pg-nums="1"></span>'
    + '<button type="button" data-pg-next="1" title="下一页">›</button>'
    + '<span data-pg-pos="1">1/1</span>'
    + '<span>到第</span><input class="pg-jump" data-pg-jump="1" type="text" inputmode="numeric">'
    + '<span>页</span><button type="button" data-pg-go="1">前往</button>'
    + '<span class="grow"></span>'
    + '<span>每页显示:</span><select data-pg-size="1">' + opts + '</select>'
    + '</nav>';
}

function statCards(pairs) {
  let html = '';
  for (const p of pairs) {
    html += '<div class="card' + (p[2] ? ' featured' : '') + '"><div class="num">' + esc(p[1]) + '</div><div class="cap">' + esc(p[0]) + '</div></div>';
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
    // ★ 2026-10-13 加：第四列 = **来源**（用户第 9/10/11 条都点名要这个字段）。
    //   待办/日程/笔记三页用它；消息页与总览页没有第四列 ⇒ 不渲染这一格（不留空壳）。
    const srcAttr = r.col4 ? '<span class="src">' + esc(r.col4) + '</span>' : '';
    items += '<li' + idAttr + goAttr + stAttr + '><span class="when">' + esc(r.col1 || '') + '</span><span class="who">' + esc(r.col2 || '') + '</span><span class="' + cls + '">' + esc(r.col3 || '') + '</span>' + srcAttr + '</li>';
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
  return '<div class="section"' + (o.pageKey ? ' data-pagekey="' + esc(o.pageKey) + '"' : '') + '><h2>' + esc(title) + '</h2>'
    + '<ul class="' + ulCls + '">' + items + '</ul>'
    + (o.pageKey ? pager(o.pageKey) : '')
    + '</div>';
}

export function pageOverview(snap) {
  const o = (snap && snap.overview) || overview();
  const st = o.stats;
  const cards = statCards([['待完成待办', st.todosOpen, true], ['待处理信息', st.messagesPending, true], ['近 7 日日程', st.schedules7d, true], ['近一周笔记', st.notes7d, true]]);
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

const TAB_LABEL = { all: '全部', pending: '待处理', 'to-todo': '已转待办', 'to-schedule': '已转日程', replied: '已回复' };

export function pageMessages(snap) {
  // ★ 2026-10-12 修：**从地址里读 `?tab=` 再传给聚合**。
  //   为什么必须：`messages()` 早就支持按 tab 筛（`PG-2` 还守着它），
  //   但页面渲染时**从来没传过 tab** ⇒ 无论点哪个 Tab 都渲染"全部"，五个 Tab 形同虚设。
  //   `snap.query` 由 `renderPage` 注入（服务端渲染时拿到的是**页面 URL 的查询串**）。
  const tab = (snap && snap.query && snap.query.tab) || 'all';
  const m = (snap && snap.messages) || messages({ tab });
  const c = m.counts;
  const cards = statCards([['待处理', c.pending], ['已转待办', c.toTodo], ['已转日程', c.toSchedule], ['已回复', c.replied]]);
  let tabs = [];
  for (const t of ['all', 'pending', 'to-todo', 'to-schedule', 'replied']) {
    // ★★ 2026-10-12 修（**消息页五个 Tab 点了没反应**）：
    //   原来写的是 `href="#messages?tab=<t>"` —— 页内锚点，点了既不筛列表也不跳页。
    //   现在链接**带查询串**去请求同一个文件；`?tab=` 由**客户端脚本**用来隐藏不匹配的行
    //   （见 `client.mjs` 里"Tab 筛选"那段）。
    //   ⚠️ 为什么不靠服务端按 `?tab=` 重渲染：面板那条路由是**读静态文件**返回的
    //      （`lib/index.js` 的 `/yishu/<页>`），它根本不跑渲染 ⇒ 服务端筛不生效；
    //      而本地直开是静态文件、同样不跑渲染。**两条路都不跑渲染** ⇒ 只能放客户端做。
    tabs.push('<a href="./messages.html?tab=' + t + '" data-tab="' + t + '"' + (t === m.tab ? ' aria-current="page"' : '') + '>' + TAB_LABEL[t] + '</a>');
  }
  // ★★ 2026-10-12 修（**消息页五个 Tab 点不了的真根因**）：
  //   原来把这一串 `<a>` 塞进 `listBlock(tabs.join(' · '), rows)` —— 而 `listBlock` 的第三列
  //   会走 `esc()`（防注入），于是页面上显示的是**字面文本** `<a href="./messages.html?tab=all">全部</a>`，
  //   **根本不是链接**。实测：源码里 5 个 `data-tab`，DOM 里 0 个。
  //   ⇒ 自建一小段导航区块（`<ul class="tabs">`），别再借数据列表那条会转义的通道。
  const navTabs = '<ul class="tabs">' + tabs.join('') + '</ul>';
  const rows = m.list.map(function (r) { return { id: r.id, col1: fmtTime(r.at), col2: r.source, col3: r.summary, state: r.state }; });
  return '<div class="stats">' + cards + '</div>' + navTabs + inlineForm('messages') + listBlock('消息列表', rows, '', { pageKey: 'messages' });
}

export function pageTodos(snap) {
  const t = (snap && snap.todos) || todos();
  const c = t.counts;
  const cards = statCards([['今日', c.today], ['本周', c.week], ['待定', c.undecided], ['已完成', c.done]]);
  const rows = t.list.map(function (r) { return { id: r.id, col1: r.dueLabel, col2: r.executor || '—', col3: r.topic + ' ' + (r.detail || ''), overdue: r.overdue, col4: r.source && r.source.label }; });
  return '<div class="stats">' + cards + '</div>' + inlineForm('todos') + listBlock('待办列表', rows, '', { pageKey: 'todos' });
}

export function pageSchedules(snap) {
  const sc = (snap && snap.schedules) || schedules();
  const c = sc.counts;
  const cards = statCards([['今日', c.today], ['未来 7 天', c.next7], ['前 30 日已完成', c.done30]]);
  const rows = sc.list.map(function (r) { return { id: r.id, col1: String(r.start || '').slice(5, 16), col2: (r.participants || []).join('、') || '—', col3: r.topic + ' ' + (r.place || ''), col4: r.source && r.source.label }; });
  // ★ 日程密度热力图（需求 3.3.5）：左=当月每天热力，右=动态分析。
  //   数据来自 `api/pages.mjs#scheduleHeatmap`（**纯规则**，不调模型 —— 这页不该偷偷烧 token）。
  const hm = (snap && snap.heatmap) || scheduleHeatmap({});
  return '<div class="stats">' + cards + '</div>' + heatBlock(hm) + inlineForm('schedules') + listBlock('日程列表', rows, '', { pageKey: 'schedules' });
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
  const rows = n.list.map(function (r) { return { id: r.id, col1: r.date, col2: (r.tags || []).join('、') || '—', col3: r.topic, col4: r.source && r.source.label }; });
  // ★ 笔记列表：分页 + **单独滚动**（用户第 5 条后半句："如果笔记列表高度超过页面高度不够，
  //   仅在笔记列表位置出现滚动条，而不是在整体页面出现垂直滚动条"）
  return '<div class="stats">' + cards + '</div>' + inlineForm('notes') + listBlock('笔记列表', rows, '', { pageKey: 'notes', scroll: true });
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
    messages: { counts: { pending: 2, toTodo: 1, toSchedule: 0, replied: 3 }, tab: 'all', list: [{ id: 'msg_1', at: Date.parse('2026-10-12T00:39:00+08:00'), source: '钉钉 · 曹元庭', summary: '一句话概括' }] },
    todos: { counts: { today: 2, week: 1, undecided: 1, done: 4 }, list: [{ id: 'td_2', dueLabel: '已逾期 3 天', executor: '我', topic: '逾期的活', detail: '细节', overdue: true }] },
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
  chk('SH-18', '消息页渲染出四个数与一句话概括', (function () { const h = renderPage('messages', { snap: snap }); return h.indexOf('已转待办') >= 0 && h.indexOf('一句话概括') >= 0 && h.indexOf('钉钉 · 曹元庭') >= 0; })());
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
  const msgHtml = renderPage('messages', { snap: snap, api: '/workdesktop/api/v1' });
  chk('SH-27', '★ 消息列表项带 data-id（浮层据此取单条）', /<li data-id="msg_1"/.test(msgHtml), (msgHtml.match(/<li[^>]*>/) || ['无'])[0]);
  const ovHtml = renderPage('overview', { snap: snap, api: '/workdesktop/api/v1' });
  chk('SH-28', '★ 总览三类提醒带 data-id + data-go（可跳对应页面并开详情，需求 3.3.2）', /data-go="schedule"/.test(ovHtml) && /data-go="todo"/.test(ovHtml) && /data-go="message"/.test(ovHtml), (ovHtml.match(/<li[^>]*>/g) || []).slice(0, 3).join(' | '));
  chk('SH-29', '★ 负向对照：没有 id 的行不写 data-id（不编假 id）', (function () {
    const h = renderPage('notes', { snap: { notes: { counts: { total: 1, thisMonth: 1, tags: 0 }, list: [{ date: '2026-10-05', topic: 'A', tags: [] }] } } });
    return h.indexOf('<li data-id=') < 0 && h.indexOf('<li>') >= 0;
  })());

  // ★ SH-30/31：日程密度热力图（需求 3.3.5）—— 左：当月每天热力；右：动态分析
  const schHtml = renderPage('schedules', { snap: snap, api: '/x' });
  chk('SH-30', '★ 日程页有密度热力图（左侧月历热力格 + 图例）', schHtml.includes('日程密度') && schHtml.includes('hm-grid') && schHtml.includes('hm-l1'), '');
  chk('SH-31', '★ 热力图右侧是动态分析；**没数据时原样呈现"没有数据就不分析"**（不编分析）', schHtml.includes('动态分析') && (function () {
    // 用一份"空库"的热力图数据驱动渲染（不依赖本机真实数据，判据才稳）
    const emptyHeat = { month: '2026-10', grid: new Array(31).fill(null).map(function (_, i) { return { date: '2026-10-' + String(i + 1).padStart(2, '0'), day: i + 1, count: 0, level: 0, items: [] }; }), analysis: ['本月（2026-10）还没有日程记录 —— 没有数据就不分析。'], totals: { count: 0, busyDays: 0, emptyDays: 31, maxStreak: 0 }, peak: null, busiestHour: null, topTopics: [] };
    const h = renderPage('schedules', { snap: { schedules: { counts: { today: 0, next7: 0, done30: 0, total: 0 }, list: [] }, heatmap: emptyHeat } });
    return h.includes('没有数据就不分析');
  })(), '');

  const pass = out.filter(function (x) { return x.ok; }).length;
  return { pass: pass, fail: out.length - pass, details: out };
}
