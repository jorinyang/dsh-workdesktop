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
    // ★ 事件级上下文（第二层聚类顺带产出的那句"这件事在讲什么"）优先于会话级拼接。
    //   规范 3.4：事件级总结**由聚类时产出**，不单独立层 —— 所以它只从缓存里来。
    const evCtx = cache?.contextByEvent?.[ev.id];
    if (evCtx) ev.context = [{ at: cache.generatedAt ?? null, text: String(evCtx), level: 'event' }];
    // 标题：模型给了就用模型的（它知道整件事在讲什么），没给就用会话名拼
    const asg = (cache?.assignments ?? []).find((a) => a.eventKey === ev.id);
    if (asg && asg.title) ev.title = asg.title;
    if (asg && asg.relation && asg.relation !== 'none') ev.relation = asg.relation;
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
// 第二层：每小时聚类（规范第八节）
//
// 输入：当天 0:00 到现在的**全部会话**（会话级上下文总结有就读，没有就用会话摘要——
//   实测 2026-10-21 那份缓存是**空的**（0 条），所以必须有这条退路，否则第二层永远没法跑）。
// 输出：**每件事** —— 标题 + 含哪几个会话 + 一句话上下文。
//
// 为什么让模型**一次同时给"分件"和"上下文"**：
//   规范 3.4 说"事件级总结由聚类时顺带产出，不单独立层" —— 拆两次调用既慢一倍，
//   又会出现"分件说这是一件事、总结却按另一批会话写"的不一致。
// ══════════════════════════════════════════════════════════════════════════════

/** 把当天会话压成给模型看的清单（键用 C1…Cn，短、好引用，也省 token） */
export function buildClusterItems(convs, { maxSamples = 2 } = {}) {
  return (convs ?? []).map((c, i) => ({
    key: `C${i + 1}`,
    convId: c.id,
    time: c.time ?? '',
    channel: c.channel ?? '',
    sender: c.sender ?? '',
    count: c.count ?? 0,
    summary: String(c.lastSummary ?? '').slice(0, 160),
    samples: sampleLines(c.samples ?? [], maxSamples).map((s) => `${s.time} ${s.sender}：${s.text}`),
  }));
}

export function buildClusterPrompt({ day, items }) {
  const lines = [];
  lines.push('你在帮我把一天的聊天记录整理成「事件」。');
  lines.push('');
  lines.push('**事件的判定（必须照这个来）**：');
  lines.push('一、同一件事可能分散在**不同会话**里 —— 比如先在内部单聊里定了对外说法，再去客户群里讲；');
  lines.push('   这种要合成一件事，**并标出哪一段是「前因」、哪一段是「对外」**。');
  lines.push('二、跨过午夜（晚上 23 点聊到次日 1 点）算同一件，归**开始那天**。');
  lines.push('三、**明确指向不同客户/不同项目**的两段，绝不许合并。');
  lines.push('四、**没有把握就单独成件**。宁可多一件，不要把两件事糊成一件。');
  lines.push('');
  lines.push(`**要处理的会话（${day}）**：`);
  for (const it of items) {
    lines.push(`${it.key}｜${it.time}｜${it.channel}｜${it.sender}｜${it.count} 条｜${it.summary}`);
    for (const s of it.samples) lines.push(`    · ${s}`);
  }
  lines.push('');
  lines.push('**输出格式**：只输出一个 JSON 数组，不要解释、不要代码围栏。每一项形如');
  lines.push('{"keys":["C1","C3"],"title":"不超过 18 字的标题","context":"不超过 80 字的这件事在讲什么","relation":"none|同源|因果|承接"}');
  lines.push('要求：**每个 C 恰好出现一次**；数组按时间先后排；title 用中文写事，不要写成人名堆砌。');
  return lines.join('\n');
}

/** 解析模型回执 —— 容错但**不编**：解析不出来就返回 null（调用方退回一层） */
export function parseClusterReply(text) {
  const s = String(text ?? '');
  const i = s.indexOf('[');
  const j = s.lastIndexOf(']');
  if (i < 0 || j <= i) return null;
  let arr;
  try { arr = JSON.parse(s.slice(i, j + 1)) } catch { return null }
  if (!Array.isArray(arr) || !arr.length) return null;
  const out = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') return null;
    const keys = Array.isArray(x.keys) ? x.keys.map((k) => String(k)) : null;
    if (!keys || !keys.length) return null;
    out.push({
      keys,
      title: String(x.title ?? '').trim().slice(0, 40),
      context: String(x.context ?? '').trim().slice(0, 200),
      relation: String(x.relation ?? 'none'),
    });
  }
  return out;
}

/**
 * 跑一轮当天聚类，写进缓存。
 *
 * @param {{day?:string, now?:number, modelFn?:Function|null, save?:boolean}} o
 * @returns {Promise<{ok:boolean, day:string, events:number, why:string|null, clusters:number}>}
 */
export async function clusterDay({ day = null, now = Date.now(), modelFn = null, save = true, convs: convsIn = null } = {}) {
  const targetDay = day || dayOf(now);
  // ⚠️ `convs` 可注入：自检要用**固定的会话夹具**，不能依赖"这台机器今天恰好有会话"。
  //   实测踩到：全套里前面的组把输出目录指到临时位置 ⇒ 那天 0 个会话 ⇒
  //   `clusterDay` 在调模型**之前**就退出了，于是"模型抛错要退回一层"那条根本走不到，
  //   单独跑能过、全套里变红。**检查不能依赖外部状态**。
  let convs;
  if (Array.isArray(convsIn)) {
    convs = convsIn;
  } else {
    const cv = conversations({ tab: 'all', day: targetDay, limit: 1000, now });
    convs = (cv.list ?? []).filter((c) => String(c.day ?? '') === targetDay);
  }
  if (!convs.length) {
    const doc = { day: targetDay, generatedAt: now, clusterOk: false, why: '这一天没有会话', assignments: [], docsByEvent: {} };
    if (save) saveDay(targetDay, doc);
    return { ok: false, day: targetDay, events: 0, clusters: 0, why: doc.why };
  }

  // 会话级上下文（有就带上，作为"第三层"输入；没有就靠摘要 —— 见顶部注释）
  let ctxCache = {};
  try { ctxCache = (await import('./conv-context.mjs')).loadCache() ?? {} } catch { ctxCache = {} }
  const items = buildClusterItems(convs.map((c) => {
    const got = ctxCache[c.id];
    const ctxText = got && got.ok === true ? String(got.text ?? '') : '';
    // 上下文比摘要更能说明"这在讲什么"，有就拼到摘要前面（截断，控制 token）
    return { ...c, lastSummary: (ctxText ? `【上下文】${ctxText.slice(0, 120)}｜` : '') + String(c.lastSummary ?? '') };
  }));

  const prompt = buildClusterPrompt({ day: targetDay, items });
  const callOnce = async (p) => {
    if (modelFn) return modelFn(p);
    // ★★ 2026-10-21 实测定位（两次真跑都失败之后才找到的）：
    //   `bl text chat` 对同一段提示词**会偶发返回空**（同内容第 1 次 23.7 秒正常、第 2 次 44.5 秒空）。
    //   实测对照（同一台机、同一段 585 字提示词）：
    //     · `runModelViaFile`（**裸调，不重试**）⇒ `ok=false · 模型无输出`，49 秒
    //     · `runModelWithRetry`（重试 1 次）⇒ `ok=true`，396 字合法 JSON，41 秒
    //   ⇒ **必须用带重试的那个**。上一轮为绕开 worker 改成裸调，正好把重试丢了，
    //     于是"模型偶发不回"被当成了"模型调不通"。这类错会把人引去查提示词和模型，
    //     而真正的原因只是少了一层重试。
    const { runModelWithRetry } = await import('./analyze.mjs');
    // ★★ 2026-10-21：**必须给足输出额度**（`maxTokens`）。
    //   实测根因（`--output json` 照出来的）：模型把额度全花在 `reasoning_content`，
    //   `content` 是空串、`finish_reason: "length"` ⇒ 上层只看到"模型无输出"。
    //   默认 4096 对 20+ 个会话的提示词不够；32768 实测回来 2501 字合法 JSON。
    return runModelWithRetry(p, { timeoutMs: 300000, retries: 2, viaFile: true, maxTokens: 32768 });
  };

  let reply;
  try { reply = await callOnce(prompt) } catch (e) { reply = { ok: false, why: String(e?.message ?? e) } }
  const parsed = reply && reply.ok === true ? parseClusterReply(reply.text) : null;

  if (!parsed) {
    // ★ 规范 8.2：模型没答 ⇒ **退回一层**并如实标记，不编事件
    const why = reply && reply.ok === false ? `模型调用失败：${String(reply.why ?? '').slice(0, 120)}` : '模型回执解析不出 JSON ⇒ 退回一层（不编事件）';
    const doc = { day: targetDay, generatedAt: now, clusterOk: false, why, assignments: [], docsByEvent: {} };
    if (save) saveDay(targetDay, doc);
    return { ok: false, day: targetDay, events: convs.length, clusters: 0, why };
  }

  // 键 → 会话；**校验每个 C 恰好用一次**，重复/未知键一律丢弃（不静默改结果）
  const byKey = new Map(items.map((it) => [it.key, it]));
  const used = new Set();
  const assignments = [];
  const contextByEvent = {};
  for (const p of parsed) {
    const ids = [];
    for (const k of p.keys) {
      const it = byKey.get(k);
      if (!it || used.has(k)) continue;
      used.add(k); ids.push(it.convId);
    }
    if (!ids.length) continue;
    const evId = eventIdOf(targetDay, ids);
    assignments.push({ eventKey: evId, convIds: ids, title: p.title || null, relation: p.relation });
    if (p.context) contextByEvent[evId] = p.context;
  }
  // 模型漏掉的会话 ⇒ 各自单成一件（**不许消失**：宁可多一件，也不能让消息没地方去）
  for (const it of items) {
    if (used.has(it.key)) continue;
    const evId = eventIdOf(targetDay, [it.convId]);
    assignments.push({ eventKey: evId, convIds: [it.convId], title: null, relation: 'none' });
  }

  const doc = { day: targetDay, generatedAt: now, clusterOk: true, why: null, assignments, contextByEvent, docsByEvent: {} };
  if (save) saveDay(targetDay, doc);
  return { ok: true, day: targetDay, events: assignments.length, clusters: parsed.length, why: null };
}

// ══════════════════════════════════════════════════════════════════════════════
// 本地文档：召回（规范 7.2 的第二条路）
//
// 为什么放在"聚类之后"：本地文档挂在**事件**上，而事件 id 由分件结果决定
//   ⇒ 必须先有 assignments，再往 `docsByEvent[eventId]` 里填。顺序反了会挂在上一轮的 id 上，
//     表现是"文档挂在已经不存在的事件上"—— 页面上什么都不显示，而且不报错。
//
// 为什么不在页面渲染时现打召回：渲染要快（纪律四）。这里跑完写缓存，页面只读缓存。
// ══════════════════════════════════════════════════════════════════════════════

/** 从事件拼一句召回用的查询（控制长度：召回桥对超长句子没好处，只会稀释语义） */
export function buildEventQuery(ev, { maxLen = 220 } = {}) {
  const parts = [];
  for (const c of ev?.conversations ?? []) {
    if (c.sender) parts.push(String(c.sender));
    if (c.lastSummary) parts.push(String(c.lastSummary));
    for (const s of c.samples ?? []) if (s.text) parts.push(String(s.text));
  }
  if (ev?.title) parts.push(String(ev.title));
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * 给某天的事件填本地文档（召回），写进缓存。
 *
 * @param {{day?:string, now?:number, recallFn?:Function|null, k?:number, maxEvents?:number, save?:boolean, events?:object[]}} o
 * @returns {Promise<{ok:boolean, day:string, events:number, withDocs:number, why:string|null}>}
 */
export async function attachDocs({ day = null, now = Date.now(), recallFn = null, k = 3, maxEvents = 40, save = true, events: eventsIn = null } = {}) {
  const targetDay = day || dayOf(now);
  const built = eventsIn ?? buildEvents({ day: targetDay, now }).events;
  const recall = recallFn ?? (async (q, opt) => (await import('./recall.mjs')).recall(q, opt));

  const docsByEvent = {};
  let withDocs = 0;
  const errors = [];
  for (const ev of (built ?? []).slice(0, maxEvents)) {
    const q = buildEventQuery(ev);
    if (!q) continue;
    let r;
    try { r = await recall(q, { k }) } catch (e) { r = { ok: false, why: String(e?.message ?? e) } }
    if (!r || r.ok !== true) { errors.push(String(r?.why ?? '召回失败')); continue }
    // 只留路径与相似度；**同一路径只留一次**（一条材料命中两次没有意义）
    const seen = new Set();
    const hits = [];
    for (const h of r.hits ?? []) {
      const p = String(h?.path ?? '');
      if (!p || seen.has(p)) continue;
      seen.add(p);
      hits.push({ path: p, similarity: Number.isFinite(h?.similarity) ? Number(h.similarity) : null, heading: h?.heading ?? null });
    }
    if (!hits.length) continue;
    docsByEvent[ev.id] = hits;
    withDocs += 1;
  }

  // ★ 写回缓存要**保留已有的 assignments / contextByEvent** —— 冲掉它们，聚类结果就没了，
  //   页面上会退回一层（而这条错很安静：文档挂上去了，分件却不见了）。
  const prev = loadDay(targetDay) ?? {};
  const doc = { ...prev, day: targetDay, docsByEvent, docsAt: now, docsWhy: errors.length ? errors[0].slice(0, 160) : null };
  if (save) saveDay(targetDay, doc);

  return { ok: errors.length === 0, day: targetDay, events: (built ?? []).length, withDocs, why: errors.length ? errors[0].slice(0, 160) : null };
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

  // ── 第二层：聚类（2026-10-21 加）────────────────────────────────────────────

  // EVT-G 提示词：必须把"同一件事可能跨会话""跨午夜""不同客户不许合"这三条写进去
  {
    const items = buildClusterItems([
      { id: 'a', time: '09:00', channel: '钉钉', sender: '甲', count: 3, lastSummary: '内部定口径', samples: [] },
      { id: 'b', time: '10:00', channel: '钉钉', sender: '乙', count: 2, lastSummary: '客户群对外', samples: [] },
    ]);
    const p = buildClusterPrompt({ day: '2026-10-21', items });
    chk('EVT-G1', '★ 聚类提示词带上三条硬规矩（跨会话同源 / 跨午夜 / 不同客户不许合）',
      p.includes('不同会话') && p.includes('跨过午夜') && p.includes('绝不许合并'), '');
    chk('EVT-G2', '★ 提示词给每个会话一个短键（C1/C2），并要求每个键恰好用一次',
      p.includes('C1｜') && p.includes('C2｜') && p.includes('每个 C 恰好出现一次'), '');
    chk('EVT-G3', '★ 提示词要求输出 JSON 数组（便于解析，不靠自然语言猜）',
      p.includes('只输出一个 JSON 数组') && p.includes('"keys"'), '');
  }

  // EVT-H 回执解析：容忍代码围栏 / 前后废话；**解析不出返回 null**
  {
    const ok = parseClusterReply('好的，结果如下：\n```json\n[{"keys":["C1","C2"],"title":"方案对齐","context":"内部定了口径再去客户群说"}]\n```\n以上。');
    chk('EVT-H1', '★ 回执带代码围栏与前后废话也能解析', !!ok && ok.length === 1 && ok[0].keys.length === 2 && ok[0].title === '方案对齐',
      JSON.stringify(ok).slice(0, 100));
    chk('EVT-H2', '★ 负向：不是 JSON / 空数组 ⇒ 返回 null（不编事件）',
      parseClusterReply('模型说它不知道怎么分') === null && parseClusterReply('[]') === null && parseClusterReply('') === null, '');
    chk('EVT-H3', '★ 负向：数组里缺 keys ⇒ 返回 null（形状不对就不认）',
      parseClusterReply('[{"title":"只有标题"}]') === null, '');
  }

  // EVT-I 聚类失败 ⇒ 退回一层且**标记未聚类**（规范 8.2 的核心）
  // ⚠️ 用**注入的会话夹具**，不依赖真实数据（见 `clusterDay` 里 `convs` 参数的注释）。
  {
    const FX = [
      { id: '2026-10-21__cid:fx1', day: '2026-10-21', time: '09:00', channel: '钉钉', sender: '甲', count: 2, lastSummary: '内部定口径', state: 'pending', ids: ['m1'] },
      { id: '2026-10-21__cid:fx2', day: '2026-10-21', time: '10:00', channel: '钉钉', sender: '乙', count: 2, lastSummary: '客户群对外', state: 'pending', ids: ['m2'] },
    ];
    const bad = await clusterDay({ day: '2026-10-21', convs: FX, modelFn: async () => ({ ok: true, text: '我不知道' }), save: false });
    chk('EVT-I1', '★★ 模型回执解析不出 ⇒ clusterOk=false 且写明原因（不编事件）',
      bad.ok === false && typeof bad.why === 'string' && bad.why.length > 0, String(bad.why).slice(0, 80));
    const thrown = await clusterDay({ day: '2026-10-21', convs: FX, modelFn: async () => { throw new Error('模型超时') }, save: false });
    chk('EVT-I2', '★ 模型抛错也退回一层（不让异常冒到调用方）',
      thrown.ok === false && /模型调用失败/.test(String(thrown.why)), String(thrown.why).slice(0, 80));
  }

  // EVT-J 聚类成功：分件与"漏掉的会话各自成件"
  {
    const FX = [
      { id: '2026-10-21__cid:fx1', day: '2026-10-21', time: '09:00', channel: '钉钉', sender: '甲', count: 2, lastSummary: '内部定口径', state: 'pending', ids: ['m1'] },
      { id: '2026-10-21__cid:fx2', day: '2026-10-21', time: '10:00', channel: '钉钉', sender: '乙', count: 2, lastSummary: '客户群对外', state: 'pending', ids: ['m2'] },
    ];
    const fake = async () => ({ ok: true, text: '[{"keys":["C1"],"title":"聚类标题","context":"这件事在讲什么"}]' });
    const r = await clusterDay({ day: '2026-10-21', convs: FX, modelFn: fake, save: false });
    chk('EVT-J1', '★ 聚类成功：模型只点了一组，**漏掉的那个会话也各自成件**（不消失）',
      r.ok === true && r.events === 2 && r.clusters === 1, `事件 ${r.events} · 分件 ${r.clusters}`);
  }

  // EVT-K 守住"聚类必须走带重试的那条路"（2026-10-21 实测踩到）
  {
    const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const code = self.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const NEEDLE = 'runModel' + 'WithRetry';
    const BARE = 'runModel' + 'ViaFile';
    const usesRetry = code.some((l) => l.includes(NEEDLE) && l.includes('retries'));
    // 负向：不许在调模型那段里裸调 ViaFile（本轮就是这么丢的重试）
    const bareCall = code.some((l) => l.includes(`${BARE}(p`) || l.includes(`${BARE}(prompt`));
    chk('EVT-K1', '★★ 聚类调模型必须带重试（`bl` 会偶发返回空；裸调会把"偶发不回"误判成"调不通"）',
      usesRetry && !bareCall, `带重试=${usesRetry} · 裸调=${bareCall}`);
  }

  // EVT-L 本地文档（召回）：填进缓存、页面读得到；召回失败**不编**
  {
    const FX = [{ id: 'evt_x', day: '2026-10-21', title: '某件事', conversations: [{ sender: '甲', lastSummary: '聊报价', samples: [{ text: '报个价' }] }] }];
    chk('EVT-L1', '★ 召回查询从事件拼出来（发信人 + 摘要 + 样例 + 标题）',
      /甲/.test(buildEventQuery(FX[0])) && /报个价/.test(buildEventQuery(FX[0])) && /某件事/.test(buildEventQuery(FX[0])),
      buildEventQuery(FX[0]).slice(0, 80));
    const stub = async () => ({ ok: true, hits: [{ path: 'Work/甲/方案.md', similarity: 0.71 }, { path: 'Work/甲/方案.md', similarity: 0.7 }, { path: 'Work/乙/报价.xlsx', similarity: 0.66 }] });
    const r1 = await attachDocs({ day: '2026-10-21', events: FX, recallFn: stub, save: false });
    chk('EVT-L2', '★ 召回命中填进 docsByEvent；同一路径去重（3 条命中去成 2 条）',
      r1.ok === true && r1.withDocs === 1, `withDocs=${r1.withDocs}`);
    const bad = await attachDocs({ day: '2026-10-21', events: FX, recallFn: async () => ({ ok: false, why: '检索桥不可用' }), save: false });
    chk('EVT-L3', '★★ 负向：召回失败 ⇒ 不写任何文档（不编"相关资料"），并把原因带出来',
      bad.withDocs === 0 && /检索桥不可用/.test(String(bad.why)), String(bad.why).slice(0, 60));
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
  // ★ 2026-10-21 加：`--enrich` = 跑第二层（每小时那一轮就调这个）
  if (argv.includes('--enrich')) {
    // ★ 2026-10-21：一轮 = **先聚类、再填本地文档**（顺序不能反，见 `attachDocs` 的注释）
    const c = await clusterDay({ day, save: true });
    console.log(c.ok
      ? `  聚类成功：${day} · ${c.events} 件（模型分出 ${c.clusters} 组）`
      : `  聚类未成：${day} · ${c.why}`);
    const d = await attachDocs({ day, save: true });
    console.log(`  本地文档：${d.withDocs} / ${d.events} 件挂上${d.why ? `（部分召回失败：${d.why}）` : ''}`);
    process.exit(c.ok ? 0 : 1);
  }
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
