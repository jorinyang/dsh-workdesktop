/**
 * v1/collector/mail.mjs —— **钉钉邮件 → v1 消息事件**（P1-5 的 A 类：复用现有引擎）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 复用哪一部分：取数/附件落盘/金额抽取/水位线/幂等 —— 已在 `mail-sync.mjs` 里做对了。
 *   本文件只补最后一段：把 `_meta/out/mail-receipts.json` 的收据**映射成 v1 消息事件**。
 *
 * 收据文件的实际形状（实测）：`{ schema, entries }`，而 `entries` 是**以 messageId 为键的对象**
 *   （不是数组！）每条含：messageId / fileName / relPath / size / sha256 / amount / currency /
 *   source / category / receivedDateTime / subject / downloadedAt_dataAsOf / adopted …
 *
 * 映射口径
 *   · `sender` = 邮件的 source（如「示例客户丁发票服务」），不是某个人的名字
 *   · `raw` = 主题（邮件的"信息原文"在这一层就是主题 + 附件引用）
 *   · 附件 ⇒ `modality='file'` + `fileRef=relPath`（需求 2.2："文件则不改变其模态"）
 *   · `source='mail'` 子通道标记（筛选引擎据此与聊天消息区分）
 *   · 幂等键 = messageId
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { advanceIfClean } from './state.mjs';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const STATE_KEY = 'dd-mail';
/** 收据文件（由现有 `mail-sync.mjs` 产出；只读消费） */
export function receiptsFile() {
  return process.env.WB_V1_MAIL_RECEIPTS || path.join(ROOT, '_meta', 'out', 'mail-receipts.json');
}

/** 读收据：entries 可能是对象（实测）也可能是数组（防御） */
export function loadEntries() {
  const p = receiptsFile();
  if (!fs.existsSync(p)) return { ok: false, why: `收据文件不存在：${p}`, entries: [] };
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const e = d?.entries;
    const arr = Array.isArray(e) ? e : (e && typeof e === 'object' ? Object.values(e) : []);
    return { ok: true, entries: arr.filter((x) => x && typeof x === 'object'), schema: d?.schema ?? null };
  } catch (err) {
    return { ok: false, why: `收据文件解析失败：${err.message}`, entries: [] };
  }
}

/** @returns {{inCount:number,outCount:number,skipped:number,quarantined:number,errors:string[],dataAsOf:string|null,truncated:boolean,why?:string}} */
export function ingestOnce({ since = null, dryRun = false, maxNew = 200 } = {}) {
  const errors = [];
  const sinceMs = since === null ? null : (typeof since === 'number' ? since : Date.parse(String(since).replace(' ', 'T')));
  const loaded = loadEntries();
  if (loaded.ok === false) return { inCount: 0, outCount: 0, skipped: 0, quarantined: 0, errors: [loaded.why], dataAsOf: null, truncated: false, why: loaded.why };

  let inCount = 0; let outCount = 0; let skipped = 0; let quarantined = 0; let truncated = false;
  let maxAt = null;

  for (const e of loaded.entries) {
    inCount += 1;
    const mid = String(e.messageId ?? '').trim();
    if (!mid) { quarantined += 1; errors.push('收据缺 messageId ⇒ 无法幂等，跳过（不猜）'); continue; }
    const at = Date.parse(String(e.receivedDateTime ?? e.downloadedAt_dataAsOf ?? ''));
    if (!Number.isFinite(at)) { quarantined += 1; errors.push(`收据 ${mid} 时间不可解析 ⇒ 跳过`); continue; }
    if (sinceMs !== null && at < sinceMs) { skipped += 1; continue; }         // Q18 起点之前 ⇒ 只读
    if (outCount >= maxNew) { truncated = true; break; }

    const subject = String(e.subject ?? '').trim();
    const sender = String(e.source ?? '').trim() || '未知发件人';
    const hasFile = typeof e.relPath === 'string' && e.relPath.length > 0;
    maxAt = Math.max(maxAt ?? 0, at);

    const made = makeEvent({
      type: 'message',
      payload: {
        channel: 'dingtalk',
        sender,
        raw: subject || (hasFile ? `[附件] ${e.fileName ?? ''}` : '(无主题)'),
        source: 'mail',
        modality: hasFile ? 'file' : 'text',
        fileRef: hasFile ? e.relPath : null,
        conversationName: '钉钉邮箱',
        summary: (subject || e.fileName || '').slice(0, 60),
        isDirect: true,
        atMe: false,
        senderType: 'user',
      },
      origin: { channel: 'dingtalk', sender, messageId: mid, raw: subject || null },
      _at: at,
    });
    if (made.ok === false) { quarantined += 1; errors.push(`邮件 ${mid} 归一失败：${made.errors.join('；')}`); continue; }
    if (dryRun) { outCount += 1; continue; }
    const r = store.upsert(made.event);
    if (r.action === 'rejected') { quarantined += 1; errors.push(`邮件 ${mid} 落库被拒：${r.reason}`); continue; }
    if (r.action === 'added') outCount += 1;
  }

  const dataAsOf = maxAt ? new Date(maxAt).toISOString() : null;
  if (!dryRun) advanceIfClean(STATE_KEY, { inCount, outCount, errors, truncated, dataAsOf, extra: { entries: loaded.entries.length, skipped, quarantined } });
  return { inCount, outCount, skipped, quarantined, errors, dataAsOf, truncated, why: truncated ? `达到本轮上限 ${maxNew}，余量留给下一轮` : null };
}
