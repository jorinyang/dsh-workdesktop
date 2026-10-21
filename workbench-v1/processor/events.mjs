#!/usr/bin/env node
/**
 * `v1/processor/events.mjs` —— **把「会话 × 天」聚合成「事件」**（页面层，不是采集层）。
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 规范：`Research/Output/个人工作台/02-规范与标准/SPEC_事件聚合规范.md`
 * 本文件只做规范第 2、4、6、7 节的机器部分；范围怎么扩、什么算同一件事，以规范为准。
 *
 * 三层（规范第八、九节）：
 *   第一层 **会话 × 天 → 事件**：一个会话一天 = 一个事件。**不调模型**，确定性，永远有结果。
 *   第二层 **每小时聚类**：把当天 0:00 到现在的事件并成几件。**调模型**，失败退回第一层。
 *   第三层 **会话级上下文总结**：已有（`conv-context.mjs`，每 15 分钟），本模块**读它**当第二层的输入。
 *
 * ⚠️ 三层的关系别搞反：第三层是**输入**，第二层是**输出**。事件级总结由第二层顺带产出，
 *   不单独立层 —— 否则就成了"先有事件才能总结、先有总结才能分事件"。
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 四条纪律
 *
 *   一、**不编事件**。模型没答 ⇒ 标记 `clustered:false`，退回一层，不产生空标题、不产生空事件。
 *   二、**事件 id 要稳**。重算前后同一件事的 id 不变（规范 8.1）。
 *      做法：`起始日 + 事件内最早那条会话的 id`。重算时同一批会话会算出同一个 id。
 *   三、**文档两条来源分开存、分开显示**（规范 7.2）。本地路径与线上链接**没有共同 id**，
 *      不假装它们配对 —— 配错比不配对更糟（读者会点开错的东西）。
 *   四、**页面渲染这一层只做快的**。正文链接是纯字符串处理，当场算；
 *      召回（要打检索桥）与模型聚类放 `enrichDay()`，由每小时那一轮跑完写进缓存。
 *      ⇒ 页面打开不等模型，也不会因为检索桥挂了就打不开。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { v1Out } from '../paths.mjs';
import * as store from '../store.mjs';
import { conversations, dayOf } from './conversations.mjs';

// ── 路径 ────────────────────────────────────────────────────────────────────────
export function eventsDir() { return path.join(v1Out(), 'events'); }
export function dayFile(day) { return path.join(eventsDir(), `${day}.json`); }

/** 读某天的事件缓存（没有就返回 null —— **不造空壳**） */
export function loadDay(day) {
  try { return JSON.parse(fs.readFileSync(dayFile(day), 'utf8')) } catch { return null }
}
export function saveDay(day, doc) {
  fs.mkdirSync(eventsDir(), { recursive: true });
  fs.writeFileSync(dayFile(day), JSON.stringify(doc, null, 2), 'utf8');
}

// ── 正文字符串处理 ──────────────────────────────────────────────────────────────

/**
 * 从一段正文里抽线上链接。
 *
 * 实测（规范 7.2）：910 条消息里 157 条自带网址，`alidocs.dingtalk.com` 占 156 次 —— 钉钉文档。
 * 另有 `n.dingtalk.com`、`img.alicdn.com`（图片，不算文档）、`page.dingtalk.com` 等。
 *
 * ⚠️ **图片链接不算文档**，要从结果里剔掉，否则"相关文档"里全是图片缩略图地址。
 *    实测 `img.alicdn.com` / `gw.alicdn.com` 是图片 CDN。
 */
const DOC_HOST_ALLOW = /(alidocs\.dingtalk\.com|docs\.dingtalk\.com|feishu\.cn|larksuite\.com|docs\.qoder\.com|shanji\.dingtalk\.com|dingtalk\.com\/app\/transcribes)/i;
const IMG_HOST = /(img\.alicdn\.com|gw\.alicdn\.com|\.png(\?|$)|\.jpg(\?|$)|\.jpeg(\?|$))/i;

export function extractUrls(text) {
  const s = String(text ?? '');
  const out = [];
  const seen = new Set();
  for (const m of s.matchAll(/https?:\/\/[^\s"'）)】\]]+/g)) {
    let u = m[0].replace(/[.,;，。；、]+$/, '');
    if (IMG_HOST.test(u)) continue;                       // 图片 CDN 不是文档
    if (u.length > 600) u = u.slice(0, 600);              // 防超长串把页面撑坏
    if (seen.has(u)) continue;
    seen.add(u); out.push(u);
  }
  // 文档域名排前面（读者更关心它们）
  out.sort((a, b) => (DOC_HOST_ALLOW.test(b) ? 1 : 0) - (DOC_HOST_ALLOW.test(a) ? 1 : 0));
  return out;
}

/** 把一串消息压成给人看的几行（卡片里只放少量，全文在会话详情里） */
export function sampleLines(messages, max = 3) {
  const list = Array.isArray(messages) ? messages : [];
  const picked = list.slice(-max);                        // 取最近的几条
  return picked.map((e) => ({
    time: (() => {
      const d = new Date(e._at); const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}`;
    })(),
    sender: String(e.payload?.sender ?? ''),
    text: String(e.payload?.summary ?? e.payload?.raw ?? '').slice(0, 120),
  }));
}

// ── 听记 ────────────────────────────────────────────────────────────────────────

/**
 * 取所有听记（`notes` 里 `payload.source === 'minutes'`）。
 *
 * 关联依据（规范 7.1）：**日期 + 时间 + 标题/关键词的语义**，**不用参与人**
 *   —— 实测 23 条听记里只有 6 条有参与人字段，且除本人外 0 个别人，那条路是断的。
 *
 * 跳转地址：`origin.raw`（实测形如 `https://shanji.dingtalk.com/app/transcribes/<taskUuid>`）。
 */
export function allMinutes() {
  const notes = store.list({ type: 'note' }) ?? [];
  const out = [];
  for (const e of notes) {
    const p = e.payload ?? {};
    if (String(p.source ?? '') !== 'minutes') continue;
    const md = String(p.content_md ?? '');
    const timeStr = /-\s*时间[:：]\s*([^\n]+)/.exec(md)?.[1]?.trim() ?? '';
    const dur = /-\s*时长[:：]\s*([^\n]+)/.exec(md)?.[1]?.trim() ?? '';
    const kw = /##\s*关键词\n+([^\n]+)/.exec(md)?.[1]?.trim() ?? '';
    out.push({
      id: e._id,
      topic: String(p.topic ?? ''),
      date: String(p.date ?? ''),
      time: timeStr,
      duration: dur,
      keywords: kw,
      // ★ 跳转地址：origin.raw 是原始链接；拿不到就退到正文里的第一个网址
      url: String(e.origin?.raw ?? '').trim() || (extractUrls(md).find((u) => /transcribes/i.test(u)) ?? ''),
    });
  }
  return out;
}

/** 「2026-10-12 16:04」⇒ 毫秒；解不出返回 null（不猜） */
export function parseMinuteTime(s) {
  const m = /(\d{4})-(\d{2})-(\d{2})[\sT]+(\d{2}):(\d{2})/.exec(String(s ?? ''));
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 给一个事件挑听记（规范 7.1：落在事件时间范围 ±2 小时）。
 *
 * ⚠️ 这个函数**只判"能不能挂"**；"一件会只能挂一处"由 `assignMinutes()` 统一分派。
 *    第一版直接在组装时逐事件调它 ⇒ **同一天的 20 个事件全挂上了同一批听记**
 *    （实测 2026-10-12：28 个事件里 20 个都带听记）——
 *    听记是稀缺资源（全库 23 条），一场会挂到二十处，等于"相关听记"这一栏失去意义。
 */
export const MINUTE_WINDOW_MS = 2 * 3600 * 1000;
export function pickMinutes(minutes, { startAt, endAt }) {
  const lo = (startAt ?? 0) - MINUTE_WINDOW_MS;
  const hi = (endAt ?? startAt ?? 0) + MINUTE_WINDOW_MS;
  return (minutes ?? []).filter((m) => {
    const t = parseMinuteTime(m.time);
    // 没有具体时间的听记，**不硬挂**（挂错比不挂糟；规范 5.3 的取向一致）
    if (t === null) return false;
    return t >= lo && t <= hi;
  });
}

/**
 * 把听记**全局分派**给事件：一条听记只归**最接近的那一件**（超出 ±2 小时则不挂）。
 *
 * ⚠️ 距离**按事件的最近一条消息算**，不是按"时间范围"算。
 *   第一版用范围 ⇒ 实测踩到：`AI听记助手` 那个会话跨了全天（10:31–21:20），
 *   于是它的"距离"恒为 0，**当天所有听记全被它吃掉**。
 *
 * ⚠️ **听记机器人自己的事件不接听记**（`MINUTE_BOT_SENDERS`）。
 *   那些消息本身就是"某场听记已生成"的通知 —— 把听记挂回去等于自己挂自己，
 *   既没有信息量，还会因为时间紧邻而抢走本该挂给"讨论那件事"的事件。
 *
 * @param {object[]} events 事件（要有 id / startAt / endAt）
 * @param {object[]} minutes 全部听记
 * @param {Map<string, number[]>} [timesById] 事件 id → 该事件内所有消息时间
 * @returns {Map<string, object[]>}
 */
export const MINUTE_BOT_SENDERS = Object.freeze(['AI听记助手', '钉钉听记']);
export function assignMinutes(events, minutes, timesById = null) {
  const out = new Map((events ?? []).map((e) => [e.id, []]));
  // 只把能接听记的事件放进候选池
  const pool = (events ?? []).filter((e) => {
    const senders = [...new Set((e.conversations ?? []).map((c) => String(c.sender ?? '')))];
    if (!senders.length) return true;
    return !senders.every((s) => MINUTE_BOT_SENDERS.includes(s));
  });
  for (const m of minutes ?? []) {
    const t = parseMinuteTime(m.time);
    if (t === null) continue;
    let best = null; let bestD = Infinity;
    for (const e of pool) {
      const times = timesById?.get(e.id) ?? null;
      let d;
      if (times && times.length) {
        d = Infinity;
        for (const x of times) { const dd = Math.abs(t - x); if (dd < d) d = dd }
      } else {
        // 没有逐条时间就退回范围距离（区间内算 0）
        const lo = e.startAt ?? 0; const hi = e.endAt ?? lo;
        d = t < lo ? lo - t : (t > hi ? t - hi : 0);
      }
      if (d < bestD) { bestD = d; best = e }
    }
    if (best && bestD <= MINUTE_WINDOW_MS) out.get(best.id).push(m);
  }
  return out;
}

// ── 第一层：会话 × 天 → 事件 ────────────────────────────────────────────────────

/** 事件 id：**起始日 + 事件内最早那条会话的 id**（重算前后不变，见纪律二） */
export function eventIdOf(day, convIds) {
  const first = [...(convIds ?? [])].sort()[0] ?? 'none';
  // 会话 id 形如 `2026-10-21__cid:xxx` —— 带 `/`、`+`、`=`，不能直接进 URL 与 DOM 属性
  const safe = String(first).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 60);
  return `evt_${day}_${safe}`;
}

/**
 * 组装一个事件对象。**纯函数**，便于自检（第八节那几条检查都靠它）。
 * @param {{day:string, convs:object[], msgsById:Map, minutes?:object[], docsByEvent?:object, contextByEvent?:object, clustered?:string|null}} o
 */
export function makeEvent({ day, convs, msgsById, minutes = [], docsByEvent = null, contextByEvent = null, clustered = null }) {
  const convsSorted = [...convs].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  // ★ 时间范围用**真实消息的时间跨度**，不用 `c.at`。
  //   实测 `conversations()` 给的 `at` 是**最后一条消息**的时间 ⇒ 单会话事件会塌成一个点，
  //   于是"落在事件时间范围内"这种判断失去依据（听记就只能靠 ±2 小时硬窗去猜）。
  const allTimes = [];
  for (const c of convsSorted) for (const mid of (c.ids ?? [])) {
    const t = msgsById.get(mid)?._at;
    if (Number.isFinite(t)) allTimes.push(t);
  }
  const startAt = allTimes.length ? Math.min(...allTimes) : Math.min(...convsSorted.map((c) => c.at ?? 0));
  const endAt = allTimes.length ? Math.max(...allTimes) : Math.max(...convsSorted.map((c) => c.at ?? 0));
  const ids = convsSorted.map((c) => c.id);
  const id = eventIdOf(day, ids);

  // 会话细节：把每条会话的少量原文样例带上（卡片里要能看见内容，不只一个标题）
  const conversationsOut = convsSorted.map((c) => {
    const msgs = (c.ids ?? []).map((mid) => msgsById.get(mid)).filter(Boolean);
    return {
      id: c.id,
      day: c.day ?? day,
      time: c.time ?? '',
      at: c.at ?? 0,
      channel: c.channel ?? '',
      sender: c.sender ?? '',
      count: c.count ?? msgs.length,
      lastSummary: c.lastSummary ?? '',
      state: c.state ?? 'pending',
      samples: sampleLines(msgs, 3),
    };
  });

  // 线上链接：把本事件所有会话（含样例原文）里的网址抽出来、去重
  const online = [];
  {
    const seen = new Set();
    for (const c of convsSorted) for (const mid of (c.ids ?? [])) {
      const e = msgsById.get(mid); if (!e) continue;
      for (const u of extractUrls(`${e.payload?.raw ?? ''} ${e.payload?.summary ?? ''}`)) {
        if (seen.has(u)) continue; seen.add(u); online.push(u);
      }
    }
  }

  // 本地路径：**只读缓存**（召回要打检索桥，页面渲染不等它 —— 纪律四）
  const local = Array.isArray(docsByEvent?.[id]) ? docsByEvent[id] : [];

  const mins = pickMinutes(minutes, { startAt, endAt });
  // 上下文：本事件内各会话的 15 分钟总结，拼成一段（带上时间，便于判断新旧）
  const ctxParts = conversationsOut
    .map((c) => {
      const got = contextByEvent?.[c.id];
      if (!got || got.ok !== true || !String(got.text ?? '').trim()) return null;
      return { at: got.at ?? null, text: String(got.text).trim() };
    })
    .filter(Boolean);

  return {
    id,
    day,
    title: titleOf(conversationsOut),
    startAt,
    endAt,
    timeRange: timeRangeOf(startAt, endAt),
    conversations: conversationsOut,
    context: ctxParts,
    docs: { local, online },
    minutes: mins,
    counts: {
      convs: conversationsOut.length,
      messages: conversationsOut.reduce((n, c) => n + (c.count ?? 0), 0),
      docs: local.length + online.length,
      minutes: mins.length,
    },
    // `clustered` = null（只有一层）/ 'model'（二层已聚类）/ 'reverted'（二层跑了但退回一层）
    clustered: clustered ?? null,
    why: null,
  };
}

/** 事件标题：会话少 ⇒ 用发信人/群名；会话多 ⇒ 用「A、B 等 N 个会话」 */
export function titleOf(convs) {
  const names = [...new Set((convs ?? []).map((c) => String(c.sender ?? '').trim()).filter(Boolean))];
  if (!names.length) return '（无标题）';
  if (names.length <= 2) return names.join(' · ');
  return `${names.slice(0, 2).join(' · ')} 等 ${names.length} 人`;
}

/** 时间范围：同一天就只显示时钟；不然带上日期 */
export function timeRangeOf(startAt, endAt) {
  if (!startAt) return '';
  const hm = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}` };
  if (!endAt || endAt === startAt) return hm(startAt);
  return `${hm(startAt)}–${hm(endAt)}`;
}

// ── 对外：取某天的事件 ──────────────────────────────────────────────────────────

/**
 * 取一天的事件。
 *
 * @param {{day?:string|null, now?:number, withCache?:boolean, limit?:number}} o
 * @returns {{day:string, events:object[], counts:object, clustered:boolean, why:string|null}}
 */
export function buildEvents({ day = null, now = Date.now(), withCache = true, limit = 200 } = {}) {
  const targetDay = day || dayOf(now);
  const cv = conversations({ tab: 'all', day: targetDay, limit: 1000, now });
  const convs = (cv.list ?? []).filter((c) => String(c.day ?? '') === targetDay);

  // 消息索引：拿 id → 事件（一次读完，别在循环里反复 list）
  const msgs = store.list({ type: 'message' }) ?? [];
  const msgsById = new Map(msgs.map((e) => [e._id, e]));

  const minutes = allMinutes();
  const cache = withCache ? loadDay(targetDay) : null;
  const docsByEvent = cache?.docsByEvent ?? null;
  const contextByEvent = cache?.contextByEvent ?? null;

  // 第二层：缓存里给了「哪些会话归哪一件」就按它分；没给 ⇒ 一层 1:1
  let groups;
  let clustered = null;
  if (cache && Array.isArray(cache.assignments) && cache.assignments.length) {
    const byConv = new Map();
    for (const a of cache.assignments) for (const cid of (a.convIds ?? [])) byConv.set(cid, a.eventKey ?? a.convIds?.[0] ?? cid);
    const buckets = new Map();
    for (const c of convs) {
      const k = byConv.get(c.id) ?? c.id;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(c);
    }
    groups = [...buckets.values()].sort((a, b) => Math.min(...a.map((x) => x.at ?? 0)) - Math.min(...b.map((x) => x.at ?? 0)));
    clustered = cache.clusterOk === true ? 'model' : 'reverted';
  } else {
    groups = convs.map((c) => [c]);
  }

  const events = groups.slice(0, limit).map((g) => {
    const ev = makeEvent({ day: targetDay, convs: g, msgsById, minutes: [], docsByEvent, contextByEvent, clustered });
    return ev;
  });

  // ★ 听记**全局分派**（一条听记只归最接近的那一件）—— 见 `assignMinutes` 的注释。
  //   逐条消息时间要先备好，否则跨全天的事件会把所有听记吃掉。
  const timesById = new Map();
  for (const e of events) {
    const arr = [];
    for (const c of e.conversations) {
      const orig = convs.find((x) => x.id === c.id);
      for (const mid of (orig?.ids ?? [])) { const t = msgsById.get(mid)?._at; if (Number.isFinite(t)) arr.push(t) }
    }
    timesById.set(e.id, arr.sort((a, b) => a - b));
  }
  const assigned = assignMinutes(events, minutes, timesById);
  for (const e of events) {
    e.minutes = assigned.get(e.id) ?? [];
    e.counts.minutes = e.minutes.length;
  }

  return {
    day: targetDay,
    events,
    counts: {
      events: events.length,
      convs: events.reduce((n, e) => n + e.counts.convs, 0),
      messages: events.reduce((n, e) => n + e.counts.messages, 0),
      pending: events.filter((e) => e.conversations.some((c) => c.state === 'pending')).length,
      withDocs: events.filter((e) => e.counts.docs > 0).length,
      withMinutes: events.filter((e) => e.counts.minutes > 0).length,
    },
    clustered: clustered === 'model',
    why: cache ? (cache.why ?? null) : '这一天还没跑聚类（现在是第一层：一个会话一天 = 一件）',
  };
}

/** 取一个事件（按 id）—— 详情用 */
export function eventById(id, { now = Date.now() } = {}) {
  const m = /^evt_(\d{4}-\d{2}-\d{2})_/.exec(String(id ?? ''));
  if (!m) return null;
  const r = buildEvents({ day: m[1], now, limit: 5000 });
  return r.events.find((e) => e.id === id) ?? null;
}

/** 最近有事件的日子（页面顶部日期切换用）——只列**真有会话**的那些天 */
export function recentDays({ limit = 14, now = Date.now() } = {}) {
  const rows = store.list({ type: 'message' }) ?? [];
  const days = [...new Set(rows.map((e) => dayOf(e._at)))].sort().reverse();
  return days.slice(0, limit);
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  // EVT-A 抽链接：文档留下、图片剔掉
  {
    const s = '看这个 https://alidocs.dingtalk.com/i/nodes/abc 和图片 https://img.alicdn.com/x.png 还有 https://example.com/a ';
    const got = extractUrls(s);
    chk('EVT-A1', '★ 抽线上链接：文档链接留下、图片 CDN 剔掉',
      got.includes('https://alidocs.dingtalk.com/i/nodes/abc') && !got.some((u) => /img\.alicdn/.test(u)) && got.includes('https://example.com/a'),
      JSON.stringify(got));
    chk('EVT-A2', '同一段里的重复链接只算一次',
      extractUrls('https://a.example/x https://a.example/x').length === 1, '');
    chk('EVT-A3', '空正文不报错、返回空数组', extractUrls('').length === 0 && extractUrls(null).length === 0, '');
  }

  // EVT-B 事件 id 稳定（纪律二）：同一批会话，顺序不同 ⇒ 同一个 id
  {
    const a = eventIdOf('2026-10-21', ['b', 'a', 'c']);
    const b = eventIdOf('2026-10-21', ['c', 'a', 'b']);
    chk('EVT-B1', '★★ 事件 id 稳定：同一批会话（顺序不同）算出同一个 id', a === b, `${a} vs ${b}`);
    const c = eventIdOf('2026-10-22', ['a', 'b', 'c']);
    chk('EVT-B2', '★ 负向：不同日期 ⇒ 不同 id（不串天）', a !== c, `${a} vs ${c}`);
    chk('EVT-B3', 'id 里不含 / + = 这类会破坏 URL 与 DOM 属性的字符',
      !/[\/+=]/.test(eventIdOf('2026-10-21', ['2026-10-21__cid:cidNJ/nF+Dwu='])), eventIdOf('2026-10-21', ['2026-10-21__cid:cidNJ/nF+Dwu=']));
  }

  // EVT-C 听记时间解析与挑拣
  {
    const t = parseMinuteTime('2026-10-12 16:04');
    chk('EVT-C1', '听记时间「2026-10-12 16:04」解得出来', Number.isFinite(t), String(t));
    chk('EVT-C2', '★ 负向：没有具体时间（只有日期/空）⇒ 返回 null，不猜',
      parseMinuteTime('2026-10-12') === null && parseMinuteTime('') === null, '');
    const mins = [
      { id: 'm1', time: '2026-10-12 16:04', topic: 'A' },
      { id: 'm2', time: '2026-10-12 03:00', topic: 'B' },   // 差 13 小时 ⇒ 不该挂
      { id: 'm3', time: '', topic: 'C' },                     // 没时间 ⇒ 不硬挂
    ];
    const start = parseMinuteTime('2026-10-12 16:00');
    const picked = pickMinutes(mins, { startAt: start, endAt: start + 60000 }).map((x) => x.id);
    chk('EVT-C3', '★★ 听记落在事件 ±2 小时内才挂；差 13 小时的不挂、没时间的也不挂',
      picked.length === 1 && picked[0] === 'm1', JSON.stringify(picked));
  }

  // EVT-D 事件组装：时间范围、标题、条数
  {
    const day = '2026-10-21';
    const mk = (id, at, sender, raw) => ({ _id: id, _at: at, payload: { sender, raw, summary: raw } });
    const msgs = [
      mk('m1', Date.parse('2026-10-21T09:00:00'), '甲', '早上的话 https://alidocs.dingtalk.com/i/nodes/x'),
      mk('m2', Date.parse('2026-10-21T09:30:00'), '乙', '再看这个 https://feishu.cn/docx/abc'),
    ];
    const msgsById = new Map(msgs.map((e) => [e._id, e]));
    const convs = [{
      id: '2026-10-21__cid:A', day, time: '09:00', at: Date.parse('2026-10-21T09:00:00'),
      channel: '钉钉', sender: '甲', count: 2, lastSummary: '乙：再看这个', state: 'pending',
    ids: ['m1', 'm2'] }];
    const ev = makeEvent({ day, convs, msgsById, minutes: allMinutes() });
    chk('EVT-D1', '事件的标题、时间范围、条数都对（时间范围用真实消息跨度，不是最后一条的时间）',
      ev.title === '甲' && ev.timeRange === '09:00–09:30' && ev.counts.convs === 1 && ev.counts.messages === 2,
      `${ev.title} / ${ev.timeRange} / ${JSON.stringify(ev.counts)}`);
    chk('EVT-D2', '★ 线上链接从正文抽出来、挂在事件上（两条不同域名）',
      ev.docs.online.length === 2 && ev.docs.online.some((u) => /alidocs/.test(u)) && ev.docs.online.some((u) => /feishu/.test(u)),
      JSON.stringify(ev.docs.online));
    chk('EVT-D3', '★ 本地路径**只来自缓存**：缓存没给就是空数组（不在渲染时现打检索桥）',
      Array.isArray(ev.docs.local) && ev.docs.local.length === 0, JSON.stringify(ev.docs.local));
    chk('EVT-D4', '会话样例带上时间/发信人/正文（卡片里要能看见内容）',
      ev.conversations[0].samples.length === 2 && ev.conversations[0].samples[0].time === '09:00',
      JSON.stringify(ev.conversations[0].samples).slice(0, 120));
  }

  // EVT-E 真实数据：今天能建出事件，且白名单群的会话在里面（规范 10.3 EVT-1）
  {
    try {
      const day = dayOf(Date.now());
      const r = buildEvents({ day, withCache: false });
      chk('EVT-E1', '★ 真实数据：今天能建出事件（第一层，不依赖模型）', r.events.length >= 0, `事件 ${r.events.length} 件 / 会话 ${r.counts.convs} 个`);
      // 白名单群是否参与：拿 im-scope.yml 的 cid 与今天会话的 conversationId 对一遍
      const names = [...new Set(r.events.flatMap((e) => e.conversations.map((c) => c.sender)).filter(Boolean))];
      chk('EVT-E2', '真实数据：事件里带着发信人/群名（不是空标题）', r.events.every((e) => e.title !== '（无标题）') || r.events.length === 0, `${names.length} 个不同来源`);
    } catch (e) {
      chk('EVT-E1', '★ 真实数据：今天能建出事件（第一层，不依赖模型）', false, String(e?.message ?? e).slice(0, 150));
    }
  }

  // EVT-F 负向：坏 id 不该炸
  {
    chk('EVT-F1', '★ 负向：乱写的 id ⇒ 返回 null（不抛错、不返回空壳）', eventById('乱写') === null, '');
  }

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}

// ── 命令行 ──────────────────────────────────────────────────────────────────────
const __isMain = (() => { try { return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url } catch { return false } })();
if (__isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    const r = await selfTest();
    console.log(`events selftest: PASS=${r.pass} FAIL=${r.fail}`);
    for (const d of r.details) if (!d.ok) console.log(`  FAIL ${d.id} :: ${d.desc} :: ${d.detail}`);
    process.exit(r.fail === 0 ? 0 : 1);
  }
  const day = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? dayOf(Date.now());
  const r = buildEvents({ day, withCache: !argv.includes('--no-cache') });
  console.log(`\n# ${day} · ${r.counts.events} 件 · 会话 ${r.counts.convs} · 消息 ${r.counts.messages} · 带文档 ${r.counts.withDocs} · 带听记 ${r.counts.withMinutes}`);
  if (r.why) console.log(`  （${r.why}）`);
  for (const e of r.events.slice(0, 20)) {
    console.log(`\n  ${e.timeRange.padEnd(12)} ${e.title}`);
    console.log(`     会话 ${e.counts.convs} · 消息 ${e.counts.messages} · 文档 ${e.counts.docs}（本地 ${e.docs.local.length} / 线上 ${e.docs.online.length}）· 听记 ${e.counts.minutes}`);
    for (const c of e.conversations) console.log(`       - ${c.time} ${c.channel} · ${c.sender} · ${c.count} 条 · ${String(c.lastSummary).slice(0, 40)}`);
    for (const u of e.docs.online.slice(0, 3)) console.log(`       🔗 ${u.slice(0, 100)}`);
    for (const m of e.minutes) console.log(`       🎙 ${m.topic.slice(0, 50)} · ${m.time} · ${m.url ? '有跳转地址' : '★ 无跳转地址'}`);
  }
}
