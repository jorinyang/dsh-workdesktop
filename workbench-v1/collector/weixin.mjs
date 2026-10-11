/**
 * v1/collector/weixin.mjs —— **微信 · 聊天窗口 → v1 消息**（P1-6：需求 2.1「保持当前状态即可」）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 复用策略（需求 2 说"把现有引擎中可用部分提取出来"，这里**一行取数逻辑都不重写**）
 *   · 取数与增量扫描：直接调 `f-weixin-realtime.mjs#scanWeixin()`（纯读、不写产物）；
 *   · 去重键：用它 `item.origin`（模块头注明确写着"两边各写一遍格式 ⇒ 去重失效"，
 *     所以**必须**用它的 origin，不许自己拼一个）；
 *   · 游标：按它的约定"由调用方持久化"——v1 用**自己的**游标文件
 *     （`_meta/out/v1/weixin-cursor.json`），与旧消费者的 `.runtime/weixin-realtime-cursor.json`
 *     各读各的，互不推进对方。
 *
 * 边界（需求 2.1 原话）
 *   微信侧只做"聊天窗口里与 DSH 的对话"：文字 / 图片 / 链接。适配器只取**文本部件**
 *   （图片与文件投递是用户 2026-09-20 明确排除的三条路线之一）⇒ 这里如实按文本收。
 *
 * 两个诚实点
 *   ① `sender` 事件里没有 ⇒ 落 **DSH 通道标签**（需求 3.1.3 允许的第三种形态），不编人名；
 *   ② `time` 可能为 null（适配器不拿 now 假装）⇒ 这类条目计 `undated` 并在台账里显式报数，
 *      事件时间用"看到它的时刻"，**不丢**（否则消息会永久消失）。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { advanceIfClean } from './state.mjs';
import { scanWeixin, loadCursor, saveCursor } from '../../f-weixin-realtime.mjs';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const STATE_KEY = 'wx-chat';
const SENDER_LABEL = 'DSH 通道（微信）';

const v1Out = () => process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1');
export function cursorFile() { return path.join(v1Out(), 'weixin-cursor.json'); }

/** 纯函数：一条适配器条目 → v1 事件（可单测，不碰磁盘） */
export function itemToEvent(item, { nowMs = Date.now() } = {}) {
  const text = String(item?.text ?? '').trim();
  if (text === '') return { ok: false, why: '空文本（非文本部件）⇒ 不收' };
  const originKey = String(item?.origin ?? '').trim();
  if (originKey === '') return { ok: false, why: '适配器没给 origin ⇒ 无法幂等，拒收（不猜）' };
  const t = item?.time ? Date.parse(String(item.time)) : NaN;
  const undated = !Number.isFinite(t);
  const made = makeEvent({
    type: 'message',
    payload: {
      channel: 'weixin',
      sender: SENDER_LABEL,
      raw: text,
      source: 'im',
      modality: 'text',
      conversationId: item?.conversationId ?? 'weixin',
      conversationName: '微信 · 聊天窗口',
      summary: text.length > 60 ? `${text.slice(0, 60)}…` : text,
      isDirect: item?.isDirect !== false,
      atMe: item?.atMe !== false,
      senderType: 'self',
    },
    origin: { channel: 'weixin', sender: SENDER_LABEL, messageId: originKey, raw: text },
    _at: undated ? nowMs : t,
  });
  if (made.ok === false) return { ok: false, why: `归一失败：${made.errors.join('；')}` };
  return { ok: true, event: made.event, undated };
}

/**
 * 跑一轮。
 * @param {{since?:string|number|null, dryRun?:boolean, scan?:Function, sessionsRoot?:string, maxFiles?:number, maxWindowBytes?:number}} o
 */
export function ingestOnce({ since = null, dryRun = false, scan = scanWeixin, sessionsRoot = null, maxFiles = 500, maxWindowBytes = undefined } = {}) {
  const errors = [];
  const sinceMs = since === null ? null : (typeof since === 'number' ? since : Date.parse(String(since).replace(' ', 'T')));
  const nowMs = Date.now();

  let cursor = null;
  if (!dryRun) {
    try { cursor = loadCursor(cursorFile()); } catch { cursor = null; }
  }

  let r;
  try {
    r = scan({ sessionsRoot, cursor, nowMs, maxFiles, ...(maxWindowBytes ? { maxWindowBytes } : {}) });
  } catch (e) {
    return { inCount: 0, outCount: 0, skipped: 0, quarantined: 0, undated: 0, errors: [`扫描失败：${e.message}`], why: '扫描异常 ⇒ 水位线不动' };
  }
  if (Array.isArray(r?.errors) && r.errors.length) errors.push(...r.errors.map(String));

  let inCount = 0; let outCount = 0; let skipped = 0; let quarantined = 0; let undated = 0;
  for (const item of (r?.items ?? [])) {
    inCount += 1;
    const conv = itemToEvent(item, { nowMs });
    if (conv.ok === false) { quarantined += 1; continue; }
    if (conv.undated) undated += 1;
    if (sinceMs !== null && !conv.undated && conv.event._at < sinceMs) { skipped += 1; continue; }   // Q18 起点
    if (dryRun) { outCount += 1; continue; }
    const res = store.upsert(conv.event);
    if (res.action === 'added') outCount += 1;
    if (res.action === 'rejected') { quarantined += 1; errors.push(`微信条目落库被拒：${res.reason}`); }
  }

  // ★ 游标保存口径（与"偏移量水位线"**不同**，这里刻意不因 errors 而停）：
  //   微信游标是**逐文件**的（`cursor.files` 存每个会话文件读到哪儿），
  //   某一个文件出错（如单文件增量窗口超安全阀）**不影响其余文件的偏移** —— 它自己已经记了 error。
  //   若因任一错误就不保存，后果是**每轮都全量重扫**（实测：200 个会话文件 72 秒），
  //   而全量重扫并不更安全（重复项由 origin 幂等挡住）。⇒ 照常保存，errors 如实入台账与水位线。
  //   实测教训：把"截断提示"（候选 255 > maxFiles 200）也当错误 ⇒ 游标永远存不下 ⇒ 每轮 72 秒。
  const saveResult = (!dryRun && r?.cursor) ? (() => { try { return saveCursor(cursorFile(), r.cursor); } catch (e) { return { ok: false, error: e.message }; } })() : null;
  if (saveResult && saveResult.ok === false) errors.push(`游标保存失败：${saveResult.error}`);
  if (!dryRun) {
    advanceIfClean(STATE_KEY, { inCount, outCount, errors, truncated: false, extra: { undated, quarantined, skipped, cursorSaved: !!(saveResult && saveResult.ok), scanned: r?.scanned ?? null } });
  }
  return { inCount, outCount, skipped, quarantined, undated, errors, why: r?.items?.length ? null : '本轮无新的微信消息' };
}
