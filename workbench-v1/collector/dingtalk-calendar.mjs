/**
 * v1/collector/dingtalk-calendar.mjs —— 钉钉 · 日程（登记表 `dd-calendar`）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 3.1.5：「日程需要结构化拆解：日程主题 / 详情 / 起止时间 / 地点 / 参与人」
 * 需求 2.2：CLI 类功能走**每 5 分钟轮询**，**幂等**，已采过的不再采。
 *
 * 实测依据（2026-10-12，不是猜的）：
 *   · `dws calendar +agenda [--start ISO --end ISO]` ⇒ `{count, events:[{eventId, summary,
 *     start:{date,dateTime,timeZone}, end:{…}, status}]}`
 *   · `dws calendar +attendee-list --event <eventId>` ⇒ `{count, attendees:[{displayName, responseStatus}]}`
 *     （**参数名是 `--event`，不是 `--event-id`** —— 第一次这么写被 CLI 自己纠正了）
 *   · `dws calendar event get --event <id>`：**没有 location/place 字段**（只有 `meetingRooms`、`roomCode`）
 *     ⇒ 没地点就**不填**，不编一个"线上"。
 *
 * 字段按登记契约（`schema.mjs` 的 PAYLOAD_SPEC.schedule）：
 *   必填 `topic`/`start`/`end`；可选 `detail`/`place`/`participants`/`type`/`source`。
 *   时间只接受 **本地** `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`（不带时区）。
 * 幂等键 = `dd-cal-<eventId>`。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { inScope } from './registry.mjs';
import { v1Out } from '../paths.mjs';

export const KEY = 'dd-calendar';
export const INTERVAL_SEC = 300;
const DAY = 86400000;

const pad = (n) => String(n).padStart(2, '0');

/** ISO（带偏移）→ **本地** `YYYY-MM-DDTHH:mm`；纯日期 → `YYYY-MM-DD`。
 *  契约只接受本地格式，所以这里把偏移换算成本机墙上时间（不是原样抄偏移字符串）。 */
export function toLocalWhen(t) {
  if (!t) return null;
  if (typeof t.date === 'string' && t.date) return t.date;              // 全天日程
  if (typeof t.dateTime === 'string' && t.dateTime) {
    const ms = Date.parse(t.dateTime);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return null;
}

export function stateFile() { return path.join(v1Out(), 'dd-calendar-seen.json'); }
export function loadSeen() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveSeen(doc) {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

/** 默认取数：经 PowerShell 调 `dws`（Windows 上 `dws` 是 .cmd 垫片，直接 spawn 会 ENOENT） */
export function defaultRun(args) {
  const PS = 'powershell.exe';
  const cmd = 'dws ' + args.map((a) => {
    const s = String(a);
    return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
  }).join(' ');
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `dws 退出码 ${r.status}：${(err || out).slice(0, 200)}` };
  try { return { ok: true, json: JSON.parse(out) }; } catch (e) { return { ok: false, why: `输出不是 JSON：${e.message}（前 120 字：${out.slice(0, 120)}）` }; }
}

/** 取时间窗内的日程 */
export function fetchAgenda({ start, end, run = defaultRun } = {}) {
  const args = ['calendar', '+agenda'];
  if (start) args.push('--start', start);
  if (end) args.push('--end', end);
  const r = run(args);
  if (r.ok !== true) return { ok: false, why: r.why };
  const events = r.json?.events;
  if (!Array.isArray(events)) return { ok: false, why: '返回里没有 events 数组' };
  return { ok: true, count: Number(r.json.count ?? events.length), events };
}

/** 取参会人（真名；CLI 参数是 `--event`） */
export function fetchAttendees(eventId, { run = defaultRun } = {}) {
  const r = run(['calendar', '+attendee-list', '--event', String(eventId)]);
  if (r.ok !== true) return { ok: false, why: r.why };
  const arr = r.json?.attendees;
  if (!Array.isArray(arr)) return { ok: false, why: '返回里没有 attendees 数组' };
  return { ok: true, participants: arr.map((a) => String(a?.displayName ?? '').trim()).filter(Boolean) };
}

/** 日程 → v1 事件（需求 3.1.5 的五项） */
export function mapEvent(ev, participants = []) {
  const errs = [];
  const topic = String(ev?.summary ?? '').trim();
  if (!topic) errs.push('缺主题（summary）');
  const eventId = String(ev?.eventId ?? '').trim();
  if (!eventId) errs.push('缺 eventId（幂等键要用）');
  const start = toLocalWhen(ev?.start);
  const end = toLocalWhen(ev?.end);
  if (!start) errs.push(`开始时间无法解析：${JSON.stringify(ev?.start)}`);
  if (!end) errs.push(`结束时间无法解析：${JSON.stringify(ev?.end)}`);
  if (errs.length) return { ok: false, errors: errs };

  const payload = {
    topic,
    start,
    end,
    participants: Array.isArray(participants) && participants.length ? participants : undefined,
    type: String(ev?.status ?? '').trim() || undefined,     // 登记契约里有 type；这里放来源状态（confirmed/cancelled）
    source: 'dingtalk-calendar',
  };
  // `detail`/`place`：列表没给、event get 也没有 location ⇒ **不填**（不编"线上"之类的占位）
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

  const at = Date.parse(ev?.start?.dateTime ?? '') || Date.parse(ev?.start?.date ?? '') || Date.now();
  return {
    ok: true,
    payload,
    origin: { channel: 'dingtalk', sender: '钉钉日程', messageId: `dd-cal-${eventId}`, raw: topic },
    _at: at,
    cancelled: String(ev?.status ?? '').toLowerCase() === 'cancelled',
  };
}

/**
 * 跑一轮：拉一个窗口（默认 前 30 天 ~ 后 7 天）→ 新/变动的才拉参会人 → 落库。
 * 窗口口径与日程页展示口径一致（今日 / 未来 7 天 / 前 30 日内已完成）。
 */
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
    const eventId = String(ev?.eventId ?? '');
    if (!eventId) { quarantined += 1; errors.push('列表里有一条没有 eventId，跳过（不猜）'); continue; }
    const mid = `dd-cal-${eventId}`;
    // 取消的日程：不进工作台（它不是"待处理的日程"）；如实计数，不静默
    if (String(ev?.status ?? '').toLowerCase() === 'cancelled') { skipped += 1; continue; }

    const prev = seen[eventId];
    const fingerprint = `${ev.summary}|${ev.start?.dateTime ?? ev.start?.date}|${ev.end?.dateTime ?? ev.end?.date}`;
    const have = existing.get(mid);
    const needDetail = !prev || prev.fp !== fingerprint || !have;

    let participants = prev?.participants ?? [];
    if (needDetail) {
      if (dryRun) { outCount += 1; continue; }
      if (outCount >= maxNew) { errors.push(`达到上限 ${maxNew} 条，其余下一轮再来`); break; }
      const got = fetchAttendees(eventId, { run });
      attendeeFetches += 1;
      if (got.ok === true) participants = got.participants;
      else errors.push(`日程 ${eventId} 参会人取不到：${got.why}（其余照采，不因参会人失败丢掉整条）`);
    } else { skipped += 1; continue; }

    const mapped = mapEvent(ev, participants);
    if (mapped.ok !== true) { quarantined += 1; errors.push(`日程 ${eventId} 映射失败：${mapped.errors.join('；')}`); continue; }
    // ★ 采集起点判据（用户 2026-10-12 裁定）：日程**起止只要有一端**在起点之后即入流。
    const scope = inScope('schedule', mapped.payload, mapped._at);
    if (!scope.inScope) { skipped += 1; outOfScope += 1; continue; }

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
// 自检（注入假 run）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const os = await import('node:os');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-ddcal-'));
  process.env.WB_V1_OUT = tmp;

  const ev = (id, summary, s, e, status = 'confirmed') => ({
    eventId: id, summary, status,
    start: { date: null, dateTime: s, timeZone: 'Asia/Shanghai' },
    end: { date: null, dateTime: e, timeZone: 'Asia/Shanghai' },
  });
  const FAKE = {
    A: ev('A', '项目评审会', '2026-10-12T14:00:00+08:00', '2026-10-12T15:00:00+08:00'),
    B: ev('B', '线上辅导', '2026-10-12T10:00:00+08:00', '2026-10-12T11:00:00+08:00'),
    C: ev('C', '已取消的会', '2026-10-13T10:00:00+08:00', '2026-10-13T11:00:00+08:00', 'cancelled'),
  };
  const runWith = (ids) => (args) => {
    if (args[1] === '+agenda') return { ok: true, json: { count: ids.length, events: ids.map((i) => FAKE[i]) } };
    if (args[1] === '+attendee-list') {
      const id = args[3];
      return { ok: true, json: { count: 2, attendees: [{ displayName: '张伟', responseStatus: 'accepted' }, { displayName: `与会者-${id}`, responseStatus: 'accepted' }] } };
    }
    return { ok: false, why: '未预期参数：' + args.join(' ') };
  };

  try {
    // ① 时间换算：ISO 带偏移 ⇒ 本地分钟（契约只收本地格式）
    chk('DTC-1', '★ ISO 带偏移 ⇒ 本地 YYYY-MM-DDTHH:mm', toLocalWhen({ dateTime: '2026-10-12T14:00:00+08:00' }) === '2026-10-12T14:00', String(toLocalWhen({ dateTime: '2026-10-12T14:00:00+08:00' })));
    chk('DTC-2', '全天日程 ⇒ 只给日期', toLocalWhen({ date: '2026-10-12', dateTime: null }) === '2026-10-12');
    chk('DTC-3', '时间缺失 ⇒ null（不编）', toLocalWhen({}) === null && toLocalWhen(null) === null);

    // ② 映射：需求 3.1.5 的各项
    const m = mapEvent(FAKE.A, ['张伟', '李强']);
    chk('DTC-4', '★ 映射出主题/起止/参与人', m.ok === true && m.payload.topic === '项目评审会' && m.payload.start === '2026-10-12T14:00' && m.payload.end === '2026-10-12T15:00' && m.payload.participants.length === 2, JSON.stringify(m.payload));
    chk('DTC-5', '★ 地点缺失 ⇒ **不填**（事件里本来就没有 location，不编"线上"）', !('place' in m.payload), JSON.stringify(Object.keys(m.payload)));
    chk('DTC-6', '幂等键 = dd-cal-<eventId>', m.origin.messageId === 'dd-cal-A');
    chk('DTC-7', '★ 负向对照：缺主题/缺 eventId/时间坏 ⇒ 映射失败', mapEvent({ eventId: 'X', start: FAKE.A.start, end: FAKE.A.end }).ok === false && mapEvent({ summary: 'x', start: FAKE.A.start, end: FAKE.A.end }).ok === false && mapEvent({ eventId: 'Y', summary: 'y', start: {}, end: {} }).ok === false);

    // ③ 一轮：A/B 进来，C（已取消）跳过
    const r1 = ingestOnce({ run: runWith(['A', 'B', 'C']), now: Date.parse('2026-10-12T12:00:00+08:00') });
    chk('DTC-8', '★ 一轮采到 2 条（已取消的那条跳过）', r1.inCount === 3 && r1.outCount === 2 && r1.skipped === 1, JSON.stringify({ in: r1.inCount, out: r1.outCount, skipped: r1.skipped }));
    chk('DTC-9', '库里 2 条日程', store.list({ type: 'schedule' }).length === 2);
    const a = store.list({ type: 'schedule' }).find((e) => e.origin.messageId === 'dd-cal-A');
    chk('DTC-10', '★ 参会人写进 payload（真名）', Array.isArray(a.payload.participants) && a.payload.participants.includes('张伟'), JSON.stringify(a.payload.participants));

    // ④ 幂等：第二轮不再新建、也不重复拉参会人
    const r2 = ingestOnce({ run: runWith(['A', 'B', 'C']), now: Date.parse('2026-10-12T12:00:00+08:00') });
    chk('DTC-11', '★ 第二轮幂等：不新建、不重复拉参会人', r2.outCount === 0 && r2.attendeeFetches === 0 && store.list({ type: 'schedule' }).length === 2, JSON.stringify({ out: r2.outCount, att: r2.attendeeFetches }));

    // ⑤ 改动 ⇒ 刷新（改时间）
    const run2 = (args) => {
      if (args[1] === '+agenda') return { ok: true, json: { count: 1, events: [ev('A', '项目评审会（改期）', '2026-10-12T16:00:00+08:00', '2026-10-12T17:00:00+08:00')] } };
      if (args[1] === '+attendee-list') return { ok: true, json: { count: 1, attendees: [{ displayName: '张伟' }] } };
      return { ok: false, why: 'unexpected' };
    };
    const r3 = ingestOnce({ run: run2, now: Date.parse('2026-10-12T12:00:00+08:00') });
    const a2 = store.list({ type: 'schedule' }).find((e) => e.origin.messageId === 'dd-cal-A');
    chk('DTC-12', '★ 日程被改动 ⇒ 刷新既有事件（不新建，条数不变）', r3.outCount === 0 && r3.refreshed === 1 && a2.payload.topic === '项目评审会（改期）' && store.list({ type: 'schedule' }).length === 2, JSON.stringify({ out: r3.outCount, refreshed: r3.refreshed, topic: a2.payload.topic }));

    // ⑥ 参会人取不到 ⇒ 整条照采（不因附属信息失败丢主记录），但如实记错
    const run3 = (args) => (args[1] === '+agenda'
      ? { ok: true, json: { count: 1, events: [ev('D', '没有参会人的会', '2026-10-14T09:00:00+08:00', '2026-10-14T10:00:00+08:00')] } }
      : { ok: false, why: '模拟参会人接口不可用' });
    const r4 = ingestOnce({ run: run3, now: Date.parse('2026-10-12T12:00:00+08:00') });
    chk('DTC-13', '★ 参会人取不到 ⇒ 日程照采（不丢主记录）且如实记错', r4.outCount === 1 && r4.errors.some((e) => /参会人取不到/.test(e)), JSON.stringify({ out: r4.outCount, errs: r4.errors.length }));

    // ⑦ 取数失败 ⇒ 写明原因
    const r5 = ingestOnce({ run: () => ({ ok: false, why: '模拟 CLI 不可用' }) });
    chk('DTC-14', '★ 列表取不到 ⇒ 写明原因（不写成"没有日程"）', r5.errors.length === 1 && /日程列表取不到/.test(r5.why), r5.why);

    // ⑧ 干跑不写盘
    const before = store.list({ type: 'schedule' }).length;
    ingestOnce({ run: runWith(['A', 'B', 'C']), dryRun: true, now: Date.parse('2026-10-12T12:00:00+08:00') });
    chk('DTC-15', '干跑不写盘', store.list({ type: 'schedule' }).length === before);
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
