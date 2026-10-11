#!/usr/bin/env node
/**
 * v1/ui/status-page.mjs —— 渲染 **弈枢 1.0 现状一览**（`Other/data/workbench-v1/status.html`）
 *
 * 为什么做这一页：进度散在对话与文档里，人和下一个接手者都得翻半天。
 *   这一页把**真实读数**（通道接线数、缺口清单、水位线、台账、四类库存、知识库产出）摊在一张页面上，
 *   并且**缺口逐条写明为什么没接** —— 让"还没做"和"做完了"一眼分得开。
 *
 * 全部数据来自真实来源（不写死、不估算）：通道注册表 · 水位线 · 引擎台账 · 运行态存储 · 知识库目录。
 * 本文件与 shell 一样**不用模板字符串**（拼接），避免 Windows 下引号/嵌套的坑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stylesheet, APP_NAME, PAGE_DEFS, STATUS_ITEMS, SWITCHES } from './shell.mjs';
import { health as registryHealth, V1_START } from '../collector/registry.mjs';
import { health as stateHealth } from '../collector/state.mjs';
import * as store from '../store.mjs';
import { readRuns } from '../ledger.mjs';
import { readSwitches } from './preview.mjs';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'Other', 'data', 'workbench-v1');

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
  });
}

function counts() {
  const out = { message: 0, note: 0, todo: 0, schedule: 0 };
  for (const t of Object.keys(out)) {
    try { out[t] = store.list({ type: t }).length; } catch { out[t] = 0; }
  }
  return out;
}

function kbFiles() {
  const base = path.join(ROOT, 'Other', 'Inflow');
  const rows = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else rows.push({ rel: path.relative(ROOT, p).split(path.sep).join('/'), size: fs.statSync(p).size });
    }
  };
  walk(base, 0);
  return rows;
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

export function renderStatus() {
  const reg = registryHealth();
  const wm = stateHealth();
  const runs = readRuns({});
  const last = runs.slice(-1)[0] ?? null;
  const c = counts();
  const files = kbFiles();
  const sw = readSwitches();

  const cards = [
    ['通路已接线', reg.implemented + ' / ' + reg.total],
    ['消息 / 笔记', c.message + ' / ' + c.note],
    ['待办 / 日程', c.todo + ' / ' + c.schedule],
    ['引擎台账', runs.length + ' 条'],
  ];
  let cardHtml = '';
  for (const p of cards) cardHtml += '<div class="card featured"><div class="num">' + esc(p[1]) + '</div><div class="cap">' + esc(p[0]) + '</div></div>';

  const byCh = reg.byChannel.map(function (b) { return [b.channel, b.implemented + ' / ' + b.total, b.missing.join(', ') || '—']; });
  const missRows = reg.missingList.map(function (m) { return [m.key, m.label, m.why]; });
  const wmRows = wm.map(function (w) { return [w.key, String(w.runs), String(w.lastIn), String(w.lastOut), String(w.lastErrors), w.suspicious ? '可疑' : '正常']; });
  const kbRows = files.map(function (f) { return [f.rel, String(f.size) + ' B']; });
  const swRows = SWITCHES.map(function (s) { return [s.label, s.key, sw.switches[s.key] === true ? '开' : sw.switches[s.key] === false ? '关' : '未知']; });

  let body = '<h1 style="font-size:22px">' + APP_NAME + ' 1.0 · 现状一览</h1>';
  body += '<div class="cap" style="margin:6px 0 18px;color:var(--c-mute);font-size:13px">采集起点 ' + esc(V1_START) + '（更早的一律只读）· 本页数据全部来自真实来源，缺口逐条写明原因</div>';
  body += '<div class="stats">' + cardHtml + '</div>';

  body += '<div class="section"><h2>一、采集器 · 通路接线</h2>' + table(['渠道', '已接线 / 总数', '缺哪些'], byCh) + '</div>';
  body += '<div class="section"><h2>二、还没接的通路（为什么没接）</h2>' + table(['通路', '是什么', '为什么还没接'], missRows) + '</div>';
  body += '<div class="section"><h2>三、水位线（每轮读到哪儿、有没有出错）</h2>' + (wmRows.length ? table(['通路', '轮数', '上轮进', '上轮出', '错误', '状态'], wmRows) : '<div class="empty">还没有读数</div>') + '</div>';
  body += '<div class="section"><h2>四、最近一轮引擎读数</h2>' + (last ? table(['引擎', '状态', '耗时', '进', '出', '说明'], [[last.engine, last.status, String(last.ms) + ' ms', String(last.inCount), String(last.outCount), last.why || (last.suspicious ? '被视为可疑（0 进 0 出且无说明）' : '—')]]) : '<div class="empty">暂无</div>') + '</div>';
  body += '<div class="section"><h2>五、底部状态栏三个开关（真实来源）</h2>' + table(['开关', '能力名', '状态'], swRows) + '<div class="cap" style="margin-top:8px;color:var(--c-mute);font-size:12px">四个系统状态（' + STATUS_ITEMS.map(function (s) { return s.label; }).join(' / ') + '）由真实探针判定，见底栏</div></div>';
  body += '<div class="section"><h2>六、已落进知识库的产出</h2>' + (kbRows.length ? table(['文件', '大小'], kbRows) : '<div class="empty">还没有产出</div>') + '</div>';

  const nav = '';
  const html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + APP_NAME + ' · 现状一览</title><style>' + stylesheet() + '</style></head><body>'
    + '<header class="topbar"><div class="brand">' + APP_NAME + '</div><nav class="nav">'
    + PAGE_DEFS.map(function (p) { return '<a href="./' + p.key + '.html">' + esc(p.label) + '</a>'; }).join('')
    + '<a href="./status.html" aria-current="page">现状一览</a>'
    + '</nav></header>'
    + '<main>' + body + '</main><footer class="spacer"></footer>'
    + '<div class="statusbar"><span>本页由 status-page.mjs 生成</span><span class="grow"></span><span>' + esc(new Date().toLocaleString('zh-CN')) + '</span></div>'
    + '</body></html>';
  return html;
}

if (process.argv[1] && process.argv[1].endsWith('status-page.mjs')) {
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, 'status.html');
  fs.writeFileSync(f, renderStatus(), 'utf8');
  console.log('已渲染 ' + path.relative(ROOT, f) + '（' + fs.statSync(f).size + ' 字节）');
}
