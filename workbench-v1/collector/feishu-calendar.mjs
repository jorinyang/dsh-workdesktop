/**
 * v1/collector/feishu-calendar.mjs —— 飞书 · 日程（登记表 `fs-calendar`）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 3.1.5：「日程结构化拆解：主题 / 详情 / 起止时间 / 地点 / 参与人」
 * 需求 2.2：CLI 类功能走**每 5 分钟轮询**、**幂等**。
 *
 * 实测依据（2026-10-12，不是猜的）：
 *   · `lark-cli calendar +agenda --start ISO --end ISO` ⇒ `{ok:true, identity, data:[…]}`
 *     每条含 `event_id / summary / start_time{datetime,timezone} / end_time{…} / description /
 *     event_organizer{display_name} / self_rsvp_status / free_busy_status / app_link / vchat`
 *     —— **飞书这条有 `description`（详情）**，钉钉那条没有。
 *   · `lark-cli calendar +get --calendar-id … --event-id …`：**不带参会人**。
 *   · 参会人要走 `lark-cli calendar event.attendees list --calendar-id … --event-id …`
 *     ⇒ `{ok:true, data:{items:[…], has_more, page_token}}`；实测手上那条**本来就是 0 位参会人**
 *     （返回空数组，不是报错）⇒ 没参会人就**不填**，不编。
 *   · 该版本（1.0.84）**没有** `calendar attendee` 子命令（我先前看到的那份清单其实是钉钉 CLI 的）。
 *
 * 字段按登记契约（`schema.mjs` PAYLOAD_SPEC.schedule）：必填 `topic/start/end`；
 * 可选 `detail/place/participants/type/source`；时间只收**本地** `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`。
 * 幂等键 = `fs-cal-<event_id>`。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { v1Out } from '../paths.mjs';
import { inScope } from './registry.mjs';

export const KEY = 'fs-calendar';
export const INTERVAL_SEC = 300;
const DAY = 86400000;

const pad = (n) => String(n).padStart(2, '0');

/** 飞书的时间对象 → **本地** `YYYY-MM-DDTHH:mm`（全天给 `YYYY-MM-DD`） */
export function toLocalWhen(t) {
  if (!t) return null;
  if (typeof t.date === 'string' && t.date) return t.date;
  if (typeof t.datetime === 'string' && t.datetime) {
    const ms = Date.parse(t.datetime);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return null;
}

export function stateFile() { return path.join(v1Out(), 'fs-calendar-seen.json'); }
export function loadSeen() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveSeen(doc) {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

/** 默认取数：经 PowerShell 调 `lark-cli`（Windows 上它是 .cmd 垫片，直接 spawn 会 ENOENT —— 与钉钉同理） */
export function defaultRun(args) {
  const PS = 'powershell.exe';
  const cmd = 'lark-cli ' + args.map((a) => {
    const s = String(a);
    return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
  }).join(' ');
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `lark-cli 退出码 ${r.status}：${(err || out).slice(0, 200)}` };
  try {
    const j = JSON.parse(out);
    if (j && j.ok === false) {
      const m = j.error?.message ?? '未知错误';
      return { ok: false, why: `lark-cli 报错：${String(m).slice(0, 200)}` };
    }
    return { ok: true, json: j };
  } catch (e) { return { ok: false, why: `输出不是 JSON：${e.message}（前 120 字：${out.slice(0, 120)}）` }; }
}

/** 取时间窗内的日程 */
export function fetchAgenda({ start, end, run = defaultRun } = {}) {
  const args = ['calendar', '+agenda'];
  if (start) args.push('--start', start);
  if (end) args.push('--end', end);
  const r = run(args);
  if (r.ok !== true) return { ok: false, why: r.why };
  const data = r.json?.data;
  if (!Array.isArray(data)) return { ok: false, why: '返回里没有 data 数组' };
  return { ok: true, count: data.length, events: data };
}

/** 取参会人（`--calendar-id` 实测用 `primary` 即可；返回空数组是正常情况，不是错误） */
export function fetchAttendees({ calendarId = 'primary', eventId, run = defaultRun } = {}) {
  // ★ 子命令必须拆成**两个词**传：`event.attendees list` 若作为一个整串，会被取数层的引号包起来
  //   （因为它含空格）⇒ CLI 收到 `"event.attendees list"` 当成一个未知子命令，报 validation 错。
  //   实测：手敲 `lark-cli calendar event.attendees list --calendar-id primary …` 成功，
  //   而经包装层传整串必失败（真跑时两条日程的参会人都取不到，就是这么来的）。
  const r = run(['calendar', 'event.attendees', 'list', '--calendar-id', String(calendarId), '--event-id', String(eventId)]);
  if (r.ok !== true) return { ok: false, why: r.why };
  const items = r.json?.data?.items;
  if (!Array.isArray(items)) return { ok: false, why: '返回里没有 data.items 数组' };
  const names = items.map((a) => String(a?.display_name ?? a?.displayName ?? '').trim()).filter(Boolean);
  return { ok: true, participants: names, count: items.length };
}

/** 日程 → v1 事件（需求 3.1.5 各项） */
export function mapEvent(ev, participants = []) {
  const errs = [];
  const topic = String(ev?.summary ?? '').trim();
  if (!topic) errs.push('缺主题（summary）');
  const eventId = String(ev?.event_id ?? '').trim();
  if (!eventId) errs.push('缺 event_id（幂等键要用）');
  const start = toLocalWhen(ev?.start_time);
  const end = toLocalWhen(ev?.end_time);
  if (!start) errs.push(`开始时间无法解析：${JSON.stringify(ev?.start_time)}`);
  if (!end) errs.push(`结束时间无法解析：${JSON.stringify(ev?.end_time)}`);
  if (errs.length) return { ok: false, errors: errs };

  const desc = String(ev?.description ?? '').trim();
  const payload = {
    topic,
    start,
    end,
    detail: desc || undefined,                                        // 飞书这条有详情（钉钉没有）
    participants: Array.isArray(participants) && participants.length ? participants : undefined,
    type: String(ev?.self_rsvp_status ?? '').trim() || undefined,     // 登记契约允许 type；这里放"我的回复状态"
    source: 'feishu-calendar',
  };
  // `place`：agenda 不给地点（有 `vchat.meeting_url` 但那不是地点）⇒ **不填**，不编
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

  const at = Date.parse(ev?.start_time?.datetime ?? '') || Date.parse(ev?.start_time?.date ?? '') || Date.now();
  return {
    ok: true,
    payload,
    origin: { channel: 'feishu', sender: '飞书日程', messageId: `fs-cal-${eventId}`, raw: topic },
    _at: at,
  };
}

/** 跑一轮：窗口 = 前 30 天 ~ 后 7 天（与日程页展示口径一致） */
export function ingestOnce({ run = defaultRun, dryRun = false, now = Date.now(), maxNew = 200, backDays = 30, fwdDays = 7 } = {}) {
  const errors = [];
  let inCount = 0; let outCount = 0; let refreshed = 0; let skipped = 0; let outOfScope = 0; let quarantined = 0; let attendeeFetches = 0;

  const iso = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00+08:00`;
  };
  const startIso = iso(now - backDays * DAY);
  const endIso = iso(now + fwdDays * DAY);

  const ag = fetchAgenda({ start: startIso, end: endIso, run });
  if (ag.ok !== true) return { inCount: 0, outCount: 0, refreshed: 0, skipped: 0, outOfScope: 0, quarantined: 0, attendeeFetches: 0, errors: [ag.why], dataAsOf: null, why: `日程列表取不到：${ag.why}` };

  const seen = loadSeen();
  const existing = new Map(store.list({ type: 'schedule' }).map((e) => [e.origin?.messageId, e]));

  for (const ev of ag.events) {
    inCount += 1;
    const eventId = String(ev?.event_id ?? '');
    if (!eventId) { quarantined += 1; errors.push('列表里有一条没有 event_id，跳过（不猜）'); continue; }
    const mid = `fs-cal-${eventId}`;
    const fingerprint = `${ev.summary}|${ev.start_time?.datetime ?? ev.start_time?.date}|${ev.end_time?.datetime ?? ev.end_time?.date}`;
    const prev = seen[eventId];
    const have = existing.get(mid);
    const needDetail = !prev || prev.fp !== fingerprint || (!have && !prev?.outOfScope);

    let participants = prev?.participants ?? [];
    if (needDetail) {
      if (dryRun) { outCount += 1; continue; }
      if (outCount >= maxNew) { errors.push(`达到上限 ${maxNew} 条，其余下一轮再来`); break; }
      const got = fetchAttendees({ eventId, run });
      attendeeFetches += 1;
      if (got.ok === true) participants = got.participants;
      else errors.push(`日程 ${eventId} 参会人取不到：${got.why}（其余照采，不因参会人失败丢掉整条）`);
    } else { skipped += 1; continue; }

    const mapped = mapEvent(ev, participants);
    if (mapped.ok !== true) { quarantined += 1; errors.push(`日程 ${eventId} 映射失败：${mapped.errors.join('；')}`); continue; }
    const scope = inScope('schedule', mapped.payload, mapped._at);
    if (!scope.inScope) {
      skipped += 1; outOfScope += 1;
      seen[eventId] = { fp: fingerprint, outOfScope: true, why: scope.why, at: new Date().toISOString() };
      continue;
    }

    const made = makeEvent({ type: 'schedule', payload: mapped.payload, origin: mapped.origin, _at: mapped._at });
    if (made.ok === false) { quarantined += 1; errors.push(`日程 ${eventId} 归一失败：${made.errors.join('；')}`); continue; }
    const r = store.upsert(made.event);
    if (r.action === 'rejected') { quarantined += 1; errors.push(`日程 ${eventId} 落库被拒：${r.reason}`); continue; }
    if (r.action === 'added') outCount += 1; else if (r.action === 'updated') refreshed += 1;
    seen[eventId] = { fp: fingerprint, at: new Date().toISOString(), participants };
  }

  if (!dryRun) saveSeen(seen);
  return {
    inCount, outCount, refreshed, skipped, outOfScope, quarantined, attendeeFetches, errors,
    dataAsOf: new Date().toISOString(),
    why: `窗口 ${startIso.slice(0, 10)} ~ ${endIso.slice(0, 10)} · 列表 ${ag.count} 条 · 新采 ${outCount} · 刷新 ${refreshed} · 跳过 ${skipped}（其中出界 ${outOfScope}） · 隔离 ${quarantined} · 参会人请求 ${attendeeFetches}`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（注入假 run：不碰真 CLI）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const os = await import('node:os');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-fscal-'));
  process.env.WB_V1_OUT = tmp;

  const ev = (id, summary, s, e, extra = {}) => ({
    event_id: id, summary,
    start_time: { datetime: s, timezone: 'Asia/Shanghai' },
    end_time: { datetime: e, timezone: 'Asia/Shanghai' },
    self_rsvp_status: 'accept', free_busy_status: 'busy', ...extra,
  });
  const FAKE = {
    A: ev('A', '项目对齐会', '2026-10-13T14:00:00+08:00', '2026-10-13T15:00:00+08:00', { description: '议题：排期与验收' }),
    B: ev('B', '九月的老会', '2026-09-20T10:00:00+08:00', '2026-09-20T11:00:00+08:00'),
    C: ev('C', '全天团建', null, null, { start_time: { date: '2026-10-15' }, end_time: { date: '2026-10-16' } }),
  };
  const runWith = (ids, attendees = []) => (args) => {
    if (args[1] === '+agenda') return { ok: true, json: { ok: true, identity: 'user', data: ids.map((i) => FAKE[i]) } };
    if (args[1] === 'event.attendees' && args[2] === 'list') return { ok: true, json: { ok: true, data: { items: attendees.map((n) => ({ display_name: n, rsvp_status: 'accept' })), has_more: false } } };
    return { ok: false, why: '未预期参数：' + args.join(' ') };
  };

  try {
    // ① 时间换算
    chk('FSC-1', '★ ISO 带偏移 ⇒ 本地 YYYY-MM-DDTHH:mm', toLocalWhen({ datetime: '2026-10-13T14:00:00+08:00' }) === '2026-10-13T14:00', String(toLocalWhen({ datetime: '2026-10-13T14:00:00+08:00' })));
    chk('FSC-2', '全天日程 ⇒ 只给日期', toLocalWhen({ date: '2026-10-15' }) === '2026-10-15');
    chk('FSC-3', '时间缺失 ⇒ null（不编）', toLocalWhen({}) === null && toLocalWhen(null) === null);

    // ② 映射
    const m = mapEvent(FAKE.A, ['张伟', '李强']);
    chk('FSC-4', '★ 主题/起止/参与人/详情都进来了（飞书这条有 description）',
      m.ok === true && m.payload.topic === '项目对齐会' && m.payload.start === '2026-10-13T14:00'
      && m.payload.end === '2026-10-13T15:00' && m.payload.participants.length === 2 && m.payload.detail === '议题：排期与验收',
      JSON.stringify(m.payload));
    chk('FSC-5', '★ 地点不填（agenda 不给地点，不编"线上"）', !('place' in m.payload), JSON.stringify(Object.keys(m.payload)));
    chk('FSC-6', '幂等键 = fs-cal-<event_id>', m.origin.messageId === 'fs-cal-A');
    chk('FSC-7', '★ 负向对照：缺主题/缺 id/时间坏 ⇒ 映射失败（不造空日程）',
      mapEvent({ event_id: 'X', start_time: FAKE.A.start_time, end_time: FAKE.A.end_time }).ok === false
      && mapEvent({ summary: 'x', start_time: FAKE.A.start_time, end_time: FAKE.A.end_time }).ok === false
      && mapEvent({ event_id: 'Y', summary: 'y', start_time: {}, end_time: {} }).ok === false);

    // ③ 一轮：A（界内）、B（截止早于起点）、C（全天、界内）
    const r1 = ingestOnce({ run: runWith(['A', 'B', 'C'], ['张伟']), now: Date.parse('2026-10-12T12:00:00+08:00') });
    chk('FSC-8', '★ 一轮：A/C 入流、B 因起止都早于起点被挡在界外', r1.inCount === 3 && r1.outCount === 2 && r1.outOfScope === 1, JSON.stringify({ in: r1.inCount, out: r1.outCount, outOfScope: r1.outOfScope }));
    const all = store.list({ type: 'schedule' });
    chk('FSC-9', '库里 2 条日程', all.length === 2, String(all.length));
    const a = all.find((e) => e.origin.messageId === 'fs-cal-A');
    chk('FSC-10', '★ 参会人写进 payload', Array.isArray(a.payload.participants) && a.payload.participants.includes('张伟'), JSON.stringify(a.payload.participants));
    chk('FSC-11', '★ 全天日程也能入流（C 已进库）', !!all.find((e) => e.origin.messageId === 'fs-cal-C'));

    // ④ 幂等 + 不重复拉参会人
    const r2 = ingestOnce({ run: runWith(['A', 'B', 'C'], ['张伟']), now: Date.parse('2026-10-12T12:00:00+08:00') });
    chk('FSC-12', '★ 第二轮：不新建、也不重复拉参会人', r2.outCount === 0 && r2.attendeeFetches === 0 && store.list({ type: 'schedule' }).length === 2, JSON.stringify({ out: r2.outCount, att: r2.attendeeFetches }));

    // ⑤ 改动 ⇒ 刷新
    const run2 = (args) => {
      if (args[1] === '+agenda') return { ok: true, json: { ok: true, data: [ev('A', '项目对齐会（改期）', '2026-10-13T16:00:00+08:00', '2026-10-13T17:00:00+08:00')] } };
      if (args[1] === 'event.attendees' && args[2] === 'list') return { ok: true, json: { ok: true, data: { items: [] } } };
      return { ok: false, why: 'unexpected' };
    };
    const r3 = ingestOnce({ run: run2, now: Date.parse('2026-10-12T12:00:00+08:00') });
    const a2 = store.list({ type: 'schedule' }).find((e) => e.origin.messageId === 'fs-cal-A');
    chk('FSC-13', '★ 日程被改动 ⇒ 刷新既有事件（不新建）', r3.outCount === 0 && r3.refreshed === 1 && a2.payload.topic === '项目对齐会（改期）' && store.list({ type: 'schedule' }).length === 2, JSON.stringify({ out: r3.outCount, refreshed: r3.refreshed }));

    // ⑥ 参会人取不到 ⇒ 整条照采
    const run3 = (args) => (args[1] === '+agenda'
      ? { ok: true, json: { ok: true, data: [ev('D', '没有参会人的会', '2026-10-14T09:00:00+08:00', '2026-10-14T10:00:00+08:00')] } }
      : { ok: false, why: '模拟参会人接口不可用' });
    const r4 = ingestOnce({ run: run3, now: Date.parse('2026-10-12T12:00:00+08:00') });
    chk('FSC-14', '★ 参会人取不到 ⇒ 日程照采且如实记错', r4.outCount === 1 && r4.errors.some((e) => /参会人取不到/.test(e)), JSON.stringify({ out: r4.outCount, errs: r4.errors.length }));

    // ⑦ lark-cli 自己报错 ⇒ 如实上报（不当成"没有日程"）
    const r5 = ingestOnce({ run: () => ({ ok: false, why: 'lark-cli 报错：invalid access token' }) });
    chk('FSC-15', '★ 取数失败 ⇒ 写明原因（不写成"没有日程"）', r5.errors.length === 1 && /日程列表取不到/.test(r5.why), r5.why);

    // ⑧ 干跑不写盘
    const before = store.list({ type: 'schedule' }).length;
    ingestOnce({ run: runWith(['A', 'B', 'C'], ['张伟']), dryRun: true, now: Date.parse('2026-10-12T12:00:00+08:00') });
    chk('FSC-16', '干跑不写盘', store.list({ type: 'schedule' }).length === before);
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
