/**
 * v1/processor/filter.mjs —— **筛选引擎**（P2：需求 3.1 的落地）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 职责（需求原文 3.1）：「筛选引擎主要是做信息的初步分类和结构化预处理」
 *   本文件先落**消息这一条主链**（量最大、也最能验证双写）：
 *     取待筛选消息 → 意图判定（Q6）→ 分流：
 *       · `voice-command` ⇒ 只打标、交给既有语音命令通道执行（**筛选不执行命令**）
 *       · `note`          ⇒ 转成笔记载荷并落运行态（自我语音"帮我记录一下"）
 *       · `message`       ⇒ 结构化后**双写知识库**（JSONL 台账 + MD 摘要，Q8）
 *     → 每条消息打 `ops: filtered`（幂等：已筛选的不再进第二轮）
 *
 * 为什么"筛选不执行命令"：判定与执行分离 —— 筛选引擎只决定"这条往哪儿走"，
 *   执行仍归既有的 `voice-command.mjs`（它有白名单与副作用控制）。
 *   把两者混在一起会让"筛选"这个步骤带上副作用，回滚与复盘都变难。
 *
 * 顺序：按 `_at` **升序**处理（保证知识库台账是时间序，而不是"最新在前"的倒序）。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { runEngine } from '../ledger.mjs';
import * as store from '../store.mjs';
import { makeEvent } from '../schema.mjs';
import { classifyIntent, toNotePayload } from './intent.mjs';
import * as kb from './kb.mjs';
import * as links from './links.mjs';

export const FILTERED_OP = 'filtered';

export function isFiltered(evt) {
  return (evt.ops ?? []).some((o) => String(o.op ?? '') === FILTERED_OP);
}

/** 跑一轮筛选（同步；台账由 ledgered 版本记，或由调用方记） */
export function runFilterOnce({ limit = 500, dryRun = false } = {}) {
  const errors = [];
  const pending = store.list({ type: 'message' })
    .filter((e) => !isFiltered(e) && (e.lifecycle === 'open' || e.lifecycle === 'processed'))
    .sort((a, b) => a._at - b._at)                      // 时间升序：台账按时间追加
    .slice(0, limit);

  let inCount = 0; let outCount = 0; let toNote = 0; let toCommand = 0; let kbWritten = 0; let linkQueued = 0; let noteWritten = 0;

  for (const evt of pending) {
    inCount += 1;
    const { intent, why } = classifyIntent(evt);

    if (intent === 'voice-command') {
      toCommand += 1;
      if (!dryRun) store.patch('message', evt._id, {}, { op: FILTERED_OP, intent, why });
      outCount += 1;
      continue;
    }

    if (intent === 'note') {
      const payload = toNotePayload(evt);
      const made = makeEvent({
        type: 'note',
        payload,
        origin: {
          channel: evt.origin.channel,
          sender: evt.payload.sender,
          messageId: `selfnote:${evt.origin.messageId ?? evt._id}`,   // 幂等键：同一条语音只转一条笔记
          raw: payload.content_md,
        },
        _at: evt._at,
      });
      if (made.ok === false) { errors.push(`${evt._id} 转笔记失败：${made.errors.join('；')}`); continue; }
      if (dryRun) { toNote += 1; outCount += 1; continue; }
      const r = store.upsert(made.event);
      if (r.action === 'added') toNote += 1;
      // 笔记也要落知识库（需求 3.1.4）：JSONL 台账 + MD（后者是向量化载体）
      const w = kb.writeEvent(made.event);
      let noteKb = [];
      if (w.ok === false) errors.push(`${made.event._id} 笔记落库失败：${w.why}`);
      else { noteKb = w.wrote; if (w.wrote.length) noteWritten += 1; }
      store.patch('message', evt._id, {}, { op: FILTERED_OP, intent, noteId: made.event._id, noteKb });
      outCount += 1;
      continue;
    }

    // intent === 'message' ⇒ 结构化 + 双写知识库 + 抽链接入队（3.1.2 / Q10）
    if (dryRun) { kbWritten += 1; outCount += 1; continue; }
    const w = kb.writeEvent(evt);
    if (w.ok === false) { errors.push(`${evt._id}：${w.why}`); continue; }   // 写失败 ⇒ **不打 filtered**，下轮重试
    if (w.wrote.length > 0) kbWritten += 1;
    // 抽链接入队（纯抽取；真正爬取交给 skill 执行者，5 分钟 tick 只看队列空不空）
    const found = links.extractLinks(evt.payload.raw);
    let queued = 0;
    if (found.length) {
      const e = links.enqueue(found, { fromId: evt._id, from: `${evt.payload.channel}·${evt.payload.sender}`, at: evt._at });
      queued = e.added.length;
      if (e.added.length) linkQueued += e.added.length;
    }
    store.patch('message', evt._id, {}, { op: FILTERED_OP, intent, kb: w.wrote, kbSkipped: w.skipped, linksFound: found.length, linksQueued: queued });
    outCount += 1;
  }

  return {
    inCount, outCount, toNote, toCommand, kbWritten, linkQueued, noteWritten, errors,
    why: inCount === 0 ? '无待筛选的消息' : null,
  };
}

/** 带台账的入口（调度用） */
export async function runFilter() {
  return runEngine('filter', async () => runFilterOnce());
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（临时知识库根 + 临时运行态；不碰真库）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const ledger = await import('../ledger.mjs');
  const intentMod = await import('./intent.mjs');

  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT; const prevKb = process.env.WB_V1_KB_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-filter-'));
  process.env.WB_V1_OUT = path.join(tmp, 'out');
  process.env.WB_V1_KB_ROOT = path.join(tmp, 'kb');
  try {
    // 意图判定与链接抽取的纯函数自检（并入本套件）
    const it = intentMod.selfTest();
    for (const d of it.details) out.push(d);
    const lk = links.selfTest();
    for (const d of lk.details) out.push(d);

    const mk = (over) => makeEvent({
      type: 'message',
      payload: { channel: 'dingtalk', sender: '张伟', raw: '明天把验收单发我 https://example.com/req', source: 'im', summary: '明天把验收单发我', modality: 'text', ...(over.payload ?? {}) },
      origin: { channel: 'dingtalk', sender: '张伟', messageId: over.mid, conversationId: 'cidB' },
      _at: over.at ?? 1791736800000,
    }).event;

    const m1 = mk({ mid: 'm-normal' });                                    // 普通消息 ⇒ 双写
    const m2 = mk({ mid: 'm-cmd', payload: { source: 'self-voice', raw: '帮我查一下今天的日程', summary: null } });   // 命令
    const m3 = mk({ mid: 'm-note', payload: { source: 'self-voice', raw: '帮我记录一下：明天找张伟要验收单', summary: null } }); // 笔记
    for (const m of [m1, m2, m3]) store.upsert(m);

    // ① 一轮筛选：三条各走一条路
    const r1 = runFilterOnce();
    chk('FLT-1', '三条消息全部处理（进 3 / 出 3）', r1.inCount === 3 && r1.outCount === 3, JSON.stringify(r1));
    chk('FLT-2', '★ 普通消息 ⇒ 双写知识库（kbWritten=1）', r1.kbWritten === 1, String(r1.kbWritten));
    chk('FLT-3', '★ 自我语音命令 ⇒ 只打标不执行（toCommand=1）', r1.toCommand === 1, String(r1.toCommand));
    chk('FLT-4', '★「帮我记录一下」⇒ 转成笔记（toNote=1）', r1.toNote === 1, String(r1.toNote));
    chk('FLT-5', '无错误', r1.errors.length === 0, r1.errors.join('；'));

    // ② 知识库落盘：JSONL + MD 都在，且内容含三要素（需求 3.1.3）
    const month = kb.ym(m1._at);
    const jsonl = path.join(process.env.WB_V1_KB_ROOT, 'Other/Inflow/消息', `${month}.jsonl`);
    const md = path.join(process.env.WB_V1_KB_ROOT, 'Other/Inflow/消息', `${month}.md`);
    chk('FLT-6', 'JSONL 台账已落盘且恰好 1 行', fs.existsSync(jsonl) && fs.readFileSync(jsonl, 'utf8').trim().split('\n').length === 1, jsonl);
    chk('FLT-7', '★ JSONL 含信息来源/发信人/信息原文（需求 3.1.3 三要素）', (() => { const j = JSON.parse(fs.readFileSync(jsonl, 'utf8').trim()); return j.channel === 'dingtalk' && j.sender === '张伟' && j.raw.includes('明天把验收单发我'); })());
    chk('FLT-17', '★ 正文里的链接被抽出来入队（3.1.2 / Q10）', r1.linkQueued === 1 && links.pendingCount() === 1 && links.pending()[0].url === 'https://example.com/req', JSON.stringify(links.pending()));
    chk('FLT-8', 'MD 摘要已落盘（向量化载体 —— JSON 会被向量库整类排除）', fs.existsSync(md) && fs.readFileSync(md, 'utf8').includes('明天把验收单发我'), md);
    chk('FLT-9', '索引已记（kb-index.json 有这条）', (() => { const idx = kb.loadIndex(); return !!idx[m1._id]; })());

    // ③ 笔记真的建出来了，且主题已去话术
    const notes = store.list({ type: 'note' });
    chk('FLT-10', '笔记已入运行态（1 条）', notes.length === 1, String(notes.length));
    chk('FLT-11', '笔记主题去掉了「帮我记录一下：」', notes[0]?.payload.topic === '明天找张伟要验收单', JSON.stringify(notes[0]?.payload.topic));
    chk('FLT-18', '★ 笔记也落知识库（需求 3.1.4：主题/时间/内容 md）', (() => {
      const f = path.join(process.env.WB_V1_KB_ROOT, 'Other/Inflow/笔记', `${month}.jsonl`);
      if (!fs.existsSync(f)) return false;
      const j = JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n')[0]);
      return j.type === 'note' && j.topic === '明天找张伟要验收单' && /^\d{4}-\d{2}-\d{2}$/.test(j.date) && typeof j.content_md === 'string';
    })(), 'Other/Inflow/笔记/');
    chk('FLT-19', '★ 笔记的 MD 载体也写了（向量库排除 .json ⇒ 没 MD 就进不了 RAG）', fs.existsSync(path.join(process.env.WB_V1_KB_ROOT, 'Other/Inflow/笔记', `${month}.md`)) && r1.noteWritten === 1, `noteWritten=${r1.noteWritten}`);

    // ④ 幂等：再跑一轮 ⇒ 无待筛选
    const r2 = runFilterOnce();
    chk('FLT-12', '★ 再跑 ⇒ 进 0（已打 filtered 标，不重复处理）', r2.inCount === 0, JSON.stringify({ in: r2.inCount, why: r2.why }));
    chk('FLT-13', '★ 知识库不重复追加（JSONL 仍 1 行）', fs.readFileSync(jsonl, 'utf8').trim().split('\n').length === 1);

    // ⑤ 干跑不写盘
    process.env.WB_V1_OUT = path.join(tmp, 'out2');
    process.env.WB_V1_KB_ROOT = path.join(tmp, 'kb2');
    const m4 = mk({ mid: 'm-dry' });
    store.upsert(m4);
    const r3 = runFilterOnce({ dryRun: true });
    chk('FLT-14', '★ 干跑：不写知识库、不打标', r3.inCount === 1 && !fs.existsSync(path.join(process.env.WB_V1_KB_ROOT, 'Other/Inflow/消息')), JSON.stringify(r3));
    chk('FLT-15', '干跑后该条仍可被真跑处理', runFilterOnce().inCount === 1);

    // ⑥ 台账入口能记真实读数
    process.env.WB_V1_OUT = path.join(tmp, 'out3');
    process.env.WB_V1_KB_ROOT = path.join(tmp, 'kb3');
    store.upsert(mk({ mid: 'm-led' }));
    await runFilter();
    const runs = ledger.readRuns({ engine: 'filter' });
    chk('FLT-16', 'runFilter 记台账（inCount>0 且非可疑）', runs.length === 1 && runs[0].inCount === 1 && runs[0].suspicious === false, JSON.stringify(runs[0]));
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    if (prevKb === undefined) delete process.env.WB_V1_KB_ROOT; else process.env.WB_V1_KB_ROOT = prevKb;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
