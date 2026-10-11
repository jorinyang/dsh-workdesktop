/**
 * v1/processor/close.mjs —— **自动关闭条件**（P5 处理引擎第一块）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求原文（照抄，别改口径）
 *   · 日程（3.3.5）："日程的标注完成条件有三种：**第一种**，当前时间已经超过日程截止时间的当天二十四点后；
 *     **第二种**，钉钉中存在当前日程的 AI 听记；**第三种**，手动标记已完成。"
 *   · 待办（3.3.4）："只要在知识库或对应沟通工具的上下文中，已经交付了待办相关的结果性物料，
 *     并完成了既定动作，则视为待办已完成；检测的节点就放在**创建待办的时候**，
 *     以及在做**每日知识库沉淀**的时候。"
 *
 * 三条纪律
 *   ① **只标完成、不删数据**：关闭 = 追加一条带原因的 op（`done` + reason + 依据），事件本体保留；
 *   ② **幂等**：已完成的跳过，重复跑不会追加第二条 done；
 *   ③ **证据要能复核**：每条自动关闭都把"依据"写进 op（哪条消息、哪场听记、什么时刻），
 *      否则事后无法回答"它凭什么算完成" —— 这正是旧世界最容易糊过去的地方。
 *
 * 手动那条（第三种）已由 `api/server.mjs` 的动作路径实现，这里只管自动的两条 + 待办证据。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import * as store from '../store.mjs';

const DAY = 86400000;
export const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const isDone = (evt) => (evt.ops ?? []).some((o) => String(o.op ?? '') === 'done');
const text = (s) => String(s ?? '');

/** 完成类词（出现其一才算"结果性物料"） */
export const DONE_HINTS = Object.freeze(['已完成', '完成了', '已发', '发了', '已交付', '交付了', '上传了', '已上传', '已提交', '提交了', '搞定了', '已处理', '已回复', 'done']);

/** 关键词切分（中文按 2-gram + 英文/数字整词，够用且不做分词依赖） */
export function keywords(s, min = 2) {
  const t = text(s).replace(/[\s\p{P}]+/gu, '');
  const out = new Set();
  const latin = text(s).match(/[A-Za-z0-9_]{3,}/g) ?? [];
  for (const w of latin) out.add(w.toLowerCase());
  for (let i = 0; i + min <= t.length; i++) out.add(t.slice(i, i + min));
  return [...out];
}

/** 两条文本的相关度（共同 2-gram 占比，0–1） */
export function overlap(a, b) {
  const A = new Set(keywords(a)); const B = new Set(keywords(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const k of A) if (B.has(k)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

/**
 * 日程自动完成：条件① 过当天 24 点 · 条件② 存在该日程的 AI 听记
 * @param {{now?:number, minutes?:Array<{title:string,at:number}>, minOverlap?:number, dryRun?:boolean}} o
 */
export function autoCloseSchedules({ now = Date.now(), minutes = [], minOverlap = 0.35, dryRun = false } = {}) {
  const rows = store.list({ type: 'schedule' });
  const closed = []; const skipped = []; const errors = [];
  for (const evt of rows) {
    if (isDone(evt)) { skipped.push({ id: evt._id, why: '已完成' }); continue; }
    const start = Date.parse(text(evt.payload?.start));
    if (!Number.isFinite(start)) { errors.push(`${evt._id} 开始时间不可解析：${evt.payload?.start}`); continue; }

    // ② 先判听记（更强的证据）：同一天 + 标题相关度够
    const hit = minutes.find((m) => Number.isFinite(m.at) && dayStart(m.at) === dayStart(start) && overlap(m.title, evt.payload?.topic) >= minOverlap);
    if (hit) {
      const op = { op: 'done', by: 'auto', reason: 'has-minutes', evidence: { minutesTitle: hit.title, minutesAt: new Date(hit.at).toISOString(), overlap: Math.round(overlap(hit.title, evt.payload?.topic) * 100) / 100 } };
      if (!dryRun) store.patch('schedule', evt._id, {}, op);
      closed.push({ id: evt._id, reason: 'has-minutes', evidence: op.evidence });
      continue;
    }
    // ① 过当天 24 点
    const deadline = dayStart(start) + DAY;
    if (now >= deadline) {
      const op = { op: 'done', by: 'auto', reason: 'past-midnight', evidence: { start: evt.payload?.start, deadline: new Date(deadline).toISOString(), now: new Date(now).toISOString() } };
      if (!dryRun) store.patch('schedule', evt._id, {}, op);
      closed.push({ id: evt._id, reason: 'past-midnight', evidence: op.evidence });
      continue;
    }
    skipped.push({ id: evt._id, why: '未到期且无听记' });
  }
  return { inCount: rows.length, closed, skipped, errors };
}

/**
 * 待办证据检测（需求 3.3.4）：当天新增信息里出现"主题相关 + 完成类词"即视为交付证据
 * @param {{now?:number, messages?:Array, minOverlap?:number, dryRun?:boolean}} o
 */
export function autoCloseTodos({ now = Date.now(), messages = null, minOverlap = 0.4, dryRun = false } = {}) {
  const todos = store.list({ type: 'todo' }).filter((e) => !isDone(e) && e.lifecycle !== 'archived');
  const msgs = messages ?? store.list({ type: 'message' });
  const closed = []; const skipped = []; const errors = [];
  for (const td of todos) {
    const topic = text(td.payload?.topic);
    if (topic === '') { errors.push(`${td._id} 没有主题 ⇒ 无法判证据`); continue; }
    const ev = msgs.find((m) => {
      const raw = text(m.payload?.raw);
      if (!DONE_HINTS.some((h) => raw.includes(h))) return false;
      return overlap(topic, raw) >= minOverlap;
    });
    if (!ev) { skipped.push({ id: td._id, why: '暂无交付证据' }); continue; }
    const op = { op: 'done', by: 'auto', reason: 'evidence', evidence: { messageId: ev.origin?.messageId ?? ev._id, sender: ev.payload?.sender ?? null, overlap: Math.round(overlap(topic, text(ev.payload?.raw)) * 100) / 100, excerpt: text(ev.payload?.raw).slice(0, 80) } };
    if (!dryRun) store.patch('todo', td._id, {}, op);
    closed.push({ id: td._id, reason: 'evidence', evidence: op.evidence });
  }
  return { inCount: todos.length, closed, skipped, errors };
}

/** 一轮自动关闭（供每日沉淀 / 定时任务调用） */
export function autoCloseOnce({ now = Date.now(), minutes = [], dryRun = false } = {}) {
  const s = autoCloseSchedules({ now, minutes, dryRun });
  const t = autoCloseTodos({ now, dryRun });
  return {
    schedules: { in: s.inCount, closed: s.closed.length, errors: s.errors, detail: s.closed },
    todos: { in: t.inCount, closed: t.closed.length, errors: t.errors, detail: t.closed },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（夹具 + 临时运行态）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeEvent } = await import('../schema.mjs');

  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prev = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-close-'));
  process.env.WB_V1_OUT = tmp;
  const NOW = Date.parse('2026-10-12T10:00:00+08:00');
  const D = (s, hh = '09:00') => `${s}T${hh}`;

  try {
    // ★ 夹具注意：事件 id 是工厂生成的（`sche_xxx`），不是来源 messageId（`s-old`）。
    //   第一版这里传错了 id ⇒ getById 返回 null ⇒ 断言炸。把生成的 id 记下来再取。
    const ids = {};
    const sch = (mid, topic, start) => { const e = makeEvent({ type: 'schedule', payload: { topic, start, end: start, place: '线上' }, origin: { channel: 'manual', sender: '我', messageId: mid }, _at: Date.parse(D('2026-10-12')) }).event; ids[mid] = e._id; return store.upsert(e); };
    sch('s-old', '上周的项目评审会', D('2026-10-05', '14:00'));           // ① 过当天 24 点 ⇒ 自动完成
    sch('s-today-late', '今天的晚会', D('2026-10-12', '20:00'));           // 未到 24 点 ⇒ 不关
    sch('s-min', '示例客户甲智慧仓库上线计划', D('2026-10-12', '14:00'));    // ② 有听记 ⇒ 自动完成

    const minutes = [{ title: '10-12 示例客户甲智慧仓库上线计划评审', at: Date.parse(D('2026-10-12', '15:00')) }];
    const r1 = autoCloseSchedules({ now: NOW, minutes });
    const byId = (mid) => store.getById('schedule', ids[mid]);
    chk('CLS-1', '★ 条件①过当天24点 ⇒ 自动完成', isDone(byId('s-old')), JSON.stringify(r1.closed.find((x) => x.reason === 'past-midnight')));
    chk('CLS-2', '★ 条件②有 AI 听记 ⇒ 自动完成（且优先于条件①判定）', isDone(byId('s-min')) && r1.closed.find((x) => x.reason === 'has-minutes'), JSON.stringify(r1.closed.find((x) => x.reason === 'has-minutes')));
    chk('CLS-3', '★ 未到 24 点且无听记 ⇒ 不关（不误杀）', !isDone(byId('s-today-late')), JSON.stringify(r1.skipped));
    chk('CLS-4', '★ 每条自动关闭都带可复核依据（时间/听记/相关度）', (() => { const op = (byId('s-min').ops ?? []).find((o) => o.op === 'done'); return op && op.by === 'auto' && op.reason === 'has-minutes' && op.evidence && op.evidence.minutesTitle; })());
    const r2 = autoCloseSchedules({ now: NOW, minutes });
    chk('CLS-5', '★ 幂等：再跑一轮不追加第二条 done', (byId('s-min').ops ?? []).filter((o) => o.op === 'done').length === 1 && r2.closed.length === 0, String(r2.closed.length));

    const todo = (mid, topic) => store.upsert(makeEvent({ type: 'todo', payload: { topic, detail: '细节', due: '2026-10-12', executor: '我' }, origin: { channel: 'manual', sender: '我', messageId: mid }, _at: NOW }).event);
    todo('t-ev', '把验收单发给张伟');
    todo('t-noev', '整理明年的预算表');
    const mkMsg = (mid, sender, raw) => store.upsert(makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender, raw, source: 'im', modality: 'text', summary: raw.slice(0, 30) }, origin: { channel: 'dingtalk', sender, messageId: mid }, _at: NOW }).event);
    mkMsg('m-ev', '我', '验收单我已经发给张伟了，已完成');
    mkMsg('m-noise', '李强', '这个预算表格式我不太喜欢');   // 有主题相关但没有完成类词

    const r3 = autoCloseTodos({ now: NOW });
    const tdEv = store.list({ type: 'todo' }).find((e) => e.payload.topic === '把验收单发给张伟');
    const tdNo = store.list({ type: 'todo' }).find((e) => e.payload.topic === '整理明年的预算表');
    chk('CLS-6', '★ 有交付证据（主题相关 + 完成类词）⇒ 自动完成', isDone(tdEv), JSON.stringify(r3.closed));
    chk('CLS-7', '★ 只有主题相关、没有完成类词 ⇒ 不算证据（不误杀）', !isDone(tdNo), JSON.stringify(r3.skipped));
    chk('CLS-8', '★ 证据里写明是哪条消息（可回查）', (() => { const op = (tdEv.ops ?? []).find((o) => o.op === 'done'); return op?.evidence?.messageId === 'm-ev' && typeof op.evidence.excerpt === 'string'; })());
    chk('CLS-9', '相关度：同主题高、无关低', overlap('把验收单发给张伟', '验收单我已经发给张伟了，已完成') >= 0.4 && overlap('把验收单发给张伟', '今天天气不错') < 0.2, `${overlap('把验收单发给张伟', '验收单我已经发给张伟了，已完成')} / ${overlap('把验收单发给张伟', '今天天气不错')}`);
    chk('CLS-10', '★ 负向对照：待办没主题 ⇒ 报错而不是瞎关', (() => { const bad = makeEvent({ type: 'todo', payload: { topic: '', detail: 'x' }, origin: { channel: 'manual', sender: '我', messageId: 't-bad' }, _at: NOW }); return bad.ok === false; })());
    const g = autoCloseOnce({ now: NOW, minutes, dryRun: true });
    chk('CLS-11', '干跑不写盘（本轮无新关闭）', g.schedules.closed === 0 && g.todos.closed === 0);
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
