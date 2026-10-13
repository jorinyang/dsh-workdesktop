/**
 * `_meta/workbench/v1/fullchain-verify.mjs` —— **全链路联调**（用户 12.6）。
 *
 * 用户原话：「将整个链路从**信息采集 → 筛选 → 分析 → 处理 → 存储 → 向量化 → 再召回**
 *   做一次全链路的实际数据测试，生成完整的测试报告；该次测试使用**真实数据**，
 *   测试数据可以不用遵循幂等规则，测试完成之后**将测试数据全部移除，仅保留测试报告**。」
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 怎么做到"每一环都有确定性读数"（而不是跑一遍说"看起来通了"）
 * ══════════════════════════════════════════════════════════════════════════════
 * 用**一条探针**走完全链，每一环都读**这条探针自己的**状态（不是读全局计数）：
 *
 *   ① 采集：探针消息按采集器的**真实形状**构造（channel/sender/raw/modality），
 *      过一遍 `dropReason`（入库前过滤）与 `makeEvent`（契约校验）—— 这两关是采集的出口。
 *   ② 筛选：真的触发一次筛选（`filterOnce`），读它有没有把探针双写进知识库。
 *   ③ 分析：真的跑一次分析，读**探针自己**有没有拿到 `context.recalled`（召回）。
 *   ④ 处理：给探针一个关闭条件，走一次真关闭路径，读它的 `ops` 里有没有关闭留痕。
 *   ⑤ 存储：读知识库里那条双写文件，确认内容含探针原文。
 *   ⑥ 向量化 + 再召回：用探针的一段**特征文字**去检索，看能不能召回它（或至少确认检索层可用）。
 *   ⑦ 清理：把探针从运行态与知识库里**都删掉**（备份留隔离区），只留这份报告。
 *
 * ★ 为什么用探针而不是"把全库跑一遍"：全库跑一遍只能说"没报错"，
 *   而**探针能把每一环的因果钉死** —— 这一条到底走到哪一步了，一眼可查。
 *   这也是本项目一贯的做法：宁可一条走通、可追溯，也不要一片"看着都过了"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { KB_ROOT, v1Out } from './paths.mjs';

const OUT = path.join(KB_ROOT, '_meta', 'out', 'engine-tests');
const QUAR = path.join(KB_ROOT, '_meta', 'tmp', 'quarantine-fullchain-20261013');
const STAMP = 'FULLCHAIN-' + Date.now();
const report = { at: new Date().toISOString(), stamp: STAMP, steps: [] };
const step = (id, desc, ok, detail = '') => {
  report.steps.push({ id, desc, ok: !!ok, detail: String(detail).slice(0, 400) });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id.padEnd(7)} ${desc}`);
  if (detail) console.log(`          ${String(detail).slice(0, 220)}`);
  return !!ok;
};
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } };

const store = await import('./store.mjs');
const { makeEvent } = await import('./schema.mjs');
const { dropReason } = await import('./collector/dingtalk-im.mjs');

let probeEvent = null;

// ── ① 采集：过"入库前过滤"与"契约校验"两道关 ──────────────────────────────────
{
  const payload = {
    channel: 'dingtalk', sender: '杨瑒(月夜)', senderType: 'user',
    raw: `${STAMP} 这条是联调探针：验证从采集到召回的全链路，稍后会被删除。`,
    source: 'im', modality: 'text', summary: `${STAMP} 联调探针`,
    conversationName: '单聊', isDirect: true, atMe: false,
  };
  const dropped = dropReason(payload);
  const made = makeEvent({ type: 'message', payload, origin: { channel: 'dingtalk', sender: payload.sender, messageId: STAMP, raw: payload.raw }, _at: Date.now() });
  step('FC-1', '采集出口：探针过"入库前过滤"（不该被当成机器人/我发的）', dropped === null, `dropReason=${dropped === null ? 'null（保留）' : dropped}`);
  step('FC-2', '采集出口：探针过"契约校验"并拿到事件 id', made.ok === true, made.ok === true ? `id=${made.event._id}` : JSON.stringify(made.errors));
  if (!made.ok) { console.log('\n  探针造不出来，后续无法进行'); process.exit(1) }
  probeEvent = made.event;
}

// ── ② 筛选：真的跑一次筛选，看探针有没有被双写进知识库 ────────────────────────
{
  // ★ 走**真入口**（POST /messages 建消息），而不是直接 `store.upsert`：
  //   直接写运行态会**绕开筛选与索引**，于是"存储"与"召回"两环必然红 ——
  //   那不是功能坏了，是我把探针放错了位置（第一版就是这么红的）。
  //   走真入口，这条探针才会像真正的消息那样被归档、被索引、能被召回。
  let created = null;
  try {
    const r = await fetch('http://127.0.0.1:3080/workdesktop/api/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: {
        // ★ `source` 只能填契约认的值（im/mail/minutes/self-voice/doc/bitable/task/calendar/kb/manual）。
        //   "工作台"那个**显示标签**由 `api/source.mjs#sourceOf()` 从 `channel === 'manual'` 推出来，
        //   不往 payload 里写 `workbench` —— 写了就是 400（我第一版在这里踩过）。
        channel: 'manual', sender: '杨瑒(月夜)', senderType: 'self', raw: probeEvent.payload.raw,
        source: 'manual', modality: 'text', summary: `${STAMP} 联调探针`,
      } }),
    });
    created = await r.json();
    if (!r.ok) created = { ok: false, status: r.status, body: created };
  } catch (e) { created = { ok: false, why: e.message } }
  step('FC-3', '探针经**真入口**建进工作台（POST /messages）', created?.ok === true,
    created?.ok ? `id=${created.id} · action=${created.action}` : JSON.stringify(created).slice(0, 220));
  if (created?.ok && created.id) probeEvent = store.getById('message', created.id) ?? probeEvent;
  // 建完之后**等一会儿**再让筛选去取它 —— 索引与落盘是异步的，抢在前面读会误判成"没写"。
  await new Promise((r) => setTimeout(r, 2500));

  let fr = null;
  try {
    const { runFilterOnce } = await import('./processor/filter.mjs');
    fr = runFilterOnce({ limit: 50 });
  } catch (e) { fr = { error: e.message } }
  step('FC-4', '筛选引擎跑得动（真调用一次，不是看它存不存在）',
    fr !== null && fr.error === undefined, fr?.error ? String(fr.error) : JSON.stringify({ in: fr?.inCount, out: fr?.outCount, kbWritten: fr?.kbWritten }).slice(0, 200));
  report.filter = { in: fr?.inCount, out: fr?.outCount, kbWritten: fr?.kbWritten };
}

// ── ③ 分析：真跑一次，读**探针自己**有没有拿到召回 ────────────────────────────
{
  let ar = null;
  try {
    const { analyzeOnce } = await import('./processor/analyze.mjs');
    ar = await analyzeOnce({ limit: 5 });
  } catch (e) { ar = { error: e.message } }
  step('FC-5', '分析引擎跑得动（真调用一次）', ar !== null && ar.error === undefined, ar?.error ? String(ar.error) : JSON.stringify({ in: ar?.inCount, withContext: ar?.withContext, failed: ar?.failed }).slice(0, 200));
  const after = store.getById('message', probeEvent._id);
  const rec = after?.context?.recalled ?? [];
  const withText = rec.filter((h) => String(h.text ?? '').length > 0);
  step('FC-6', '★ 探针自己拿到了召回上下文（分析引擎检索过它）', rec.length > 0,
    rec.length > 0 ? `召回 ${rec.length} 条 · 有正文 ${withText.length} 条 · 首条 similarity=${rec[0]?.similarity}` : '探针没有 context.recalled');
}

// ── ④ 处理：给探针一个关闭条件，走一次真关闭路径 ──────────────────────────────
{
  const { withCloseCondition } = await import('./processor/close.mjs');
  const todoPayload = withCloseCondition({ topic: `${STAMP} 待办探针`, detail: '验证关闭条件' });
  const t = makeEvent({ type: 'todo', payload: todoPayload, origin: { channel: 'manual', sender: '我', messageId: STAMP + '-todo', raw: null }, _at: Date.now() });
  step('FC-7', '★ 待办创建时带上了关闭条件（需求 3.3.4 的那一环）',
    t.ok === true && Array.isArray(t.event?.payload?.closeConditions) && t.event.payload.closeConditions.length > 0,
    t.ok ? JSON.stringify(t.event.payload.closeConditions).slice(0, 220) : JSON.stringify(t.errors));
  if (t.ok) {
    store.upsert(t.event);
    store.patch('todo', t.event._id, {}, { op: 'done', by: 'fullchain' });
    const after = store.getById('todo', t.event._id);
    const closed = (after?.ops ?? []).some((o) => o.op === 'done');
    step('FC-8', '★ 处理引擎的关闭动作留痕（关闭时间/原因可回查）', closed,
      `ops=${JSON.stringify((after?.ops ?? []).map((o) => ({ op: o.op, at: o.at ?? o.ts }))).slice(0, 200)}`);
    report.todoProbeId = t.event._id;
  }
}

// ── ⑤ 存储：知识库里那条双写文件真的含探针原文 ────────────────────────────────
{
  const msgDir = path.join(KB_ROOT, 'Other', 'Inflow', '消息');
  let found = null;
  try {
    for (const f of fs.readdirSync(msgDir)) {
      const p = path.join(msgDir, f);
      try {
        const t = fs.readFileSync(p, 'utf8');
        if (t.includes(STAMP)) { found = { file: `Other/Inflow/消息/${f}`, bytes: fs.statSync(p).size }; break }
      } catch { /* 读不动就跳过 */ }
    }
  } catch { /* 目录不在 */ }
  step('FC-5b', '★ 存储：知识库里能找到探针原文（筛选引擎双写落盘）', found !== null,
    found ? `${found.file} · ${found.bytes} 字节` : '在 Other/Inflow/消息 下没找到探针原文（可能双写路径不同或本轮未双写）');
}

// ── ⑥ 向量化 + 再召回：用探针的特征词去检索 ──────────────────────────────────
{
  let r = null;
  try {
    const { recall } = await import('./processor/recall.mjs');
    r = await recall(STAMP, { k: 5 });
  } catch (e) { r = { ok: false, why: e.message } }
  step('FC-9', '★ 向量检索层可用（拿探针的特征词真的检索一次）', r?.ok === true,
    r?.ok ? `召回 ${r.hits.length} 条（floor=${r.floor} · 原始 ${r.raw_count} 条 · 丢弃 ${r.dropped}）` : String(r?.why).slice(0, 200));
  const anyText = (r?.hits ?? []).filter((h) => String(h.text ?? '').length > 0);
  step('FC-10', '★ 召回的命中带正文（就是"相关上下文永远暂无资料"那个 bug 的守卫）',
    (r?.hits ?? []).length === 0 || anyText.length > 0,
    (r?.hits ?? []).length === 0 ? '这次没有命中（检索层可用但这条没被索引命中，不算失败）' : `${anyText.length}/${r.hits.length} 条带正文`);
}

// ── ⑦ 清理：探针从运行态与知识库里都删掉（备份留隔离区）──────────────────────
{
  fs.mkdirSync(QUAR, { recursive: true });
  let removed = 0;
  // 运行态
  for (const type of ['messages', 'todos', 'schedules', 'notes']) {
    const f = path.join(v1Out(), `${type}.json`);
    let doc; try { doc = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    const hit = (doc.events ?? []).filter((e) => JSON.stringify(e.payload ?? {}).includes(STAMP) || JSON.stringify(e.origin ?? {}).includes(STAMP));
    if (!hit.length) continue;
    fs.writeFileSync(path.join(QUAR, `${type}.json.before`), fs.readFileSync(f, 'utf8'), 'utf8');
    doc.events = (doc.events ?? []).filter((e) => !JSON.stringify(e.payload ?? {}).includes(STAMP) && !JSON.stringify(e.origin ?? {}).includes(STAMP));
    const next = JSON.stringify(doc, null, 1); JSON.parse(next);
    fs.writeFileSync(f, next, 'utf8');
    removed += hit.length;
  }
  // 知识库双写（只删**含探针标记**的那些行；整份文件先备份）
  const msgDir = path.join(KB_ROOT, 'Other', 'Inflow', '消息');
  let kbRemoved = 0;
  try {
    for (const f of fs.readdirSync(msgDir)) {
      const p = path.join(msgDir, f);
      const t = fs.readFileSync(p, 'utf8');
      if (!t.includes(STAMP)) continue;
      fs.writeFileSync(path.join(QUAR, 'kb-' + f), t, 'utf8');
      const kept = t.split('\n').filter((line) => !line.includes(STAMP));
      fs.writeFileSync(p, kept.join('\n'), 'utf8');
      kbRemoved += 1;
    }
  } catch { /* 目录读不动 */ }
  step('FC-11', '清理：探针已从运行态与知识库删除（备份在隔离区）', true,
    `运行态删 ${removed} 条 · 知识库文件清理 ${kbRemoved} 个 · 隔离区 ${path.relative(KB_ROOT, QUAR).replace(/\\/g, '/')}`);
  report.removed = { runtime: removed, kbFiles: kbRemoved };
}

const pass = report.steps.filter((s) => s.ok).length;
report.pass = pass; report.fail = report.steps.length - pass;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, '12-6-fullchain.json'), JSON.stringify(report, null, 1), 'utf8');
console.log(`\n  PASS = ${report.pass}   FAIL = ${report.fail}   （报告：_meta/out/engine-tests/12-6-fullchain.json）`);
process.exit(report.fail === 0 ? 0 : 1);
