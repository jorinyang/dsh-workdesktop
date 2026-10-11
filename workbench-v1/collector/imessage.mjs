/**
 * v1/collector/imessage.mjs —— iMessage / 短信（登记表 `im-imessage`）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 3.1.3：「消息结构化拆解：来源 / 发信人 / 原文」
 * 需求 2.2：CLI 类功能走**每 5 分钟轮询**、**幂等**。
 * 登记表原话：「Q4 并入消息采集：把现有 `cli-imessage.mjs` 的拉取逻辑接进 v1（不再单独跑旧任务）」
 *
 * **沿用旧链路，不另造取数**（旧脚本 `_meta/workbench/cli-imessage.mjs` 已把取数做完）：
 *   iPhone（短信转发）→ Mac 的 chat.db → Mac 侧 `imessage-digest.py`（FDA 只给这一个脚本）
 *     → PC 通过 SSH 定时拉成 `_meta/out/imessage-digest.json` → **本模块读它并入 v1**
 *   旧任务 `DSH-iMessage-Pull` 继续负责"拉"这一跳；本模块只负责"并"。
 *
 * digest 实测形状（2026-09-25 那份，130 条）：
 *   `{ _note, generatedAt, host, dbPath, senderWhitelist[], scanned{…, channelHealthy, silentDays,
 *      latestMessageAt}, messages:[{rowid, guid, sender, service, chat, from_me, date_ms, date, text,
 *      text_source}] }`
 *
 * 幂等键 = `im-<guid>`；只收**收到的**消息（`from_me=false`；digest 本身也只含收到的）。
 * 认不出的情况**一律如实上报**：digest 不存在 / 解析失败 / 通道不健康 / 数据陈旧 —— 都不写成"没有消息"。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { KB_ROOT, hasKbRoot } from '../paths.mjs';
import { inScope } from './registry.mjs';

export const KEY = 'im-imessage';
export const INTERVAL_SEC = 300;

/** digest 位置：允许用环境变量覆盖（自检与迁移都用得上），缺省在库内 `_meta/out/` */
export function digestPath() {
  if (process.env.WB_V1_IMESSAGE_DIGEST) return path.resolve(process.env.WB_V1_IMESSAGE_DIGEST);
  if (!hasKbRoot()) return null;
  return path.join(KB_ROOT, '_meta', 'out', 'imessage-digest.json');
}

/** 读 digest（可注入 read 便于自检） */
export function fetchDigest({ read = null } = {}) {
  const p = digestPath();
  const reader = read ?? ((f) => fs.readFileSync(f, 'utf8'));
  if (!p) return { ok: false, why: '没有知识库根，找不到 digest（设 WB_V1_KB_ROOT 或 WB_V1_IMESSAGE_DIGEST）' };
  let text;
  try { text = reader(p); } catch (e) { return { ok: false, why: `digest 读不到（${p}）：${e.message}` }; }
  let j;
  try { j = JSON.parse(text); } catch (e) { return { ok: false, why: `digest 不是合法 JSON：${e.message}` }; }
  if (!Array.isArray(j?.messages)) return { ok: false, why: 'digest 里没有 messages 数组（形状变了？）' };
  return { ok: true, digest: j, path: p, count: j.messages.length };
}

/** 摘要：一行话说清这条消息（页面列表要一行） */
export function summarize(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** digest 里的一条 → v1 消息事件（需求 3.1.3 三项：来源 / 发信人 / 原文） */
export function mapMessage(m) {
  const errs = [];
  const guid = String(m?.guid ?? '').trim();
  if (!guid) errs.push('缺 guid（幂等键要用）');
  const text = String(m?.text ?? '').trim();
  if (!text) errs.push('没有正文（空消息不入流）');
  const at = Number(m?.date_ms);
  if (!Number.isFinite(at) || at <= 0) errs.push(`发送时间无法解析：${JSON.stringify(m?.date_ms)}`);
  if (errs.length) return { ok: false, errors: errs };

  const sender = String(m?.sender ?? '').trim() || '未知发信人';
  const payload = {
    channel: 'imessage',                       // 需求 3.1.3：信息来源
    sender,                                    // 需求 3.1.3：发信人（本机号码/联系人名）
    raw: text,                                 // 需求 3.1.3：信息原文
    modality: 'text',
    summary: summarize(text),
    // ★ `source` 在契约里是**枚举**（子通道：im / mail / minutes / self-voice / doc / …），
    //   不是自由文本 —— 第一版写 'imessage' 被契约拒掉（整条消息入不了库）。
    //   iMessage/短信属于 `im` 这个子通道；"到底是 SMS 还是 iMessage"留在 `origin.raw` 里（已带 service）。
    source: 'im',
  };
  return {
    ok: true,
    payload,
    // 服务类型（SMS / iMessage）与来源会话留在 origin.raw，便于回查
    origin: { channel: 'imessage', sender, messageId: `im-${guid}`, raw: `${m?.service ?? ''} · ${m?.chat ?? ''}`.trim() },
    _at: at,
  };
}

/** 跑一轮 */
export function ingestOnce({ read = null, dryRun = false, maxNew = 200, now = Date.now() } = {}) {
  const errors = [];
  let inCount = 0; let outCount = 0; let refreshed = 0; let skipped = 0; let outOfScope = 0; let quarantined = 0;

  const got = fetchDigest({ read });
  if (got.ok !== true) return { inCount: 0, outCount: 0, refreshed: 0, skipped: 0, outOfScope: 0, quarantined: 0, errors: [got.why], dataAsOf: null, why: `digest 取不到：${got.why}` };

  const d = got.digest;
  const sc = d.scanned ?? {};
  // ★ 通道健康与数据新鲜度**如实报**（旧脚本就带这几项读数；不因为"能读到文件"就当链路健康）
  const notes = [];
  if (sc.channelHealthy === false) notes.push('**通道不健康**（scanned.channelHealthy=false）');
  if (Number.isFinite(Number(sc.silentDays)) && Number(sc.silentDays) >= 3) notes.push(`已静默 ${sc.silentDays} 天`);
  if (d.generatedAt) {
    const ageH = (now - Date.parse(d.generatedAt)) / 3600000;
    if (Number.isFinite(ageH) && ageH >= 24) notes.push(`digest 已 ${Math.floor(ageH / 24)} 天未更新（生成于 ${d.generatedAt}）`);
  }

  for (const m of d.messages) {
    inCount += 1;
    if (m?.from_me === true) { skipped += 1; continue; }        // 只收收到的（digest 本身也只含收到的，双保险）
    const mapped = mapMessage(m);
    if (mapped.ok !== true) { quarantined += 1; errors.push(`消息 ${String(m?.guid ?? m?.rowid ?? '?').slice(0, 24)} 映射失败：${mapped.errors.join('；')}`); continue; }
    const scope = inScope('message', mapped.payload, mapped._at);
    if (!scope.inScope) { skipped += 1; outOfScope += 1; continue; }

    if (dryRun) { outCount += 1; continue; }
    if (outCount + refreshed >= maxNew) { errors.push(`达到上限 ${maxNew} 条，其余下一轮再来`); break; }

    const made = makeEvent({ type: 'message', payload: mapped.payload, origin: mapped.origin, _at: mapped._at });
    if (made.ok === false) { quarantined += 1; errors.push(`消息映射归一失败：${made.errors.join('；')}`); continue; }
    const r = store.upsert(made.event);
    if (r.action === 'rejected') { quarantined += 1; errors.push(`消息落库被拒：${r.reason}`); continue; }
    if (r.action === 'added') outCount += 1; else if (r.action === 'updated') refreshed += 1;
  }

  return {
    inCount, outCount, refreshed, skipped, outOfScope, quarantined, errors,
    dataAsOf: d.generatedAt ?? null,
    digestPath: got.path,
    why: `digest ${got.count} 条 · 新采 ${outCount} · 刷新 ${refreshed} · 跳过 ${skipped}（其中出界 ${outOfScope}） · 隔离 ${quarantined}`
      + (notes.length ? ` · ⚠️ ${notes.join(' · ')}` : ''),
    notes,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（注入 read：不碰真 digest）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const os = await import('node:os');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT;
  const prevDigest = process.env.WB_V1_IMESSAGE_DIGEST;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-im-'));
  process.env.WB_V1_OUT = tmp;
  process.env.WB_V1_IMESSAGE_DIGEST = path.join(tmp, 'imessage-digest.json');

  const NOW = Date.parse('2026-10-12T12:00:00+08:00');
  // ⚠️ 夹具要容错：负向对照会故意传 `NaN` 时间，而 `new Date(NaN).toISOString()` 会**抛异常**
  //   （第一版就栽在这：夹具自己先炸了，断言根本没跑到）。
  const MSG = (guid, text, ms, extra = {}) => ({ rowid: 1, guid, sender: '1069446611947', service: 'SMS', chat: '1069446611947', from_me: false, date_ms: ms, date: Number.isFinite(ms) ? new Date(ms).toISOString() : null, text, text_source: 'attributedBody(approx)', ...extra });
  const DIGEST = (messages, scanned = {}, generatedAt = '2026-10-12T11:00:00+08:00') => JSON.stringify({
    _note: 'fixture', generatedAt, host: 'x', dbPath: '/x/chat.db', senderWhitelist: ['a', 'b'],
    scanned: { fromRowid: 1, toRowid: 9, sinceDays: 3, rowsScanned: 9, kept: messages.length, newSinceLastRun: messages.length, skipped: 0, approxText: 1, latestMessageAt: '2026-10-12T10:00:00+08:00', silentDays: 0, channelHealthy: true, ...scanned },
    messages,
  });
  const reader = (txt) => () => txt;

  try {
    // ① 映射：需求 3.1.3 三项
    const m = mapMessage(MSG('G1', '你的快递已到菜鸟驿站', NOW - 3600000));
    chk('IMS-1', '★ 映射出 来源/发信人/原文（需求 3.1.3）', m.ok === true && m.payload.channel === 'imessage' && m.payload.sender === '1069446611947' && m.payload.raw === '你的快递已到菜鸟驿站', JSON.stringify(m.payload));
    chk('IMS-2', '幂等键 = im-<guid>', m.origin.messageId === 'im-G1');
    chk('IMS-3', '一行摘要（长文本截断）', summarize('x'.repeat(100)).endsWith('…') && summarize('短').length === 1);
    chk('IMS-4', '★ 负向对照：缺 guid / 空正文 / 时间坏 ⇒ 映射失败（不入空消息）',
      mapMessage(MSG('', 'x', NOW)).ok === false && mapMessage(MSG('G', '   ', NOW)).ok === false && mapMessage(MSG('G', 'x', NaN)).ok === false);

    // ② 一轮：界内两条入流、界外一条跳过、自己发的一条跳过
    const t = NOW - 3600000;
    const r1 = ingestOnce({ read: reader(DIGEST([MSG('A', '界内的第一条', t), MSG('B', '界内的第二条', t - 60000), MSG('C', '九月的旧消息', Date.parse('2026-09-20T10:00:00+08:00'))])), now: NOW });
    chk('IMS-5', '★ 一轮：两条入流、一条（9 月）出界', r1.inCount === 3 && r1.outCount === 2 && r1.outOfScope === 1, JSON.stringify({ in: r1.inCount, out: r1.outCount, outOfScope: r1.outOfScope }));
    chk('IMS-6', '库里 2 条消息', store.list({ type: 'message' }).length === 2, String(store.list({ type: 'message' }).length));
    chk('IMS-7', '★ 自己发的（from_me=true）不入流', ingestOnce({ read: reader(DIGEST([MSG('D', '我自己发的', t, { from_me: true })])), now: NOW }).outCount === 0);

    // ③ 幂等
    const r2 = ingestOnce({ read: reader(DIGEST([MSG('A', '界内的第一条', t), MSG('B', '界内的第二条', t - 60000)])), now: NOW });
    chk('IMS-8', '★ 第二轮幂等：不新建', r2.outCount === 0 && store.list({ type: 'message' }).length === 2, JSON.stringify({ out: r2.outCount }));

    // ④ 通道不健康 / 数据陈旧 ⇒ 如实报，不写成"没有消息"
    const r3 = ingestOnce({ read: reader(DIGEST([], { channelHealthy: false, silentDays: 5 }, '2026-09-25T13:47:11+08:00')), now: NOW });
    chk('IMS-9', '★ 通道不健康 ⇒ 明说（不当成"没有消息"）', r3.notes.some((x) => /通道不健康/.test(x)), JSON.stringify(r3.notes));
    chk('IMS-10', '★ 静默天数与 digest 陈旧都如实报', r3.notes.some((x) => /静默/.test(x)) && r3.notes.some((x) => /未更新/.test(x)), JSON.stringify(r3.notes));

    // ⑤ digest 缺失 / 坏 JSON / 形状变了 ⇒ 三种都要分得清
    const r4 = ingestOnce({ read: () => { throw new Error('ENOENT: no such file'); }, now: NOW });
    chk('IMS-11', '★ digest 读不到 ⇒ 写明路径与原因', /digest 取不到/.test(r4.why) && /ENOENT/.test(r4.why), r4.why);
    const r5 = ingestOnce({ read: reader('{ 坏 json'), now: NOW });
    chk('IMS-12', '★ 坏 JSON ⇒ 说"不是合法 JSON"（与"文件不存在"分开）', /不是合法 JSON/.test(r5.why), r5.why);
    const r6 = ingestOnce({ read: reader('{"messages":{}}'), now: NOW });
    chk('IMS-13', '★ 形状变了 ⇒ 说"没有 messages 数组"', /没有 messages 数组/.test(r6.why), r6.why);

    // ⑥ 干跑不写盘
    const before = store.list({ type: 'message' }).length;
    ingestOnce({ read: reader(DIGEST([MSG('E', '干跑不该写进去', t)])), dryRun: true, now: NOW });
    chk('IMS-14', '干跑不写盘', store.list({ type: 'message' }).length === before);
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    if (prevDigest === undefined) delete process.env.WB_V1_IMESSAGE_DIGEST; else process.env.WB_V1_IMESSAGE_DIGEST = prevDigest;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
