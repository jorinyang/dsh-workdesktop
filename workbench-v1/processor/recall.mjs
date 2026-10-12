/**
 * v1/processor/recall.mjs —— **知识库召回层**（P3 输入侧；需求 3.2 的"召回相关向量信息"）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么不直接用现成的 `kb-call.mjs#askKnowledge`
 *   它把相似度门槛**写死**成 `KB_CALIBRATION.floor = 0.60`（源码第 117 行 `.filter(... >= MIN_SIMILARITY)`），
 *   且不提供覆盖入口（实测传 `minSimilarity: 0.3` 无效，`min_similarity` 仍是 0.6）。
 *   而 0.60 是**旧流程校准过的值**，动它会连带影响旧链路 ⇒ v1 走底层检索、带自己的门槛。
 *
 * ★ 门槛怎么定的（2026-10-12 实测标定，不拍脑袋）
 *   直接调底层 `queryRagBatch` 看原始相似度：
 *     「示例客户乙 客服 Agent 培训」→ 0.66 / 0.65
 *     「示例客户丙 交付 复盘」  → 0.66 / 0.63 / 0.62
 *     「个人工作台 采集器 设计」→ **0.59**（被 0.60 门槛丢掉的一条真实相关命中）
 *   ⇒ 本库相似度挤在 **0.59–0.66** 的窄带里，门槛切在分布正中间。
 *     所以 v1 用 **0.55** 作下限（留出余量），质量交给 **top-k 排序**控制，而不是靠绝对门槛卡。
 *     门槛做成参数：真实用法变了自己调，不用改代码。
 *
 * ★ 一条不许省的纪律：**分清"查不到"与"桥断了"**
 *   桥不可用时返回 `{ok:false, why}`；真的没有相关内容时返回 `{ok:true, hits:[]}`。
 *   两者混为一谈的后果：分析引擎会以为"知识库里没有相关材料"，而真相是**检索根本没跑成** ——
 *   这正是静默降级，产出缺了依据也没人会发现。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KB_ROOT as ROOT, ragBridgePath } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 默认相似度下限（见文件头标定；可用 WB_V1_RECALL_FLOOR 覆盖） */
export const DEFAULT_FLOOR = Number(process.env.WB_V1_RECALL_FLOOR ?? 0.55);
export const DEFAULT_K = 5;
export const PURPOSE = 'related';       // "找材料"用途：可召回原始素材（含 Other/Input/**）

/** 把底层返回的各种形状统一成 hits 数组（底层形状不唯一，实测见过 results[0].hits 与 [0].hits） */
export function pickHits(raw) {
  if (!raw) return [];
  if (Array.isArray(raw.hits)) return raw.hits;
  if (Array.isArray(raw.results) && raw.results[0] && Array.isArray(raw.results[0].hits)) return raw.results[0].hits;
  if (Array.isArray(raw) && raw[0] && Array.isArray(raw[0].hits)) return raw[0].hits;
  return [];
}

/**
 * 归一一条命中：只要 v1 用得上的字段（路径/片段/相似度），不把底层整包往下传。
 *
 * ★★ 2026-10-13 修（用户报"相关上下文一直显示**暂无相关资料**"，并要我查清是哪一层的问题）。
 *   查下来的结论：**知识和检索都是好的，是字段名没接上。**
 *   实测桥（`_meta/workbench/rag-bridge.mjs`）返回的命中长这样：
 *     { file_path, heading_path, chunk_id, score, similarity, **snippet**, doc_type, purpose, trust, accepted }
 *   —— 正文在 **`snippet`** 里。而这里原来只认 `text` / `content` / `chunk`，
 *   **三个都对不上** ⇒ `text` 一律是空串 ⇒ 详情页判定"没有材料" ⇒ 显示「暂无相关资料」。
 *   证据链（留档，免得下次又从头查）：
 *     ① 桥单独调用返回 0.68 相似度的真实片段（`snippet` 有内容）；
 *     ② 库里那条事件的 `context.recalled[0]` 里 `similarity=0.6957`（**召回确实发生了**）但 `text=""`；
 *     ③ 所以既不是"没有资料"，也不是"检索没生效"，就是**归一漏了 `snippet` 这个别名**。
 *   ⇒ 别名表补上 `snippet`；以后桥再加别名，**先看它真返回什么字段**再改这里（别照名字猜）。
 */
export function normalizeHit(h) {
  return {
    path: String(h?.path ?? h?.file_path ?? '').split(path.sep).join('/'),
    text: String(h?.text ?? h?.content ?? h?.chunk ?? h?.snippet ?? '').slice(0, 800),
    similarity: Number.isFinite(h?.similarity) ? Number(h.similarity) : null,
    heading: h?.heading_path ?? null,
    page: h?.page_no ?? null,
  };
}

/** 真跑：惰性加载底层桥（测试时不会碰到它） */
export async function realRunner({ query, k }) {
  const { pathToFileURL } = await import('node:url');
  const mod = await import(pathToFileURL(ragBridgePath()).href);   // RAG 桥属知识库侧，不在本包内
  const raw = mod.queryRagBatch([{ query, k }], { runtime: process.env.WB_V1_RAG_RUNTIME ?? 'worker', purpose: PURPOSE });
  return raw;
}

/**
 * 召回。
 * @param {string} query
 * @param {{k?:number, floor?:number, runner?:Function, purpose?:string}} o
 * @returns {Promise<{ok:boolean, hits:Array, why:string|null, floor:number, raw_count:number, dropped:number}>}
 */
export async function recall(query, { k = DEFAULT_K, floor = DEFAULT_FLOOR, runner = realRunner } = {}) {
  const q = String(query ?? '').trim();
  if (q === '') return { ok: false, hits: [], why: '空查询 ⇒ 不检索（不发空查询去打服务）', floor, raw_count: 0, dropped: 0 };

  let raw = null;
  try {
    raw = await runner({ query: q, k });
  } catch (e) {
    return { ok: false, hits: [], why: `检索桥调用失败：${e.message}`, floor, raw_count: 0, dropped: 0 };
  }
  if (!raw) return { ok: false, hits: [], why: '检索桥返回空（null/undefined）⇒ 当作不可用，而不是"没有相关内容"', floor, raw_count: 0, dropped: 0 };

  // 桥自报不可用 ⇒ 如实上抛，不要伪装成"没有命中"
  if (raw.available === false) return { ok: false, hits: [], why: `检索服务不可用：${raw.reason ?? '未说明原因'}`, floor, raw_count: 0, dropped: 0 };

  const all = pickHits(raw).map(normalizeHit);
  const hits = all.filter((h) => (h.similarity ?? 0) >= floor).sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)).slice(0, k);
  return {
    ok: true,
    hits,
    why: null,
    floor,
    raw_count: all.length,
    dropped: all.length - hits.length,
    below_threshold_reported: raw.below_threshold ?? null,
  };
}

/** 把召回结果拼成给模型看的上下文块（分析引擎用） */
export function contextBlock(hits, { max = 5, chars = 400 } = {}) {
  if (!hits?.length) return '';
  return hits.slice(0, max).map((h, i) => {
    const src = h.path || '(未知来源)';
    const sim = h.similarity === null ? '' : ` · 相似度 ${h.similarity.toFixed(2)}`;
    return `【材料 ${i + 1}】${src}${sim}\n${String(h.text ?? '').slice(0, chars)}`;
  }).join('\n\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（用桩，不碰真服务）
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const stub = (hits, extra = {}) => () => ({ available: true, hits, ...extra });
  const H = (s, p) => ({ similarity: s, path: p, text: `片段 ${p}` });

  return (async () => {
    const r1 = await recall('测试', { runner: stub([H(0.7, 'Work/a.md'), H(0.5, 'Work/b.md'), H(0.56, 'Work/c.md')]) });
    chk('RCL-1', '按相似度排序 + 过门槛（0.7 留、0.56 留、0.5 丢）', r1.ok && r1.hits.length === 2 && r1.hits[0].path === 'Work/a.md' && r1.hits[1].path === 'Work/c.md', JSON.stringify(r1.hits.map((h) => [h.path, h.similarity])));
    chk('RCL-2', '★ 默认门槛 0.55（实测窄分布定的），并如实报丢了几条', r1.floor === 0.55 && r1.dropped === 1, `floor=${r1.floor} dropped=${r1.dropped}`);

    const r2 = await recall('测试', { runner: stub([H(0.59, 'Work/x.md')]) });
    chk('RCL-3', '★ 0.59 的命中**不再被丢掉**（旧 0.60 门槛下它必死）', r2.ok && r2.hits.length === 1, JSON.stringify(r2.hits));

    const r3 = await recall('测试', { runner: stub([]) });
    chk('RCL-4', '★ 真的没有相关内容 ⇒ ok=true + hits=[]（不是失败）', r3.ok === true && r3.hits.length === 0 && r3.why === null);

    const r4 = await recall('测试', { runner: () => ({ available: false, reason: '索引未就绪' }) });
    chk('RCL-5', '★ 桥自报不可用 ⇒ ok=false 且给出原因（不伪装成"没有相关内容"）', r4.ok === false && /索引未就绪/.test(r4.why), String(r4.why));

    const r5 = await recall('测试', { runner: () => { throw new Error('spawn EPERM'); } });
    chk('RCL-6', '★ 桥抛异常 ⇒ ok=false（区分"查不到"与"桥断了"）', r5.ok === false && /EPERM/.test(r5.why), String(r5.why));

    const r6 = await recall('测试', { runner: () => null });
    chk('RCL-7', '★ 桥返回 null ⇒ 判为不可用（不当作"无命中"）', r6.ok === false, String(r6.why));

    const r7 = await recall('   ', { runner: stub([]) });
    chk('RCL-8', '空查询 ⇒ 直接拒绝（不打服务）', r7.ok === false && /空查询/.test(r7.why));

    const r8 = await recall('测试', { k: 1, runner: stub([H(0.7, 'a'), H(0.6, 'b')]) });
    chk('RCL-9', 'k 生效（只取前 1 条）', r8.hits.length === 1);

    const r9 = await recall('测试', { runner: () => ({ results: [{ hits: [H(0.7, 'Work/a.md')] }] }) });
    chk('RCL-10', '底层两种返回形状都能识别（results[0].hits）', r9.ok && r9.hits.length === 1);

    chk('RCL-11', 'contextBlock 给模型看的块含来源与相似度', /【材料 1】Work\/a\.md · 相似度 0\.70/.test(contextBlock([{ path: 'Work/a.md', similarity: 0.7, text: 'x' }])), contextBlock([{ path: 'Work/a.md', similarity: 0.7, text: 'x' }]));
    chk('RCL-12', '无命中 ⇒ 上下文块为空串（不产出空壳标题）', contextBlock([]) === '');

  // ★★ 2026-10-13 加（**用户报"相关上下文一直显示暂无相关资料"的回归守卫**）：
  //   根因是归一漏了桥实际使用的字段名 `snippet` ⇒ `text` 恒为空 ⇒ 详情页判定"没有材料"。
  //   实测桥返回的正是这些字段（`_meta/workbench/rag-bridge.mjs#queryRagBatch`）：
  //     { file_path, heading_path, chunk_id, score, similarity, **snippet**, doc_type, purpose, trust, accepted }
  //   ⇒ 这条检查**照桥的真实形状**喂（不是照我想的字段），钉住 `snippet` 能被取到正文。
  //     ⚠️ 反面教训写在这：上一轮我按"名字看着像"猜字段（text/content/chunk），
  //        猜到第三个都没猜中真名，而**任何一条检查都没发现**——因为我从没用真实形状喂过。
  const realShape = {
    file_path: 'Work/示例客户甲/Output/方案.md',
    heading_path: '第一章 > 目标',
    chunk_id: 16356,
    score: 0.016393,
    similarity: 0.6813,
    snippet: '这是桥真实返回的正文片段。',
    doc_type: 'md',
    purpose: 'analyze',
    trust: 'business',
    accepted: true,
    stale: false,
  };
  const nh = normalizeHit(realShape);
  chk('RCL-13', '★★ 桥的真实字段 `snippet` 能取到正文（此前只认 text/content/chunk ⇒ text 恒为空）',
    nh.text === '这是桥真实返回的正文片段。', JSON.stringify({ text: nh.text, path: nh.path }));
  chk('RCL-14', '归一保留路径/标题/相似度（桥的 file_path / heading_path / similarity）',
    nh.path === 'Work/示例客户甲/Output/方案.md' && nh.heading === '第一章 > 目标' && nh.similarity === 0.6813, JSON.stringify(nh));
  // 负向对照：真的没有正文时，text 必须是空串（**不许拿路径或标题冒充正文**）
  chk('RCL-15', '★ 负向对照：桥没给正文 ⇒ text 为空串（不拿 path/heading 冒充）',
    normalizeHit({ file_path: 'a.md', heading_path: 'h' }).text === '');

    const pass = out.filter((x) => x.ok).length;
    return { pass, fail: out.length - pass, details: out };
  })();
}

// CLI（供手工核对召回质量；用完显式退出 —— 检索桥会持有句柄）
if (process.argv[1] && process.argv[1].endsWith('recall.mjs')) {
  const q = process.argv.slice(2).join(' ');
  recall(q).then((r) => {
    console.log(JSON.stringify({ ok: r.ok, why: r.why, floor: r.floor, raw: r.raw_count, dropped: r.dropped, hits: r.hits.map((h) => ({ s: h.similarity, p: h.path })) }, null, 1));
    process.exit(0);
  });
}
