/**
 * v1/store.mjs —— 工作台 v1.0 **运行态存储层**（P0-3）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 两层存储的分工（总体规划 §4.3）
 *   · **运行态（本文件）** = `_meta/out/v1/<type>s.json` —— 前端读写、引擎流转。
 *     不进向量库（现状即排除 `_meta/out/`），所以可以随时重建。
 *   · **库存（后续 P2/P5 落）** = 知识库正式目录里的 JSON 台账 + MD 摘要 —— 人读 + 向量化 + 驾驶舱。
 *   ⇒ 前端永远读运行态；引擎写运行态**并**写库存（双写，Q8）。
 *
 * 纪律
 *   · **原子写**：先写 `<file>.tmp-<pid>` 再 rename —— 中途崩了不会留下半截 JSON。
 *   · **幂等**：`upsert` 按 `originKey` 去重（同一条消息重复投递只有一条事件）。
 *     撞键时只更新"内容类"字段（payload/context/analysis），**不动 lifecycle/ops** ——
 *     否则重采一次会把"已处理"打回"待处理"。
 *   · **不改真相**：本层不做字段校验的"兜底补值"；非法事件在 schema 层就被拒。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { TYPES, TYPE_LABELS, SCHEMA_VERSION, validateEvent, originKey, LIFECYCLE, makeEvent, transition } from './schema.mjs';
import { KB_ROOT as ROOT } from './paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * ★ **"可视化模型数"的唯一判定**（2026-10-12 收口，P0-2）。
 *
 * 为什么要有这个函数，而不是各处写 `e.analysis?.visual`：
 *   收口前有两处**算法不同**的统计 ——
 *     · 本文件（store.mjs）统计的是 `analysis.visual.built === true`（**真建出来的**）；
 *     · `api/cockpit.mjs` 统计的是 `analysis.visual` **存在**（**只是给了建议的**）。
 *   同一个数（驾驶舱"笔记数 / 可视化模型数"）在两处口径不一致 ⇒ 页面上的数会骗人：
 *   一条只被建议、从没建过的笔记，也被算成"可视化模型"。
 *   ⇒ 现在**只有这一份判定**，两处都 import 它。要改口径只改这里（改一处、只有一个真相）。
 */
export const isVisualBuilt = (e) => e?.analysis?.visual?.built === true;

export function storeDir() {
  return process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1');
}
export function storePath(type) {
  return path.join(storeDir(), `${type}s.json`);   // message→messages, note→notes, ...
}

const EMPTY = (type) => ({ schema: SCHEMA_VERSION, type, updatedAt: new Date().toISOString(), events: [] });

export function loadType(type) {
  if (!TYPES.includes(type)) throw new Error(`未知类型 ${JSON.stringify(type)}`);
  const p = storePath(type);
  if (!fs.existsSync(p)) return EMPTY(type);
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!d || !Array.isArray(d.events)) return EMPTY(type);
    return { ...EMPTY(type), ...d, events: d.events };
  } catch (e) {
    // **不静默重建**：文件坏了要让人知道（改名留档，返回空壳，由上层决定是否报错）
    const bak = `${p}.corrupt-${Date.now()}`;
    try { fs.renameSync(p, bak); } catch { /* noop */ }
    console.error(`⚠️ ${type}s.json 解析失败（已留档 ${path.basename(bak)}）：${e.message}`);
    return EMPTY(type);
  }
}

export function saveType(type, doc) {
  const p = storePath(type);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = { ...doc, schema: SCHEMA_VERSION, type, updatedAt: new Date().toISOString() };
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);            // 原子落盘
  return body;
}

/**
 * 写入/更新一条事件（幂等）。
 * @returns {{action:'added'|'updated'|'rejected', reason?:string, _id?:string}}
 */
export function upsert(evt) {
  const errors = validateEvent(evt);
  if (errors.length) return { action: 'rejected', reason: errors.join('；') };
  const doc = loadType(evt.type);
  const key = originKey(evt);
  const idx = doc.events.findIndex((e) => originKey(e) === key);
  if (idx === -1) {
    doc.events.push(evt);
    saveType(evt.type, doc);
    return { action: 'added', _id: evt._id };
  }
  const prev = doc.events[idx];
  doc.events[idx] = {
    ...prev,
    payload: evt.payload,                                   // 内容可被新采集覆盖（源更新了）
    context: evt.context ?? prev.context,
    analysis: evt.analysis ?? prev.analysis,
    deliverables: evt.deliverables?.length ? evt.deliverables : prev.deliverables,
    // lifecycle / ops / closedBy / archiveRef 一律保留 —— 不许把"已处理"打回"待处理"
  };
  saveType(evt.type, doc);
  return { action: 'updated', _id: prev._id };
}

/** 打补丁（处理引擎用）：只改允许的字段，并追加一条 ops 留痕 */
const PATCHABLE = ['payload', 'context', 'analysis', 'deliverables', 'closedBy', 'archiveRef'];
export function patch(type, id, changes, op = null) {
  const doc = loadType(type);
  const idx = doc.events.findIndex((e) => e._id === id);
  if (idx === -1) return { ok: false, why: `找不到事件 ${id}（${type}）` };
  const evt = doc.events[idx];
  for (const k of Object.keys(changes)) {
    if (!PATCHABLE.includes(k)) return { ok: false, why: `字段 ${k} 不允许直接打补丁（lifecycle 请走 schema.transition）` };
  }
  doc.events[idx] = { ...evt, ...changes };
  if (op) doc.events[idx].ops = [...(doc.events[idx].ops ?? []), { at: Date.now(), ...op }];
  saveType(type, doc);
  return { ok: true, event: doc.events[idx] };
}

export function getById(type, id) {
  return loadType(type).events.find((e) => e._id === id) ?? null;
}

export function list({ type, lifecycle = null, limit = 0, since = null } = {}) {
  let rows = loadType(type).events;
  if (lifecycle) rows = rows.filter((e) => e.lifecycle === lifecycle);
  if (since) rows = rows.filter((e) => e._at >= since);
  rows = [...rows].sort((a, b) => b._at - a._at);      // 新的在前
  return limit > 0 ? rows.slice(0, limit) : rows;
}

// ── 日期工具（统计用；全部按本地日期，不做时区换算） ─────────────────────────
const pad = (n) => String(n).padStart(2, '0');
export const dayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function shiftDay(n, base = new Date()) { const d = new Date(base); d.setDate(d.getDate() + n); return dayStr(d); }
const dayOf = (v) => (typeof v === 'string' ? v.slice(0, 10) : '');

/**
 * 前端统计（需求 3.3.2–3.3.6 的每个数字都从这里取，**不在页面上另算一遍**）
 *   messages : total / pending / toTodo / toSchedule / replied   （3.3.3）
 *   todos    : today / thisWeek / undated / done                 （3.3.4）
 *   schedules: today / next7 / done30d                           （3.3.5）
 *   notes    : total / thisMonth / tags                          （3.3.6）
 *   overview : 四项关键数字 + 三类提醒                            （3.3.2）
 */
export function stats(now = new Date()) {
  const today = dayStr(now);
  const weekEnd = shiftDay(7, now);
  const month = today.slice(0, 7);
  const d30ago = shiftDay(-30, now);

  const msgs = list({ type: 'message' });
  const todos = list({ type: 'todo' });
  const scheds = list({ type: 'schedule' });
  const notes = list({ type: 'note' });

  const isClosed = (e) => e.lifecycle === 'verified' || e.lifecycle === 'archived';
  const hasOp = (e, op) => (e.ops ?? []).some((o) => String(o.op ?? '').startsWith(op));

  const messages = {
    total: msgs.length,
    pending: msgs.filter((e) => !isClosed(e)).length,
    toTodo: msgs.filter((e) => hasOp(e, 'to-todo')).length,
    toSchedule: msgs.filter((e) => hasOp(e, 'to-schedule')).length,
    replied: msgs.filter((e) => hasOp(e, 'replied')).length,
  };

  const openTodos = todos.filter((e) => !isClosed(e));
  const todosStat = {
    total: todos.length,
    today: openTodos.filter((e) => e.payload?.due && dayOf(e.payload.due) === today).length,
    thisWeek: openTodos.filter((e) => { const d = dayOf(e.payload?.due); return d && d > today && d <= weekEnd; }).length,
    undated: openTodos.filter((e) => !e.payload?.due).length,
    done: todos.filter(isClosed).length,
    overdue: openTodos.filter((e) => { const d = dayOf(e.payload?.due); return d && d < today; }).length,
  };

  const schedules = {
    total: scheds.length,
    today: scheds.filter((e) => dayOf(e.payload?.start) === today).length,
    next7: scheds.filter((e) => { const d = dayOf(e.payload?.start); return d >= today && d <= weekEnd; }).length,
    done30d: scheds.filter((e) => isClosed(e) && dayOf(e.payload?.start) >= d30ago).length,
    upcoming: scheds.filter((e) => dayOf(e.payload?.start) > today).length,
  };

  const tagSet = new Set();
  for (const n of notes) for (const t of (n.payload?.tags ?? [])) tagSet.add(t);

  const notesStat = {
    total: notes.length,
    thisMonth: notes.filter((e) => dayOf(e.payload?.date) .startsWith(month)).length,
    tags: tagSet.size,
    visualized: notes.filter(isVisualBuilt).length,
  };

  return {
    at: now.toISOString(),
    messages, todos: todosStat, schedules, notes: notesStat,
    lifecycle: Object.fromEntries(LIFECYCLE.map((k) => [k, [msgs, todos, scheds, notes].reduce((a, arr) => a + arr.filter((e) => e.lifecycle === k).length, 0)])),
  };
}

/** 三类提醒（需求 3.3.2：重要日程/行程、逾期/临期任务、长期未回复信息） */
export function reminders({ now = new Date(), urgentScheduleDays = 2, dueSoonDays = 3, staleReplyDays = 3 } = {}) {
  const today = dayStr(now);
  const schedEnd = shiftDay(urgentScheduleDays, now);
  const dueEnd = shiftDay(dueSoonDays, now);
  const staleBefore = shiftDay(-staleReplyDays, now);

  const urgent = list({ type: 'schedule' })
    .filter((e) => e.lifecycle !== 'archived' && dayOf(e.payload?.start) >= today && dayOf(e.payload?.start) <= schedEnd)
    .map((e) => ({ _id: e._id, title: e.payload.topic, at: e.payload.start, kind: 'schedule' }));

  const tasks = list({ type: 'todo' })
    .filter((e) => e.lifecycle === 'open' || e.lifecycle === 'processed')
    .map((e) => ({ e, d: dayOf(e.payload?.due) }))
    .filter(({ d }) => d && d <= dueEnd)
    .map(({ e, d }) => ({ _id: e._id, title: e.payload.topic, at: e.payload.due, overdue: d < today, kind: 'todo' }));

  const stale = list({ type: 'message' })
    .filter((e) => e.lifecycle === 'open' && dayOf(e.origin?.at ?? new Date(e._at).toISOString()) <= staleBefore)
    .map((e) => ({ _id: e._id, title: e.payload?.summary || String(e.payload?.raw ?? '').slice(0, 40), at: new Date(e._at).toISOString().slice(0, 10), kind: 'message' }));

  return { urgent, tasks, stale };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（用临时目录，不碰真实运行态）
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prev = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-selftest-'));
  process.env.WB_V1_OUT = tmp;
  try {
    const mk = (over = {}) => makeEvent({
      type: 'message',
      payload: { channel: 'dingtalk', sender: '张伟', raw: '明天对一下验收', ...(over.payload ?? {}) },
      origin: { channel: 'dingtalk', sender: '张伟', messageId: over.mid ?? 'mid_1' },
      _at: over._at ?? 1730000000000,
    }).event;

    // ① 写入 + 读回
    const a = upsert(mk());
    chk('STO-1', '首次写入 ⇒ added', a.action === 'added', JSON.stringify(a));
    chk('STO-2', '读回条数 = 1', list({ type: 'message' }).length === 1);

    // ② 幂等：同 messageId 再写一次 ⇒ 不新增
    const b = upsert(mk({ payload: { raw: '明天对一下验收（更新）' } }));
    chk('STO-3', '同 messageId 重复写入 ⇒ updated 而非 added', b.action === 'updated', JSON.stringify(b));
    chk('STO-4', '去重后条数仍为 1', list({ type: 'message' }).length === 1);

    // ③ 已处理不许被打回（重采不得覆盖 lifecycle）
    const doc = loadType('message');
    const ev = doc.events[0];
    transition(ev, 'processed', { op: 'manual' });
    saveType('message', doc);
    upsert(mk({ payload: { raw: '第三次采集' } }));
    const after = loadType('message').events[0];
    chk('STO-5', '重采后 lifecycle 仍为 processed（不回退）', after.lifecycle === 'processed', after.lifecycle);
    chk('STO-6', '重采后 payload 已更新（内容以最新为准）', after.payload.raw === '第三次采集', after.payload.raw);

    // ④ 非法事件必须被拒（不在存储层兜底）
    const badRes = upsert({ _id: 'msg_x', _at: 1, type: 'message', lifecycle: 'open', origin: { channel: 'dingtalk', sender: 'X' }, payload: { channel: 'dingtalk', sender: 'X' } });
    chk('STO-7', '非法事件 ⇒ rejected（不写盘）', badRes.action === 'rejected', badRes.reason);

    // ⑤ 原子写：目录里不该留下 tmp 文件
    const leftovers = fs.readdirSync(tmp).filter((f) => f.includes('.tmp-'));
    chk('STO-8', '无残留 .tmp 文件（原子写生效）', leftovers.length === 0, leftovers.join(','));

    // ⑥ 统计口径可复算：造 1 条已完成待办 + 1 条今日日程
    const t = makeEvent({ type: 'todo', payload: { topic: '补报表', detail: '补齐发出', due: dayStr() }, origin: { channel: 'manual', sender: 'me', messageId: 't1' } }).event;
    t.lifecycle = 'verified';
    upsert(t);
    const s = makeEvent({ type: 'schedule', payload: { topic: '验收会', start: `${dayStr()}T15:00`, end: `${dayStr()}T16:00` }, origin: { channel: 'manual', sender: 'me', messageId: 's1' } }).event;
    upsert(s);
    const st = stats();
    chk('STO-9', 'stats.todos.done 计入已验证待办', st.todos.done === 1, JSON.stringify(st.todos));
    chk('STO-10', 'stats.schedules.today 计入今日日程', st.schedules.today === 1, JSON.stringify(st.schedules));

    // ⑦ patch 白名单：不许直接改 lifecycle
    const pr = patch('todo', t._id, { lifecycle: 'archived' });
    chk('STO-11', 'patch 拒绝直接改 lifecycle（必须走 transition）', pr.ok === false, pr.why);
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
