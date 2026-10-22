#!/usr/bin/env node
/**
 * `v1/processor/event-merge.mjs` —— **手建一个事件时，从五个来源把相关内容捞回来合并进去**。
 *
 * 用户原话（2026-10-23）：「事件中的新增一条消息改为**新增一个事件**，生效机制是创建一个事件，
 *   然后分析引擎从**会话 / 知识库 / RAG / 待办 / 日程 / 笔记**中获取与事件相关的内容，合并为一个事件。」
 *
 * ── 为什么不用模型来"理解"这段主题 ────────────────────────────────────────────
 *   这一步要**点一下就有结果**（表单提交后在页面上直接看到合进来什么）。
 *   调模型要几十秒到两分钟，体验上等于"点了没反应"。
 *   ⇒ 用**关键词命中 + 召回**：快（召回实测 0.4 秒）、可解释（能说清"为什么把它算进来"）、可复现。
 *   真要"读懂语义再合并"，那是**每小时聚类那一轮**的事（`events.mjs#clusterDay`），不是这里。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────────────
 *   一、**捞不到就说捞不到**。合并结果里 `why` 写明，页面照实显示 —— 不留空让人以为"就是没有"。
 *   二、**关键词必须真的出现在原文里**才算命中。不做模糊联想，宁可少合并。
 *      一个词都提不出来（比如主题只有一个字）⇒ 直接返回空结果 + 原因，**不拿空关键词去扫全库**
 *      （空关键词会把每一条都算命中，那是"全中"，比不合并糟得多）。
 *   三、**召回失败不影响其它四路**。知识库那条挂了，会话/待办/日程/笔记照旧合并，`why` 里带一句。
 */
import * as store from '../store.mjs';
import { pathToFileURL } from 'node:url';

/** 这些词太常见，拿去匹配等于没匹配 —— 命中它们说明不了任何事 */
const STOP = new Set([
  '我们', '你们', '他们', '这个', '那个', '一个', '一下', '可以', '需要', '什么', '怎么',
  '因为', '所以', '但是', '然后', '现在', '今天', '明天', '昨天', '事情', '问题', '情况',
  '相关', '内容', '东西', '时候', '以及', '还有', '就是', '不是', '没有', '已经', '如果',
]);

/**
 * 从一段话里提关键词。
 *
 * 做法：中文按**二字词**切（不做分词，免得引一个词典依赖）；英文/数字按词切。
 * 为什么取二字：中文里"验收""报价""排期"这类两字词已经足够区分话题，
 * 三字以上切出来的碎片反而容易误命中。
 */
export function keywordsOf(text, { min = 2, max = 20 } = {}) {
  const s = String(text ?? '');
  const out = new Set();
  // 英文 / 数字
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) out.add(m[0].toLowerCase());
  // 中文：连续汉字串里取相邻两字
  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bg = run.slice(i, i + 2);
      if (!STOP.has(bg)) out.add(bg);
    }
  }
  return [...out].slice(0, max);
}

/** 一条文本命中几个关键词（返回命中的词，便于说明"为什么算进来"） */
export function hitsIn(text, kws) {
  const s = String(text ?? '').toLowerCase();
  if (!s) return [];
  return kws.filter((k) => s.includes(k.toLowerCase()));
}

/**
 * 合并：从五个来源捞出与这件事相关的内容。
 *
 * @param {{topic:string, detail?:string, now?:number, recallFn?:Function|null, sources?:object, max?:number}} o
 *   `sources` 可注入（自检用）：`{messages, todos, schedules, notes}`，不给就读 store。
 * @returns {Promise<{convIds:string[], docs:object[], todos:object[], schedules:object[], notes:object[], at:number, why:string|null}>}
 */
export async function mergeFor({ topic, detail = '', now = Date.now(), recallFn = null, sources = null, max = 12 } = {}) {
  const empty = (why) => ({ convIds: [], docs: [], todos: [], schedules: [], notes: [], at: now, why });
  const kws = keywordsOf(`${topic} ${detail}`);
  // 二、没关键词就别扫全库（否则每条都"命中"，等于全中，比不合并糟）
  if (!kws.length) return empty('主题里提不出可用来匹配的词（太短或都是常用词），没有合并任何内容');

  const src = sources ?? {
    messages: store.list({ type: 'message' }) ?? [],
    todos: store.list({ type: 'todo' }) ?? [],
    schedules: store.list({ type: 'schedule' }) ?? [],
    notes: store.list({ type: 'note' }) ?? [],
  };

  // ── ① 会话：命中的消息按 conversationId（+天）归组 ──
  const convMap = new Map();
  for (const e of src.messages ?? []) {
    const p = e.payload ?? {};
    const hit = hitsIn(`${p.raw ?? ''} ${p.summary ?? ''}`, kws);
    if (!hit.length) continue;
    // 会话 id 可能缺（手工记的消息）⇒ 用「日期 + 发送人」合成一个，与 conversations.mjs 的兜底一致
    const cid = String(p.conversationId ?? '').trim()
      || `${String(new Date(e._at).toISOString()).slice(0, 10)}__sender:${String(p.sender ?? '')}`;
    if (!convMap.has(cid)) convMap.set(cid, { id: cid, hits: new Set(), count: 0, lastAt: 0, sender: String(p.sender ?? ''), sample: '' });
    const c = convMap.get(cid);
    for (const k of hit) c.hits.add(k);
    c.count += 1;
    if (e._at >= c.lastAt) { c.lastAt = e._at; c.sample = String(p.summary || p.raw || '').slice(0, 80) }
  }
  const convs = [...convMap.values()]
    .sort((a, b) => b.hits.size - a.hits.size || b.count - a.count)
    .slice(0, max)
    .map((c) => ({ id: c.id, hits: [...c.hits], count: c.count, lastAt: c.lastAt, sender: c.sender, sample: c.sample }));

  // ── ② 待办 / ③ 日程 / ④ 笔记：按主题/正文命中 ──
  const pick = (list, fields, n = max) => (list ?? [])
    .map((e) => {
      const p = e.payload ?? {};
      const text = fields.map((f) => String(p[f] ?? '')).join(' ');
      const hits = hitsIn(text, kws);
      return hits.length ? { id: e._id, at: e._at, hits, topic: String(p.topic ?? '').slice(0, 80) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.hits.length - a.hits.length)
    .slice(0, n);

  const todos = pick(src.todos, ['topic', 'detail']);
  const schedules = pick(src.schedules, ['topic', 'detail', 'place']);
  const notes = pick(src.notes, ['topic', 'content_md']);

  // ── ⑤ 知识库 / RAG：召回（可以失败，失败只影响这一路）──
  let docs = [];
  let recallWhy = null;
  const recall = recallFn ?? (async (q, opt) => (await import('./recall.mjs')).recall(q, opt));
  try {
    const r = await recall(`${topic} ${detail}`.trim(), { k: 5 });
    if (r && r.ok === true) {
      docs = (r.hits ?? []).map((h) => ({
        path: String(h.path ?? ''),
        similarity: Number.isFinite(h.similarity) ? Number(h.similarity) : null,
        heading: h.heading ?? null,
      })).filter((h) => h.path);
    } else {
      recallWhy = String(r?.why ?? '召回没有返回结果').slice(0, 120);
    }
  } catch (e) {
    recallWhy = String(e?.message ?? e).slice(0, 120);
  }

  const total = convs.length + docs.length + todos.length + schedules.length + notes.length;
  // 一、捞不到就说捞不到（并把原因写清）
  const why = total > 0 ? null
    : `用关键词（${kws.slice(0, 6).join('、')}${kws.length > 6 ? '…' : ''}）在会话/待办/日程/笔记里都没命中`
      + (recallWhy ? `，知识库召回也没成：${recallWhy}` : '，知识库召回也没命中');

  return { convIds: convs.map((c) => c.id), convs, docs, todos, schedules, notes, at: now, keywords: kws, why };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  // MERGE-A 关键词提取
  {
    const k = keywordsOf('客户验收安排');
    chk('MERGE-A1', '★ 中文按二字提炼关键词', k.includes('验收') && k.includes('客户'), JSON.stringify(k.slice(0, 8)));
    chk('MERGE-A2', '★ 常用词被剔掉（"需要""可以"这类留下来等于没匹配）',
      !keywordsOf('需要可以这个').includes('需要') && !keywordsOf('需要可以这个').includes('可以'), '');
    chk('MERGE-A3', '英文与数字整体成一个词', keywordsOf('Q3 报表 rebuild').some((x) => x.toLowerCase() === 'rebuild'), JSON.stringify(keywordsOf('Q3 报表 rebuild')));
  }

  // MERGE-B 空关键词 ⇒ **不扫全库**
  {
    const r = await mergeFor({ topic: '。', detail: '', sources: { messages: [], todos: [], schedules: [], notes: [] }, recallFn: async () => ({ ok: true, hits: [] }) });
    chk('MERGE-B1', '★★ 提不出关键词 ⇒ 返回空合并 + 写明原因（不拿空关键词扫全库）',
      r.convIds.length === 0 && typeof r.why === 'string' && r.why.length > 0, String(r.why).slice(0, 60));
  }

  // MERGE-C 五路合并：会话/待办/日程/笔记按命中，RAG 走桩
  {
    const sources = {
      messages: [
        { _id: 'm1', _at: Date.parse('2026-10-20T10:00:00'), payload: { conversationId: 'cidA', sender: '张三', raw: '验收时间定在下周三', summary: '验收时间定在下周三', channel: 'dingtalk' } },
        { _id: 'm2', _at: Date.parse('2026-10-20T10:05:00'), payload: { conversationId: 'cidA', sender: '张三', raw: '验收清单我发你', summary: '验收清单我发你', channel: 'dingtalk' } },
        { _id: 'm3', _at: Date.parse('2026-10-20T11:00:00'), payload: { conversationId: 'cidB', sender: '李四', raw: '中午吃什么', summary: '中午吃什么', channel: 'dingtalk' } },
      ],
      todos: [{ _id: 't1', _at: 1, payload: { topic: '准备验收材料', detail: '把清单补齐' } }],
      schedules: [{ _id: 's1', _at: 1, payload: { topic: '验收会', detail: '线上', place: '会议室A' } }],
      notes: [{ _id: 'n1', _at: 1, payload: { topic: '验收要点', content_md: '# 验收\n- 看清单' } }],
    };
    const recallStub = async () => ({ ok: true, hits: [{ path: 'Work/甲/验收清单.md', similarity: 0.72 }] });
    const r = await mergeFor({ topic: '客户验收', detail: '把验收清单定下来', sources, recallFn: recallStub });
    chk('MERGE-C1', '★★ 会话按 conversationId 归组，且**不相关的会话不进来**（cidB 说吃午饭）',
      r.convIds.includes('cidA') && !r.convIds.includes('cidB'), JSON.stringify(r.convIds));
    chk('MERGE-C2', '★ 待办 / 日程 / 笔记三路都命中了',
      r.todos.length === 1 && r.schedules.length === 1 && r.notes.length === 1,
      `${r.todos.length}/${r.schedules.length}/${r.notes.length}`);
    chk('MERGE-C3', '★ 知识库那一路走召回，命中带相似度', r.docs.length === 1 && r.docs[0].similarity === 0.72, JSON.stringify(r.docs));
    chk('MERGE-C4', '★ 每条命中都带"为什么算进来"（命中了哪些词）', r.convs[0].hits.length > 0 && r.todos[0].hits.length > 0, JSON.stringify(r.convs[0].hits));
    chk('MERGE-C5', '捞到东西时 why 为空（没有"没捞到"要解释）', r.why === null, String(r.why));
  }

  // MERGE-D 召回挂了不影响其余四路
  {
    const sources = {
      messages: [{ _id: 'm1', _at: 1, payload: { conversationId: 'cidA', sender: '张三', raw: '验收时间', summary: '验收时间' } }],
      todos: [], schedules: [], notes: [],
    };
    const r = await mergeFor({ topic: '客户验收', sources, recallFn: async () => ({ ok: false, why: '检索桥不可用' }) });
    chk('MERGE-D1', '★★ 召回失败不影响会话那一路（照样合并进来）', r.convIds.includes('cidA'), JSON.stringify(r.convIds));
    chk('MERGE-D2', '★ 全都没命中时，why 里带上召回失败的原因（不把"检索挂了"说成"没有相关内容"）',
      (await mergeFor({ topic: '客户验收', sources: { messages: [], todos: [], schedules: [], notes: [] }, recallFn: async () => ({ ok: false, why: '检索桥不可用' }) })).why.includes('检索桥不可用'), '');
  }

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}

// ── 命令行 ──────────────────────────────────────────────────────────────────────
// ⚠️ 入口判据**不许只看文件名后缀**（全库有一条 `CLI-GUARD` 专门守这个）：
//   按后缀判会在别人 import 这个模块时**顺带把 CLI 跑一遍**。
//   正确做法：比 `import.meta.url` 与 `pathToFileURL(process.argv[1])` 是否同一个文件。
const __isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(entry).href;
  } catch { return false }
})();
if (__isMain) {
  if (process.argv.includes('--selftest')) {
    const r = await selfTest();
    console.log(`event-merge selftest: PASS=${r.pass} FAIL=${r.fail}`);
    for (const d of r.details) if (!d.ok) console.log(`  FAIL ${d.id} :: ${d.desc} :: ${d.detail}`);
    process.exit(r.fail === 0 ? 0 : 1);
  }
  const topic = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';
  const r = await mergeFor({ topic });
  console.log(`\n# 合并「${topic}」`);
  console.log(`  会话 ${r.convs.length} · 文档 ${r.docs.length} · 待办 ${r.todos.length} · 日程 ${r.schedules.length} · 笔记 ${r.notes.length}`);
  for (const c of r.convs) console.log(`   会话 ${c.sender} · 命中 ${c.hits.join('/')} · ${c.count} 条 · ${c.sample.slice(0, 40)}`);
  for (const d of r.docs) console.log(`   文档 ${d.path.slice(0, 70)} (${d.similarity})`);
  for (const t of r.todos) console.log(`   待办 ${t.topic}`);
  if (r.why) console.log(`   原因：${r.why}`);
}
