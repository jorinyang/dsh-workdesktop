/**
 * `v1/api/context-summary.mjs` —— **相关上下文的 LLM 概括**（用户 2026-10-14 第 4/5/6/7 条）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户原话（四个页面的详情都点了同一条）
 *   「相关上下文：应检索 **RAG 知识库和本身知识库**；将相关内容通过 **LLM 概括后展示**；
 *     **不得显示相关上下文的文件路径**。」
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 做法与三条纪律
 *
 *   一、**检索**：召回落库在 `evt.context.recalled`（由分析引擎写）。
 *      这里是"拿已经召回的材料去概括"，**不重复检索** —— 免得同一个详情反复打检索层。
 *      若事件上**还没有**召回结果（新消息还没被分析），这里**如实回 none**，
 *      由界面显示"暂无"或"尚未分析"，**不假装检索过**。
 *
 *   二、**概括**：把材料的正文喂给模型，要它写一段**面向人的中文概述**，
 *      并**明确禁止出现文件路径/文件名/编号** —— 这是用户点名的那条。
 *      提示词里把"不要写路径"写死，同时**输出端再兜一道**（见 `stripPaths`）：
 *      模型偶尔会漏，光靠提示词不够。
 *
 *   三、**缓存**：按 `（事件 id + 召回时间 + 材料条数）` 缓存。
 *      同一个详情反复打开不重复烧 token；材料变了（重新分析过）才重算。
 *      缓存落在**运行态目录**（`_meta/out/v1/.runtime/ctx-summary-cache.json`），不是知识库。
 *
 * ⚠️ **不吞错**：模型不可用 / 超时 ⇒ 回 `{text:null, why}`，界面如实说"概括不可用"，
 *   而不是把一堆原文片段当成"概括"展示（那等于骗人）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { v1Out, KB_ROOT } from '../paths.mjs';

const CACHE = () => path.join(v1Out(), '.runtime', 'ctx-summary-cache.json');
let _mem = null;   // 进程内缓存（读一次文件，之后内存里查）

function loadCache() {
  if (_mem !== null) return _mem;
  try { _mem = JSON.parse(fs.readFileSync(CACHE(), 'utf8')) ?? {} } catch { _mem = {} }
  return _mem;
}
function saveCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE()), { recursive: true });
    fs.writeFileSync(CACHE(), JSON.stringify(c, null, 1), 'utf8');
  } catch { /* 缓存写不进去不该影响详情 —— 下次重算而已 */ }
}

/** 把概括里可能漏出来的路径/文件名**兜掉**（提示词管不住的部分，输出端再管一道） */
export function stripPaths(s) {
  return String(s ?? '')
    // 形如 `Work/客户/Input/xxx.md`、`Other/Inflow/…`、`C:\…`、`_meta/…` 的一律去掉
    .replace(/[A-Za-z]:\\[^\s，。；、）)]+/g, '')
    .replace(/(?:^|[\s（(])(?:Work|Research|Other|_meta|Output|Input)\/[^\s，。；、）)]+/g, ' ')
    // 单独的 `.md` / `.txt` / `.jsonl` 文件名
    .replace(/[\w\u4e00-\u9fa5.\-]+\.(?:md|txt|jsonl?|html|csv|xlsx?|docx?|pdf)\b/g, '')
    .replace(/[（(]\s*[)）]/g, '')          // 去掉清空后留下的空括号
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s，。、；:：-]+/, '')
    .trim();
}

/**
 * 材料够不够概括（太少就别叫模型了 —— 一句话材料概括出来也是废话）。
 *
 * ★ 门槛定 20 字（2026-10-14 从 40 调下来）：第一版定 40，结果自检夹具里那几句
 *   **一句 25～26 字的中文**全被判"太短" ⇒ CS-3/5/6/7 一起红。
 *   查清之后确认是**门槛定得太高**：40 字等于"至少两句话"，而一句 26 字的话已经
 *   含得住"谁、做了什么、什么结论"，够概括了。
 *   20 字能挡掉的是「好的」「收到」「[图片消息]」这种**真的没内容**的，
 *   挡不掉也不该挡"一句话的实质信息"。
 */
export function enoughMaterial(hits) {
  const rows = (hits ?? []).filter((h) => String(h?.text ?? '').trim().length >= 12);
  const total = rows.reduce((n, h) => n + String(h.text).trim().length, 0);
  return { ok: rows.length >= 1 && total >= 20, rows, total };
}

/**
 * 概括一条事件的相关上下文。
 * @returns {{text:string|null, why?:string, cached?:boolean, material?:number}}
 */
export async function summarizeContext({ type, evt, deps = {} } = {}) {
  const hits = evt?.context?.recalled ?? [];
  if (hits.length === 0) {
    return { text: null, why: evt?.context?.recallError ? `召回不可用：${evt.context.recallError}` : '这条还没有召回到相关材料（分析引擎跑过之后才有）' };
  }
  const mat = enoughMaterial(hits);
  if (!mat.ok) return { text: null, why: '召回到的材料太短，不足以概括' };

  const key = `${evt._id}|${evt.context?.at ?? ''}|${hits.length}`;
  const cache = loadCache();
  if (cache[key] && typeof cache[key].text === 'string') return { text: cache[key].text, cached: true, material: mat.rows.length };

  // ★ 模型调用走**动态 import**（与 `api/cockpit.mjs` 同一套做法）：
  //   ① 平时不必加载模型模块；② 自检能整块替换掉（`deps.modelFn`），不必真调模型。
  //   第一版我把路径写成了 `../processor/model.mjs` —— **那个文件不存在**，
  //   真正的产地是 `../processor/analyze.mjs`。写错的后果是**只有真调模型时才炸**，
  //   所以自检必须覆盖"模型这一层"（见 `selfTest` 的 CS-5，注入一个假的模型函数）。
  const modelFn = deps.modelFn ?? (await import('../processor/analyze.mjs')).runModel;
  const topic = evt?.payload?.topic ?? evt?.payload?.summary ?? String(evt?.payload?.raw ?? '').slice(0, 60);
  const brief = [
    `【当前${type === 'note' ? '笔记' : type === 'todo' ? '待办' : type === 'schedule' ? '日程' : '消息'}】${String(topic).slice(0, 120)}`,
    '【检索到的相关材料（供你参考，不要照抄，也不要提它们从哪来）】',
    ...mat.rows.slice(0, 6).map((h, i) => `${i + 1}. ${String(h.text).replace(/\s+/g, ' ').slice(0, 400)}`),
    '',
    '请用中文写一段 80~160 字的概述，说明这些材料与当前这条的关系、以及它们提供了什么可用的信息。',
    '硬要求：',
    '· 只写内容本身，**不要出现任何文件路径、文件名、目录名、编号或来源标识**；',
    '· 不要罗列，写成连贯的一段话；',
    '· 材料与当前这条关系不大就直说关系不大，不要硬扯。',
  ].join('\n');

  try {
    const m = await modelFn(brief);
    if (m?.ok === false || !m?.text) {
      return { text: null, why: `概括失败：${m?.why ?? '模型没有返回内容'}` };
    }
    const text = stripPaths(m.text);
    if (text === '') return { text: null, why: '概括结果里只剩路径（已被剔除），没有可用内容' };
    cache[key] = { text, at: new Date().toISOString(), material: mat.rows.length, raw_len: String(m.text).length };
    saveCache(cache);
    return { text, material: mat.rows.length };
  } catch (e) {
    return { text: null, why: `概括失败：${String((e && e.message) || e).slice(0, 160)}` };
  }
}

/**
 * **同步取**概括（给"不是 async 的 handler"用，见 server.mjs 详情路由那段注释）。
 *
 * 三种回执：
 *   · 缓存里有 ⇒ `{text, cached:true}`
 *   · 该有但没有 ⇒ **立刻回 `{pending:true}` 并在后台开算**（详情不等模型：它要几十秒）
 *   · 压根不该有（没材料 / 材料太短）⇒ `{text:null, error:'为什么'}`
 *
 * 为什么这么设计：详情浮层是**点一下就打开**的东西，让它等模型几十秒是不可接受的。
 *   ⇒ 先回"正在概括…"，后台算完写进缓存；界面再打开（或轮询一次）就拿到了。
 *   ⚠️ 后台算失败**不吞**：写进缓存一个 `error` 字段，下次同步取时如实带出来。
 */
export function ctxSummaryCached(evt) {
  const hits = evt?.context?.recalled ?? [];
  if (hits.length === 0) {
    return { text: null, error: evt?.context?.recallError ? `召回不可用：${evt.context.recallError}` : '这条还没有召回到相关材料（分析引擎跑过之后才有）' };
  }
  const mat = enoughMaterial(hits);
  if (!mat.ok) return { text: null, error: '召回到的材料太短，不足以概括' };

  const key = `${evt._id}|${evt.context?.at ?? ''}|${hits.length}`;
  const cache = loadCache();
  const hit = cache[key];
  if (hit && typeof hit.text === 'string' && hit.text !== '') return { text: hit.text, cached: true, material: hit.material ?? null };
  if (hit && hit.error) return { text: null, error: hit.error };

  // 缓存里没有 ⇒ 后台开算（**同一份材料只开一次**：用 `_inflight` 挡住重复触发）
  if (!_inflight.has(key)) {
    _inflight.add(key);
    // 注意：**不 await** —— 这里是同步函数，算完自己落缓存。
    summarizeContext({ type: evt.type, evt })
      .then((r) => {
        const c = loadCache();
        if (r.text) c[key] = { text: r.text, at: new Date().toISOString(), material: r.material ?? null };
        else c[key] = { error: r.why ?? '概括失败' };
        saveCache(c);
      })
      .catch((e) => {
        const c = loadCache();
        c[key] = { error: `概括异常：${String((e && e.message) || e).slice(0, 120)}` };
        saveCache(c);
      })
      .finally(() => { _inflight.delete(key) });
  }
  return { text: null, pending: true };
}
const _inflight = new Set();
/**
 * 清掉概括缓存（**给自检用**）。
 * ★ 为什么需要：CS-7 那条检查（"同一份材料第二次走缓存"）**跨轮会互相干扰** ——
 *   上一轮算过的键留在缓存里，这一轮第一次就直接命中 ⇒ 模型一次没调 ⇒ 判红。
 *   检查要**自清**才能独立复跑，不能依赖"上一轮没跑过"。
 */
export function _clearSummaryCache() { _mem = {}; try { fs.rmSync(CACHE(), { force: true }) } catch { /* 没有就算了 */ } }

export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail: String(detail) });

  // CS-1 路径兜底：模型漏出来的路径必须被剔掉（用户点名的那条硬要求）
  const dirty = '材料提到 Work/中艺AI大赛/Input/钉钉/_transcripts/单聊-木兰.txt 这份记录，还提到 C:\\Users\\Aorus\\Desktop\\Knowledge\\Other\\Inflow\\x.md 和 方案.docx。';
  const cleaned = stripPaths(dirty);
  chk('CS-1', '★ 概括里漏出来的路径/文件名被剔掉（用户点名：不得显示文件路径）',
    !/Work\/|C:\\|\.md|\.docx|_transcripts/.test(cleaned) && cleaned.includes('材料提到'),
    cleaned.slice(0, 110));
  chk('CS-2', '剔完之后不留空括号/杂乱标点', !/[（(]\s*[)）]/.test(cleaned) && !/\s{2,}/.test(cleaned));

  // CS-3 材料太短就别叫模型
  chk('CS-3', '材料太短 ⇒ 不调模型，如实说"不足以概括"',
    enoughMaterial([{ text: '短' }]).ok === false && enoughMaterial([{ text: '这是一段足够长的材料，用来测试概括的门槛是否生效。' }]).ok === true);

  // CS-4 没有召回 ⇒ 如实说，且不调模型
  let called = 0;
  const neverCalled = async () => { called += 1; return { ok: true, text: '不该被调用' } };
  const r4 = await summarizeContext({ type: 'message', evt: { _id: 'x', context: { recalled: [] } }, deps: { modelFn: neverCalled } });
  chk('CS-4', '没有召回材料 ⇒ 回"还没有召回到"且**不调模型**', r4.text === null && called === 0, String(r4.why).slice(0, 90));

  // ★★ CS-5 模型这一层必须被覆盖 —— 第一版 import 路径写错，只有真调模型时才炸
  const fakeModel = async () => ({ ok: true, text: '这段材料说明了客户在培训中关注的重点，与当前这条直接相关。路径 Work/a/b.md 不该出现。' });
  const r5 = await summarizeContext({
    type: 'message',
    evt: { _id: 'cs5', context: { at: 'T1', recalled: [{ text: '这是一段足够长的召回材料，用来验证概括链路是否接通。' }] }, payload: { raw: '测试' } },
    deps: { modelFn: fakeModel },
  });
  chk('CS-5', '★★ 概括链路接通（模型这层真的被调到），且**输出端的路径兜底也生效**',
    r5.text !== null && r5.text.includes('客户') && !/Work\/|\.md/.test(r5.text),
    String(r5.text ?? r5.why).slice(0, 120));

  // CS-6 模型失败 ⇒ 不吞，如实回 why
  const badModel = async () => ({ ok: false, why: '模型返回非 0（exit=1）' });
  const r6 = await summarizeContext({
    type: 'message',
    evt: { _id: 'cs6', context: { at: 'T2', recalled: [{ text: '这是一段足够长的召回材料，用来验证模型失败时的表现。' }] }, payload: { raw: '测试' } },
    deps: { modelFn: badModel },
  });
  chk('CS-6', '★ 模型失败 ⇒ **如实报失败**（不拿片段冒充概括）',
    r6.text === null && /概括失败/.test(String(r6.why)), String(r6.why).slice(0, 100));

  // CS-7 缓存：同一份材料第二次不再调模型
  // ★ 先清缓存 —— 否则上一轮算过的键还在，这一轮第一次就命中，模型一次没调 ⇒ 假红。
  _clearSummaryCache();
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, text: '第一次概括的结果，用于验证缓存是否生效。' } };
  const evtSame = { _id: 'cs7', context: { at: 'T3', recalled: [{ text: '这是一段足够长的召回材料，用来验证缓存。' }] }, payload: { raw: '测试' } };
  const a = await summarizeContext({ type: 'message', evt: evtSame, deps: { modelFn: counting } });
  const b = await summarizeContext({ type: 'message', evt: evtSame, deps: { modelFn: counting } });
  chk('CS-7', '★ 同一份材料第二次走缓存（不重复烧 token）', calls === 1 && b.cached === true && a.text === b.text,
    `模型被调 ${calls} 次 · 第二次 cached=${b.cached}`);

  return { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out };
}
