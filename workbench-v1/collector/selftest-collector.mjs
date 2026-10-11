#!/usr/bin/env node
/**
 * v1/collector/selftest-collector.mjs —— P1 采集器**验收套件**（离线 · 用夹具，不碰真实事件流）
 *
 * 覆盖：
 *   · REG 段 —— 通道注册表（16 条全声明 + 缺口如实 + 轮询间隔）
 *   · WM  段 —— 水位线（干净才推进 / 有错不推进 / 截断不推进）
 *   · MOD 段 —— 模态（真实样本识别 + 未接线如实失败 + 空文本不算成功）
 *   · DD  段 —— 钉钉聊天采集（范围打标 / 模态分流 / 半行不消费 / 幂等 / 隔离与排队留证）
 *
 * 用法：node _meta/workbench/v1/collector/selftest-collector.mjs
 * 末行：PASS = n   FAIL = m
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as registry from './registry.mjs';
import * as state from './state.mjs';
import * as modality from './modality.mjs';
import { SELF_CID } from '../../voice-command.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-collector-'));
const EVENTS = path.join(TMP, 'im-events.ndjson');
process.env.WB_V1_OUT = path.join(TMP, 'out');
process.env.WB_V1_IM_EVENTS = EVENTS;

const dd = await import('./dingtalk-im.mjs');
const store = await import('../store.mjs');
const ledger = await import('../ledger.mjs');

let pass = 0; let fail = 0;
const rows = [];
function emit(section, res) {
  for (const d of res.details) { rows.push({ section, ...d }); if (d.ok) pass++; else fail++; console.log(`  ${d.ok ? '✓' : '✗'} ${d.id.padEnd(16)} ${d.desc}${!d.ok && d.detail ? `\n        ${d.detail}` : ''}`); }
  console.log(`  ── ${section}: PASS=${res.pass} FAIL=${res.fail}\n`);
}
const mk = (o) => JSON.stringify(o);

console.log('############ 工作台 v1.0 · P1 采集器自检 ############\n');
console.log('── REG · 通道注册表 ──');   emit('REG', registry.selfTest());
console.log('── WM · 水位线 ──');       emit('WM', state.selfTest());
console.log('── MOD · 模态识别与转换 ──'); emit('MOD', modality.selfTest());

// ── 夹具：真实形状的钉钉事件（含一条坏 JSON、一条半行）──────────────────────────
const fixture = [
  mk({ type: 'user_im_message_receive_o2o_all', message_id: 'm1', conversation_id: 'cidA', sender: '王芳【示例】', content: '明天下午三点对一下验收清单', create_time: '2026-10-12 00:10:00' }),
  mk({ type: 'user_im_message_receive_group_all', message_id: 'm2', conversation_id: 'cidB', sender: '李强', content: '这个方案我看过了', create_time: '2026-10-12 00:11:00' }),
  mk({ type: 'user_im_message_receive_at', message_id: 'm3', conversation_id: 'cidB', sender: '张伟', content: '@月夜 明天把报表发我', create_time: '2026-10-12 00:12:00' }),
  mk({ type: 'user_im_message_receive_o2o_all', message_id: 'm4', conversation_id: SELF_CID, sender: '我（示例用户）', content: '[语音消息](mediaId=$v1) 注意：如需下载使用dws chat message download-media命令下载', create_time: '2026-10-12 00:13:00' }),
  mk({ type: 'user_im_message_receive_group_all', message_id: 'm5', conversation_id: 'cidB', sender: '李强', content: '[图片消息](mediaId=$i1) 注意：如需下载使用dws chat message download-media命令下载', create_time: '2026-10-12 00:14:00' }),
  '{这不是合法 JSON',
].join('\n') + '\n';
fs.writeFileSync(EVENTS, fixture, 'utf8');

console.log('── DD · 钉钉聊天采集（夹具）──');
{
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  // ① 第一轮：3 条文字入流，语音/图片进排队，坏 JSON 进隔离
  const r1 = dd.ingestOnce();
  chk('DD-1', '进 6 行 ⇒ 出 3 条消息（3 文字成功）', r1.inCount === 6 && r1.outCount === 3, JSON.stringify({ in: r1.inCount, out: r1.outCount, deferred: r1.deferred, q: r1.quarantined }));
  chk('DD-2', '★ 语音 + 图片（通道未接线）⇒ 进排队 2 条，不伪造内容', r1.deferred === 2, String(r1.deferred));
  chk('DD-3', '★ 坏 JSON ⇒ 进隔离 1 条（不静默丢）', r1.quarantined === 1, String(r1.quarantined));
  chk('DD-4', '排队留证文件有 2 行', fs.readFileSync(path.join(process.env.WB_V1_OUT, 'deferred.jsonl'), 'utf8').trim().split('\n').length === 2);
  chk('DD-5', '隔离留证文件有 1 行', fs.readFileSync(path.join(process.env.WB_V1_OUT, 'unparsed.ndjson'), 'utf8').trim().split('\n').length === 1);

  // ② 范围打标（需求 2.2 的四条逻辑通路）
  const rows1 = store.list({ type: 'message' });
  const m1 = rows1.find((e) => e.origin.messageId === 'm1');
  const m2 = rows1.find((e) => e.origin.messageId === 'm2');
  const m3 = rows1.find((e) => e.origin.messageId === 'm3');
  chk('DD-6', '单聊 ⇒ isDirect=true', m1?.payload.isDirect === true && m1?.payload.source === 'im');
  chk('DD-7', '白名单群全部 ⇒ isDirect=false 且 atMe=false', m2?.payload.isDirect === false && m2?.payload.atMe === false);
  chk('DD-8', '群内@我 ⇒ atMe=true', m3?.payload.atMe === true);
  chk('DD-9', '一句话概括已生成（列表页用）', typeof m1?.payload.summary === 'string' && m1.payload.summary.length > 0, m1?.payload.summary);
  chk('DD-10', '时间取 create_time（本地时间不换算）', new Date(m1?._at).toISOString().startsWith('2026-10-11T16:10'), new Date(m1?._at).toISOString());

  // ③ 幂等：再跑一轮 ⇒ 无新内容（偏移量已到底）
  const r2 = dd.ingestOnce();
  chk('DD-11', '再跑一轮 ⇒ 无新内容（水位线生效，不重扫）', r2.inCount === 0 && r2.outCount === 0, JSON.stringify({ in: r2.inCount, why: r2.why }));

  // ④ 重放安全：强制偏移归零再跑 ⇒ 事件层幂等挡住（不产生重复）
  state.advanceIfClean(dd.STATE_KEY, { offset: 0, inCount: 0, outCount: 0 });
  const r3 = dd.ingestOnce();
  chk('DD-12', '★ 偏移归零重放 ⇒ 出 0 条（originKey 幂等挡住重复）', r3.outCount === 0 && store.list({ type: 'message' }).length === 3, JSON.stringify({ out: r3.outCount, store: store.list({ type: 'message' }).length }));

  // ⑤ 接线后：语音能转写、图片能落盘 ⇒ 排队的两条本轮入流
  state.advanceIfClean(dd.STATE_KEY, { offset: 0, inCount: 0, outCount: 0 });
  const r4 = dd.ingestOnce({ hooks: { asr: () => ({ ok: true, text: '帮我记录一下：明天把报表发给张伟' }), download: () => ({ ok: true, path: 'Other/Inflow/文件/2026-10/x.png' }) } });
  const after = store.list({ type: 'message' });
  chk('DD-13', '★ 接线后：语音/图片入流（出 2 条，库存 5）', r4.outCount === 2 && after.length === 5, JSON.stringify({ out: r4.outCount, store: after.length }));
  const selfMsg = after.find((e) => e.origin.messageId === 'm4');
  chk('DD-14', '★ 给自己发的语音 ⇒ source=self-voice + modality=voice（命令/笔记判定留给筛选引擎，Q6）', selfMsg?.payload.source === 'self-voice' && selfMsg?.payload.modality === 'voice' && /帮我记录一下/.test(selfMsg?.payload.raw ?? ''));
  const imgMsg = after.find((e) => e.origin.messageId === 'm5');
  chk('DD-15', '★ 图片 ⇒ 模态转 file 且带 fileRef（需求 2.2："图片视频则转为文件"）', imgMsg?.payload.modality === 'file' && !!imgMsg?.payload.fileRef, JSON.stringify(imgMsg?.payload));

  // ⑥ 半行不消费（防止把一条消息劈成两半）
  const before = fs.statSync(EVENTS).size;
  fs.appendFileSync(EVENTS, '{"type":"user_im_message_receive_o2o_all","message_id":"m6","conversation_id":"cidA","sender":"X","content":"半行', 'utf8');
  const r5 = dd.ingestOnce();
  chk('DD-16', '★ 无换行的半行 ⇒ 不消费（in=0），偏移量停在半行前', r5.inCount === 0, JSON.stringify({ in: r5.inCount, offset: r5.offset }));
  chk('DD-17', '偏移量 < 文件大小（确实停住了）', r5.offset < fs.statSync(EVENTS).size, `${r5.offset} < ${fs.statSync(EVENTS).size}（追加前 ${before}）`);
  fs.appendFileSync(EVENTS, '行补全"}\n', 'utf8');
  const r6 = dd.ingestOnce();
  chk('DD-18', '补全换行后 ⇒ 该条被正常消费', r6.inCount === 1 && r6.outCount === 1, JSON.stringify({ in: r6.inCount, out: r6.outCount }));

  // ⑧ 排队去重（实测：同一条消息会被多个订阅各投一次 ⇒ 8 条里其实只有 3 条不同消息）
  state.advanceIfClean(dd.STATE_KEY, { offset: 0, inCount: 0, outCount: 0 });
  const qFile = path.join(process.env.WB_V1_OUT, 'deferred.jsonl');
  const qBefore = fs.readFileSync(qFile, 'utf8').trim().split('\n').length;
  fs.appendFileSync(EVENTS, fixture.split('\n')[3] + '\n', 'utf8');     // 重复投递"自我语音"那条
  const r8 = dd.ingestOnce();
  const qAfter = fs.readFileSync(qFile, 'utf8').trim().split('\n').length;
  chk('DD-22', '★ 同一条消息被多订阅重复投递 ⇒ 排队项不重复增加（(messageId,mediaId) 去重）', qAfter === qBefore && r8.deferred === 0 && r8.deferredDup >= 3, JSON.stringify({ qBefore, qAfter, deferred: r8.deferred, dup: r8.deferredDup }));

  // ⑦ 台账（由**调度入口**记，不在采集模块里各记一份 —— 避免两处判断走散）
  fs.appendFileSync(EVENTS, mk({ type: 'user_im_message_receive_o2o_all', message_id: 'm7', conversation_id: 'cidA', sender: 'X', content: '台账测试用一条', create_time: '2026-10-12 00:20:00' }) + '\n', 'utf8');
  await ledger.runEngine('collector', async () => {
    const o = dd.ingestOnce();
    return { inCount: o.inCount, outCount: o.outCount, why: o.why ?? null };
  });
  const led = ledger.readRuns({ engine: 'collector' });
  chk('DD-19', '★ 经 runEngine 跑 ⇒ 台账有真实读数（进/出/耗时都在）', led.length >= 1 && led.some((x) => x.inCount > 0 && x.outCount > 0), `runs=${led.length} 末条=${JSON.stringify(led[led.length - 1] ?? null)}`);
  chk('DD-20', '水位线记录 runs 与读写读数', (state.get(dd.STATE_KEY)?.runs ?? 0) >= 5, JSON.stringify(state.get(dd.STATE_KEY)));
  chk('DD-21', '★ 缺 mediaId 的多媒体与"未接线"都不算成功（无伪造入库）', store.list({ type: 'message' }).every((e) => typeof e.payload.raw === 'string' && e.payload.raw.length > 0));

  emit('DD', { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out });
}

// ── A 类 · 听记 / 邮件（复用现有引擎的最后一段映射）────────────────────────────
const MIRROR = path.join(TMP, 'minutes');
fs.mkdirSync(MIRROR, { recursive: true });
process.env.WB_V1_MINUTES_DIR = MIRROR;
const RECEIPTS = path.join(TMP, 'mail-receipts.json');
process.env.WB_V1_MAIL_RECEIPTS = RECEIPTS;

const minutes = await import('./minutes.mjs');
const mail = await import('./mail.mjs');

console.log('── MIN · 钉钉听记 → v1 笔记 ──');
{
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const body = (title, date, hhmm, kw) => `# ${title}\n\n- 时间：${date} ${hhmm}\n- 时长：30 分钟\n- 来源：钉钉听记（dws minutes）｜taskUuid \`t1\`\n- 原链接：https://example.com/${encodeURIComponent(title)}\n\n## 关键词\n\n${kw}\n\n## 摘要\n\n> 测试摘要\n`;

  fs.writeFileSync(path.join(MIRROR, '听记_2026-10-12_0930_10-12 测试听记_abc12345.md'), body('10-12 测试听记', '2026-10-12', '09:30', '数据迁移 · 系统培训'), 'utf8');
  fs.writeFileSync(path.join(MIRROR, '听记_2026-10-08_1554_旧听记_deadbeef.md'), body('旧听记', '2026-10-08', '15:54', '旧'), 'utf8');
  fs.writeFileSync(path.join(MIRROR, '随便一个名字.md'), '# 命名不合规\n', 'utf8');

  // 命名解析（真实文件名）
  const p = minutes.parseMirrorName('听记_2026-10-08_1554_10-08 示例客户甲智慧仓库上线计划_33deb2a9.md');
  chk('MIN-1', '镜像文件名解析正确（日期/时刻/标题/hash）', p && p.date === '2026-10-08' && p.hhmm === '1554' && p.hash === '33deb2a9' && p.title.includes('示例客户甲'), JSON.stringify(p));
  chk('MIN-2', '★ 命名不合规 ⇒ 解析为 null（不猜）', minutes.parseMirrorName('随便一个名字.md') === null);

  const r1 = minutes.ingestOnce({ since: '2026-10-12T00:00:00' });
  chk('MIN-3', '★ Q18 起点生效：10-12 的入流、10-08 的跳过', r1.outCount === 1 && r1.skipped === 1, JSON.stringify({ out: r1.outCount, skipped: r1.skipped, q: r1.quarantined }));
  chk('MIN-4', '★ 命名不合规 ⇒ 进隔离（不静默丢）', r1.quarantined === 1, String(r1.quarantined));
  const notes = store.list({ type: 'note' });
  const n = notes[0];
  chk('MIN-5', '笔记载荷齐备（主题/时间/内容 md/标签）', n?.payload.topic === '10-12 测试听记' && n?.payload.date === '2026-10-12' && n.payload.content_md.startsWith('# ') && JSON.stringify(n.payload.tags) === JSON.stringify(['数据迁移', '系统培训']), JSON.stringify(n?.payload.tags));
  chk('MIN-6', '来源标 minutes + 幂等键=hash', n?.payload.source === 'minutes' && n?.origin.messageId === 'abc12345', n?.origin.messageId);

  const r2 = minutes.ingestOnce({ since: '2026-10-12T00:00:00' });
  chk('MIN-7', '★ 重复扫描 ⇒ 不产生第二条（hash 幂等）', r2.outCount === 0 && store.list({ type: 'note' }).length === notes.length, JSON.stringify({ out: r2.outCount, total: store.list({ type: 'note' }).length }));
  emit('MIN', { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out });
}

console.log('── MAIL · 钉钉邮件 → v1 消息 ──');
{
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  // 实测形状：entries 是**以 messageId 为键的对象**
  fs.writeFileSync(RECEIPTS, JSON.stringify({
    schema: 'workbench-mail-receipts/1',
    entries: {
      'mid-new': { messageId: 'mid-new', fileName: '发票.pdf', relPath: 'Other/票据/2026/发票.pdf', size: 70234, sha256: 'abc123', amount: 385.44, currency: 'CNY', source: '示例客户丁发票服务', category: '酒店', receivedDateTime: '2026-10-12T02:11:34Z', subject: '【示例客户丁】发票已开具' },
      'mid-old': { messageId: 'mid-old', fileName: '旧.pdf', relPath: 'Other/票据/2026/旧.pdf', source: '某公司', subject: '旧邮件', receivedDateTime: '2026-09-09T06:11:34Z' },
      'mid-noid': { fileName: '无ID.pdf', subject: '缺 messageId 的坏收据' },
    },
  }, null, 2), 'utf8');

  const before = store.list({ type: 'message' }).length;
  const r = mail.ingestOnce({ since: '2026-10-12T00:00:00' });
  chk('MAIL-1', '★ 对象形态的 entries 也能读（实测形状）+ Q18 起点生效', r.inCount === 3 && r.outCount === 1 && r.skipped === 1, JSON.stringify({ in: r.inCount, out: r.outCount, skipped: r.skipped }));
  chk('MAIL-2', '★ 缺 messageId 的收据 ⇒ 隔离并说明（不猜、不重复入库）', r.quarantined === 1 && r.errors.some((e) => /messageId/.test(e)), r.errors.join('；'));
  const m = store.list({ type: 'message' }).find((e) => e.origin.messageId === 'mid-new');
  chk('MAIL-3', '邮件映射：sender=来源、source=mail、modality=file、fileRef 就位', m?.payload.sender === '示例客户丁发票服务' && m?.payload.source === 'mail' && m?.payload.modality === 'file' && m?.payload.fileRef === 'Other/票据/2026/发票.pdf', JSON.stringify(m?.payload));
  chk('MAIL-4', '主题进原文与概括', m?.payload.raw === '【示例客户丁】发票已开具' && !!m?.payload.summary);
  const r2 = mail.ingestOnce({ since: '2026-10-12T00:00:00' });
  chk('MAIL-5', '★ 重复扫描 ⇒ 不重复入库（messageId 幂等）', r2.outCount === 0 && store.list({ type: 'message' }).length === before + 1, JSON.stringify({ out: r2.outCount, total: store.list({ type: 'message' }).length }));
  emit('MAIL', { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out });
}

console.log('── WX · 微信聊天窗口 → v1 消息（注入假扫描器，不依赖真实会话文件）──');
{
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const weixin = await import('./weixin.mjs');
  const CUR = path.join(process.env.WB_V1_OUT, 'weixin-cursor.json');

  // ① 纯函数：条目 → 事件（含四种边界）
  const e1 = weixin.itemToEvent({ origin: 'weixin://a/1', text: '把这份合同转给法务', time: '2026-10-12T09:00:00+08:00', conversationId: 'weixin', isDirect: true, atMe: true }, {});
  chk('WX-1', '正文/来源标 weixin + source=im + 发信人=DSH 通道标签（不编人名）', e1.ok && e1.event.payload.channel === 'weixin' && e1.event.payload.source === 'im' && e1.event.payload.sender === 'DSH 通道（微信）', JSON.stringify(e1.event?.payload));
  chk('WX-2', '★ 幂等键 = 适配器自己的 origin（不另拼一套）', e1.event.origin.messageId === 'weixin://a/1');
  chk('WX-3', '★ 空文本 ⇒ 拒收（非文本部件）', weixin.itemToEvent({ origin: 'weixin://a/2', text: '   ', time: '2026-10-12T09:00:00+08:00' }, {}).ok === false);
  chk('WX-4', '★ 缺 origin ⇒ 拒收（无法幂等就不收，不猜）', weixin.itemToEvent({ text: '无 origin', time: '2026-10-12T09:00:00+08:00' }, {}).ok === false);
  const e5 = weixin.itemToEvent({ origin: 'weixin://a/5', text: '没有时间戳的消息', time: null }, { nowMs: 1791739000000 });
  chk('WX-5', '★ 无时间戳 ⇒ 不丢：计入 undated 并用"看到它的时刻"', e5.ok === true && e5.undated === true && e5.event._at === 1791739000000);

  // ② 注入假扫描器：4 条（1 条起点前 / 1 条空文本 / 1 条正常 / 1 条无时间戳）
  const items = [
    { origin: 'weixin://b/old', text: '起点之前的老消息', time: '2026-10-08T10:00:00+08:00', conversationId: 'weixin', isDirect: true, atMe: true },
    { origin: 'weixin://b/empty', text: '', time: '2026-10-12T09:10:00+08:00' },
    { origin: 'weixin://b/new', text: '链接 https://example.com/x 帮我看下', time: '2026-10-12T09:20:00+08:00', conversationId: 'weixin', isDirect: true, atMe: true },
    { origin: 'weixin://b/undated', text: '这条没有时间', time: null },
  ];
  let savedCursor = null;
  const fakeScan = ({ cursor }) => ({ items, cursor: { schema: 'test', at: '2026-10-12T01:50:00Z', n: (cursor?.n ?? 0) + 1 }, scanned: { files: 1 }, errors: [] });

  const before = store.list({ type: 'message' }).length;
  const r1 = weixin.ingestOnce({ since: '2026-10-12T00:00:00', scan: fakeScan });
  chk('WX-6', '★ 四条条目：起点前跳过 1 · 空文本隔离 1 · 入流 2（含无时间戳那条）', r1.inCount === 4 && r1.outCount === 2 && r1.skipped === 1 && r1.quarantined === 1, JSON.stringify({ in: r1.inCount, out: r1.outCount, skip: r1.skipped, q: r1.quarantined }));
  chk('WX-7', 'undated 显式报数（台账里看得见）', r1.undated === 1, String(r1.undated));
  chk('WX-8', '游标已持久化到 v1 自己的文件（不碰旧消费者的游标）', fs.existsSync(CUR), CUR);
  chk('WX-9', '入库条数增加 2（只增不重复）', store.list({ type: 'message' }).length === before + 2);

  // ③ 幂等：同一批再来一次 ⇒ 不新增
  const r2 = weixin.ingestOnce({ since: '2026-10-12T00:00:00', scan: fakeScan });
  chk('WX-10', '★ 同一批重放 ⇒ 出 0（origin 幂等）', r2.outCount === 0 && store.list({ type: 'message' }).length === before + 2, JSON.stringify({ out: r2.outCount, total: store.list({ type: 'message' }).length }));

  // ④ ★ 口径订正（实测踩到）：**非致命错误不得卡住游标**
  //    原实现"有错就不存游标"，结果扫描器把"候选文件 255 > 上限 200 被截断"当 error 返回
  //    ⇒ 游标永远存不下 ⇒ **每轮全量重扫 72 秒**，而全量重扫并不更安全（重复由 origin 幂等挡住）。
  //    per-file 游标的语义是"每个文件各自读到哪儿"，单个文件的错误不该作废其余文件的偏移。
  const curBefore = fs.readFileSync(CUR, 'utf8');
  const r3 = weixin.ingestOnce({ scan: () => ({ items: [], cursor: { schema: 'test', at: '2030-01-01T00:00:00Z', files: { a: { offset: 1 } } }, scanned: {}, errors: ['模拟：候选文件数超上限被截断'] }) });
  chk('WX-11', '★ 非致命错误（截断提示）⇒ 游标**仍保存**（否则每轮全量重扫），但 errors 如实入账', fs.readFileSync(CUR, 'utf8') !== curBefore && r3.errors.length > 0, `errors=${JSON.stringify(r3.errors)}`);
  // ⑤ 扫描抛异常 ⇒ 没有可用的 cursors ⇒ 不保存（游标内容不变）
  const curBefore2 = fs.readFileSync(CUR, 'utf8');
  const r4 = weixin.ingestOnce({ scan: () => { throw new Error('模拟扫描器崩了'); } });
  chk('WX-12', '★ 扫描抛异常 ⇒ 游标不动 + 如实报错（不吞）', fs.readFileSync(CUR, 'utf8') === curBefore2 && r4.errors.length > 0, r4.errors.join('；'));

  emit('WX', { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out });
}

console.log('############ 合计 ############');
console.log(`PASS = ${pass}   FAIL = ${fail}`);
const failed = rows.filter((r) => !r.ok);
if (failed.length) { console.log('\n未通过项：'); for (const f of failed) console.log(`  - [${f.section}] ${f.id} ${f.desc}${f.detail ? ` — ${f.detail}` : ''}`); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }
process.exit(fail === 0 ? 0 : 1);
