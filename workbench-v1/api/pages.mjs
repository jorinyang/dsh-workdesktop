/**
 * v1/api/pages.mjs —— **页面数据接口**（P4 前端契约；需求 3.3.2–3.3.6 逐页对应）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 这一层做什么：把运行态里的事件，整理成**每个页面正好要的那些字段**。
 *   为什么不把原始事件直接丢给前端：需求 3.3.x 对每页的字段是**点名的**
 *   （消息页要"待处理/已转待办/已转日程/已回复"四个数、待办页要"距离截止时间"、
 *     日程页要"今日/未来7天/前30日内已完成"…）—— 这些口径必须在**一处**定义，
 *     否则前端两处各算一遍，数字对不上（本项目已经吃过"两处各写一遍"的亏）。
 *
 * 口径（直接来自需求原文，别改）：
 *   · 消息：**转待办 / 转日程 / 已回复 都算已处理**；"已回复"沿用既有规则
 *     （我在对应沟通工具里回复过即视为已回复）
 *   · 待办：今日 / 本周 / 待定 / 已完成；列表显示"距离截止时间"
 *   · 日程：今日 / 未来7天 / 前30日内已完成；完成条件三种（过当天 24 点 / 有 AI 听记 / 手动）
 *   · 笔记：总数 / 本月新增 / 标签数
 *   · 总览：待完成待办 · 待处理信息 · 近 7 日日程 · 近一周笔记 + 三类关键提醒
 * ══════════════════════════════════════════════════════════════════════════════
 */

import * as store from '../store.mjs';

const DAY = 86400000;
export const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const dayEnd = (ms) => dayStart(ms) + DAY - 1;
/** 距今天数（正=未来，负=已过）—— 待办页"距离截止时间"用 */
export function daysFromToday(dueMs, now = Date.now()) {
  return Math.round((dayStart(dueMs) - dayStart(now)) / DAY);
}
/** 人话化的距离（前端列表直接显示） */
export function dueLabel(dueMs, now = Date.now()) {
  const d = daysFromToday(dueMs, now);
  if (d === 0) return '今天';
  if (d === 1) return '明天';
  if (d === -1) return '昨天';
  return d > 0 ? `还有 ${d} 天` : `已逾期 ${-d} 天`;
}

/** 消息的"处理状态"（需求 3.3.3：转待办/转日程/已回复 都算已处理） */
export function messageState(evt) {
  const ops = evt.ops ?? [];
  const has = (n) => ops.some((o) => String(o.op ?? '') === n);
  if (has('to-todo') || evt.payload?.linkedTodoId) return 'to-todo';
  if (has('to-schedule') || evt.payload?.linkedScheduleId) return 'to-schedule';
  if (has('replied') || evt.payload?.replied === true) return 'replied';
  return 'pending';
}
export const MESSAGE_TABS = Object.freeze(['all', 'pending', 'to-todo', 'to-schedule', 'replied']);

const senderLine = (evt) => {
  const ch = { dingtalk: '钉钉', feishu: '飞书', weixin: '微信', imessage: 'iMessage', manual: '手工' }[evt.payload.channel] ?? evt.payload.channel;
  return `${ch} · ${evt.payload.sender}`;
};

/** 消息页：四个数字 + 列表（列表字段：日期时间/来源/发信人/一句话概括） */
export function messages({ tab = 'all', limit = 200, now = Date.now() } = {}) {
  const rows = store.list({ type: 'message' }).sort((a, b) => b._at - a._at);
  const counts = { pending: 0, toTodo: 0, toSchedule: 0, replied: 0, total: rows.length };
  const decorated = rows.map((e) => {
    const st = messageState(e);
    if (st === 'pending') counts.pending += 1;
    else if (st === 'to-todo') counts.toTodo += 1;
    else if (st === 'to-schedule') counts.toSchedule += 1;
    else if (st === 'replied') counts.replied += 1;
    return {
      id: e._id, at: e._at, state: st,
      source: senderLine(e),
      sender: e.payload.sender,
      summary: e.payload.summary ?? String(e.payload.raw ?? '').slice(0, 60),
      channel: e.payload.channel,
    };
  });
  const filter = tab === 'all' ? decorated : decorated.filter((r) => r.state === tab);
  return { counts, tab, tabs: MESSAGE_TABS, list: filter.slice(0, limit), now };
}

/** 待办页：今日/本周/待定/已完成
 *  ★ 口径（修过一个会丢事的 bug）：**逾期项并入"今日"桶**，并单列 overdue 计数。
 *    早先 `today` 只收"今天到期"、`week` 只收"今天到未来7天" ⇒ **已逾期的任务掉进两桶缝隙、列表里彻底消失** ——
 *    而它恰恰最急。凡"该被处理但没被处理"的东西，列表里必须有它的位置。 */
export function todos({ bucket = 'all', now = Date.now() } = {}) {
  const rows = store.list({ type: 'todo' });
  const open = rows.filter((e) => e.lifecycle !== 'archived' && !(e.ops ?? []).some((o) => o.op === 'done'));
  const done = rows.filter((e) => (e.ops ?? []).some((o) => o.op === 'done'));
  const dueMs = (e) => (e.payload.due ? Date.parse(e.payload.due) : NaN);
  const overdue = open.filter((e) => Number.isFinite(dueMs(e)) && dueMs(e) < dayStart(now));
  const dueToday = open.filter((e) => Number.isFinite(dueMs(e)) && dueMs(e) <= dayEnd(now) && dueMs(e) >= dayStart(now));
  const in7 = open.filter((e) => Number.isFinite(dueMs(e)) && dueMs(e) >= dayStart(now) && dueMs(e) <= dayStart(now) + 7 * DAY);
  const undecided = open.filter((e) => !e.payload.due);
  // ★ 2026-10-12 修（**用户报"待办页点不了"之后查出来的真 bug**）：
  //   默认桶原来是 `today`（"逾期 + 今天到期"）—— 而**绝大多数待办没有截止时间**，
  //   它们落在 `undecided` 桶里。于是"今日 0 条"时列表**整块是空态**（`listBlock` 空 ⇒ 渲染「暂无」），
  //   而统计卡里明明白白写着「待定 4」—— 数字说有、列表说没有，**页面自相矛盾**，
  //   用户看到的就是"待办页点不了"（列表里根本没有行）。
  //   ⇒ 补一个 `all`（四桶并集）并**改默认**：页面默认把全部待办列出来，
  //     单桶仍可单独取（总览要的是"今日/逾期"那两桶，不受影响）。
  const buckets = {
    today: [...overdue, ...dueToday].sort((a, b) => dueMs(a) - dueMs(b)),   // 今天要处理的 = 逾期 + 今天到期
    week: in7,
    undecided,
    done,
    all: [...open, ...done],
  };
  const list = (buckets[bucket] ?? []).map((e) => ({
    id: e._id, topic: e.payload.topic, detail: e.payload.detail ?? '',
    // ★ 字段名以 schema 登记为准：执行人是 **executor**、发布人是 **publisher**
    //   （早先读 assignee，校验器判"未登记字段"⇒ 执行人会永远显示为空）
    executor: e.payload.executor ?? null, publisher: e.payload.publisher ?? null,
    due: e.payload.due ?? null,
    dueLabel: e.payload.due ? dueLabel(Date.parse(e.payload.due), now) : '无期限',
    overdue: e.payload.due ? Date.parse(e.payload.due) < dayStart(now) : false,
    closeConditions: e.payload.closeConditions ?? null,   // P5 自动关闭用（需求 3.3.4）
  })).sort((a, b) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999')));
  return {
    counts: { today: buckets.today.length, week: in7.length, undecided: undecided.length, done: done.length, overdue: overdue.length, total: rows.length },
    bucket, list,
  };
}

/** 日程页：今日 / 未来7天 / 前30日内已完成 */
export function schedules({ bucket = 'today', now = Date.now() } = {}) {
  const rows = store.list({ type: 'schedule' });
  const at = (e) => Date.parse(e.payload.start ?? '');
  const isDone = (e) => (e.ops ?? []).some((o) => o.op === 'done');
  const today = rows.filter((e) => Number.isFinite(at(e)) && dayStart(at(e)) === dayStart(now));
  const next7 = rows.filter((e) => Number.isFinite(at(e)) && at(e) >= dayStart(now) && at(e) <= dayStart(now) + 7 * DAY);
  const done30 = rows.filter((e) => isDone(e) && Number.isFinite(at(e)) && at(e) >= dayStart(now) - 30 * DAY && at(e) < dayStart(now));
  const buckets = { today, next7, done30 };
  const list = (buckets[bucket] ?? []).map((e) => ({
    id: e._id, topic: e.payload.topic, start: e.payload.start, end: e.payload.end ?? null,
    // ★ 字段名以 schema 的登记为准：日程地点是 **place**（不是 location）
    //   —— 早先这里读 location，校验器当场判"未登记字段"，否则地点会永远显示为空
    place: e.payload.place ?? null, participants: e.payload.participants ?? [],
    type: e.payload.type ?? null, done: isDone(e),
  })).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { counts: { today: today.length, next7: next7.length, done30: done30.length, total: rows.length }, bucket, list };
}

/**
 * **日程密度热力图**（需求 3.3.5 原话：
 *   "数据展示的下方是日程密度的热力图，左侧展示的是当月每天的日程热力，
 *    右侧展示的是日程热力的动态分析（结合日程的密度及日程的主题和详情，对日程安排进行分析）"）。
 *
 * 两条口径（写清楚，免得后面变成玄学）：
 *   · **热力值 = 当天日程条数**（`level` 0–4 按当天条数分档：0 条 0；1 条 1；2 条 2；3 条 3；≥4 条 4）。
 *     不用"时长"当热力，是因为一天开几个会才是"密度"，时长会把它和"一个长会"混起来。
 *   · **动态分析 = 规则统计**（**不调模型**）：峰值日、空白日、最忙时段、主题聚类。
 *     要模型版叙述走驾驶舱那三条（它们有"无数据不调模型"的纪律），这里不偷偷烧 token。
 *
 * 左侧是**当月**（含当月第一天到月末，前面补空格对齐星期），右侧是分析。
 */
export function scheduleHeatmap({ now = Date.now(), month = null } = {}) {
  const rows = store.list({ type: 'schedule' });
  const d = new Date(now);
  const y = month ? Number(String(month).slice(0, 4)) : d.getFullYear();
  const m = month ? Number(String(month).slice(5, 7)) : d.getMonth() + 1;
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();

  const perDay = new Map();                                  // 'YYYY-MM-DD' -> {count, items[]}
  for (let i = 1; i <= daysInMonth; i += 1) {
    perDay.set(`${y}-${String(m).padStart(2, '0')}-${String(i).padStart(2, '0')}`, { count: 0, items: [] });
  }
  const hourBuckets = new Array(24).fill(0);
  for (const e of rows) {
    const ms = Date.parse(e.payload?.start ?? '');
    if (!Number.isFinite(ms)) continue;
    const dd = new Date(ms);
    if (dd.getFullYear() !== y || dd.getMonth() + 1 !== m) continue;
    const key = `${y}-${String(m).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
    const cell = perDay.get(key);
    if (!cell) continue;
    cell.count += 1;
    cell.items.push({ id: e._id, topic: e.payload?.topic ?? '', start: e.payload?.start ?? null, hour: dd.getHours() });
    hourBuckets[dd.getHours()] += 1;
  }
  const level = (n) => (n <= 0 ? 0 : n >= 4 ? 4 : n);
  const cells = [...perDay.entries()].map(([date, v]) => ({ date, day: Number(date.slice(8, 10)), count: v.count, level: level(v.count), items: v.items }));
  // 前面补空格，让第一格落在正确的星期列（周一为一周之始）
  const lead = (first.getDay() + 6) % 7;
  const grid = [...new Array(lead).fill(null), ...cells];

  const busiest = [...cells].sort((a, b) => b.count - a.count).filter((c) => c.count > 0);
  const peak = busiest[0] ?? null;
  const emptyDays = cells.filter((c) => c.count === 0).length;
  const busiestHour = hourBuckets.map((n, h) => ({ hour: h, n })).sort((a, b) => b.n - a.n)[0] ?? null;
  const topics = new Map();
  for (const e of rows) {
    const ms = Date.parse(e.payload?.start ?? '');
    if (!Number.isFinite(ms)) continue;
    const dd = new Date(ms);
    if (dd.getFullYear() !== y || dd.getMonth() + 1 !== m) continue;
    const t = String(e.payload?.topic ?? '').trim();
    if (t) topics.set(t, (topics.get(t) ?? 0) + 1);
  }
  const topTopics = [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([topic, n]) => ({ topic, n }));
  const total = cells.reduce((n, c) => n + c.count, 0);

  // 动态分析：**纯规则生成**（不调模型），每条都能回查到上面那几个数
  const lines = [];
  lines.push(total === 0
    ? `本月（${y}-${String(m).padStart(2, '0')}）还没有日程记录 —— 没有数据就不分析。`
    : `本月共 ${total} 条日程，分布在 ${cells.length - emptyDays} 天里（空白 ${emptyDays} 天）。`);
  if (peak) lines.push(`最忙的一天是 ${peak.date.slice(8, 10)} 日（${peak.count} 条）${peak.items.length ? '：' + peak.items.map((x) => x.topic).filter(Boolean).slice(0, 3).join('、') : ''}。`);
  if (busiestHour && busiestHour.n > 0) lines.push(`最集中的时段是 ${String(busiestHour.hour).padStart(2, '0')}:00 前后（${busiestHour.n} 条）${busiestHour.hour <= 11 ? ' —— 集中在上半天' : busiestHour.hour >= 18 ? ' —— 集中在傍晚之后，注意别连着排' : ''}。`);
  if (cells.length - emptyDays > 0) lines.push(`平均每天 ${(total / (cells.length - emptyDays)).toFixed(1)} 条（按有日程的天算）。`);
  if (topTopics.length) lines.push(`主题上以「${topTopics.map((t) => t.topic).slice(0, 3).join('」「')}」为主 —— 反复出现的主题值得单独沉淀成方法论。`);
  const maxStreak = (() => { let best = 0; let cur = 0; for (const c of cells) { if (c.count > 0) { cur += 1; best = Math.max(best, cur); } else cur = 0; } return best; })();
  if (maxStreak >= 3) lines.push(`连续 ${maxStreak} 天都有日程 —— 密度偏高，建议留出整块不排会的时间。`);

  return {
    month: `${y}-${String(m).padStart(2, '0')}`,
    grid, cells, lead, daysInMonth,
    totals: { count: total, busyDays: cells.length - emptyDays, emptyDays, maxStreak },
    peak: peak ? { date: peak.date, count: peak.count } : null,
    busiestHour: busiestHour && busiestHour.n > 0 ? busiestHour : null,
    topTopics, analysis: lines,
  };
}

/** 笔记页：总数 / 本月新增 / 标签数 */export function notes({ now = Date.now(), limit = 200 } = {}) {
  const rows = store.list({ type: 'note' }).sort((a, b) => b._at - a._at);
  const d = new Date(now);
  const monthPrefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const tags = new Set();
  for (const e of rows) for (const t of (e.payload.tags ?? [])) tags.add(t);
  return {
    counts: { total: rows.length, thisMonth: rows.filter((e) => String(e.payload.date ?? '').startsWith(monthPrefix)).length, tags: tags.size },
    list: rows.slice(0, limit).map((e) => ({
      id: e._id, topic: e.payload.topic, date: e.payload.date,
      tags: e.payload.tags ?? [], source: e.payload.source ?? null,
      hasAnalysis: !!e.analysis, hasVisual: !!(e.analysis && e.analysis.visual),
    })),
  };
}

/** 总览页（需求 3.3.2）：四个数字 + 三类关键提醒 */
export function overview({ now = Date.now(), staleReplyDays = 3 } = {}) {
  const m = messages({ now }); const t = todos({ now }); const s = schedules({ now }); const n = notes({ now });
  const rows = store.list({ type: 'message' });

  // 提醒一：重要日程（未来 7 天）—— ★ 必须用 next7 那个桶，不能用今日列表（早先取错桶只出 1 条）
  const upcoming = schedules({ bucket: 'next7', now }).list
    .filter((x) => x.start && Date.parse(x.start) >= dayStart(now)).slice(0, 5)
    .map((x) => ({ kind: 'schedule', id: x.id, title: x.topic, at: x.start, note: x.place ?? '' }));
  // 提醒二：逾期 / 临期任务（**逾期全收** + 今天 + 明天）—— 直接在全部未完成待办上算，不走桶（免得又被桶缝隙漏掉）
  const openTodos = todos({ bucket: 'week', now });
  const allOpen = [...todos({ bucket: 'today', now }).list, ...openTodos.list, ...todos({ bucket: 'undecided', now }).list];
  const seen = new Set();
  const urgent = allOpen.filter((x) => {
    if (seen.has(x.id)) return false; seen.add(x.id);
    if (!x.due) return false;
    return daysFromToday(Date.parse(x.due), now) <= 1;
  }).map((x) => ({ kind: 'todo', id: x.id, title: x.topic, at: x.due, note: x.dueLabel }));
  // 提醒三：长期未回复的消息（待处理且超过 N 天）
  const stale = rows.filter((e) => messageState(e) === 'pending' && now - e._at >= staleReplyDays * DAY)
    .sort((a, b) => a._at - b._at).slice(0, 10)
    .map((e) => ({ kind: 'message', id: e._id, title: e.payload.summary ?? String(e.payload.raw).slice(0, 40), at: e._at, note: `${senderLine(e)} · 已 ${Math.floor((now - e._at) / DAY)} 天未回复` }));

  return {
    stats: {
      todosOpen: t.counts.total - t.counts.done,
      messagesPending: m.counts.pending,
      schedules7d: s.counts.next7,
      notes7d: n.list.filter((x) => Date.parse(x.date ?? 0) >= dayStart(now) - 7 * DAY).length,
      notesTotal: n.counts.total,
    },
    reminders: { upcoming, urgent, stale },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（夹具；临时运行态，不碰真实数据）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeEvent } = await import('../schema.mjs');

  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prev = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-pages-'));
  process.env.WB_V1_OUT = tmp;
  const NOW = Date.parse('2026-10-12T10:00:00+08:00');
  const D = (s) => Date.parse(`${s}T09:00:00+08:00`);

  try {
    // 消息：4 条，覆盖四种状态
    const msg = (mid, raw, ops = []) => {
      const e = makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw, summary: raw.slice(0, 20), source: 'im', modality: 'text' }, origin: { channel: 'dingtalk', sender: '张伟', messageId: mid }, _at: D('2026-10-01') }).event;
      e.ops = ops; return e;
    };
    store.upsert(msg('m1', '待处理的一条'));
    store.upsert(msg('m2', '转成待办的一条', [{ op: 'to-todo' }]));
    store.upsert(msg('m3', '转成日程的一条', [{ op: 'to-schedule' }]));
    store.upsert(msg('m4', '已回复的一条', [{ op: 'replied' }]));

    const M = messages({ now: NOW });
    chk('PG-1', '消息页四个数字对得上（待处理1/转待办1/转日程1/已回复1）', M.counts.pending === 1 && M.counts.toTodo === 1 && M.counts.toSchedule === 1 && M.counts.replied === 1, JSON.stringify(M.counts));
    chk('PG-2', '★ Tab 过滤（需求 3.3.3 的五个 Tab）', messages({ tab: 'to-todo', now: NOW }).list.length === 1 && messages({ tab: 'all', now: NOW }).list.length === 4);
    chk('PG-3', '列表字段齐：来源+发信人+概括', /钉钉 · 张伟/.test(M.list[0].source) && typeof M.list[0].summary === 'string');

    // 待办：逾期 / 今天 / 无期限 / 已完成
    const todo = (mid, topic, due, ops = []) => store.upsert(makeEvent({ type: 'todo', payload: { topic, detail: '细节', due, executor: '我', publisher: '张伟' }, origin: { channel: 'manual', sender: '我', messageId: mid }, _at: NOW }).event);
    todo('t1', '逾期的活', '2026-10-09');
    todo('t2', '今天到期', '2026-10-12');
    todo('t3', '没有期限', null);
    const t4 = makeEvent({ type: 'todo', payload: { topic: '已完成的', detail: '细节', due: '2026-10-12' }, origin: { channel: 'manual', sender: '我', messageId: 't4' }, _at: NOW }).event;
    t4.ops = [{ op: 'done' }]; store.upsert(t4);

    const T = todos({ now: NOW });
    chk('PG-4', '★ 逾期项并入"今日"（today 2 = 逾期1+今天1；week 1；待定1；已完成1）', T.counts.today === 2 && T.counts.week === 1 && T.counts.undecided === 1 && T.counts.done === 1 && T.counts.overdue === 1, JSON.stringify(T.counts));
    const tl = todos({ bucket: 'today', now: NOW }).list;
    chk('PG-5', '★ "距离截止时间"是人话（逾期/今天）', tl.some((x) => x.dueLabel === '已逾期 3 天') && tl.some((x) => x.dueLabel === '今天'), JSON.stringify(tl.map((x) => x.dueLabel)));
    chk('PG-6', '逾期被标出来（前端可标红）+ 逾期排在最前', tl.find((x) => x.topic === '逾期的活')?.overdue === true && tl.find((x) => x.topic === '今天到期')?.overdue === false && tl[0].topic === '逾期的活', JSON.stringify(tl.map((x) => [x.topic, x.overdue])));
    chk('PG-6b', '★ 负向对照：逾期的活**不会**在任何桶里消失（早先的 bug 就是它掉进缝隙）', ['today', 'week', 'undecided'].some((b) => todos({ bucket: b, now: NOW }).list.some((x) => x.topic === '逾期的活')), JSON.stringify(['today', 'week', 'undecided'].map((b) => todos({ bucket: b, now: NOW }).list.map((x) => x.topic))));

    // 日程：今天 / 未来7天 / 前30天已完成
    // ★ 日程时间口径：schema 只接受 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`（**本地时间、不带时区**）
    //   —— 带 +08:00 会被校验器拒（实测）。理由：全系统单时区（我的机器），
    //      带偏移反而制造"同一时刻两种写法"的分歧；绝对时刻由事件的 `_at`（毫秒）承担。
    const sch = (mid, topic, start, ops = []) => { const e = makeEvent({ type: 'schedule', payload: { topic, start, end: start, place: '线上', participants: ['我'] }, origin: { channel: 'dingtalk', sender: '我', messageId: mid }, _at: NOW }).event; e.ops = ops; return store.upsert(e); };
    sch('s1', '今天开会', '2026-10-12T14:00');
    sch('s2', '三天后评审', '2026-10-15T14:00');
    sch('s3', '上周已开完', '2026-10-05T14:00', [{ op: 'done' }]);
    const S = schedules({ now: NOW });
    chk('PG-7', '日程三个桶（今日1/未来7天2/前30日已完成1）', S.counts.today === 1 && S.counts.next7 === 2 && S.counts.done30 === 1, JSON.stringify(S.counts));

    // 笔记：总数 / 本月新增 / 标签数
    store.upsert(makeEvent({ type: 'note', payload: { topic: 'A', date: '2026-10-05', content_md: 'x', tags: ['采集', '设计'] }, origin: { channel: 'dingtalk', sender: '我', messageId: 'n1' }, _at: NOW }).event);
    store.upsert(makeEvent({ type: 'note', payload: { topic: 'B', date: '2026-09-28', content_md: 'y', tags: ['设计'] }, origin: { channel: 'dingtalk', sender: '我', messageId: 'n2' }, _at: NOW }).event);
    const N = notes({ now: NOW });
    chk('PG-8', '笔记三个数（总数2/本月新增1/标签数2）', N.counts.total === 2 && N.counts.thisMonth === 1 && N.counts.tags === 2, JSON.stringify(N.counts));

    // 总览
    const O = overview({ now: NOW });
    chk('PG-9', '总览四个数齐（待完成待办/待处理消息/近7日日程/近一周笔记）', O.stats.todosOpen === 3 && O.stats.messagesPending === 1 && O.stats.schedules7d === 2 && typeof O.stats.notes7d === 'number', JSON.stringify(O.stats));
    chk('PG-10', '★ 提醒一：重要日程（未来7天）', O.reminders.upcoming.length === 2 && O.reminders.upcoming[0].kind === 'schedule', JSON.stringify(O.reminders.upcoming.map((x) => x.title)));
    chk('PG-11', '★ 提醒二：逾期/临期任务', O.reminders.urgent.some((x) => x.note === '已逾期 3 天') && O.reminders.urgent.some((x) => x.note === '今天'), JSON.stringify(O.reminders.urgent.map((x) => x.note)));

    // ★ PG-20…24：日程密度热力图（需求 3.3.5）
    const HM = scheduleHeatmap({ now: NOW });
    chk('PG-20', '★ 热力图按月出格子（当月天数 + 前置空格对齐星期）', HM.grid.length === HM.cells.length + HM.lead && HM.cells.length === HM.daysInMonth, JSON.stringify({ grid: HM.grid.length, cells: HM.cells.length, lead: HM.lead, days: HM.daysInMonth }));
    chk('PG-21', '★ 热力分档 0–4（当天条数越多越热；≥4 归 4）', HM.cells.every((c) => c.level === (c.count <= 0 ? 0 : c.count >= 4 ? 4 : c.count)), JSON.stringify(HM.cells.filter((c) => c.count > 0).map((c) => [c.date, c.count, c.level])));
    chk('PG-22', '★ 动态分析**每条都有数可回查**（不写没有依据的话）', Array.isArray(HM.analysis) && HM.analysis.length > 0 && HM.analysis.every((s) => typeof s === 'string' && s.length > 0), JSON.stringify(HM.analysis.slice(0, 2)));
    chk('PG-23', '★ 负向对照：**没数据就不分析**（不生成一段看起来像分析的文本）', (function () {
      const prev = process.env.WB_V1_OUT;
      const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-hm-'));
      process.env.WB_V1_OUT = t2;
      try { const h = scheduleHeatmap({ now: NOW }); return h.totals.count === 0 && h.analysis.length === 1 && h.analysis[0].includes('没有数据就不分析'); }
      finally { if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev; try { fs.rmSync(t2, { recursive: true, force: true }); } catch { /* noop */ } }
    })());
    chk('PG-24', '★ 热力图是**纯规则**：不调模型（无网络/无 spawn 依赖，只有统计）', HM.busiestHour === null || typeof HM.busiestHour.hour === 'number', JSON.stringify(HM.busiestHour));
    chk('PG-12', '★ 提醒三：长期未回复消息（>3天、待处理）', O.reminders.stale.length === 1 && /未回复/.test(O.reminders.stale[0].note), JSON.stringify(O.reminders.stale));
    chk('PG-13', '★ 负向对照：已处理的消息不进"未回复"清单', !O.reminders.stale.some((x) => /已回复|转成/.test(x.title)));
    chk('PG-14', 'dueLabel 边界（明天/昨天）', dueLabel(D('2026-10-13'), NOW) === '明天' && dueLabel(D('2026-10-11'), NOW) === '昨天', `${dueLabel(D('2026-10-13'), NOW)} / ${dueLabel(D('2026-10-11'), NOW)}`);
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
