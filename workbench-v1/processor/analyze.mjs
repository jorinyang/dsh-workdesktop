/**
 * v1/processor/analyze.mjs —— **分析引擎**（P3；需求 3.2 逐条落地）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求原文的四条口径（照抄，别改）
 *   3.2.1 消息：检索 + 召回相关向量 → 结构化内容 + 原始信息 + 相关上下文 → 交给前端（**不调模型**）
 *   3.2.2 笔记：检索 + 召回 → **综合分析、给出分析与建议** → 若适合可视化则调工具构建 → 整合给前端
 *   3.2.3 待办：**只把结构化内容交给前端**，交人工执行（**不调模型**）
 *   3.2.4 日程：检索 + 召回 → 结构化内容 + 相关上下文 → 交给前端
 *   ⇒ 成本口径（Q9）：四类里只有**笔记**在创建时调模型；消息/日程只召回，待办直通。
 *
 * 三条纪律
 *   ① **召回失败 ≠ 没有上下文**：召回层返回 `ok:false` 时，`context.recallError` 写明原因，
 *      绝不写成"知识库里没有相关材料"（那会让人以为检索过了）。
 *   ② **模型失败就不产出分析**：`analysis` 留空 + 记 `error`，下轮重试；**不编一段看起来像分析的文本**。
 *   ③ **可视化只给"建议"不给结论**：判断由规则给出 `suggested` + `why`，真正构建由前端按钮触发
 *      （需求 3.2.2 说"如果适合则调用工具构建" —— 调用动作归 P4/P5，引擎只负责判断与建议）。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from 'node:child_process';
import { runEngine } from '../ledger.mjs';
import * as store from '../store.mjs';

const PS = 'powershell.exe';
/** 推理通道：百炼 CLI（本机既有通道，已验证可用） */
export const DEFAULT_MODEL_CMD = 'bl text chat --message';

/** 真跑模型（经 powershell 调 bl；失败如实返回，不编内容） */
export function runModel(prompt, { timeoutMs = 180000 } = {}) {
  const q = String(prompt).replace(/'/g, "''");
  const cmd = `bl text chat --message '${q}'`;
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `模型返回非 0（exit=${r.status}）：${(err || out).slice(0, 200)}` };
  if (out === '') return { ok: false, why: '模型无输出' };
  return { ok: true, text: out };
}

/** 可视化判断（规则；只给建议） */
export const VISUAL_RULES = Object.freeze([
  { tool: 'coordinates', why: '内容含维度/排序/分布/对比 ⇒ 适合用坐标系落成一张定位图', re: /维度|排序|优先级|分布|对比|占比|矩阵|象限/ },
  { tool: 'project_graph', why: '内容含关系/流程/结构/依赖 ⇒ 适合用工程图落成结构图', re: /关系|流程|结构|依赖|链路|路径|上下游|闭环/ },
  { tool: 'modeling', why: '内容含方法论/从边界到验收/能力分层 ⇒ 适合在建模中心落成模型', re: /方法论|从边界|验收|分层|架构|L0|L1|L2|L3|L4|体检/ },
]);
export function suggestVisual(noteText) {
  const t = String(noteText ?? '');
  for (const r of VISUAL_RULES) if (r.re.test(t)) return { suggested: r.tool, why: r.why };
  return null;
}

/** 组装笔记的分析提示（把召回材料一起给它，要求给"分析与建议"） */
export function buildNotePrompt(note, hits) {
  const ctx = (hits ?? []).slice(0, 5).map((h, i) => `【材料${i + 1}】${h.path}（相似度 ${h.similarity ?? '-'}）\n${String(h.text ?? '').slice(0, 400)}`).join('\n\n');
  return [
    '你在给一条工作笔记做综合分析。要求：先给判断，再给理由，最后给下一步；不要客套，不要复述原文。',
    '输出格式（严格三段，每段不超过 120 字）：',
    '判断：…',
    '理由：…',
    '下一步：…',
    '',
    `【笔记主题】${note.payload?.topic ?? ''}`,
    `【笔记内容】\n${String(note.payload?.content_md ?? '').slice(0, 1500)}`,
    ctx ? `\n【知识库相关材料】\n${ctx}` : '\n【知识库相关材料】无',
  ].join('\n');
}

/**
 * 跑一轮分析。
 * @param {{limit?:number, dryRun?:boolean, recallFn?:Function, modelFn?:Function, now?:number}} o
 */
export async function analyzeOnce({ limit = 50, dryRun = false, recallFn = null, modelFn = runModel } = {}) {
  const recall = recallFn ?? (await import('./recall.mjs')).recall;
  const errors = [];
  const todo = [];
  for (const type of ['message', 'note', 'schedule', 'todo']) {
    for (const e of store.list({ type })) {
      if (e.analysis !== null && e.analysis !== undefined) continue;          // 已分析
      if ((e.ops ?? []).some((o) => String(o.op ?? '') === 'analyzed')) continue;
      todo.push(e);
    }
  }
  const batch = todo.slice(0, limit);
  let out = { message: 0, note: 0, schedule: 0, todo: 0, withContext: 0, modelCalls: 0, failed: 0 };

  for (const evt of batch) {
    const t = evt.type;
    const q = String(evt.payload?.topic ?? evt.payload?.summary ?? evt.payload?.raw ?? '').slice(0, 200);

    // 待办：直通人工，不召回不调模型（需求 3.2.3）
    if (t === 'todo') {
      if (!dryRun) store.patch('todo', evt._id, { analysis: { by: 'none', reason: '待办按需求直接交人工执行（3.2.3）', at: new Date().toISOString() } }, { op: 'analyzed' });
      out.todo += 1;
      continue;
    }

    let hits = []; let recallErr = null;
    if (q !== '') {
      const r = await recall(q);
      if (r.ok === true) {
        hits = r.hits;
        if (hits.length) out.withContext += 1;
        if (!dryRun) store.patch(t, evt._id, { context: { recalled: hits, floor: r.floor, raw_count: r.raw_count, at: new Date().toISOString() } });
      } else {
        recallErr = r.why;
        errors.push(`${evt._id} 召回不可用：${r.why}`);
      }
    }

    if (t === 'note') {
      const v = suggestVisual(String(evt.payload?.content_md ?? ''));
      const prompt = buildNotePrompt(evt, hits);
      const m = await modelFn(prompt);
      if (m.ok !== true) {
        errors.push(`${evt._id} 模型未产出：${m.why}`);
        out.failed += 1;
        if (!dryRun) store.patch('note', evt._id, { analysis: { by: 'model', error: m.why, at: new Date().toISOString(), visual: v } }, { op: 'analyzed', partial: true, recallError: recallErr });
      } else {
        out.modelCalls += 1;
        if (!dryRun) store.patch('note', evt._id, { analysis: { by: 'model', text: m.text, visual: v, at: new Date().toISOString(), contextCount: hits.length } }, { op: 'analyzed' });
      }
      out.note += 1;
      continue;
    }

    // 消息 / 日程：召回即完成（需求 3.2.1 / 3.2.4），不调模型
    if (!dryRun) store.patch(t, evt._id, { analysis: { by: 'recall-only', contextCount: hits.length, at: new Date().toISOString(), recallError: recallErr } }, { op: 'analyzed' });
    out[t] += 1;
  }

  return { inCount: batch.length, ...out, errors, why: batch.length === 0 ? '没有待分析的事件' : null };
}

/** 带台账的入口 */
export async function analyze({ limit = 50 } = {}) {
  return runEngine('analyze', async () => analyzeOnce({ limit }));
}

/**
 * **重跑一条笔记**（供「分析笔记」动作与"工作台新建笔记后立即分析"调用，需求 3.3.6 + 用户 Q3）。
 *
 * 为什么要单独一个入口，而不是复用 `analyzeOnce`：
 *   `analyzeOnce` 按"没有 analysis 的才算待分析"取件 —— 重跑时这条**已经有 analysis**，
 *   会被它自己跳过。重跑的语义是"**覆盖**上一次的结论"，所以这里显式地重新召回 + 重新调模型，
 *   再整块写回（`visual.built` 这类落点**保留**，因为那是"建过"的事实，不是分析的结论）。
 *
 * 三条纪律照旧：召回失败 ≠ 没有上下文（写 `recallError`）；模型失败 ⇒ **不编分析**、只记 error；
 * 模型/召回全部**注入**，自检不出网。
 */
export async function reanalyzeNote(evt, { recallFn = null, modelFn = runModel, dryRun = false } = {}) {
  if (!evt || evt.type !== 'note') return { ok: false, why: '只对笔记做分析' };
  const recall = recallFn ?? (await import('./recall.mjs')).recall;
  const q = String(evt.payload?.topic ?? evt.payload?.content_md ?? '').slice(0, 200);
  let hits = []; let recallErr = null;
  if (q !== '') {
    const r = await recall(q);
    if (r.ok === true) hits = r.hits;
    else recallErr = r.why;
  }
  const prevVisual = evt.analysis?.visual ?? null;
  // 可视化建议**重新判定**，但**已建成的落点保留**（built/ref/name/tool 是事实，不是结论）
  const fresh = suggestVisual(String(evt.payload?.content_md ?? ''));
  const visual = fresh
    ? { ...fresh, built: prevVisual?.built === true, ref: prevVisual?.ref ?? null, name: prevVisual?.name ?? null, tool: prevVisual?.tool ?? null, at: prevVisual?.at ?? null }
    : (prevVisual?.built === true ? prevVisual : null);
  const m = await modelFn(buildNotePrompt(evt, hits));
  const at = new Date().toISOString();
  const analysis = m.ok === true
    ? { by: 'model', text: m.text, visual, at, contextCount: hits.length, recallError: recallErr, rerun: true }
    : { by: 'model', error: m.why, visual, at, contextCount: hits.length, recallError: recallErr, rerun: true };
  if (!dryRun) {
    store.patch('note', evt._id, { context: { recalled: hits, at }, analysis }, { op: 'analyzed', rerun: true, recallError: recallErr });
  }
  return { ok: m.ok === true, why: m.ok === true ? null : m.why, text: m.text ?? null, visual, contextCount: hits.length, recallError: recallErr };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（注入桩：召回与模型都不出网）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeEvent } = await import('../schema.mjs');

  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prev = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-analyze-'));
  process.env.WB_V1_OUT = tmp;
  const NOW = Date.now();

  const stubRecall = async (q) => ({ ok: true, hits: [{ path: 'Work/示例客户甲/x.md', text: `与「${q}」相关的材料`, similarity: 0.66 }], floor: 0.55, raw_count: 1, dropped: 0, why: null });
  const stubModel = async () => ({ ok: true, text: '判断：值得做\n理由：有历史材料支撑\n下一步：先做小样' });

  try {
    store.upsert(makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw: '明天把验收单发我', source: 'im', modality: 'text', summary: '明天把验收单发我' }, origin: { channel: 'dingtalk', sender: '张伟', messageId: 'm1' }, _at: NOW }).event);
    store.upsert(makeEvent({ type: 'note', payload: { topic: '采集器设计的几个维度', date: '2026-10-12', content_md: '从维度上看，排序与对比是关键', tags: ['设计'] }, origin: { channel: 'manual', sender: '我', messageId: 'n1' }, _at: NOW }).event);
    store.upsert(makeEvent({ type: 'todo', payload: { topic: '把验收单发给张伟', detail: 'x', due: '2026-10-12' }, origin: { channel: 'manual', sender: '我', messageId: 't1' }, _at: NOW }).event);
    store.upsert(makeEvent({ type: 'schedule', payload: { topic: '项目评审会', start: '2026-10-12T14:00', end: '2026-10-12T15:00' }, origin: { channel: 'manual', sender: '我', messageId: 's1' }, _at: NOW }).event);

    const r1 = await analyzeOnce({ recallFn: stubRecall, modelFn: stubModel });
    chk('ANZ-1', '四类各处理一条', r1.message === 1 && r1.note === 1 && r1.todo === 1 && r1.schedule === 1, JSON.stringify(r1));
    chk('ANZ-2', '★ 消息/日程只召回不调模型（成本口径）', r1.modelCalls === 1, `modelCalls=${r1.modelCalls}`);

    const msg = store.list({ type: 'message' })[0];
    chk('ANZ-3', '★ 消息写入相关上下文（需求 3.2.1）', (msg.context?.recalled ?? []).length === 1 && msg.context.recalled[0].path === 'Work/示例客户甲/x.md', JSON.stringify(msg.context).slice(0, 120));
    chk('ANZ-4', '消息的分析标记为仅召回', msg.analysis?.by === 'recall-only');

    const note = store.list({ type: 'note' })[0];
    chk('ANZ-5', '★ 笔记有分析与建议（需求 3.2.2）', typeof note.analysis?.text === 'string' && note.analysis.text.includes('判断：'), JSON.stringify(note.analysis).slice(0, 140));
    chk('ANZ-6', '★ 笔记给出可视化建议（维度/排序 ⇒ 坐标系）', note.analysis?.visual?.suggested === 'coordinates', JSON.stringify(note.analysis?.visual));

    const td = store.list({ type: 'todo' })[0];
    chk('ANZ-7', '★ 待办直通人工：不召回不调模型（需求 3.2.3）', td.analysis?.by === 'none' && (td.context?.recalled ?? []).length === 0);

    const r2 = await analyzeOnce({ recallFn: stubRecall, modelFn: stubModel });
    chk('ANZ-8', '★ 幂等：再跑一轮不重复分析', r2.inCount === 0, JSON.stringify({ in: r2.inCount, why: r2.why }));

    // 召回失败 ≠ 没有上下文
    process.env.WB_V1_OUT = path.join(tmp, 'out2');
    store.upsert(makeEvent({ type: 'message', payload: { channel: 'manual', sender: '我', raw: '召不回的一条', source: 'manual', modality: 'text' }, origin: { channel: 'manual', sender: '我', messageId: 'm2' }, _at: NOW }).event);
    const r3 = await analyzeOnce({ recallFn: async () => ({ ok: false, hits: [], why: '桥断了', floor: 0.55, raw_count: 0, dropped: 0 }) });
    const m2 = store.list({ type: 'message' })[0];
    chk('ANZ-9', '★ 召回不可用 ⇒ 写明 recallError（不写成"没有相关材料"）', r3.errors.length === 1 && m2.analysis?.recallError === '桥断了' && (m2.context?.recalled ?? []).length === 0, JSON.stringify(m2.analysis));

    // 模型失败 ⇒ 不产出分析
    process.env.WB_V1_OUT = path.join(tmp, 'out3');
    store.upsert(makeEvent({ type: 'note', payload: { topic: '会失败的笔记', date: '2026-10-12', content_md: 'x' }, origin: { channel: 'manual', sender: '我', messageId: 'n2' }, _at: NOW }).event);
    const r4 = await analyzeOnce({ recallFn: stubRecall, modelFn: async () => ({ ok: false, why: '模型超时' }) });
    const n2 = store.list({ type: 'note' })[0];
    chk('ANZ-10', '★ 模型失败 ⇒ 不编分析文本，只记错误（下轮可重试）', n2.analysis?.text === undefined && n2.analysis?.error === '模型超时' && r4.failed === 1, JSON.stringify(n2.analysis));

    chk('ANZ-11', '可视化规则：关系/流程 ⇒ 工程图', suggestVisual('这里的流程与依赖关系需要理清')?.suggested === 'project_graph');
    chk('ANZ-12', '★ 负向对照：普通笔记不硬套可视化建议', suggestVisual('今天下午开了个会，聊了聊进度') === null);
    chk('ANZ-13', '提示词含笔记内容与材料（供模型用）', buildNotePrompt({ payload: { topic: 'T', content_md: 'C' } }, [{ path: 'P', text: 'S', similarity: 0.6 }]).includes('【材料1】P'));
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
