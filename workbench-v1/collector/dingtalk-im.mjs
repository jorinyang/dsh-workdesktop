/**
 * v1/collector/dingtalk-im.mjs —— **钉钉聊天采集**（Stream 侧的消费端，P1-2）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 分工（沿用现有实测过的架构，只换下游）
 *   生产端：WSL 里的 `wsl-dws-event.sh` 连钉钉 Stream，把事件以 NDJSON 追加到
 *           `_meta/out/.runtime/im-events.ndjson`（计划任务 `DSH-IM-Event`，实测在跑）。
 *   消费端：本文件 —— 按**自己的偏移量**跟随那个文件（与旧消费者各读各的，互不干扰），
 *           归一 → 范围打标 → 模态转换 → 落 v1 消息事件。
 *
 * 感知范围（需求 2.2 原文）—— 由事件类型 + 会话 id 判定，四条逻辑通路共用一个跟随器：
 *   user_im_message_receive_o2o_all   → 单聊
 *   user_im_message_receive_group_all → 白名单群的**全部**信息
 *   user_im_message_receive_at        → 群内**@我**
 *   conversation_id === SELF_CID      → 给自己发的（语音）→ 打 `source=self-voice`，
 *                                       **命令 / 笔记的判定交给筛选引擎**（Q6），采集侧不裁决
 *
 * 三条不会丢数据的纪律
 *   ① **半行不消费**：只前进到最后一个完整换行的位置（否则会把一条消息劈成两半）。
 *   ② **解析不了的留证**：进 `.runtime/im-event-unparsed-v1.ndjson`，不静默丢。
 *   ③ **转不动的进队列**：语音要 ASR、图片/视频要下载，通道未接线时把整条事件写进
 *      `_meta/out/v1/deferred.jsonl`（可见、可重放），**不伪造空文本**、也不让偏移量原地打转。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { get as getState, advanceIfClean } from './state.mjs';
import { convert, detectModality, extractMediaId, stripDownloadHint } from './modality.mjs';
import { SELF_CID, SELF_NAMES } from '../../voice-command.mjs';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 四条逻辑通路共用**一个**跟随器与**一个**偏移量（同一个文件、同一个消费位置） */
export const STATE_KEY = 'dd-im-stream';
/** 事件文件（生产端在写；只读跟随）。可用 WB_V1_IM_EVENTS 覆盖 —— 供夹具测试，测试不碰真实事件流 */
export function eventFile() {
  return process.env.WB_V1_IM_EVENTS || path.join(ROOT, '_meta', 'out', '.runtime', 'im-events.ndjson');
}
/** 一次补跑最多回溯多少字节（长时间停机后不要把几十 MB 一次灌进来） */
export const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const v1Out = () => process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1');
const QUARANTINE = () => path.join(v1Out(), 'unparsed.ndjson');
const DEFERRED = () => path.join(v1Out(), 'deferred.jsonl');

/** 事件类型 → 范围标记 */
export function scopeOf(ev) {
  const t = String(ev?.type ?? '');
  const cid = String(ev?.conversation_id ?? '');
  const isSelf = cid !== '' && cid === SELF_CID;
  return {
    kind: /_o2o_all$/.test(t) ? 'direct' : /_at$/.test(t) ? 'at-me' : /_group_all$/.test(t) ? 'group-all' : 'unknown',
    isDirect: /_o2o_all$/.test(t),
    atMe: /_at$/.test(t),
    isSelf,
    source: isSelf ? 'self-voice' : 'im',
  };
}

/** create_time（"2026-10-12 00:45:05" 本地时间）→ 毫秒；取不到就退回 event_time / timestamp */
export function atOf(ev) {
  const t = String(ev?.create_time ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)) {
    const ms = Date.parse(t.replace(' ', 'T'));
    if (Number.isFinite(ms)) return ms;
  }
  for (const k of ['event_time', 'timestamp']) if (Number.isFinite(ev?.[k])) return ev[k];
  return Date.now();
}

/** 一句话概括（列表页"一句话的消息概括"，需求 3.3.3）：首行 + 截断，不做语义加工 */
export function summarize(content, max = 60) {
  const s = stripDownloadHint(content).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/** 排队队列的去重键：同一 (messageId, mediaId) 只留一条
 *  为什么需要：同一条消息会被**多个订阅**各投一次（事件文件里重复出现），
 *  不去重就会给同一条媒体排 3 次队（实测：8 条里其实只有 3 条不同消息）。 */
export function deferredKey(ev) {
  return `${String(ev?.message_id ?? '')}|${extractMediaId(ev?.content) ?? ''}`;
}

/** 已排队集合（供去重） */
export function loadDeferredKeys() {
  const p = DEFERRED();
  if (!fs.existsSync(p)) return new Set();
  const keys = new Set();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { keys.add(deferredKey(JSON.parse(line)?.ev)); } catch { /* 坏行忽略 */ }
  }
  return keys;
}

/**
 * 跑一轮采集。
 * @param {{hooks?:object, dryRun?:boolean, maxBytes?:number}} o
 * @returns {{inCount:number,outCount:number,deferred:number,quarantined:number,offset:number,truncated:boolean,errors:string[],why?:string}}
 */
export function ingestOnce({ hooks = {}, dryRun = false, maxBytes = MAX_REPLAY_BYTES, since = null } = {}) {
  const errors = [];
  const sinceMs = since === null ? null : (typeof since === 'number' ? since : Date.parse(String(since).replace(' ', 'T')));
  if (since !== null && !Number.isFinite(sinceMs)) return { inCount: 0, outCount: 0, deferred: 0, quarantined: 0, skipped: 0, offset: 0, truncated: false, errors: [`--since 解析失败：${since}`] };
  const st = getState(STATE_KEY);
  let offset = Number.isFinite(st?.offset) ? st.offset : 0;

  if (!fs.existsSync(eventFile())) {
    return { inCount: 0, outCount: 0, deferred: 0, quarantined: 0, offset, truncated: false, errors, why: `事件文件不存在（生产端未产事件）：${eventFile()}` };
  }
  const size = fs.statSync(eventFile()).size;
  if (size < offset) {                       // 文件被轮转/截断 ⇒ 从头读（事件层幂等兜底）
    errors.push(`事件文件变小（${size} < 已读 ${offset}）⇒ 判定被轮转，偏移量重置为 0`);
    offset = 0;
  }
  const want = size - offset;
  if (want <= 0) return { inCount: 0, outCount: 0, deferred: 0, quarantined: 0, offset, truncated: false, errors, why: '无新内容' };

  const len = Math.min(want, maxBytes);
  const truncated = want > len;
  const fd = fs.openSync(eventFile(), 'r');
  const buf = Buffer.allocUnsafe(len);
  let read = 0;
  try { read = fs.readSync(fd, buf, 0, len, offset); } catch (e) { errors.push(`读事件文件失败：${e.message}`); } finally { fs.closeSync(fd); }
  const text = buf.subarray(0, read).toString('utf8');
  const lines = text.split('\n');
  const tail = lines.pop() ?? '';             // 可能是半行 ⇒ 不消费
  const consumed = read - Buffer.byteLength(tail, 'utf8');
  const newOffset = offset + consumed;

  let inCount = 0; let outCount = 0; let deferred = 0; let deferredDup = 0; let quarantined = 0; let skipped = 0;
  const queued = loadDeferredKeys();            // 已排队的 (messageId|mediaId) 集合

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    inCount += 1;

    let ev = null;
    try { ev = JSON.parse(t); } catch (e) {
      quarantined += 1;
      if (!dryRun) appendJsonl(QUARANTINE(), { at: new Date().toISOString(), why: `非 JSON：${e.message}`, raw: t.slice(0, 4000) });
      continue;
    }

    // 采集起点（Q18：v1.0 从 2026-10-12 00:00:00 起算；更早的只读，不进新流程）
    const at0 = atOf(ev);
    if (sinceMs !== null && at0 < sinceMs) { skipped += 1; continue; }

    const sc = scopeOf(ev);
    const raw0 = String(ev.content ?? '');
    const at = atOf(ev);
    // 把 CLI 需要的三个 id 一起交给 hook：download-media 要 messageId + openConversationId（实测无需转换）
    const conv = convert(raw0, hooks, { sender: ev.sender, at, messageId: ev.message_id, conversationId: ev.conversation_id });

    if (!conv.ok) {
      // 转不动（语音没 ASR / 图片没下载）⇒ 进队列留证，等通道接线后重放；**不伪造内容**
      // 去重：同一条消息被多订阅各投一次 ⇒ 同一 (messageId, mediaId) 只排一次队
      const dk = deferredKey(ev);
      if (queued.has(dk)) { deferredDup += 1; continue; }
      queued.add(dk);
      deferred += 1;
      if (!dryRun) appendJsonl(DEFERRED(), { at: new Date().toISOString(), stateKey: STATE_KEY, mediaId: conv.mediaId, modality: conv.modality, why: conv.why, ev });
      continue;
    }

    const payload = {
      channel: 'dingtalk',
      sender: String(ev.sender ?? '未知发送者'),
      raw: conv.text ?? raw0,
      source: sc.source,
      modality: conv.modality,
      mediaId: conv.mediaId,
      fileRef: conv.fileRef,
      conversationId: ev.conversation_id ?? null,
      // 群聊时"发信人"= 群组 + 发言人（需求 3.1.3）——群名这里拿不到，先用会话 id，筛选引擎可补
      conversationName: sc.isSelf ? '（我自己的窗口）' : (sc.isDirect ? '单聊' : `群 ${String(ev.conversation_id ?? '').slice(0, 12)}…`),
      summary: summarize(conv.text ?? raw0),
      atMe: sc.atMe,
      isDirect: sc.isDirect,
      senderType: SELF_NAMES.includes(String(ev.sender ?? '')) ? 'self' : 'user',
    };

    const made = makeEvent({
      type: 'message',
      payload,
      origin: {
        channel: 'dingtalk',
        sender: payload.sender,
        messageId: String(ev.message_id ?? '') || null,
        conversationId: String(ev.conversation_id ?? '') || null,
        raw: payload.raw,
      },
      _at: at,
    });
    if (made.ok === false) {
      quarantined += 1;
      if (!dryRun) appendJsonl(QUARANTINE(), { at: new Date().toISOString(), why: `归一后不合规：${made.errors.join('；')}`, raw: t.slice(0, 4000) });
      continue;
    }
    if (!dryRun) {
      const r = store.upsert(made.event);
      if (r.action === 'rejected') { quarantined += 1; appendJsonl(QUARANTINE(), { at: new Date().toISOString(), why: `落库被拒：${r.reason}`, raw: t.slice(0, 4000) }); continue; }
      if (r.action === 'added') outCount += 1;
    } else {
      outCount += 1;
    }
  }

  // 记水位线：I/O 层有错就不推进；被截断也不推进（下轮接着读）
  const adv = dryRun
    ? { advanced: false, why: '干跑：不动水位线' }
    : advanceIfClean(STATE_KEY, { offset: newOffset, inCount, outCount, errors, truncated, extra: { deferred, deferredDup, quarantined, skipped } });

  return { inCount, outCount, deferred, deferredDup, quarantined, skipped, offset: newOffset, truncated, errors, why: adv.why };
}
