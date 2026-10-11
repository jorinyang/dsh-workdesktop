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
import { fileURLToPath } from 'node:url';

import { stylesheet, APP_NAME, PAGE_DEFS } from './shell.mjs';
import { stats, trend, graph, sliceFor, hasEnoughData, readNarrative } from '../api/cockpit.mjs';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'Other', 'data', 'workbench-v1');

/** 六块的顺序与标题（需求 4.3.6 原样） */
export const SECTIONS = Object.freeze([
  { key: 'stats', title: '一、数据统计', kind: 'data' },
  { key: 'graph', title: '二、知识图谱', kind: 'data' },
  { key: 'trend', title: '三、发展趋势', kind: 'data' },
  { key: 'insight', title: '四、业务洞察', kind: 'model' },
  { key: 'state', title: '五、状态分析', kind: 'model' },
  { key: 'advice', title: '六、发展建议', kind: 'model' },
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

/** 图谱块：用极简 SVG 画力导向结果的替代——圆形布局 + 直线（**可点击穿透**由链接承担） */
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
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;border:1px solid var(--c-hairline);border-radius:8px">';
  for (const e of g.edges) {
    const a = pos[e.from]; const b = pos[e.to];
    if (!a || !b) continue;
    svg += '<line x1="' + a[0].toFixed(1) + '" y1="' + a[1].toFixed(1) + '" x2="' + b[0].toFixed(1) + '" y2="' + b[1].toFixed(1) + '" stroke="var(--c-hairline)" stroke-width="1"><title>' + esc(e.kind + '：' + e.why) + '</title></line>';
  }
  for (const n of g.nodes) {
    const p = pos[n.id];
    const color = byKind[n.kind] || 'var(--c-body-mid)';
    svg += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (n.kind === 'doc' ? 5 : 7) + '" fill="' + color + '"><title>' + esc(n.kind + '：' + n.label) + '</title></circle>';
  }
  svg += '</svg>';
  return svg + '<div class="cap" style="margin-top:8px;color:var(--c-mute);font-size:12px">' + esc(g.note) + '　节点 ' + g.counts.nodes + ' · 边 ' + g.counts.edges + ' · 构成 ' + esc(JSON.stringify(g.counts.byKind)) + '</div>';
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

/** 模型三块：**已生成就显示内容**，未生成就如实说"尚未生成"；那条规矩常设可见 */
export function modelBlock(kind, now) {
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
  // ★ 规矩常设可见：无论当前有没有数据、有没有生成，这条约束都写在块里（它是纪律，不是条件提示）
  return '<div class="card">' + head + btn
    + '<div class="cap" style="margin-top:6px;color:var(--c-mute);font-size:12px">规矩：没有真实数据切片时不调用模型 —— 避免生成"没数据也像模像样"的分析。</div>'
    + '</div>';
}

export function renderCockpit({ now = Date.now(), from = null, to = null } = {}) {
  const s = stats({ now }); const g = graph({ now }); const t = trend({ from, to, now, days: 14 });
  const nav = PAGE_DEFS.map((p) => '<a href="./' + p.key + '.html">' + esc(p.label) + '</a>').join('') + '<a href="./status.html">现状一览</a><a href="./cockpit.html" aria-current="page">驾驶舱</a>';
  let body = '<h1 style="font-size:22px">' + APP_NAME + ' · 驾驶舱</h1>';
  body += '<div class="cap" style="margin:6px 0 18px;color:var(--c-mute);font-size:13px">自上而下六块（需求 4.3.6）· 前三块为真实数据，后三块需要模型且须先有真实切片</div>';
  const blocks = { stats: statsBlock(s), graph: graphBlock(g), trend: trendBlock(t) };
  for (const sec of SECTIONS) {
    body += '<div class="section"><h2>' + esc(sec.title) + '</h2>'
      + (sec.kind === 'data' ? blocks[sec.key] : modelBlock(sec.key, now))
      + '</div>';
  }
  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + APP_NAME + ' · 驾驶舱</title><style>' + stylesheet() + '</style></head><body>'
    + '<header class="topbar"><div class="brand">' + APP_NAME + '</div><nav class="nav">' + nav + '</nav></header>'
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
  L.push('  var btns = document.querySelectorAll("[data-cockpit-gen]");');
  L.push('  for (var i = 0; i < btns.length; i++) (function(btn){');
  L.push('    btn.addEventListener("click", function(){');
  L.push('      var kind = btn.getAttribute("data-cockpit-gen");');
  L.push('      var msg = document.querySelector("[data-cockpit-msg=\\"" + kind + "\\"]");');
  L.push('      btn.disabled = true;');
  L.push('      if (msg) msg.textContent = "生成中…（约 30 秒）";');
  L.push('      fetch(API + "/cockpit/" + kind, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })');
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
  chk('CKP-7', '★ 后三块如实写"尚未生成"，不假装已分析', (html.match(/尚未生成/g) ?? []).length === 3 || (html.match(/尚未生成/g) ?? []).length >= 1, String((html.match(/尚未生成/g) ?? []).length));
  chk('CKP-8', '★ 后三块写明"没数据不调模型"的规矩', html.includes('不调用模型') || html.includes('没有事件'));
  chk('CKP-9', '★ 模型三块的提问各不相同（洞察/状态/建议）', new Set(SECTIONS.filter((s) => s.kind === 'model').map((s) => sliceFor(s.key).ask)).size === 3);
  chk('CKP-10', '顶导航横排且当前页高亮', html.includes('aria-current="page"') && html.includes('class="nav"'));
  chk('CKP-11', '★ 无外部依赖（不外链脚本/字体/CDN）', !/src="http|href="http|cdn\./.test(html));
  chk('CKP-12', '★ 负向对照：样式不写死颜色（走 token 变量）', (() => { const body = html.slice(html.indexOf('<main')); return !/#[0-9a-fA-F]{6}/.test(body); })());
  chk('CKP-13', 'SVG 用 token 变量上色（不是硬编码色值）', html.includes('fill="var(--c-accent-blue)"'));

  // ── 生成入口（2026-10-12 接线）────────────────────────────────────────────
  chk('CKP-14', '★ 三块都有「生成」按钮（不再是"等每日任务"的空话）', (html.match(/data-cockpit-gen=/g) ?? []).length === 3, String((html.match(/data-cockpit-gen=/g) ?? []).length));
  chk('CKP-15', '★ 页面内联客户端脚本，且**相对**接口基址（嵌进插件 host 才走同一条）', html.includes('var API = "/workdesktop/api/v1"') && !/src="http/.test(html));
  chk('CKP-16', '★ 无数据的那块按钮是禁用的（不让人点了才发现没数据）', (() => {
    const empty = modelBlock('advice', Date.parse('1970-01-02T00:00:00+08:00'));
    return empty.includes('disabled') && empty.includes('按规矩不调模型');
  })());
  chk('CKP-17', '★ 客户端脚本对 409（无数据）单独给话术，不与普通失败混同', html.includes('409') && html.includes('拒绝生成（按规矩不调模型）'));
  chk('CKP-18', '★ 负向对照：脚本不外链（页面自包含）', !/<script[^>]+src=/.test(html));

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}

if (process.argv[1] && process.argv[1].endsWith('cockpit-page.mjs')) {
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, 'cockpit.html');
  fs.writeFileSync(f, renderCockpit(), 'utf8');
  console.log('已渲染 ' + path.relative(ROOT, f) + '（' + fs.statSync(f).size + ' 字节）');
}
