/**
 * `v1/processor/conv-context.mjs` —— **会话级的"相关上下文"**（用户 2026-10-14 这一轮）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户原话
 *   「在**相关上下文**中的分析改为**每 15 分钟让大模型跑一次当天该会话的信息**，
 *     获取与当天会话信息相关的上下文，并列举在此处。」
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 与"每条消息自己那份上下文"是什么关系（两者都留着，各管一段）
 *
 *   · **每条消息**的 `context.recalled` —— 筛选引擎触发分析引擎时取的（向量召回，**不调模型**）。
 *     它回答"这一条和知识库里哪些材料有关"，粒度是**一条**。
 *   · **每个会话（当天）**的这一份 —— 把这个会话当天所有消息**合成一段**交给大模型，
 *     让它挑出"与该会话相关的上下文"。它回答"这一整天的对话在讲什么、牵扯到哪些材料"，
 *     粒度是**一天的会话**。
 *   ⇒ 用户这一轮明确说详情页显示的是**后者**，所以详情页读这份；
 *     前者照旧留着（转待办/转日程要按条取字段时还用得上）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 两条纪律
 *
 *   一、**15 分钟一轮，但只跑"有变化的会话"**。缓存键是"最后一条消息的时间 + 条数" ——
 *      这一天没有新消息 ⇒ 不重算、不调模型。用户说的是"每 15 分钟跑一次"，
 *      指的是**节奏**；对没有变化的会话反复烧 token 不是他要的东西（他前面已经为这类
 *      无谓消耗提过一次）。
 *   二、**模型没产出 ⇒ 如实写 `error`，不编一段看起来像分析的文本**。这与笔记分析同一条纪律。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';   // ★ 入口判据要用它精确比对（见文件末那段）
import { v1Out } from '../paths.mjs';

export const CACHE_FILE = 'conv-context-cache.json';

export function cachePath() { return path.join(v1Out(), CACHE_FILE); }

export function loadCache() {
  try { return JSON.parse(fs.readFileSync(cachePath(), 'utf8')) ?? {} } catch { return {} }
}
export function saveCache(doc) {
  const f = cachePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}
export function _clearCache() { try { fs.rmSync(cachePath(), { force: true }) } catch { /* noop */ } }

/** 会话的稳定缓存键（**只认"哪一天 + 哪个会话"** —— 因为会话就是按天切的） */
export const convKey = (conv) => `${conv.day}|${conv.key}`;

/** 会话的"内容指纹"：最后一条的时间 + 条数。变了才值得重算。 */
export const fingerprint = (conv) => `${conv.lastAt}|${conv.count}`;

/** 把会话当天的消息拼成给模型的料（`XX:XX 内容`，与详情页显示同一形态） */
export function materialOf(conv, { maxChars = 6000, timeOf = null } = {}) {
  const lines = [];
  let total = 0;
  for (const e of conv.items) {
    const hm = timeOf ? timeOf(e._at) : (() => { const d = new Date(e._at); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}` })();
    const who = String(e.payload?.sender ?? '').trim();
    const body = String(e.payload?.raw ?? e.payload?.summary ?? '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const line = `${hm}${who ? ' ' + who : ''}：${body}`;
    if (total + line.length > maxChars) { lines.push('…（当天消息较长，已截断）'); break }
    lines.push(line); total += line.length;
  }
  return lines.join('\n');
}

/** 提示词：要它**挑出相关上下文**，不要它复述会话 */
export function buildConvPrompt(conv, { selfName = '我' } = {}) {
  const who = conv.kind === 'sender' ? `${conv.sender}（无会话号，按发信人聚）` : `${conv.sender}`;
  return [
    '你在帮我把一段当天的工作对话，对照知识库，找出**与该对话相关的上下文**。',
    '',
    `【会话】${conv.day} · ${conv.channel} · ${who} · 共 ${conv.count} 条`,
    '【当天消息（按时间）】',
    materialOf(conv),
    '',
    '【要你做的事】',
    '1. 用 3~6 条列出"这段对话牵扯到的**已有背景 / 相关项目 / 相关材料 / 相关人物**"，每条一句话，句首写清它是什么。',
    '2. 再写一句话点出"这段对话**在解决什么问题**"。',
    '3. 如果这段对话看不出与库内任何材料相关，就**直说"没有明显相关的库内材料"**，不要硬凑。',
    '',
    '【硬要求】',
    '- **只输出上面这些内容，不要复述对话原文**（原文界面会另处显示）。',
    '- **不要写任何文件路径、文件名、链接**。',
    '- 不要写"综上所述""值得注意的是"这类套话。',
    `- 对话里的"${selfName}"就是我。`,
  ].join('\n');
}

/**
 * 跑一轮：**只处理有变化的会话**。
 * @param {{limit?:number, dryRun?:boolean, modelFn?:Function, convs?:object[], now?:number}} o
 */
export async function convContextOnce({ limit = 40, dryRun = false, modelFn = null, convs = null, now = Date.now() } = {}) {
  const { aggregate } = await import('./conversations.mjs');
  const { conversations } = await import('./conversations.mjs');
  let list = convs;
  if (!list) {
    const store = await import('../store.mjs');
    list = aggregate(store.list({ type: 'message' }), { now }).conversations;
  }
  const cache = loadCache();
  const pending = [];
  for (const c of list) {
    const k = convKey(c);
    const fp = fingerprint(c);
    const prev = cache[k];
    if (prev && prev.fingerprint === fp && prev.text) continue;     // 没变化 + 已有结论 ⇒ 跳过（不烧 token）
    pending.push({ c, k, fp });
  }
  const batch = pending.slice(0, limit);
  let ok = 0; let failed = 0; let calls = 0; const errors = [];
  const run = modelFn ?? (await import('./analyze.mjs')).runModel;

  for (const { c, k, fp } of batch) {
    calls += 1;
    if (dryRun) { ok += 1; continue }
    let m;
    try { m = await run(buildConvPrompt(c)) } catch (e) { m = { ok: false, why: `模型调用异常：${String(e && e.message).slice(0, 120)}` } }
    if (m && m.ok === true && typeof m.text === 'string' && m.text.trim() !== '') {
      cache[k] = { day: c.day, key: c.key, sender: c.sender, channel: c.channel, count: c.count, fingerprint: fp, text: m.text.trim(), at: new Date(now).toISOString(), error: null };
      ok += 1;
    } else {
      const why = String((m && m.why) || '模型未产出').slice(0, 160);
      // ⚠️ 失败也**记下指纹**：否则下一轮会为同一个会话反复重试、反复烧 token。
      //   但**不写 text** —— 界面据此区分"还在算"与"算完了但没产出"。
      cache[k] = { day: c.day, key: c.key, sender: c.sender, channel: c.channel, count: c.count, fingerprint: fp, text: null, at: new Date(now).toISOString(), error: why };
      errors.push(`${k}：${why}`);
      failed += 1;
    }
  }
  if (!dryRun) saveCache(cache);
  return {
    inCount: list.length, pending: pending.length, processed: batch.length, ok, failed, calls, errors,
    why: pending.length === 0 ? '所有会话都没有变化（不重算、不调模型）' : null,
  };
}

export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail: String(detail) });
  const os = await import('node:os');
  const prev = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-convctx-'));
  process.env.WB_V1_OUT = tmp;

  try {
    const D1 = Date.parse('2026-10-14T09:00:00+08:00');
    const conv = {
      day: '2026-10-14', key: 'cid:cidA', kind: 'conversation', sender: '张三', channel: '钉钉',
      count: 2, lastAt: D1 + 3600000, items: [
        { _at: D1, payload: { sender: '张三', raw: '早上第一条' } },
        { _at: D1 + 3600000, payload: { sender: '李四', raw: '上午第二条' } },
      ],
    };
    const mat = materialOf(conv);
    chk('CX-1', '★★ 会话材料按时间拼成 `HH:MM 内容`（与详情页同形态）',
      /09:00 .*早上第一条/.test(mat) && /10:00 .*上午第二条/.test(mat), mat.replace(/\n/g, ' | '));
    chk('CX-2', '★ 材料里带发信人（看不出谁说的就没法分析）', mat.includes('张三') && mat.includes('李四'), mat.replace(/\n/g, ' | '));

    const p = buildConvPrompt(conv);
    chk('CX-3', '★★ 提示词明确要求"挑出相关上下文"，并**明令不要复述原文**',
      /相关/.test(p) && /不要复述对话原文/.test(p), p.slice(-120).replace(/\n/g, ' '));
    chk('CX-4', '★★ 提示词里**明令不许写文件路径**（与消息详情同一条禁令）',
      /不要写任何文件路径/.test(p));
    chk('CX-5', '★ 提示词给了"看不出相关就直说"的退路（不硬凑）', /没有明显相关的库内材料/.test(p));

    const fp1 = fingerprint(conv);
    const fp2 = fingerprint({ ...conv, lastAt: conv.lastAt + 1000 });
    chk('CX-6', '★ 指纹随"最后一条时间"变化（有新消息才重算）', fp1 !== fp2, `${fp1} vs ${fp2}`);
    chk('CX-7', '★ 指纹含条数（条数变了也要重算）', fingerprint(conv) !== fingerprint({ ...conv, count: 3 }));

    // 只跑有变化的
    _clearCache();
    let calls = 0;
    const stub = async () => { calls += 1; return { ok: true, text: '相关：某项目背景\n在解决：接口能力确认' } };
    const r1 = await convContextOnce({ convs: [conv], modelFn: stub, now: D1 });
    chk('CX-8', '★★ 第一次跑：算一次、调一次模型', r1.processed === 1 && r1.ok === 1 && calls === 1, JSON.stringify({ p: r1.processed, ok: r1.ok, calls }));
    const r2 = await convContextOnce({ convs: [conv], modelFn: stub, now: D1 + 1000 });
    chk('CX-9', '★★ 没有变化 ⇒ **第二次不重算、不调模型**（用户要的是节奏，不是重复烧）',
      r2.processed === 0 && calls === 1, JSON.stringify({ p: r2.processed, calls, why: r2.why }));
    const r3 = await convContextOnce({ convs: [{ ...conv, lastAt: conv.lastAt + 60000, count: 3 }], modelFn: stub, now: D1 + 2000 });
    chk('CX-10', '★★ 有新消息 ⇒ 重算一次', r3.processed === 1 && calls === 2, JSON.stringify({ p: r3.processed, calls }));

    // 模型失败：如实记 error、不编文本
    _clearCache();
    const r4 = await convContextOnce({ convs: [conv], modelFn: async () => ({ ok: false, why: '模型超时' }), now: D1 });
    const cc = loadCache();
    const rec = cc[convKey(conv)];
    chk('CX-11', '★★ 模型没产出 ⇒ 记 error、**text 留空**（不编一段像分析的文本）',
      r4.failed === 1 && rec.text === null && rec.error === '模型超时', JSON.stringify({ t: rec.text, e: rec.error }));
    chk('CX-12', '★ 失败也记指纹（否则下一轮反复重试、反复烧 token）', !!rec.fingerprint, String(rec.fingerprint));

    chk('CX-13', '★ 缓存键只认"哪一天 + 哪个会话"（会话就是按天切的）',
      convKey(conv) === '2026-10-14|cid:cidA', convKey(conv));
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
  }
  return { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out };
}

// ══════════════════════════════════════════════════════════════════════════════
// 命令行入口（用户原话：「**每 15 分钟**让大模型跑一次当天该会话的信息」）
//
// ⚠️ 入口判据用 `import.meta.url` **精确比对**，不许写 `argv[1].endsWith('…')` ——
//   本项目为此栽过：12 个模块用后缀判据，别人 import 它们时会**顺带跑一遍整个入口**。
//
// 用法：
//   node conv-context.mjs --run [--limit N] [--dry-run]   跑一轮（只算有变化的会话）
//   node conv-context.mjs --selftest                       自检
// ══════════════════════════════════════════════════════════════════════════════
const isMainConv = (() => {
  try { const entry = process.argv[1]; return !!entry && import.meta.url === pathToFileURL(entry).href } catch { return false }
})();
if (isMainConv) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    const r = await selfTest();
    console.log(`conv-context selftest: PASS=${r.pass} FAIL=${r.fail}`);
    for (const d of r.details) if (!d.ok) console.log(`  FAIL ${d.id} :: ${d.desc} :: ${d.detail}`);
    process.exit(r.fail === 0 ? 0 : 1);
  }
  if (argv.includes('--run')) {
    const li = argv.indexOf('--limit');
    const limit = li >= 0 ? Number(argv[li + 1]) || 40 : 40;
    const dryRun = argv.includes('--dry-run');
    const t0 = Date.now();
    const r = await convContextOnce({ limit, dryRun });
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`[conv-context] ${dryRun ? '（干跑）' : ''}会话 ${r.inCount} 个 · 有变化 ${r.pending} 个 · 本轮算 ${r.processed} 个（成功 ${r.ok} · 失败 ${r.failed}）· 用时 ${secs}s`);
    if (r.why) console.log(`[conv-context] ${r.why}`);
    if (r.errors?.length) { console.log(`[conv-context] 错误 ${r.errors.length} 条（前 3）：`); for (const e of r.errors.slice(0, 3)) console.log('  ! ' + String(e).slice(0, 160)) }
    console.log('PASS');
    process.exit(0);
  }
  console.log('用法：node conv-context.mjs --run [--limit N] [--dry-run] | --selftest');
  process.exit(2);
}
