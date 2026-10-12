/**
 * v1/api/cockpit.mjs —— **驾驶舱数据层**（P7；需求 4.3）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 4.3.6 的统计口径（照抄，一个都不许漏）
 *   消息数：总数 / 待处理 / 已处理
 *   日程数：总数 / 已进行 / 待进行
 *   待办数：总数 / 已完成 / 逾期 / 待完成
 *   笔记数：总数 / 标签数 / **可视化模型数**
 *
 * 本文件只做**纯数据**（可离线测、可复算）：统计 / 知识图谱 / 趋势切片。
 *   · 需要模型的三块（业务洞察 / 状态分析 / 发展建议）不在这里 —— 它们由 `narrative()` 走模型，
 *     且**必须先有真实数据切片**才允许调用（避免"没数据也生成一段分析"）。
 *   · 图谱只连**有真实依据**的边（同发信人 / 同客户目录 / 召回命中），不靠相似度硬凑关系。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import * as store from '../store.mjs';
import { isVisualBuilt } from '../store.mjs';   // ★ 唯一判定（收口 P0-2：此前这里有第二套算法，与 store 不一致）
import { messageState } from './pages.mjs';

const DAY = 86400000;
export const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const ymd = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const isDone = (e) => (e.ops ?? []).some((o) => String(o.op ?? '') === 'done');
const hasOp = (e, n) => (e.ops ?? []).some((o) => String(o.op ?? '') === n);

/** 一、数据统计（需求 4.3.6 四组口径） */
export function stats({ now = Date.now() } = {}) {
  const msgs = store.list({ type: 'message' });
  const sch = store.list({ type: 'schedule' });
  const td = store.list({ type: 'todo' });
  const nt = store.list({ type: 'note' });

  const msgPending = msgs.filter((e) => messageState(e) === 'pending').length;
  const schDone = sch.filter(isDone).length;
  const tdDone = td.filter(isDone).length;
  const tdOverdue = td.filter((e) => !isDone(e) && e.payload?.due && Date.parse(e.payload.due) < dayStart(now)).length;
  const tags = new Set();
  for (const e of nt) for (const t of (e.payload?.tags ?? [])) tags.add(t);
  const visualModels = nt.filter(isVisualBuilt).length;

  return {
    messages: { total: msgs.length, pending: msgPending, processed: msgs.length - msgPending },
    schedules: { total: sch.length, done: schDone, upcoming: sch.length - schDone },
    todos: { total: td.length, done: tdDone, overdue: tdOverdue, open: td.length - tdDone - tdOverdue },
    notes: { total: nt.length, tags: tags.size, visualModels },
  };
}

/** 三、发展趋势：按日切片（纯数据；模型叙述由 narrative 负责） */
export function trend({ from = null, to = null, now = Date.now(), days = 30 } = {}) {
  const toMs = to ? Date.parse(to) + DAY : dayStart(now) + DAY;
  const fromMs = from ? dayStart(Date.parse(from)) : toMs - days * DAY;
  const buckets = new Map();
  // ★ 先建桶再放数：第一版写成 `put(t,'message') && ... -= 1` 想"预置后再减掉"，
  //   但 put 返回 undefined ⇒ 减一那半永远不执行 ⇒ **每个空日被塞了一条假消息**（合计直接虚高）。
  //   ⇒ 分成 ensure（只建桶、不计数）与 put（只计数）两个函数，语义不会含糊。
  const ensure = (ms) => {
    const k = ymd(ms);
    if (!buckets.has(k)) buckets.set(k, { date: k, message: 0, note: 0, todo: 0, schedule: 0, todoDone: 0, scheduleDone: 0 });
    return buckets.get(k);
  };
  const put = (ms, type) => { ensure(ms)[type] += 1; };
  const lastDay = dayStart(toMs - DAY);
  for (let t = dayStart(fromMs); t <= lastDay; t += DAY) ensure(t);
  for (const type of ['message', 'note', 'schedule']) for (const e of store.list({ type })) if (e._at >= fromMs && e._at < toMs) put(e._at, type);
  for (const e of store.list({ type: 'todo' })) {
    if (e._at >= fromMs && e._at < toMs) put(e._at, 'todo');
    const d = (e.ops ?? []).find((o) => o.op === 'done');
    if (d?.at) { const ms = Date.parse(d.at); if (ms >= fromMs && ms < toMs) put(ms, 'todoDone'); }
  }
  for (const e of store.list({ type: 'schedule' })) {
    const d = (e.ops ?? []).find((o) => o.op === 'done');
    if (d?.at) { const ms = Date.parse(d.at); if (ms >= fromMs && ms < toMs) put(ms, 'scheduleDone'); }
  }
  const series = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  const sum = (k) => series.reduce((n, r) => n + r[k], 0);
  return {
    from: ymd(fromMs), to: ymd(toMs - DAY), days: series.length, series,
    totals: { message: sum('message'), note: sum('note'), todo: sum('todo'), schedule: sum('schedule'), todoDone: sum('todoDone'), scheduleDone: sum('scheduleDone') },
  };
}

/** 二、知识图谱：节点 + **有依据的**边（同发信人 / 同客户目录 / 召回命中） */
export function graph({ maxNodes = 200, now = Date.now() } = {}) {
  const nodes = new Map(); const edges = [];
  const addNode = (id, kind, label, extra = {}) => { if (!nodes.has(id)) nodes.set(id, { id, kind, label, ...extra }); return id; };
  const addEdge = (a, b, kind, why) => { if (a && b && a !== b) edges.push({ from: a, to: b, kind, why }); };

  const events = [];
  for (const t of ['message', 'note', 'todo', 'schedule']) for (const e of store.list({ type: t })) events.push(e);
  events.sort((a, b) => b._at - a._at);

  const bySender = new Map();
  for (const e of events) {
    const nid = addNode(e._id, e.type, String(e.payload?.topic ?? e.payload?.summary ?? e.payload?.raw ?? e._id).slice(0, 40));
    const sender = String(e.payload?.sender ?? e.payload?.publisher ?? '').trim();
    if (sender) {
      const sid = addNode(`sender:${sender}`, 'sender', sender);
      addEdge(nid, sid, 'from', '同一发信人');
      bySender.set(sender, [...(bySender.get(sender) ?? []), nid]);
    }
    // 召回命中 ⇒ 与知识库文档建立边（真实依据：分析引擎召回过它）
    for (const h of (e.context?.recalled ?? []).slice(0, 3)) {
      if (!h?.path) continue;
      const docId = addNode(`doc:${h.path}`, 'doc', h.path.split('/').pop(), { path: h.path });
      addEdge(nid, docId, 'recalled', `分析引擎召回（相似度 ${h.similarity ?? '-'}）`);
    }
  }
  // 同一发信人下的多条 ⇒ 两两相连（限流，避免爆边）
  for (const [sender, ids] of bySender) {
    const cap = ids.slice(0, 8);
    for (let i = 1; i < cap.length; i++) addEdge(cap[i - 1], cap[i], 'same-sender', `同属「${sender}」的消息流`);
  }

  const nodeList = [...nodes.values()].slice(0, maxNodes);
  const keep = new Set(nodeList.map((n) => n.id));
  const keptEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return {
    nodes: nodeList, edges: keptEdges,
    counts: { nodes: nodeList.length, edges: keptEdges.length, byKind: nodeList.reduce((m, n) => { m[n.kind] = (m[n.kind] ?? 0) + 1; return m; }, {}) },
    note: '边只来自真实依据（同一发信人 / 分析引擎召回命中），不靠相似度硬凑',
  };
}

/** 需要模型的三块：先取真实数据切片，再交给模型；**没数据就不调** */
export function sliceFor(kind, { from = null, to = null, now = Date.now() } = {}) {
  const s = stats({ now }); const t = trend({ from, to, now }); const g = graph({ now });
  const byKind = { insight: '业务洞察', state: '状态分析', advice: '发展建议' };
  const asks = {
    insight: '从这些切片里找出业务规律与异常（只看材料，不编）',
    state: '给出当前业务的真实状态（哪些在推进、哪些停住了）',
    advice: '结合趋势与状态，给出可执行的改进建议（谁、什么时候、做什么）',
  };
  return { kind, label: byKind[kind] ?? kind, ask: asks[kind] ?? '', stats: s, trend: t, graphCounts: g.counts, events: t.totals };
}
export function hasEnoughData(slice) {
  const e = slice?.events ?? {};
  return (e.message + e.note + e.todo + e.schedule) > 0;
}

// ── 模型三块的生成与读取 ──────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));
export function narrativeDir() { return path.join(process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1'), 'cockpit'); }
export function narrativeFile(kind) { return path.join(narrativeDir(), `${kind}.json`); }
const fpOf = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

/** 读已生成的那一块（没有就返回 null —— 页面据此显示"尚未生成"） */
export function readNarrative(kind) {
  try { return JSON.parse(fs.readFileSync(narrativeFile(kind), 'utf8')); } catch { return null; }
}

/**
 * 生成一块（幂等：输入指纹没变就直接返回旧的，不重复调模型）
 * @param {'insight'|'state'|'advice'} kind
 * @param {{from?:string,to?:string,now?:number,modelFn?:Function,force?:boolean}} o
 */
export async function narrative(kind, { from = null, to = null, now = Date.now(), modelFn = null, force = false } = {}) {
  const sl = sliceFor(kind, { from, to, now });
  if (!hasEnoughData(sl)) {
    // ★ 规矩：没有真实数据切片就不调模型（不给它机会生成"没数据也像模像样"的分析）
    return { ok: false, refused: true, why: `区间内没有事件（${JSON.stringify(sl.events)}）⇒ 按规矩不调用模型`, kind, label: sl.label };
  }
  const material = JSON.stringify({ stats: sl.stats, totals: sl.trend.totals, series: sl.trend.series, graph: sl.graphCounts });
  const fp = fpOf(sl.ask + material);
  const prev = readNarrative(kind);
  if (!force && prev && prev.fp === fp) return { ok: true, cached: true, kind, label: sl.label, text: prev.text, fp };

  const prompt = [
    '你在为业务驾驶舱写一块分析。要求：先给判断，再给理由，最后给下一步；只依据下面的真实数据，不要编。',
    `这一块是：${sl.label}。${sl.ask}`,
    '输出不超过 400 字，分三段：判断 / 理由 / 下一步。',
    '',
    `【真实数据切片】（区间 ${sl.trend.from} ~ ${sl.trend.to}）`,
    material,
  ].join('\n');

  const m = modelFn ? await modelFn(prompt) : await (async () => {
    const { runModel } = await import('../processor/analyze.mjs');
    return runModel(prompt);
  })();
  if (m.ok !== true) return { ok: false, why: `模型未产出：${m.why}`, kind, label: sl.label, fp };

  const doc = { kind, label: sl.label, ask: sl.ask, from: sl.trend.from, to: sl.trend.to, fp, at: new Date().toISOString(), text: m.text, events: sl.events };
  try {
    fs.mkdirSync(narrativeDir(), { recursive: true });
    const tmp = `${narrativeFile(kind)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, narrativeFile(kind));
  } catch (e) { return { ok: false, why: `写入失败：${e.message}`, kind, fp }; }
  return { ok: true, cached: false, kind, label: sl.label, text: m.text, fp };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeEvent } = await import('../schema.mjs');

  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prev = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-cockpit-'));
  process.env.WB_V1_OUT = tmp;
  const NOW = Date.parse('2026-10-12T10:00:00+08:00');
  const D = (s, hh = '09:00') => Date.parse(`${s}T${hh}:00+08:00`);

  try {
    const msg = (mid, raw, ops = []) => { const e = makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw, source: 'im', modality: 'text', summary: raw.slice(0, 20) }, origin: { channel: 'dingtalk', sender: '张伟', messageId: mid }, _at: D('2026-10-10') }).event; e.ops = ops; e.context = { recalled: [{ path: 'Work/示例客户甲/x.md', similarity: 0.66, text: 't' }] }; return store.upsert(e); };
    msg('m1', '待处理的一条');
    msg('m2', '已回复的一条', [{ op: 'replied' }]);
    const td = (mid, topic, due, ops = []) => { const e = makeEvent({ type: 'todo', payload: { topic, detail: 'd', due, executor: '我' }, origin: { channel: 'manual', sender: '我', messageId: mid }, _at: D('2026-10-09') }).event; e.ops = ops; return store.upsert(e); };
    td('t1', '逾期的', '2026-10-09');
    td('t2', '已完成的', '2026-10-12', [{ op: 'done', at: '2026-10-11T10:00:00+08:00' }]);
    const sch = (mid, topic, start, ops = []) => { const e = makeEvent({ type: 'schedule', payload: { topic, start, end: start }, origin: { channel: 'manual', sender: '我', messageId: mid }, _at: D('2026-10-11') }).event; e.ops = ops; return store.upsert(e); };
    sch('s1', '已开完', '2026-10-10T14:00', [{ op: 'done', at: '2026-10-11T08:00:00+08:00' }]);
    sch('s2', '待开', '2026-10-15T14:00');
    const nt = makeEvent({ type: 'note', payload: { topic: 'A', date: '2026-10-05', content_md: 'x', tags: ['采集', '设计'] }, origin: { channel: 'manual', sender: '我', messageId: 'n1' }, _at: D('2026-10-05') }).event;
    nt.analysis = { by: 'model', text: 't', visual: { suggested: 'coordinates', why: 'w' } }; store.upsert(nt);

    const S = stats({ now: NOW });
    chk('CKT-1', '★ 消息：总数/待处理/已处理', S.messages.total === 2 && S.messages.pending === 1 && S.messages.processed === 1, JSON.stringify(S.messages));
    chk('CKT-2', '★ 日程：总数/已进行/待进行', S.schedules.total === 2 && S.schedules.done === 1 && S.schedules.upcoming === 1, JSON.stringify(S.schedules));
    chk('CKT-3', '★ 待办：总数/已完成/逾期/待完成', S.todos.total === 2 && S.todos.done === 1 && S.todos.overdue === 1 && S.todos.open === 0, JSON.stringify(S.todos));
    chk('CKT-4', '★ 笔记：总数 / 标签数 / 可视化模型数（**只算真建出来的**）', S.notes.total === 1 && S.notes.tags === 2 && S.notes.visualModels === 0, JSON.stringify(S.notes));
    // ★ CKT-50/51（P0-2 收口）：这个夹具**故意只给建议、不给 built** ——
    //   收口前 `api/cockpit.mjs` 数的是"`analysis.visual` 存在"，会把这条算成 1 个可视化模型（假绿）。
    //   现在判定统一走 `store.isVisualBuilt`（唯一一份），所以 0 才是如实；建出来之后才变 1。
    //   （编号说明：本文件 CKT-1..22 已占用，故新号段取 50 起，避免撞号。）
    chk('CKT-50', '★ 只有建议、没真建 ⇒ 可视化模型数**不算**它（收口前这里会算成 1）', S.notes.visualModels === 0, `visualModels=${S.notes.visualModels} visual=${JSON.stringify(nt.analysis.visual)}`);
    { const n2 = store.getById('note', nt._id); store.patch('note', n2._id, { analysis: { ...n2.analysis, visual: { ...n2.analysis.visual, built: true, tool: 'coordinates', ref: '/x.json' } } }); }
    chk('CKT-51', '★ 真建出来（built=true）⇒ 才计 1（两处口径同源）', stats({ now: NOW }).notes.visualModels === 1 && store.stats(new Date(NOW)).notes.visualized === 1, JSON.stringify({ cockpit: stats({ now: NOW }).notes.visualModels, storeVisualized: store.stats(new Date(NOW)).notes.visualized }));

    const T = trend({ from: '2026-10-05', to: '2026-10-12', now: NOW });
    chk('CKT-5', '★ 趋势按日切片且区间正确（8 天）', T.days === 8 && T.from === '2026-10-05' && T.to === '2026-10-12', JSON.stringify({ days: T.days, from: T.from, to: T.to }));
    chk('CKT-6', '趋势合计与统计一致（消息 2 条）', T.totals.message === 2, JSON.stringify(T.totals));
    chk('CKT-7', '★ 完成动作按"完成时刻"落桶（不是创建日）', T.series.find((r) => r.date === '2026-10-11')?.todoDone === 1, JSON.stringify(T.series.map((r) => [r.date, r.todoDone])));
    chk('CKT-8', '空日被预置（趋势图不会断）', T.series.length === 8, String(T.series.length));

    const G = graph({ now: NOW });
    chk('CKT-9', '★ 图谱节点含事件与发信人', G.counts.byKind.message === 2 && G.counts.byKind.sender === 1, JSON.stringify(G.counts));
    chk('CKT-10', '★ 召回命中 ⇒ 与知识库文档建边（真实依据）', G.edges.some((e) => e.kind === 'recalled' && e.to.startsWith('doc:')), JSON.stringify(G.edges.filter((e) => e.kind === 'recalled').slice(0, 2)));
    chk('CKT-11', '★ 负向对照：没有依据就不连边（不靠相似度硬凑）', G.edges.every((e) => ['from', 'recalled', 'same-sender'].includes(e.kind)), JSON.stringify([...new Set(G.edges.map((e) => e.kind))]));
    chk('CKT-12', '★ 图谱写明了边的来源口径', /真实依据/.test(G.note));

    const sl = sliceFor('insight', { from: '2026-10-05', to: '2026-10-12', now: NOW });
    chk('CKT-13', '★ 模型三块的输入切片带真实数据（统计+趋势+图谱计数）', sl.stats.messages.total === 2 && sl.trend.totals.note === 1 && typeof sl.graphCounts.nodes === 'number');
    chk('CKT-14', '★ 有数据才允许调模型（没数据不生成分析）', hasEnoughData(sl) === true && hasEnoughData({ events: { message: 0, note: 0, todo: 0, schedule: 0 } }) === false);
    chk('CKT-15', '三块的标签与提问各不相同', sliceFor('insight').label === '业务洞察' && sliceFor('state').label === '状态分析' && sliceFor('advice').label === '发展建议' && sliceFor('insight').ask !== sliceFor('advice').ask);

    // 模型三块：生成 / 幂等 / 拒绝
    const stubModel = async () => ({ ok: true, text: '判断：推进中\n理由：有真实事件\n下一步：继续' });
    const n1 = await narrative('state', { from: '2026-10-05', to: '2026-10-12', now: NOW, modelFn: stubModel });
    chk('CKT-16', '★ 有数据 ⇒ 生成并落盘一块', n1.ok === true && n1.cached === false && fs.existsSync(narrativeFile('state')), JSON.stringify({ ok: n1.ok, fp: n1.fp }));
    chk('CKT-17', '落盘内容含输入指纹与区间（可复算）', (() => { const d = readNarrative('state'); return !!d && d.fp === n1.fp && d.from === '2026-10-05'; })());
    const n2 = await narrative('state', { from: '2026-10-05', to: '2026-10-12', now: NOW, modelFn: async () => ({ ok: true, text: '不该被调用' }) });
    chk('CKT-18', '★ 幂等：输入没变 ⇒ 用缓存，不重复调模型', n2.cached === true && n2.text === '判断：推进中\n理由：有真实事件\n下一步：继续', JSON.stringify({ cached: n2.cached }));
    const n3 = await narrative('state', { from: '2026-10-05', to: '2026-10-12', now: NOW, modelFn: async () => ({ ok: true, text: '强制重生成' }), force: true });
    chk('CKT-19', 'force 可强制重生成', n3.cached === false && n3.text === '强制重生成');
    const n4 = await narrative('advice', { from: '2020-01-01', to: '2020-01-02', now: NOW, modelFn: async () => { throw new Error('不该被调用'); } });
    chk('CKT-20', '★ 没数据 ⇒ 直接拒绝（模型根本不会被调用）', n4.ok === false && n4.refused === true && /不调用模型/.test(n4.why), JSON.stringify(n4));
    const n5 = await narrative('insight', { from: '2026-10-05', to: '2026-10-12', now: NOW, modelFn: async () => ({ ok: false, why: '模型超时' }) });
    chk('CKT-21', '★ 模型失败 ⇒ 不落盘（页面仍是"尚未生成"，不留空壳）', n5.ok === false && !fs.existsSync(narrativeFile('insight')));
    chk('CKT-22', '未生成的那块读出来是 null（页面据此显示尚未生成）', readNarrative('insight') === null && readNarrative('state') !== null);
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
