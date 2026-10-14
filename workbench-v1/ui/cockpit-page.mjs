#!/usr/bin/env node
/**
 * v1/ui/cockpit-page.mjs —— **驾驶舱页面**（P7 呈现层；需求 4.3.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 4.3.6 原文：「自上而下的页面内容是：**数据统计 / 知识图谱 / 发展趋势 /
 *   业务洞察 / 状态分析 / 发展建议**」，并点名了要统计的四组数：
 *   消息数（总数/待处理/已处理）· 日程数（总数/已进行/待进行）·
 *   待办数（总数/已完成/逾期/待完成）· 笔记数（总数/标签数/可视化模型数）。
 *
 * 六块的现状要分清（不许把"还没生成"写成"已经分析"）：
 *   一 数据统计 · 二 知识图谱 · 三 发展趋势 —— **真实数据**（来自 `api/cockpit.mjs`）
 *   四 业务洞察 · 五 状态分析 · 六 发展建议 —— **需要模型**：本页如实显示"尚未生成"，
 *     并写明它们的输入切片已经备好、且"没有真实数据就不允许调用模型"这条规矩。
 *
 * 与 shell.mjs 同一写法：**不用模板字符串**（拼接），避免 Windows 下引号/嵌套的坑。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath , pathToFileURL } from 'node:url';

import { stylesheet, APP_NAME, PAGE_DEFS } from './shell.mjs';
import { stats, trend, graph, sliceFor, hasEnoughData, readNarrative, units } from '../api/cockpit.mjs';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'Other', 'data', 'workbench-v1');

/** 六块的顺序与标题（需求 4.3.6 原样） */
export const SECTIONS = Object.freeze([
  { key: 'stats', title: '一、数据统计', kind: 'data' },
  { key: 'graph', title: '二、知识图谱', kind: 'data' },
  { key: 'trend', title: '三、发展趋势', kind: 'data' },
  // ★ 趋势块**额外**带一块模型分析（需求 4.3.2：那五种方法 + 可自定义时间周期）。
  //   柱状图是"数据"，五种分析是"需要模型"的那一半 —— 分开列，页面才知道要给按钮。
  //   ⚠️ 这一条的 `key` 必须就是模型类型 `trend`（`modelBlock` 用它去 `sliceFor` 取切片），
  //      不能为了"名字好看"改成 trendNarrative —— 那样会取不到切片、按钮永远禁用（实测踩到）。
  //      与上面那条 data 的 key 重复是有意的：同一块标题下，先画图、再放分析。
  { key: 'trend', title: '三·补 趋势演进分析（情景还原 / 事件归因 / 决策树回溯 / 噪声分离 / 反事实）', kind: 'model' },
  // ★★ 2026-10-14 改（用户 8.3 / 8.4 是**两件事**，所以拆成两块；六块的骨架不变 ——
  //   用户 8.6 只点名了六块，所以这两块同放在"四、业务洞察"之下）：
  //     · 8.3 业务/项目复盘 = **挑一个单元往里看**（单个项目或某条业务线）⇒ `unit: true` 给它一个选择器
  //     · 8.4 全盘业务分析 = **站在全部业务上方看**
  { key: 'insight', title: '四、业务/项目复盘（挑一个项目或业务线，按七个维度复盘）', kind: 'model', unit: true },
  { key: 'analysis', title: '四·补 全盘业务分析（战略 / 执行 / 机制 / 能力 / 市场 / 资源 / 方法论及认知迭代）', kind: 'model' },
  { key: 'state', title: '五、状态分析', kind: 'model' },
  { key: 'advice', title: '六、发展建议（SWOT + 短期1月 / 中期3月 / 长期1年）', kind: 'model' },
]);

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}
function table(headers, rows) {
  let h = '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>';
  for (const t of headers) h += '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--c-hairline);color:var(--c-mute);font-weight:var(--w-medium)">' + esc(t) + '</th>';
  h += '</tr></thead><tbody>';
  for (const r of rows) {
    h += '<tr>';
    for (const c of r) h += '<td style="padding:6px 8px;border-bottom:1px solid var(--c-hairline);vertical-align:top">' + esc(c) + '</td>';
    h += '</tr>';
  }
  return h + '</tbody></table>';
}

/** 统计块（四组口径，需求 4.3.6 点名） */
export function statsBlock(s) {
  const cards = [
    ['消息', s.messages.total, `待处理 ${s.messages.pending} · 已处理 ${s.messages.processed}`],
    ['日程', s.schedules.total, `已进行 ${s.schedules.done} · 待进行 ${s.schedules.upcoming}`],
    ['待办', s.todos.total, `已完成 ${s.todos.done} · 逾期 ${s.todos.overdue} · 待完成 ${s.todos.open}`],
    ['笔记', s.notes.total, `标签 ${s.notes.tags} · 可视化模型 ${s.notes.visualModels}`],
  ];
  let h = '<div class="stats">';
  for (const c of cards) h += '<div class="card featured"><div class="num">' + esc(c[1]) + '</div><div class="cap">' + esc(c[0]) + ' · ' + esc(c[2]) + '</div></div>';
  return h + '</div>';
}

/**
 * 图谱块：圆形布局 + 直线（**可点击穿透**）。
 *
 * ★★ 2026-10-14 改（用户第 8.1 条原话）：
 *   「每个节点都能够**点击穿透到具体的知识点内容/文档**。知识点之间的关系以不同的连线呈现。」
 *   原来节点只是 `<circle>` + `<title>`（悬浮提示）—— **点不动**。
 *
 * 穿透的目标按节点种类给（**能开的才做成链接，开不了的如实标出来**）：
 *   · `message` / `note` / `todo` / `schedule` ⇒ 打开**详情浮层**（那条事件本身）
 *   · `doc`（带 `path`）⇒ **打开文档正文**（走 `GET /v1/doc?p=…`，只允许 Work/Research 下的文本）
 *   · `sender` ⇒ 这类节点**没有可打开的单篇内容**，如实标注"发信人节点（不可穿透）"，
 *     不给一个点了没反应的圆点（本项目为此返工过多轮）
 */
export function graphBlock(g) {
  // ★ 空图也要写清边的来源口径 —— 那是**常设声明**，不能因为"现在没数据"就消失
  const provenance = '<div class="cap" style="margin-top:8px;color:var(--c-mute);font-size:12px">' + esc(g.note) + '</div>';
  if (!g.nodes.length) return '<div class="empty">还没有节点（先让采集器跑起来）</div>' + provenance;
  const W = 720; const H = 360; const cx = W / 2; const cy = H / 2; const R = 140;
  const byKind = { message: 'var(--c-accent-blue)', note: 'var(--c-accent-purple)', todo: 'var(--c-accent-orange)', schedule: 'var(--c-accent-green)', sender: 'var(--c-ink)', doc: 'var(--c-mute)' };
  const pos = {};
  g.nodes.forEach((n, i) => {
    const a = (i / g.nodes.length) * Math.PI * 2;
    const r = n.kind === 'sender' ? R * 0.45 : n.kind === 'doc' ? R * 1.25 : R;
    pos[n.id] = [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;border:1px solid var(--c-hairline);border-radius:8px" data-graph="1">';
  // ★ 连线**按种类给不同颜色与虚实**（用户："知识点之间的关系以不同的连线呈现"）。
  //   原来所有边都是同一条灰线 —— 看不出"同一发信人"和"召回命中"是两种不同的关系。
  const EDGE_STYLE = {
    from: { stroke: 'var(--c-accent-blue)', dash: '' },            // 同一发信人
    recall: { stroke: 'var(--c-accent-purple)', dash: '4 3' },     // 分析引擎召回命中
    same: { stroke: 'var(--c-mute)', dash: '2 4' },
  };
  for (const e of g.edges) {
    const a = pos[e.from]; const b = pos[e.to];
    if (!a || !b) continue;
    const s = EDGE_STYLE[e.kind] ?? { stroke: 'var(--c-hairline)', dash: '' };
    svg += '<line x1="' + a[0].toFixed(1) + '" y1="' + a[1].toFixed(1) + '" x2="' + b[0].toFixed(1) + '" y2="' + b[1].toFixed(1) + '" stroke="' + s.stroke + '" stroke-width="1"' + (s.dash ? ' stroke-dasharray="' + s.dash + '"' : '') + '><title>' + esc(e.kind + '：' + e.why) + '</title></line>';
  }
  // 事件类节点的种类 → 详情接口的类型名（复数，路由只认复数）
  const TYPE_OF = { message: 'messages', note: 'notes', todo: 'todos', schedule: 'schedules' };
  for (const n of g.nodes) {
    const p = pos[n.id];
    const color = byKind[n.kind] || 'var(--c-body-mid)';
    const r = n.kind === 'doc' ? 5 : 7;
    const common = 'cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + r + '" fill="' + color + '"';
    const evType = TYPE_OF[n.kind];
    if (evType) {
      // 可穿透：事件节点 ⇒ 详情浮层
      svg += '<circle ' + common + ' class="g-node" data-g-open="' + esc(evType + ':' + n.id) + '" style="cursor:pointer"><title>' + esc(n.kind + '：' + n.label + '（点开看详情）') + '</title></circle>';
    } else if (n.kind === 'doc' && n.path) {
      // 可穿透：文档节点 ⇒ 打开正文
      svg += '<circle ' + common + ' class="g-node" data-g-doc="' + esc(n.path) + '" style="cursor:pointer"><title>' + esc('文档：' + n.label + '（点开看正文）') + '</title></circle>';
    } else {
      // 不可穿透：**如实标出来**，不给一个点了没反应的圆点
      svg += '<circle ' + common + ' class="g-node g-node-flat"><title>' + esc(n.kind + '：' + n.label + '（' + (n.kind === 'sender' ? '发信人节点，没有可打开的单篇内容' : '这一种节点还没有穿透目标') + '）') + '</title></circle>';
    }
  }
  svg += '</svg>';
  // ★ 图例（连线与节点各是什么）—— 用户要求"以不同的连线呈现"，那就得说明哪种线是什么
  const legend = '<div class="cap" style="margin-top:8px;color:var(--c-mute);font-size:12px">'
    + '连线：<span style="color:var(--c-accent-blue)">实线=同一发信人</span> · '
    + '<span style="color:var(--c-accent-purple)">虚线=分析引擎召回命中</span>　'
    + '节点：<span style="color:var(--c-accent-blue)">消息</span> · <span style="color:var(--c-accent-purple)">笔记</span> · <span style="color:var(--c-accent-orange)">待办</span> · <span style="color:var(--c-accent-green)">日程</span> · <span style="color:var(--c-ink)">发信人</span> · <span style="color:var(--c-mute)">文档</span>'
    + '<br>点节点可穿透：消息/笔记/待办/日程 ⇒ 打开详情；文档 ⇒ 打开正文；发信人节点没有可打开的单篇内容（如实标出，不给点了没反应的圆点）</div>';
  return svg + legend
    + '<div class="cap" style="margin-top:8px;color:var(--c-mute);font-size:12px">' + esc(g.note) + '　节点 ' + g.counts.nodes + ' · 边 ' + g.counts.edges + ' · 构成 ' + esc(JSON.stringify(g.counts.byKind)) + '</div>';
}

/** 趋势块：按日柱状（纯 SVG，无外部依赖） */
export function trendBlock(t) {
  if (!t.series.length) return '<div class="empty">区间内没有数据</div>';
  const max = Math.max(1, ...t.series.map((r) => r.message + r.note + r.todo + r.schedule));
  const W = 720; const H = 180; const bw = W / t.series.length;
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;border:1px solid var(--c-hairline);border-radius:8px">';
  t.series.forEach((r, i) => {
    const total = r.message + r.note + r.todo + r.schedule;
    const bh = (total / max) * (H - 40);
    const x = i * bw + 4;
    svg += '<rect x="' + x.toFixed(1) + '" y="' + (H - 20 - bh).toFixed(1) + '" width="' + Math.max(2, bw - 8).toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2" fill="var(--c-accent-blue)"><title>' + esc(`${r.date}：消息 ${r.message} · 笔记 ${r.note} · 待办 ${r.todo} · 日程 ${r.schedule}（完成 ${r.todoDone + r.scheduleDone}）`) + '</title></rect>';
    if (i % Math.ceil(t.series.length / 8) === 0) svg += '<text x="' + (x + 2).toFixed(1) + '" y="' + (H - 6) + '" font-size="9" fill="var(--c-mute)">' + esc(r.date.slice(5)) + '</text>';
  });
  svg += '</svg>';
  return svg + '<div class="cap" style="margin-top:8px;color:var(--c-mute);font-size:12px">' + esc(t.from + ' ~ ' + t.to + '（' + t.days + ' 天）· 合计 ' + JSON.stringify(t.totals)) + '</div>';
}

/**
 * 需要模型的那几块：**已生成就显示内容**，未生成就如实说"尚未生成"；那条规矩常设可见。
 * @param {string} kind 模型类型（与 `NARRATIVE_SPECS` 的键一致）
 * @param {number} now
 * @param {{unit?:boolean}} [sec] 该块在 `SECTIONS` 里的那一条（`unit:true` ⇒ 渲染单元选择器）
 */
export function modelBlock(kind, now, sec = null) {
  const sl = sliceFor(kind, { now });
  const enough = hasEnoughData(sl);
  const saved = readNarrative(kind);
  let head;
  if (saved && saved.text) {
    const at = saved.at ? new Date(saved.at).toLocaleString('zh-CN') : '';
    head = '<div class="cap" style="font-size:14px;color:var(--c-ink);white-space:pre-wrap;line-height:1.7">' + esc(saved.text) + '</div>'
      + '<div class="cap" style="margin-top:8px;color:var(--c-mute);font-size:12px">生成于 ' + esc(at) + ' · 区间 ' + esc(saved.from + ' ~ ' + saved.to) + ' · 输入指纹 ' + esc(saved.fp) + ' · 事件 ' + esc(JSON.stringify(saved.events)) + '</div>';
  } else {
    head = '<div class="cap" style="font-size:13px;color:var(--c-body)">'
      + (enough ? '尚未生成（点下面的「生成」，或等每日任务）' : '尚未生成（区间内没有事件 ⇒ 本块暂不生成）')
      + '</div>'
      + '<div class="cap" style="margin-top:6px;color:var(--c-mute);font-size:12px">输入切片：' + esc(sl.label) + ' · 事件 ' + esc(JSON.stringify(sl.events)) + ' · 图谱节点 ' + sl.graphCounts.nodes + '　提问：' + esc(sl.ask) + '</div>';
  }
  // 生成入口：POST 到 v1 的写路径（已登记 `/cockpit/:kind`）。**相对路径** ⇒ 独立服务与插件 host 都走同一条。
  const btn = '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    + '<button class="btn" data-cockpit-gen="' + esc(kind) + '"' + (enough ? '' : ' disabled') + '>'
    + (saved && saved.text ? '重新生成' : '生成') + '</button>'
    + '<span class="cap" data-cockpit-msg="' + esc(kind) + '" style="color:var(--c-mute);font-size:12px">'
    + (enough ? '约需 30 秒（调模型）' : '没有数据 ⇒ 按钮已禁用，按规矩不调模型')
    + '</span></div>';
  // ★★ 2026-10-14 加（用户 8.3）：「抽离出库内**单个项目或某条业务线**，按业务单元维度，
  //   即**对象或域**，进行复盘。对进行中的业务线或项目，复盘到截止当时已有的所有信息。」
  //   ⇒ 这一块给一个**单元选择器**。选空 = 复盘全部单元（原先的行为，保留）。
  //   选项来自 `units()`（与后端同一份清单，不在页面里另算一套）。
  let unitPicker = '';
  if (sec && sec.unit === true) {
    const us = units({ now });
    const cur = String((saved && saved.unit) || '');
    const opts = ['<option value="">（全部单元，逐个复盘）</option>']
      .concat(us.list.slice(0, 60).map((u) => '<option value="' + esc(u.name) + '"' + (u.name === cur ? ' selected' : '') + '>'
        + esc(u.name) + '（' + u.total + ' 条）</option>'));
    unitPicker = '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<span class="cap" style="font-size:12px">复盘哪个单元：</span>'
      + '<select data-cockpit-unit="' + esc(kind) + '" style="font:inherit;font-size:13px;padding:3px 6px;border:1px solid var(--c-hairline);border-radius:4px;background:transparent;color:var(--c-ink)">'
      + opts.join('') + '</select>'
      + '<span class="cap" style="color:var(--c-mute);font-size:12px">共 ' + us.counts.units + ' 个单元 · ' + esc(us.note) + '</span>'
      + '</div>';
  }
  // ★ 规矩常设可见：无论当前有没有数据、有没有生成，这条约束都写在块里（它是纪律，不是条件提示）
  return '<div class="card">' + head + unitPicker + btn
    + '<div class="cap" style="margin-top:6px;color:var(--c-mute);font-size:12px">规矩：没有真实数据切片时不调用模型 —— 避免生成"没数据也像模像样"的分析。</div>'
    + '</div>';
}

export function renderCockpit({ now = Date.now(), from = null, to = null } = {}) {
  const s = stats({ now }); const g = graph({ now }); const t = trend({ from, to, now, days: 14 });
  // ★★ 2026-10-15 两条裁定一起落在这里，所以这页**不再有顶上那条导航**：
  //
  //   ① 摘掉「现状一览」那一项 —— 用户原话：「现状一览**没有任何意义，请移除掉**」。
  //      它的渲染器 `ui/status-page.mjs` 与产物 `status.html` 已一并移除。
  //   ② **整条导航都摘掉** —— 用户裁定：「驾驶舱**只看它自己的六块，不跳工作台**」。
  //      理由（用户原话）：「**驾驶舱是驾驶舱，工作台是工作台**」——
  //      两者是官方侧栏里**并列的两个入口**，点进驾驶舱却看到工作台的导航条，
  //      等于从一个入口进去又回到另一个入口。
  //
  //   ⇒ 原先这里有一行 `const nav = PAGE_DEFS.map(…)`，**已删**（不是留着不用）。
  //     留着没人用的常量，下一个人会以为"导航还在、只是没渲染"。
  //   ⚠️ `PAGE_DEFS` 的 import 仍然保留 —— `stylesheet()`/`APP_NAME` 同一个来源，
  //     而且导航没了不等于那五个页不存在（它们在侧栏「工作台」那个入口里）。
  let body = '<h1 style="font-size:22px">驾驶舱</h1>';
  body += '<div class="cap" style="margin:6px 0 18px;color:var(--c-mute);font-size:13px">自上而下六块（需求 4.3.6）· 前三块为真实数据，后三块需要模型且须先有真实切片</div>';
  // ★ 时间区间选择器（需求 4.3.2 原话："可以周期性（时间维度，**自定义筛选时间周期**）"）。
  //   起止日期在这里选一次，下面四块的「生成」都带着它去调 ——
  //   而不是每块各配一套日期（那样四块会各说各的区间，页面上的数就对不起来了）。
  body += '<div class="card" id="range-bar" style="margin-bottom:16px">'
    + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
    + '<span style="font-size:13px;color:var(--c-ink);font-weight:var(--w-medium)">分析区间</span>'
    + '<input type="date" id="range-from" value="' + esc(from ?? '') + '" style="font:inherit;padding:4px 6px;border:1px solid var(--c-hairline);border-radius:4px">'
    + '<span style="color:var(--c-mute)">~</span>'
    + '<input type="date" id="range-to" value="' + esc(to ?? '') + '" style="font:inherit;padding:4px 6px;border:1px solid var(--c-hairline);border-radius:4px">'
    + '<button class="btn" data-range-quick="7">近 7 天</button>'
    + '<button class="btn" data-range-quick="30">近 30 天</button>'
    + '<button class="btn" data-range-quick="90">近 90 天</button>'
    + '<button class="btn" data-range-clear="1">清空（用默认）</button>'
    + '</div>'
    + '<div class="cap" style="margin-top:6px;color:var(--c-mute);font-size:12px">留空 = 用各块的默认区间。选好之后点下面任意一块的「生成」，那一块就按这个区间算 —— 输入没变（含区间）就返回上一次的结果，不重复调模型。</div>'
    + '</div>';
  const blocks = { stats: statsBlock(s), graph: graphBlock(g), trend: trendBlock(t) };
  for (const sec of SECTIONS) {
    body += '<div class="section"><h2>' + esc(sec.title) + '</h2>'
      + (sec.kind === 'data' ? blocks[sec.key] : modelBlock(sec.key, now, sec))
      + '</div>';
  }
  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    // ⚠️ 浏览器标签页的标题也要改：原来写 `工作台 · 驾驶舱` ——
    //   那等于说"这是工作台里的驾驶舱"，与"两个并列入口"的事实相反（用户 2026-10-15 裁定）。
    + '<title>驾驶舱</title><style>' + stylesheet() + '</style></head><body>'
    // ★★ 2026-10-15 摘掉顶上那条导航（用户裁定：驾驶舱**只看它自己的六块，不跳工作台**）。
    //
    // 摘之前：`<header class="topbar"><div class="brand">工作台</div><nav class="nav">今日总览 · 消息 ·
    //   待办 · 日程 · 笔记 · 驾驶舱</nav></header>`。
    // 为什么摘：驾驶舱与工作台是**官方侧栏里两个并列的入口**，而点进驾驶舱却看到工作台的导航条 ——
    //   等于从一个入口进去又回到另一个入口。用户原话：「**驾驶舱是驾驶舱，工作台是工作台**」。
    //
    // ⚠️ 摘的是**整条 header（含品牌字「工作台」）**，不是只摘 `<nav>`：
    //   留着 `<div class="brand">工作台</div>` 的话，页面顶上仍然写着"工作台"，
    //   那还是在说"你在工作台里"。用户要的是"这是驾驶舱"。
    // ⚠️ `nav` 那个变量**一并删掉**（在 renderCockpit 顶部），别留一个没人用的常量 ——
    //   留着它下次有人会以为导航还在、只是没渲染。
    + '<main data-page="cockpit">' + body + '</main><footer class="spacer"></footer>'
    + '<div class="statusbar"><span>驾驶舱 · 数据统计 / 知识图谱 / 发展趋势 / 业务洞察 / 状态分析 / 发展建议</span><span class="grow"></span><span>' + esc(new Date(now).toLocaleString('zh-CN')) + '</span></div>'
    + cockpitClientScript()
    + '</body></html>';
}

/** 驾驶舱页面的客户端脚本（内联，零外链）：只做一件事 —— 点「生成」调**已登记**的写路径 */
export function cockpitClientScript() {
  const L = [];
  L.push('<script>');
  L.push('(function(){');
  L.push('  var API = "/workdesktop/api/v1";');
  // ★ 区间选择器：四块的「生成」共用这一个区间（读 DOM，不存第二份状态）
  L.push('  function rangeBody(){');
  L.push('    var f = document.getElementById("range-from"); var t = document.getElementById("range-to");');
  L.push('    var o = {}; if (f && f.value) o.from = f.value; if (t && t.value) o.to = t.value; return o;');
  L.push('  }');
  // ★★ 2026-10-14 加（用户 8.3）：「抽离出库内**单个项目或某条业务线**…进行复盘。」
  //   ⇒ 生成时把那一块自己的**单元选择器**的值一起带上；
  //     每块各读各的（`data-cockpit-unit="<kind>"`），不共用一个全局状态 ——
  //     否则"给复盘选了单元"会连带把别的块也收窄，那是看不见的错。
  L.push('  function unitOf(kind){');
  L.push('    var sel = document.querySelector(\'[data-cockpit-unit="\' + kind + \'"]\');');
  L.push('    return sel && sel.value ? String(sel.value) : null;');
  L.push('  }');
  L.push('  function ymd(d){ var p = function(n){ return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }');
  L.push('  var quicks = document.querySelectorAll("[data-range-quick]");');
  L.push('  for (var q = 0; q < quicks.length; q++) (function(b){');
  L.push('    b.addEventListener("click", function(){');
  L.push('      var days = Number(b.getAttribute("data-range-quick")) || 7;');
  L.push('      var to = new Date(); var from = new Date(Date.now() - (days - 1) * 86400000);');
  L.push('      var f = document.getElementById("range-from"); var t = document.getElementById("range-to");');
  L.push('      if (f) f.value = ymd(from); if (t) t.value = ymd(to);');
  L.push('    });');
  L.push('  })(quicks[q]);');
  L.push('  var clr = document.querySelector("[data-range-clear]");');
  L.push('  if (clr) clr.addEventListener("click", function(){ var f = document.getElementById("range-from"); var t = document.getElementById("range-to"); if (f) f.value = ""; if (t) t.value = ""; });');
  L.push('  var btns = document.querySelectorAll("[data-cockpit-gen]");');
  L.push('  for (var i = 0; i < btns.length; i++) (function(btn){');
  L.push('    btn.addEventListener("click", function(){');
  L.push('      var kind = btn.getAttribute("data-cockpit-gen");');
  L.push('      var msg = document.querySelector("[data-cockpit-msg=\\"" + kind + "\\"]");');
  L.push('      btn.disabled = true;');
  L.push('      if (msg) msg.textContent = "生成中…（约 30 秒）";');
  L.push('      fetch(API + "/cockpit/" + kind, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: (function(){ var b = rangeBody(); var u = unitOf(kind); if (u) b.unit = u; return b })() }) })');
  L.push('        .then(function(r){ return r.json().then(function(d){ return { code: r.status, d: d }; }); })');
  L.push('        .then(function(res){');
  L.push('          if (res.code === 200 && res.d && res.d.ok) { if (msg) msg.textContent = "已生成，正在刷新…"; location.reload(); return; }');
  L.push('          if (res.code === 409) { if (msg) msg.textContent = "没有数据 ⇒ 拒绝生成（按规矩不调模型）"; btn.disabled = false; return; }');
  L.push('          if (msg) msg.textContent = "失败（" + res.code + "）：" + ((res.d && res.d.error) || "未知原因");');
  L.push('          btn.disabled = false;');
  L.push('        })');
  L.push('        .catch(function(e){ if (msg) msg.textContent = "请求失败：" + e.message; btn.disabled = false; });');
  L.push('    });');
  L.push('  })(btns[i]);');
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-14 加（用户第 8.1 条）：「每个节点都能够**点击穿透到具体的知识点内容/文档**。」
  //
  //   节点上带了两类目标（见 `graphBlock`）：
  //     · `data-g-open="messages:xxx"` ⇒ 打开那条事件的**详情浮层**
  //     · `data-g-doc="Work/…/x.md"`  ⇒ 打开**文档正文**（`GET /v1/doc?p=…`）
  //
  //   为什么详情用浮层而不是跳页：驾驶舱是**看全局**的地方，跳走就丢了位置；
  //   而且别的页面（总览）早就是就地开浮层的做法，这里跟它保持一致。
  //
  //   ⚠️ 浮层里**只放这一段文本**，不做完整的"详情页"（那套在四个功能页上已经有了）。
  //     这里要的是"点一下能看见那条到底是什么" —— 够用就停。
  L.push('  function overlay(title, bodyText){');
  L.push('    var old = document.getElementById("ckp-ov"); if (old) old.parentNode.removeChild(old);');
  L.push('    var mask = document.createElement("div"); mask.id = "ckp-ov";');
  L.push('    mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";');
  L.push('    var box = document.createElement("div");');
  L.push('    box.style.cssText = "background:var(--c-canvas,#fff);color:var(--c-ink,#111);max-width:760px;max-height:80vh;overflow:auto;border-radius:10px;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.3)";');
  L.push('    var h = document.createElement("div"); h.textContent = title;');
  L.push('    h.style.cssText = "font-weight:600;margin-bottom:10px;font-size:15px";');
  L.push('    var b = document.createElement("pre"); b.textContent = bodyText;');
  L.push('    b.style.cssText = "white-space:pre-wrap;word-break:break-word;font:13px/1.7 ui-monospace,Menlo,Consolas,monospace;margin:0";');
  L.push('    var x = document.createElement("button"); x.textContent = "关闭";');
  L.push('    x.style.cssText = "margin-top:14px;padding:5px 14px;cursor:pointer";');
  L.push('    x.addEventListener("click", function(){ mask.parentNode.removeChild(mask) });');
  L.push('    mask.addEventListener("click", function(ev){ if (ev.target === mask) mask.parentNode.removeChild(mask) });');
  L.push('    box.appendChild(h); box.appendChild(b); box.appendChild(x); mask.appendChild(box); document.body.appendChild(mask);');
  L.push('  }');
  L.push('  var nodes = document.querySelectorAll("[data-g-open]");');
  L.push('  for (var n1 = 0; n1 < nodes.length; n1++) (function(c){');
  L.push('    c.addEventListener("click", function(){');
  L.push('      var spec = String(c.getAttribute("data-g-open")).split(":");');
  L.push('      var type = spec[0]; var id = spec.slice(1).join(":");');
  L.push('      overlay("载入中…", "正在取详情…");');
  L.push('      fetch(API + "/detail/" + type + "/" + encodeURIComponent(id))');
  L.push('        .then(function(r){ return r.json(); })');
  L.push('        .then(function(d){');
  L.push('          if (d && d.error) { overlay("取详情失败", String(d.error)); return; }');
  L.push('          var s = d.structured || {}; var o = d.original || {};');
  L.push('          var lines = [];');
  L.push('          lines.push("类型：" + type);');
  L.push('          if (o.sender) lines.push("发信人：" + o.sender);');
  L.push('          if (s.topic) lines.push("主题：" + s.topic);');
  L.push('          if (s.due) lines.push("截止：" + s.due);');
  L.push('          if (s.start) lines.push("时间：" + s.start + (s.end ? (" ~ " + s.end) : ""));');
  L.push('          if (s.date) lines.push("日期：" + s.date);');
  L.push('          lines.push("");');
  //          ★ 正文里同样**不显示图片链接**（与四个功能页同一条规矩），只留「［图片消息］」
  L.push('          var body = String(s.raw || s.content_md || s.detail || s.summary || "").replace(/\\[(图片|视频|语音|文件)消息\\]\\(mediaId=[^)\\s]*\\)?/g, "［$1消息］").replace(/mediaId=[^)\\s]*/g, "").trim();');
  L.push('          lines.push(body || "（这条没有正文）");');
  L.push('          if (d.contextSummary) { lines.push(""); lines.push("相关上下文：" + d.contextSummary); }');
  L.push('          else if (d.contextSummaryPending) { lines.push(""); lines.push("相关上下文：正在概括（稍后再点一次就能看到）"); }');
  L.push('          else if (d.contextSummaryError) { lines.push(""); lines.push("相关上下文：" + d.contextSummaryError); }');
  L.push('          overlay((s.topic || body || id).slice(0, 60), lines.join("\\n"));');
  L.push('        })');
  L.push('        .catch(function(e){ overlay("取详情失败", String(e.message || e)); });');
  L.push('    });');
  L.push('  })(nodes[n1]);');
  L.push('  var docs = document.querySelectorAll("[data-g-doc]");');
  L.push('  for (var n2 = 0; n2 < docs.length; n2++) (function(c){');
  L.push('    c.addEventListener("click", function(){');
  L.push('      var p = c.getAttribute("data-g-doc");');
  L.push('      overlay("载入中…", "正在取文档…");');
  L.push('      fetch(API + "/doc?p=" + encodeURIComponent(p))');
  L.push('        .then(function(r){ return r.json(); })');
  L.push('        .then(function(d){ if (d && d.error) { overlay("打不开这份文档", String(d.error) + "\\n\\n" + p); return; } overlay(p.split("/").pop(), String(d.text || "（空文件）") + (d.truncated ? "\\n\\n…（文件较长，只显示了前一段）" : "")); })');
  L.push('        .catch(function(e){ overlay("打不开这份文档", String(e.message || e) + "\\n\\n" + p); });');
  L.push('    });');
  L.push('  })(docs[n2]);');
  L.push('})();');
  L.push('</script>');
  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const html = renderCockpit();

  chk('CKP-1', '六块顺序与需求一致（自上而下）', (() => {
    const idx = SECTIONS.map((s) => html.indexOf(s.title));
    return idx.every((v) => v > 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]);
  })(), JSON.stringify(SECTIONS.map((s) => s.title)));
  chk('CKP-2', '★ 统计四组口径都在（消息/日程/待办/笔记）', ['消息', '日程', '待办', '笔记'].every((k) => html.includes(k + ' ·')));
  chk('CKP-3', '★ 待办写明"逾期"这一档（需求点名）', html.includes('逾期'));
  chk('CKP-4', '★ 笔记写明"可视化模型"这一档（需求点名）', html.includes('可视化模型'));
  chk('CKP-5', '知识图谱有节点/边计数与边来源口径', html.includes('节点') && html.includes('边') && html.includes('真实依据'));
  chk('CKP-6', '趋势块有区间与合计', html.includes('合计') && /\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/.test(html));
  // ★★ 2026-10-14 改（**原来这条是"写死未生成"的**，后三块真的生成之后它当场变红）。
  //   原判据：页面上出现「尚未生成」≥1 次 ⇒ 过。
  //   它想守的规矩是**「后三块不许假装已分析」** —— 但用"必须出现某句话"来表达这条规矩是错的：
  //     · 后三块还没生成时：那句话出现 3 次 ⇒ 过（当时是对的）；
  //     · 后三块**已经生成**时：那句话出现 0 次 ⇒ **红**，而这时页面恰恰是**对的**
  //       （它给的是真实内容，不是"尚未生成"）。
  //   ⇒ 一条把"正确状态"判成错的检查，早晚会被人当成噪声关掉。
  //   ⇒ 改成**逐块对着真实数据判**：每一块 **要么渲染出模型给的正文，要么如实写「尚未生成」**。
  //     · `readNarrative(kind)` 有内容 ⇒ 页面里必须出现那段正文的头一段（证明确实渲染了）；
  //     · `readNarrative(kind)` 为 null ⇒ 页面里必须出现「尚未生成」（证明没假装）。
  //   这样"未生成"与"已生成"两种状态都判得对，而且**都不许出现第三种状态**（既没内容也没那句话）。
  {
    const MODEL_KINDS = ['insight', 'state', 'advice']
    const bad = []
    for (const k of MODEL_KINDS) {
      const n = readNarrative(k)
      const has = n && typeof n.text === 'string' && n.text.trim() !== ''
      if (!has) {
        // ⚠️ 判"这一块在不在页面上"要按它的标题找，不能只看整页有没有那句话 ——
        //    三块里只有一块没生成时，"≥1 次"会被另外两块满足，等于漏判。
        const title = SECTIONS.find((s) => s.key === k)?.title ?? ''
        const seg = title ? html.slice(html.indexOf(title), html.indexOf(title) + 3000) : ''
        if (!seg.includes('尚未生成')) bad.push(`${k}:没有数据却没写"尚未生成"`)
        continue
      }
      const head = n.text.trim().slice(0, 24)
      if (!html.includes(head)) bad.push(`${k}:有生成内容（${head}…）却没渲染出来`)
    }
    chk('CKP-7', '★★ 后三块**逐块**对着真实数据判：有内容就渲染、没内容就如实写"尚未生成"（不许假装已分析）',
      bad.length === 0,
      bad.length ? bad.join(' | ') : MODEL_KINDS.map((k) => `${k}=${readNarrative(k)?.text ? '已渲染' : '未生成'}`).join(' · '))
  }
  chk('CKP-8', '★ 后三块写明"没数据不调模型"的规矩', html.includes('不调用模型') || html.includes('没有事件'));
  // ★★ 2026-10-14 改：原来写死 `keys.length === 4`。加了「全盘业务分析」之后变五块 ⇒ 当场红。
  //   **红得对**，但它顺手把**块数**也写进去了 —— 而块数会随需求拆法漂移
  //   （4.3 拆四块、8.3/8.4 拆成两块，都是同一件事的不同拆法）。
  //   ⇒ 改成只守真正要守的那条：**每一块的提问都不一样**（重复的提问 = 两块在问同一件事，
  //     那种错看起来像"内容不够"，其实是配置写重了）。
  chk('CKP-9', '★ 模型块的提问各不相同（块数不写死 —— 拆法会变）', (() => {
    const keys = SECTIONS.filter((s) => s.kind === 'model').map((s) => s.key);
    const asks = keys.map((k) => sliceFor(k).ask);
    return keys.length >= 4 && new Set(asks).size === keys.length && asks.every((a) => a && a.length > 10);
  })(), JSON.stringify(SECTIONS.filter((s) => s.kind === 'model').map((s) => s.key)));
  // ★★ 2026-10-15 改（**这条判据守的东西已经不在了**）。
  //   原文：`chk('CKP-10', '顶导航横排且当前页高亮', html.includes('aria-current="page"') && html.includes('class="nav"'))`
  //   —— 它守的是"页面顶部那条工作台导航"。用户裁定「驾驶舱**只看它自己的六块，不跳工作台**」
  //   ⇒ 那条导航**已整条摘掉**（连 `<header>` 与品牌字一起）⇒ 原判据必然判否。
  //   ⇒ 反过来守**摘干净了**。删掉这条检查是最省事的做法，**但那等于以后没人拦着它被加回来**。
  //
  //   ⚠️ 判据**不能**用 `aria-current`：那个词在 `<style>` 里有 3 处（`.nav a[aria-current="page"]` 之类
  //     的样式选择器），与"页面上有没有导航"无关 —— 我第一版就是这么写的，于是摘干净了它照样判否。
  //   ⇒ 按**页面结构**判：不许有 `<header>` / `<nav>` / `class="nav"` / 指向工作台各页的链接。
  const noHeader = !html.includes('<header') && !html.includes('<nav') && !html.includes('class="nav"');
  const noWorkbenchLinks = (html.match(/href="\.\/(overview|messages|todos|schedules|notes)\.html"/g) ?? []).length === 0;
  chk('CKP-10', '★★ 页面里**没有**工作台那条导航（驾驶舱是驾驶舱，不跳工作台 —— 用户 2026-10-15 裁定）',
    noHeader && noWorkbenchLinks,
    `<header>/<nav>/class="nav" 有没有=${!noHeader} · 指向工作台各页的链接=${(html.match(/href="\.\/(overview|messages|todos|schedules|notes)\.html"/g) ?? []).length}`);

  // ★ CKP-20…23（P4 收尾）：时间区间选择器（需求 4.3.2「可自定义筛选时间周期」）
  chk('CKP-20', '★ 有分析区间选择器（起止日期 + 三档快捷 + 清空）', html.includes('id="range-from"') && html.includes('id="range-to"') && (html.match(/data-range-quick=/g) ?? []).length === 3 && html.includes('data-range-clear'));
  chk('CKP-21', '★ 各块的「生成」共用同一个区间（不各配一套，免得各块各说各的区间）', (() => {
    const js = cockpitClientScript();
    // ★ 2026-10-14 改：判据从"字面量 `payload: rangeBody()`"放宽到"用了 rangeBody() 这个函数"——
    //   因为加了单元之后那行变成了 IIFE（先取区间、再按需带 unit）。
    //   守的东西没变：**区间只有一处取法**，各块都走它。
    return js.includes('rangeBody()') && /querySelectorAll\("\[data-cockpit-gen\]"\)/.test(js);
  })());
  // ★★ 2026-10-14 加（用户 8.3）：「抽离出库内**单个项目或某条业务线**…进行复盘。」
  chk('CKP-24', '★★ 复盘块有**业务单元选择器**，且选项来自库内单元清单（不在页面里另算一套）',
    html.includes('data-cockpit-unit="insight"') && html.includes('复盘哪个单元') && html.includes('（全部单元，逐个复盘）'));
  chk('CKP-25', '★★ 选了单元会**带进生成请求**（不带的话选择器就是个摆设）',
    cockpitClientScript().includes('unitOf(kind)') && cockpitClientScript().includes('b.unit = u'));
  chk('CKP-26', '★ 单元选择器**每块各读各的**（不共用一个全局值，免得给复盘选的单元把别的块也收窄）',
    (cockpitClientScript().match(/data-cockpit-unit="'\s*\+\s*kind/g) ?? []).length >= 1);
  chk('CKP-22', '★ 客户端脚本语法有效（真编译一遍：语法错在服务端看不出来，只有浏览器才炸）', (() => {
    const m = /<script>([\s\S]*)<\/script>/.exec(cockpitClientScript());
    if (!m) return false;
    try { new Function(m[1]); return true; } catch { return false; }
  })());
  chk('CKP-23', '★ 快捷档算出的是**本地日期**（UTC 会少一天），且格式是 YYYY-MM-DD', (() => {
    const js = cockpitClientScript();
    return /getFullYear\(\)/.test(js) && /getMonth\(\) \+ 1/.test(js) && /getDate\(\)/.test(js);
  })());
  chk('CKP-11', '★ 无外部依赖（不外链脚本/字体/CDN）', !/src="http|href="http|cdn\./.test(html));
  chk('CKP-12', '★ 负向对照：**除了变量定义块**，样式里不写死颜色', (() => {
    // ★ 判据分两步收窄（2026-10-12 改两次，两次都是假红）：
    //   ① 原来扫 `<main>` 之后的全部 HTML ⇒ 模型正文里的 `#21#22#140`（日程主题里的编号）被当成色值；
    //   ② 改成只看样式块 ⇒ 又撞上 `:root { --c-primary: #080808; }` —— **变量定义本来就该写色值**。
    //   ⇒ 正解：把 `:root` 变量块摘掉，再看剩下的样式里有没有写死的颜色。
    //   **假红比不查更糟：会让人开始怀疑整套数。**
    const styles = (html.match(/<style>[\s\S]*?<\/style>/g) ?? []).join('\n');
    const noVars = styles.replace(/:root\s*\{[\s\S]*?\}/g, '');
    return styles.length > 0 && noVars.length > 0 && !/#[0-9a-fA-F]{6}/.test(noVars);
  })());
  chk('CKP-13', 'SVG 用 token 变量上色（不是硬编码色值）', html.includes('fill="var(--c-accent-blue)"'));

  // ── 生成入口（2026-10-12 接线）────────────────────────────────────────────
  chk('CKP-14', '★ 五块都有「生成」按钮 —— 2026-10-12 由三块扩为四块，2026-10-14 加「全盘业务分析」成五块', (html.match(/data-cockpit-gen=/g) ?? []).length === 5, String((html.match(/data-cockpit-gen=/g) ?? []).length));
  chk('CKP-15', '★ 页面内联客户端脚本，且**相对**接口基址（嵌进插件 host 才走同一条）', html.includes('var API = "/workdesktop/api/v1"') && !/src="http/.test(html));
  chk('CKP-16', '★ 无数据的那块按钮是禁用的（不让人点了才发现没数据）', (() => {    const empty = modelBlock('advice', Date.parse('1970-01-02T00:00:00+08:00'));
    return empty.includes('disabled') && empty.includes('按规矩不调模型');
  })());
  chk('CKP-17', '★ 客户端脚本对 409（无数据）单独给话术，不与普通失败混同', html.includes('409') && html.includes('拒绝生成（按规矩不调模型）'));
  chk('CKP-18', '★ 负向对照：脚本不外链（页面自包含）', !/<script[^>]+src=/.test(html));

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}

const __isMain = (() => { try { const entry = process.argv[1]; return !!entry && import.meta.url === pathToFileURL(entry).href } catch { return false } })();
if (__isMain) {
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, 'cockpit.html');
  fs.writeFileSync(f, renderCockpit(), 'utf8');
  console.log('已渲染 ' + path.relative(ROOT, f) + '（' + fs.statSync(f).size + ' 字节）');
}
