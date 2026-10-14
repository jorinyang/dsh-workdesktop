#!/usr/bin/env node
/**
 * `_meta/workbench/v1/collector/replay-deferred.mjs` —— **把 deferred 里够条件的事件捞回来**。
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么要有它（用户这一轮要"对齐所有功能与数据链路"，这是最后一段没接上的）
 *
 *   采集器遇到"转不动"的事件（没转写的语音、下不来的图）时**不伪造内容**，
 *   而是把它 append 进 `_meta/out/v1/deferred.jsonl`，注释写着"等通道接线后**重放**"。
 *   而水位线照常前进 ⇒ **那些事件再也不会被读到**。
 *
 *   实测（2026-10-15）：队列里 9 条，**没有任何东西在读它** ——
 *   队列有了、能力也有了（那两轮补上了网址直取与云盘通路），**中间的搬运没有**。
 *   ⇒ 这 9 条永久躺在那里，虽然按现在的代码**9/9 都能处理**。
 *
 * ── 三条纪律
 *
 *   一、**不重复实现"怎么转"**：复用采集器自己的 `convert`（连同它的 hook）与
 *      `dropReason` / `scopeOf` —— 那是唯一真相源。这里只负责"喂进去、按结果分拣"。
 *      ⚠️ 代价是"怎么转"若改了，这里要跟着看一遍；所以**不要**在这里再写一套判模态的规则。
 *
 *   二、**成功了才移走**。判据是 `store.upsert` 真的收了（`added`/`updated`），不是"转出来了"。
 *      ⇒ 转出来但落库被拒的（比如入库前过滤挡掉）**也算处理掉了** —— 它已经"有结论"了，
 *        留在队列里只是让队列永远不干净。这一点要写在结果里、能看见。
 *
 *   三、**幂等**：移走的同时记账（`deferred-replayed.jsonl`，只追加）。
 *      重跑不会把已捞回来的又捞一遍 —— 队列里已经没有了。
 *
 * 用法：
 *   node _meta/workbench/v1/collector/replay-deferred.mjs            # 真跑
 *   node _meta/workbench/v1/collector/replay-deferred.mjs --dry      # 只看会捞回几条
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { v1Out } from '../paths.mjs';
import * as store from '../store.mjs';
import { makeEvent } from '../schema.mjs';
import { convert } from './modality.mjs';
import { dwsDownloadHook } from './media.mjs';
import { dropReason, scopeOf, atOf, summarize, deferredKey } from './dingtalk-im.mjs';

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');

const deferredFile = () => path.join(v1Out(), 'deferred.jsonl');
const replayedFile = () => path.join(v1Out(), 'deferred-replayed.jsonl');

/** 只追加一行 JSONL（原子性：appendFileSync 是原子的，够用） */
const appendJsonl = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
};

export async function replayDeferred({ dryRun = false, now = Date.now() } = {}) {
  const src = deferredFile();
  if (!fs.existsSync(src)) return { total: 0, recovered: 0, stillStuck: 0, kept: 0, rows: [], why: '没有 deferred 队列' };

  const lines = fs.readFileSync(src, 'utf8').split('\n').filter((l) => l.trim());
  // 坏行照旧留着（解析不了的东西不该被这次重放抹掉）
  const rows = [];
  let badLines = 0;
  for (const l of lines) { try { const j = JSON.parse(l); if (j && j.ev) rows.push(j); else badLines += 1 } catch { badLines += 1 } }

  const hooks = { download: dwsDownloadHook() };
  const out = { total: rows.length, recovered: 0, stillStuck: 0, kept: 0, badLines, rows: [], why: null };
  const stillRows = [];

  for (const r of rows) {
    const ev = r.ev;
    const raw0 = String(ev.content ?? '');
    const at = atOf(ev);
    // ★ 复用采集器同一个 convert（含同一个 download hook）—— 不另写"怎么转"
    const conv = await convert(raw0, hooks, { sender: ev.sender, at, messageId: ev.message_id, conversationId: ev.conversation_id });

    if (!conv.ok) {
      out.stillStuck += 1;
      out.rows.push({ key: deferredKey(ev), ok: false, why: String(conv.why ?? '').slice(0, 120) });
      stillRows.push(r);
      continue;
    }

    const sc = scopeOf(ev);
    const payload = {
      channel: 'dingtalk',
      sender: String(ev.sender ?? '未知发送者'),
      raw: conv.text ?? raw0,
      source: sc.source,
      modality: conv.modality,
      mediaId: conv.mediaId,
      fileRef: conv.fileRef,
      conversationId: ev.conversation_id ?? null,
      conversationName: sc.isSelf ? '（我自己的窗口）' : (sc.isDirect ? '单聊' : `群 ${String(ev.conversation_id ?? '').slice(0, 12)}…`),
      summary: summarize(conv.text ?? raw0),
      atMe: sc.atMe,
      isDirect: sc.isDirect,
      senderType: 'user',
    };
    // 入库前过滤（与采集器同一条规则）
    const dropped = dropReason(payload);
    if (dropped !== null) {
      out.kept += 1;
      out.rows.push({ key: deferredKey(ev), ok: true, how: `落库前过滤挡掉（${dropped}）` });
      if (!dryRun) appendJsonl(replayedFile(), { at: new Date(now).toISOString(), key: deferredKey(ev), how: 'filtered', why: dropped });
      continue;
    }

    const made = makeEvent({
      type: 'message',
      payload,
      origin: { channel: 'dingtalk', sender: payload.sender, messageId: String(ev.message_id ?? '') || null, conversationId: String(ev.conversation_id ?? '') || null },
      _at: at,
    });
    // ⚠️ 两处照采集器写（我第一版都漏了，而表现是**落库被拒但原因看不懂**）：
    //   ① `makeEvent` 返回 `{ok, event, errors}` —— **不是**事件本身；
    //      把整个返回值丢给 `upsert` 会得到"事件缺 _id；缺 _at；缺 type…"，
    //      而那些字段明明有（它们在 `made.event` 里）⇒ 报错像是在说字段缺失，其实是我传错了对象。
    //   ② `ok === false` 要先判（归一后不合规），并**进隔离区留证**，而不是继续往下走。
    if (made.ok === false) {
      out.stillStuck += 1;
      out.rows.push({ key: deferredKey(ev), ok: false, why: `归一后不合规：${made.errors.join('；')}` });
      stillRows.push(r);
      continue;
    }
    if (dryRun) { out.recovered += 1; out.rows.push({ key: deferredKey(ev), ok: true, how: '能落库（干跑未写）' }); continue }

    const res = store.upsert(made.event);
    if (res.action === 'rejected') {
      out.stillStuck += 1;
      out.rows.push({ key: deferredKey(ev), ok: false, why: `落库被拒：${res.reason}` });
      stillRows.push(r);
      continue;
    }
    out.recovered += 1;
    out.rows.push({ key: deferredKey(ev), ok: true, how: res.action, id: res._id });
    appendJsonl(replayedFile(), { at: new Date(now).toISOString(), key: deferredKey(ev), how: res.action, id: res._id, modality: conv.modality, fileRef: conv.fileRef ?? null });
  }

  // ★ 队列重写：**只留还卡着的**（捞回来的移走）
  //   ⚠️ 坏行也留着 —— 这次重放不该顺手抹掉看不懂的东西。
  if (!dryRun) {
    const badRaw = lines.filter((l) => { try { const j = JSON.parse(l); return !(j && j.ev) } catch { return true } });
    const next = [...stillRows.map((r) => JSON.stringify(r)), ...badRaw];
    fs.writeFileSync(src, next.length ? next.join('\n') + '\n' : '', 'utf8');
  }
  return out;
}

// ── 命令行 ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const r = await replayDeferred({ dryRun: DRY });
  console.log('');
  console.log('############ 工作台 v1.0 · deferred 重放 ############');
  console.log(`  队列里 ${r.total} 条${r.badLines ? `（另有 ${r.badLines} 行解析不了，原样留着）` : ''}`);
  console.log(`  捞回来 ${r.recovered} · 仍卡着 ${r.stillStuck} · 落库前过滤挡掉 ${r.kept}`);
  console.log('');
  for (const x of r.rows) {
    console.log(`   ${x.ok ? '捞回' : '仍卡'}  ${String(x.how ?? x.why ?? '').slice(0, 110)}`);
  }
  console.log('');
  console.log(DRY ? '  干跑：队列没动、库没写。' : `  队列已重写（只剩仍卡着的）；记账 append 到 ${path.relative(process.cwd(), replayedFile())}`);
  process.exit(0);
}
