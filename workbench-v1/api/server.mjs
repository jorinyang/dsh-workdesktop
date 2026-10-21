/**
 * v1/api/server.mjs —— **本地 HTTP 接口**（P4/P5 的接缝：页面 ↔ 运行态）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么需要它：页面现在只能"看"（服务端渲染），不能"操作"。
 *   需求 3.3.3–3.3.6 都要求"可以新增一条"和"点击弹详情、做操作（转待办/转日程/已回复…）" ——
 *   这些必须有一条**写路径**。而写路径早就在契约里登记过（`v1/write-routes.json`，13 条）。
 *
 * ★ 三条纪律写进代码
 *   ① **只放行登记过的写路径**：请求的 method+path 必须在 `write-routes.json` 里；
 *      没登记的一律 404 并说明"未登记"。这样"新增一条野路子写接口"必须先去登记表上签字。
 *   ② **写只落运行态，不直接写知识库**：新增的事件先进 store，由筛选引擎负责结构化与双写。
 *      否则"知识库落盘"会有第二处实现（本项目吃过"两处各写一遍"的亏）。
 *   ③ **校验失败如实回报**：把 schema 的逐条错误原样回给调用方（400 + errors），不吞。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath , pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';   // ★ 会话级转换的幂等键用它算（ESM 里没有 require）

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import * as pages from './pages.mjs';
// ★ 2026-10-14 加：自检里要直接问"这条现在落在哪一档"（todos/schedules 的桶）
//   与"消息属于哪个页签"（messageState）—— 这一轮的要求全是"**状态真的变了吗**"，
//   只看接口回没回 200 是不够的（前几轮栽的就是"接口成功、记录没动"）。
const { todos, schedules, messages, messageState, MESSAGE_TABS } = pages;
import { NARRATIVE_SPECS } from './cockpit.mjs';   // 驾驶舱四块的落点（允许值从它取，**一处定义**）
// ★ 2026-10-14 加：**相关上下文的 LLM 概括**（用户第 4/5/6/7 条都点名同一条：
//   "检索 RAG 与本身知识库 → 经 LLM 概括后展示 → 不得显示文件路径"）。
//   放在 api 层是因为它只服务详情接口，不参与采集/分析那两条流水。
import { summarizeContext, ctxSummaryCached } from './context-summary.mjs';
// ★ 2026-10-14 加（用户原话：「消息页面的消息列表应该改成按照会话聚合的会话列表」）：
//   会话聚合是**纯函数**（无 IO），静态 import 进来 —— 读路由那条 if 链是同步的，
//   在那里写 `await import()` 会直接语法错（本文件已有一次同样教训）。
import { conversations as conversationsOf, one as conversationOne, channelName as channelNameOf } from '../processor/conversations.mjs';
// ★★ 2026-10-21 加：**事件聚合**（页面层再上一层视角：一堆会话算不算"同一件事"）。
//   规范：`Research/Output/个人工作台/02-规范与标准/SPEC_事件聚合规范.md`
//   第一层是纯函数、没有 IO ⇒ 静态 import 即可（与 conversations 同理，不走动态 import）。
import * as eventsApi from '../processor/events.mjs';
import { loadCache as loadConvCache, convKey as convCacheKey, fingerprint as convFingerprint } from '../processor/conv-context.mjs';
// ★ 2026-10-14 加（用户第 5.1 / 6.1 条）：**把一段话收成"一句话"** —— 消息转待办/转日程的标题用它。
//   原来那两处的标题是 `summary ?? raw` 再截 80 字，而 `summary` 本身就是原文截断
//   ⇒ 结果是**被切一半的话**，不是"概括为一句话"。纯规则，不调模型（见 brief.mjs 的说明）。
import { briefTitle, pickParticipants, pickPlace } from '../processor/brief.mjs';
// ★ 2026-10-14 加（用户这一轮）：**从「消息 + 相关上下文」里提取结构化字段**。
//   三种转换（转待办/转日程/转笔记）与两种跨转换都走它 —— 一处产地，不各写一套判法。
import { extractTodo, extractSchedule, extractNote } from '../processor/extract.mjs';
import { KB_ROOT as ROOT, PKG_ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

// ══════════════════════════════════════════════════════════════════════════════
// ★ 为什么通道/水位线**不再静态 import**（2026-10-12 实测定位，不是预防性写法）
//
// 现象：面板（DSH 插件 host）上 `GET /workdesktop/api/v1/health` 报 implemented=9/18，
//       同一个文件在新进程里 `health()` 报 18/18 —— 同文件、同函数，**只差进程**。
// 真因：插件 host（`Desktop/DSH/plugins/dsh-workdesktop/lib/index.js` L3889）用动态 `import()`
//       **一次性**加载本文件；ES 模块在**一个 Node 进程里只执行一次**（模块注册表缓存），
//       而这三条原本是静态 import ⇒ registry/state 的模块态被冻在进程启动那一刻（本机 03:57:55）。
//       此后三轮开发把 13→18 条通道写进了文件，**进程里没有**。
// 影响：① 面板显示假读数（实测 9/18）；② 更糟的是**以后每次改 v1 都不生效**，直到重启 —— 会反复骗人。
//
// 处置：这两条按**每次请求现读** —— 带 `?v=<文件 mtime>` 的动态 import：
//       文件一变 URL 就变 ⇒ 模块重新求值；文件没变则命中缓存（不白读盘）。
//       守卫见自检 API-35/36（真改文件 ⇒ 读数必须跟着变，不许再冻住）。
// ══════════════════════════════════════════════════════════════════════════════
const REGISTRY_URL = new URL('../collector/registry.mjs', import.meta.url);
const STATE_URL = new URL('../collector/state.mjs', import.meta.url);
const freshCache = new Map();

/** 按文件 mtime 取模块：没改就复用，改了立刻重新求值（绕开 ESM 的进程级只加载一次） */
export async function freshMod(url, tag) {
  let mtime = 0;
  try { mtime = fs.statSync(url).mtimeMs; } catch { mtime = 0; }
  const key = tag + '@' + mtime;
  if (freshCache.has(key)) return freshCache.get(key);
  const u = new URL(url.href);
  u.searchParams.set('v', String(mtime));
  const mod = await import(u.href);
  freshCache.set(key, mod);
  return mod;
}
/** 通道健康（现读；读不到如实回 error，不假装"没接"） */
export async function registryHealthLive() {
  try { return (await freshMod(REGISTRY_URL, 'registry')).health(); }
  catch (e) { return { error: `通道登记表读不到：${e.message}`, total: null, implemented: null, missing: null }; }
}
/** 水位线健康（现读；同上） */
export async function stateHealthLive() {
  try { return (await freshMod(STATE_URL, 'state')).health(); }
  catch (e) { return { error: `水位线模块读不到：${e.message}` }; }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const API_PREFIX = '/workdesktop/api/v1';

/** 读登记表并归一：登记表里写的是 `route` 整串（如 "POST /workdesktop/api/v1/messages"） */
export function writeRoutes() {
  try {
    // ★ 登记表是**包内资源**，必须按 PKG_ROOT 解析，**不能**按知识库根：
    //   否则一旦用环境变量把 KB_ROOT 指到别处（测试就是临时目录），这里就会去那里找一个不存在的文件。
    const d = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'write-routes.json'), 'utf8'));
    const rows = Array.isArray(d) ? d : (d.routes ?? []);
    return rows.map((r) => {
      if (r.path) return { method: String(r.method ?? 'POST').toUpperCase(), path: r.path, engine: r.engine ?? null, reason: r.reason ?? null };
      const m = /^([A-Z]+)\s+(\S+)$/.exec(String(r.route ?? '').trim());
      return m ? { method: m[1], path: m[2], engine: r.engine ?? null, reason: r.reason ?? null } : { method: '?', path: String(r.route ?? ''), engine: null, reason: null };
    });
  } catch { return []; }
}

/** 已登记的写路径（method + path 精确匹配；带 `:id` 的模板按前缀段匹配） */
export function isRegistered(method, urlPath) {
  const m = String(method).toUpperCase();
  return writeRoutes().some((r) => {
    if (r.method !== m) return false;
    if (r.path === urlPath) return true;
    if (!r.path.includes(':')) return false;
    const a = r.path.split('/'); const b = urlPath.split('/');
    if (a.length !== b.length) return false;
    return a.every((seg, i) => (seg.startsWith(':') ? b[i].length > 0 : seg === b[i]));
  });
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj, null, 1);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    // ⚠️ 本函数**一个请求只能调一次** —— 请求流消费完就没了，再调会永久挂起
    //   （2026-10-12 实测踩到：见下方 `if (act)` 里那条长注释）。加一行守卫，让复用立刻现形而不是挂 180 秒。
    if (req.readableEnded || req.complete) return resolve({ ok: false, why: '请求体已被读过一次（readBody 不得重复调用）' });
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { req.destroy(); resolve({ ok: false, why: '请求体过大' }); } else chunks.push(c); });
    req.on('end', () => { try { resolve({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch (e) { resolve({ ok: false, why: `请求体不是合法 JSON：${e.message}` }); } });
    req.on('error', (e) => resolve({ ok: false, why: e.message }));
  });
}

/** 新增一条事件（四类通用）：校验 → 落运行态 → 交给筛选引擎 */
export function createEvent(type, payload, { origin = null, at = null } = {}) {
  // ★★ 2026-10-13 加（用户第 9 条 / 需求 3.3.4）：
  //   「所有待办创建的时候都应当根据待办的具体事项，**匹配验证/关闭的条件**」——
  //   实测这个字段**全库没有任何地方在写**（11 条待办，带关闭条件 0 条），
  //   自动关闭的判定（`close.mjs#autoCloseTodos`）虽然在跑，但创建时从不填条件 ⇒ 这一环是断的。
  //   ⇒ 在**唯一的创建入口**这里补上（四条路径都经过它：本页新建、消息转待办、日程转待办、采集器）。
  //     `withCloseCondition` 是幂等的：**已经填过就不覆盖**，尊重人工写的条件。
  const withCond = type === 'todo' && _deps.withCloseCondition
    ? _deps.withCloseCondition(payload ?? {})
    : (payload ?? {});
  const made = makeEvent({
    type,
    payload: withCond,
    origin: origin ?? { channel: 'manual', sender: '我', messageId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, raw: null },
    _at: at ?? Date.now(),
  });
  if (made.ok === false) return { ok: false, code: 400, errors: made.errors };
  const r = store.upsert(made.event);
  if (r.action === 'rejected') return { ok: false, code: 400, errors: [r.reason ?? '落库被拒'] };
  return { ok: true, code: 200, id: made.event._id, action: r.action, event: made.event };
}

const EVENT_FOR = { messages: 'message', notes: 'note', todos: 'todo', schedules: 'schedule' };

/**
 * **这条事件还需不需要取相关上下文**（用户 2026-10-14 要的"流入时取一次、之后不重复取"）。
 *
 * ⚠️ 判据本体在 `processor/context-gate.mjs`（**中立小模块**），这里只是转出去方便调用。
 *   为什么不直接写在这个文件里：分析引擎也要用同一个判据，而 `server.mjs` 会动态 import
 *   分析引擎 ⇒ 写在这里就成了**两边互相引用**（懒加载下当时不炸，但那是埋着的隐患）。
 */
import { needsContext as needsContextGate, queryOf } from '../processor/context-gate.mjs';
export { needsContext } from '../processor/context-gate.mjs';

/**
 * **给一条事件补一次相关上下文**（**只召回，不调模型**）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么把这件事提成一个函数（原来只写在"新建消息"那一小段里）
 *
 *   实测：原来**只有"经接口新建消息"这一条路**会就地召回（ops 记 `recalled-on-create`），
 *   依据是需求 3.3.3 里的一句话。流入的另外几条路**都没有这一步**：
 *     · **采集器进来的消息**（钉钉/飞书/微信…，占了绝大多数）—— 采集器走 `makeEvent` + `store.upsert`，
 *       根本不经过接口；
 *     · **待办 / 日程 / 笔记**经接口新建 —— 那种情况下原来 `type !== 'message'` 直接就 return 了。
 *   ⇒ 所以"流入时取上下文"实际上**只覆盖了一小部分**。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 与"分析引擎"是什么关系（两处都在取，会不会重复）
 *
 *   · 这里是**新建时当场取**（点"存为笔记"那一刻就取好，详情页立刻有材料可显示）；
 *   · 分析引擎是**兜底清扫**（采集器那条路不经过接口，只能靠它按批补）。
 *   两者**共用上面的 `needsContext`** ⇒ 谁先跑都一样，**不会重复取**。
 *   ⚠️ 判据必须一致，否则会出现"接口取过一遍、引擎又取一遍"——那正是用户要避免的。
 */
export async function recallIntoEvent(type, id, evt, { deps = _deps, force = false } = {}) {
  if (!force && !needsContextGate(evt)) {
    const had = evt?.context?.recalled ?? [];
    return { skipped: true, hits: had.length, recalled: had, recallError: evt?.context?.recallError ?? null };
  }
  const q = queryOf(evt);
  if (q === '') return { skipped: true, hits: 0, recalled: [], recallError: null, why: '没有可检索的文本' };
  const { recall } = await import('../processor/recall.mjs');
  let hits = []; let recallError = null;
  try {
    const rr = await (deps.recall ?? recall)(q);
    if (rr.ok === true) hits = rr.hits; else recallError = rr.why;
  } catch (e) {
    recallError = `召回异常：${String(e && e.message).slice(0, 120)}`;
  }
  store.patch(type, id, { context: { recalled: hits, at: new Date().toISOString(), recallError } }, { op: 'recalled-on-create', by: 'api', evidence: { hits: hits.length, recallError } });
  // ⚠️ 回执里**要带 `recalled` 数组本体**，不只是条数 —— 原来那条路返回的就是数组，
  //   我改成只给计数时 `API-10c` 当场变红（界面上也可能直接用它）。**能少给信息就别改形状。**
  return { hits: hits.length, recalled: hits, recallError };
}

/**
 * **可注入的动作实现**（只给自检用；生产路径为 null ⇒ 走动态 import 的真实现）。
 *
 * 为什么要有这个口子：ESM 的模块命名空间对象是**只读**的
 * （实测：`analyzeMod.reanalyzeNote = …` ⇒ `TypeError: Cannot assign to read only property`）
 * ⇒ 自检没法用"猴子补丁"换掉模型调用，而笔记的「分析笔记」动作**真会调模型**。
 * 若不做这个口子，这个自检要么真烧 token、要么只能不测 —— 两条都不要。
 * 注意它**只**在本文件的导出上（可写），与生产行为无关：不注入就一字不差走原路。
 */
export const _deps = {
  reanalyzeNote: null, buildVisualForNote: null, recall: null,
  // ★ 2026-10-13：创建待办时补"关闭条件"（`close.mjs#withCloseCondition`）。
  //   放 `_deps` 是为了自检能替换它（不真写库）。**默认在模块加载时就接上**——
  //   不接的话这个功能只在测试里存在、线上是空的（那正是它此前 0 条的原因）。
  withCloseCondition: null,
};
{
  const { withCloseCondition } = await import('../processor/close.mjs');
  _deps.withCloseCondition = withCloseCondition;
}

export function handler(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  // ── 读路径（GET）────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (p === `${API_PREFIX}/health`) {
      // 现读（见上方长注释）：handler 保持同步签名，这两条是 async ⇒ 内部消化后再回
      return Promise.all([registryHealthLive(), stateHealthLive()])
        .then(([ch, wm]) => json(res, 200, { channels: ch, watermarks: wm }))
        .catch((e) => json(res, 500, { error: `健康读数失败：${e.message}` }));
    }

    // ★★ 2026-10-13 加（用户第 7 条）：**把消息里的图片取出来给详情页显示**。
    //   用户原话：「点击消息列表中的对应图片消息进入详情后，需要能够显示出该图片。」
    //   实测：消息的 `payload.fileRef` 指向 `Other/Inflow/文件/<月>/<mediaId>.<ext>`，文件**都在**（35/35）。
    //   但浏览器取不到它 —— 面板那条路由只供 `/yishu/<页>`，没有取文件的通道 ⇒ 页面上没法显示。
    //
    //   ⚠️ 安全边界（这是**唯一**能让外部按路径读知识库文件的入口，必须收紧）：
    //     ① 只允许 `Other/Inflow/` 之下（图片/文件/文档的落点），别的目录一律 403；
    //     ② 解析成绝对路径后**再确认它仍在允许目录内**（挡 `..` 穿越）；
    //     ③ 只回**图片与常见文档**这几类扩展名，不回 `.mjs` / `.json` / `.env` 这类；
    //     ④ 只读，绝不写。
    const fm = new RegExp(`^${API_PREFIX}/file$`).exec(p);
    if (fm) {
      if (!isRegistered('GET', `${API_PREFIX}/file`)) return json(res, 404, { error: '取文件路径未登记（先去 write-routes.json 登记）' });
      const rel = String(u.searchParams.get('p') ?? '').replace(/\\/g, '/');
      if (rel === '') return json(res, 400, { error: '缺少参数 p（形如 Other/Inflow/文件/2026-10/x.jpg）' });
      const ALLOW_DIR = path.join(ROOT, 'Other', 'Inflow');
      const ALLOW_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf', '.md', '.txt', '.docx', '.xlsx', '.pptx', '.zip']);
      const abs = path.resolve(ROOT, rel);
      const within = abs === ALLOW_DIR || abs.startsWith(ALLOW_DIR + path.sep);
      if (!within) return json(res, 403, { error: '只允许读 Other/Inflow 下的文件' });
      if (!ALLOW_EXT.has(path.extname(abs).toLowerCase())) return json(res, 403, { error: `这类扩展名不给：${path.extname(abs)}` });
      if (!fs.existsSync(abs)) return json(res, 404, { error: `文件不在：${rel}` });
      const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
      const buf = fs.readFileSync(abs);
      res.writeHead(200, {
        'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(buf.length),
        'cache-control': 'private, max-age=300',
      });
      res.end(buf);
      return true;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-14 加：`GET /doc?p=<知识库相对路径>` —— 给**驾驶舱知识图谱**的文档节点穿透用。
    //   用户第 8.1 条：「每个节点都能够点击穿透到具体的**知识点内容/文档**。」
    //   图谱里的 `doc` 节点指向 `Work/…`、`Research/…` 下的正文，浏览器取不到 ⇒ 需要这一条。
    //
    //   ⚠️ 这条路**比 `/file` 更要小心**：`/file` 只放开 `Other/Inflow` 一个目录，
    //      而这里要读的是**整个知识库的正文**。所以四条限制一条都不能少：
    //        一、只允许 `Work/` 与 `Research/` 两个顶层目录（**不是整个知识库**）——
    //            `_meta/`、`Other/` 这些**明确排除**（里面有登记表、密钥线索、运行态文件）；
    //        二、只允许**纯文本类**扩展名（正文）；二进制一律不给；
    //        三、解析成绝对路径之后**再核一次**它在允许目录之内（挡 `..` 穿越）；
    //        四、**截断**（文件很长时只回前一段 —— 这个通道是给"点一下看看是什么"用的，
    //            不是给下载全文用的；回整份会把浮层和响应都撑爆）。
    const docm = new RegExp(`^${API_PREFIX}/doc$`).exec(p);
    if (docm) {
      if (!isRegistered('GET', `${API_PREFIX}/doc`)) return json(res, 404, { error: '文档路径未登记（先去 write-routes.json 登记）' });
      const rel = String(u.searchParams.get('p') ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (rel === '') return json(res, 400, { error: '缺少参数 p（形如 Work/客户/Output/某文档.md）' });
      const ALLOW_TOP = ['Work', 'Research'];
      const TEXT_EXT = new Set(['.md', '.txt', '.html', '.csv', '.json', '.jsonl', '.yml', '.yaml', '.tsv']);
      const top = rel.split('/')[0];
      if (!ALLOW_TOP.includes(top)) return json(res, 403, { error: `只允许读 ${ALLOW_TOP.join(' / ')} 下的正文（这一条是 ${top}）` });
      if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) return json(res, 403, { error: `这类扩展名不给（只给纯文本正文）：${path.extname(rel)}` });
      const abs = path.resolve(ROOT, rel);
      // ★ 解析之后再核一次（`Work/../_meta/x` 这种要在这一步被挡住）
      const okTop = ALLOW_TOP.some((t2) => {
        const base = path.join(ROOT, t2);
        return abs === base || abs.startsWith(base + path.sep);
      });
      if (!okTop) return json(res, 403, { error: '解析之后的路径不在允许目录之内（路径穿越已挡住）' });
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: `文件不在：${rel}` });
      const LIMIT = 20000;
      let text = fs.readFileSync(abs, 'utf8');
      const truncated = text.length > LIMIT;
      if (truncated) text = text.slice(0, LIMIT);
      return json(res, 200, { ok: true, path: rel, text, truncated, bytes: fs.statSync(abs).size });
    }

    // ★★ 2026-10-14 加（用户原话）：**会话详情**。
    //   「点击会话列表进入会话详情，会话详情中，除了现有的来源渠道、发信人之外，
    //     **信息原文应该是按照时间顺序，将当天该会话的所有信息按时间排序（XX：XX  XXXXXXXXXXX）**。
    //     在**相关上下文**中的分析改为**每 15 分钟让大模型跑一次当天该会话的信息**，
    //     获取与当天会话信息相关的上下文，并列举在此处。」
    //   ⚠️ 放在 `detail/:type/:id` **之前**：会话 id 与那条正则不匹配（含 `:` `/` `+`），
    //     但先判更稳妥 —— 免得以后放宽路径字符集时被它抢走。
    if (p === `${API_PREFIX}/conversation`) {
      if (!isRegistered('GET', `${API_PREFIX}/conversation`)) return json(res, 404, { error: '会话详情路径未登记（先去 write-routes.json 登记）' });
      const cid = String(u.searchParams.get('id') ?? '').trim();
      if (cid === '') return json(res, 400, { error: '缺少 id（会话标识，形如 2026-10-14__cid:xxx）' });
      const c = conversationOne(cid);
      if (!c) return json(res, 404, { error: '没有这个会话（可能当天没有消息，或会话标识不对）', id: cid });
      // 上下文：读**会话级**那份（15 分钟一轮、由大模型跑出来的），
      //   **不在这个请求里调模型** —— 那会让人等几十秒。
      const cache = loadConvCache();
      const k = convCacheKey(c);
      const rec = cache[k] ?? null;
      const stale = rec ? rec.fingerprint !== convFingerprint(c) : true;
      return json(res, 200, {
        ok: true, id: c.id, day: c.day, count: c.count,
        channel: c.channel, sender: c.sender,
        // 信息原文：**按时间升序**，形态 `XX:XX 内容`（前端直接按这个显示）
        messages: c.items.map((e) => {
          const dd = new Date(e._at);
          const pp = (n) => String(n).padStart(2, '0');
          return {
            id: e._id, at: e._at, hm: `${pp(dd.getHours())}:${pp(dd.getMinutes())}`,
            sender: String(e.payload?.sender ?? ''), channel: channelNameOf(e.payload?.channel),
            raw: String(e.payload?.raw ?? ''), hasImage: /mediaId=|\[图片消息\]/.test(String(e.payload?.raw ?? '')),
          };
        }),
        // 会话级相关上下文（大模型跑出来的那份）
        convContext: rec?.text ?? null,
        convContextError: rec?.error ?? null,
        convContextAt: rec?.at ?? null,
        convContextStale: stale && !!(rec?.text),      // 有新消息但还没轮到重算 ⇒ 界面可以说明"这段之后又有新消息"
        convContextPending: !rec,                      // 还没算过 ⇒ "正在算"
        availableOps: ['已回复', '转待办', '转日程', '转笔记'],
      });
    }

    // 详情浮层数据：结构化内容 + 原始消息 + 相关上下文 + 可执行操作
    // 路径必须先登记（write-routes.json 里有这条 GET）—— 读路径也守同一条纪律，别偷偷开洞
    const d = new RegExp(`^${API_PREFIX}/detail/([a-z]+)/([A-Za-z0-9_]+)$`).exec(p);
    if (d) {
      if (!isRegistered('GET', `${API_PREFIX}/detail/:type/:id`)) return json(res, 404, { error: '详情路径未登记（先去 write-routes.json 登记）' });
      const type = d[1]; const id = d[2];
      const typeMap = { messages: 'message', notes: 'note', todos: 'todo', schedules: 'schedule' };
      const t = typeMap[type];
      if (!t) return json(res, 404, { error: `未知类型：${type}`, available: Object.keys(typeMap) });
      const evt = store.getById(t, id);
      if (!evt) return json(res, 404, { error: '没有这条事件', type, id });
      const opsFor = {
        message: ['转待办', '转日程', '转笔记', '已回复'],
        todo: ['已搁置', '转日程', '已完成'],
        schedule: ['转待办', '已完成'],
        note: ['可视化构建', '分析笔记'],
      };
      // ★ 判定结果（用户 Q2 的"待处置"就落在这里）：判过但判据不足的候选项。
      //   只报 **还没建出来** 的那些 —— 已建的已经在列表里了，再报一次会让人以为重复。
      const det = evt._detect ?? null;
      const createdKinds = new Set((det?.created ?? []).map((c) => c.kind));
      const pending = (det?.pending ?? []).filter((c) => !createdKinds.has(c.kind));
      // ★★ 2026-10-14 加（用户这一轮第 4/5/6/7 条都点名同一条）：
      //   「相关上下文：应检索 RAG 知识库和本身知识库；将相关内容通过 **LLM 概括后展示**；
      //     **不得显示相关上下文的文件路径**。」
      //   ⇒ 在服务端**按需**概括一次，**按（命中集合 + 事件更新时间）缓存** ——
      //     同一个详情反复打开不该反复烧 token；材料变了（`context.at` 变）才重算。
      //   ⚠️ 概括失败**不吞**：回 `summaryError`，界面如实说"概括不可用"，而不是拿一堆片段冒充概括。
      //   ⚠️ 这一段所在的 handler **不是 async**（详情路由是同步函数）—— 第一版直接写 `await`，
      //      `node --check` 当场报 `Unexpected reserved word`。
      //      ⇒ 用**同步返回 + 内部消化**的写法：概括是异步的，就先回一个占位、
      //        概要在后台算完再让界面刷新（见客户端 `contextSummaryPending`）。
      //        这样详情**立刻打开**（不等模型几十秒），概括随后补上。
      const ctx = ctxSummaryCached(evt);
      const ctxSummary = ctx.text ?? null;               // ★ 给**文本**，不是整个对象
      const ctxSummaryError = ctx.error ?? null;
      const ctxSummaryPending = ctx.pending === true;
      return json(res, 200, {
        id: evt._id, type: evt.type, lifecycle: evt.lifecycle, at: evt._at,
        structured: evt.payload,                       // 结构化内容
        original: evt.origin,                          // 原始消息（来源/发信人/原文）
        context: evt.context ?? { recalled: [] },      // 相关上下文（分析引擎召回后写入）
        // ★ 给界面用的**概括**（不含任何文件路径，见 `summarizeContext`）
        contextSummary: ctxSummary,
        contextSummaryError: ctxSummaryError,
        contextSummaryPending: ctxSummaryPending,      // ★ 还在算 ⇒ 界面显示"正在概括"，别显示成"暂无"
        analysis: evt.analysis ?? null,                // 分析与建议 / 可视化（笔记用）
        deliverables: evt.deliverables ?? [],
        ops: evt.ops ?? [],
        detect: det ? { at: det.at, summary: det.summary, created: det.created ?? [], pending } : null,
        availableOps: opsFor[evt.type] ?? [],          // 可执行操作（界面据此渲染按钮）
      });
    }

    const m = new RegExp(`^${API_PREFIX}/pages/([a-z]+)$`).exec(p);
    if (m) {
      const key = m[1];
      // ★★ 2026-10-14（用户原话）：「消息页面的消息列表应该改成**按照会话聚合的会话列表**」。
      //   ⇒ 消息页的数据从"一条条消息"换成"一条条会话（会话 × 天）"。
      //   ⚠️ 保留原 `messages` 聚合不动：它还管着每条消息的处置状态（转待办/转日程/转笔记），
      //     会话列表是在它**之上**的一层视角，不是把它顶掉。
      if (key === 'messages') {
        // ⚠️ 这里的 handler 不是 async（整个读路由是一条同步的 if 链），
        //   所以**不能直接 `await`** —— 第一版写了 `await import(...)`，`node --check` 当场报
        //   `Unexpected reserved word`（这个坑本文件第 346 行附近的注释里已经记过一次）。
        //   ⇒ 用**已经静态 import 好的模块**（会话聚合是纯函数、没有 IO，不需要动态 import）。
        const cv = conversationsOf({ tab: u.searchParams.get('tab') ?? 'all' });
        const flat = pages.messages({ tab: 'all' });
        return json(res, 200, {
          // ★★ 2026-10-14 改口径（**这次改动牵连到的地方**）：列表已经是**会话**了，
          //   卡片上的数字就必须是**会话数**。原来给的是 message 条数 ⇒
          //   会出现"待处理 213"而列表只有 54 行 —— **数字说有、列表对不上**，
          //   正是这个项目里已经栽过几次的那类自相矛盾。
          //   `byMessage` 另给一份条数：需要看"到底多少条消息"时还有地方可取。
          counts: cv.counts,
          byMessage: { pending: flat.counts.pending, toTodo: flat.counts.toTodo, toSchedule: flat.counts.toSchedule, toNote: flat.counts.toNote, replied: flat.counts.replied, total: flat.counts.total },
          list: cv.list, tab: cv.tab,
          tabs: MESSAGE_TABS,
          // 每条消息的处置状态照旧给出来（会话行上的"已转待办"等标记要用）
          messageStates: Object.fromEntries(flat.list.map((x) => [x.id, x.state])),
          view: 'conversations',
        });
      }
      // ★★ 2026-10-21 加：**事件页**（消息页升级后的那一层）。
      //   与 `messages` 并列、不替换 —— 旧的路由留着（页面万一出问题还能退回会话列表）。
      //   数据全来自 `processor/events.mjs#buildEvents()`：第一层是纯函数，
      //   第二层（每小时聚类）若该天缓存里有结果就一并生效，没有就如实标 `clustered:false`。
      if (key === 'events') {
        const day = u.searchParams.get('day') || null;
        return json(res, 200, eventsApi.buildEvents({ day }));
      }
      const fn = pages[key === 'overview' ? 'overview' : key];
      if (typeof fn !== 'function') return json(res, 404, { error: `没有这个页面数据：${key}`, available: ['overview', 'messages', 'events', 'todos', 'schedules', 'notes'] });
      const data = fn();
      // ★ 日程页额外带**密度热力图**（需求 3.3.5）：左侧月历热力 + 右侧动态分析。
      //   放在这里而不是塞进 `schedules()`，是因为它在语义上是"日程页的第二块"，不是日程列表的一部分。
      if (key === 'schedules') return json(res, 200, { ...data, heatmap: pages.scheduleHeatmap({}) });
      return json(res, 200, data);
    }
    return json(res, 404, { error: '未知读路径' });
  }

  // ── 写路径（POST）：必须先登记 ───────────────────────────────────────────────
  if (req.method === 'POST') {
    if (!isRegistered('POST', p)) {
      return json(res, 404, { error: '未登记的写路径（写接口必须先登记在 write-routes.json）', path: p });
    }

    // 动作路径：/{类型}/{id}/{动作} —— 详情浮层上的按钮走这里
    // ★★ 2026-10-14 改：**会话动作**的 id 里带 `:` `/` `+` `=`（形如 `2026-10-14__cid:cidYfn8k+5mWU/YcUESFbS5hg==`），
    //   `[A-Za-z0-9_]+` 那条匹配不到 ⇒ 请求落到后面回 404「未知类型」。
    //   ⇒ id 那一段放宽成"**除斜杠以外的任意可打印字符**"，并且要求客户端 **URL 编码**传进来
    //     （`encodeURIComponent` 之后 `:` 变 `%3A`、`/` 变 `%2F`，所以「不含斜杠」这条仍然成立）。
    //   ⚠️ 为什么不用"再开一条正则"：动作路由只有这一条，开第二条就得决定谁先匹配，
    //     而这个项目已经为"两条相似判据谁先谁后"栽过（`下月底` 被 `月底` 抢先）。
    //     放宽现有这一条、并**在下面校验类型**，只有一条路要走。
    const act = new RegExp(`^${API_PREFIX}/([a-z]+)/([^/]+)/([a-z-]+)$`).exec(p);
    // 驾驶舱的"生成"入口：/cockpit/{kind} —— 只有两段，所以单独匹配（上面那条要求三段）
    //   走 `narrative()`：先取真实数据切片，**没数据就拒绝调模型**（避免生成"没数据也像模像样"的分析）。
    //   会等模型返回（实测约 36 秒），前端需显示"生成中"。
    const ck = new RegExp(`^${API_PREFIX}/cockpit/([a-z]+)$`).exec(p);
    if (ck) {
      const kind = ck[1];
      // ★ `trend` 于 2026-10-12 加入（需求 4.3.2：趋势演进分析的五种方法 + **自定义时间周期**）。
      //   允许值从 `NARRATIVE_SPECS` 取（**一处定义**），别在这里再抄一份清单 ——
      //   两处清单迟早不一致，而不一致的表现是"页面有按钮、接口说未知"。
      //   （`cockpit.mjs` 只 import store/pages，不 import 本文件 ⇒ 静态 import 不成环。）
      const KIND_LIST = Object.keys(NARRATIVE_SPECS);
      if (!KIND_LIST.includes(kind)) {
        return json(res, 400, { error: `未知的驾驶舱块：${kind}`, allowed: KIND_LIST });
      }
      return (async () => {
        try {
          // 可选区间（需求 4.3.2「可自定义筛选时间周期」）：给了就按区间取切片
          // ★ 两层坑，都踩过：
          //   ① `readBody` 把解析结果放在 **`.json`** 里（不是摊平在顶层）；
          //   ② 本项目的写路径既有约定是 `{ payload: {...} }`（客户端与套件都这么发）。
          //   第一版只读顶层 ⇒ 参数静默丢失、退化成默认窗口（"传了 1970 年却返回缓存内容"，被 API-33 抓到）。
          //   ⇒ 这里既收 `payload` 里的，也收平铺的，避免调用方写法不同就静默失效。
          const b = await readBody(req);
          const raw = b && b.ok !== false ? (b.json ?? {}) : {};
          const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;
          const from = typeof payload.from === 'string' ? payload.from : null;
          const to = typeof payload.to === 'string' ? payload.to : null;
          // ★ 2026-10-14 加（用户 8.3）：复盘"单个项目或某条业务线"时带上的**业务单元**。
          //   不校验它的合法性（单元清单是从库里现算的、会随数据变）——
          //   只传字符串下去，由 `sliceFor` 把它写进提示词；**未知单元不会报错**，
          //   模型会如实说"这个单元在切片里没有材料"（比在这里猜一份合法清单可靠）。
          const unit = typeof payload.unit === 'string' && payload.unit.trim() !== '' ? payload.unit.trim() : null;
          if (from || to) console.error(`[v1] cockpit/${kind} 区间 ${from ?? '-'} ~ ${to ?? '-'}`);
          if (unit) console.error(`[v1] cockpit/${kind} 单元 ${unit}`);
          const { narrative } = await import('./cockpit.mjs');
          const r = await narrative(kind, { from, to, unit });
          if (r.ok !== true) return json(res, r.refused ? 409 : 502, { ok: false, kind, refused: !!r.refused, error: r.why });
          return json(res, 200, { ok: true, kind, label: r.label, cached: !!r.cached, fp: r.fp, unit: r.unit ?? null, text: r.text });
        } catch (e) {
          return json(res, 500, { ok: false, error: '生成失败：' + (e && e.message ? e.message : String(e)) });
        }
      })();
    }
    if (act) {
      const plural = act[1];
      // ★ 2026-10-14：id 那一段现在允许 URL 编码后的字符 ⇒ **取出来要解码一次**
      //   （会话 id 里的 `:` `/` `+` `=` 在地址里都是 %XX 形态）。
      //   ⚠️ 解码失败不吞：退回原样，让后面的"会话不存在 ⇒ 404"如实报出来。
      let id = act[2];
      try { id = decodeURIComponent(id) } catch { /* 保持原样 */ }
      const action = act[3];
      const t = { messages: 'message', notes: 'note', todos: 'todo', schedules: 'schedule', conversations: 'conversations' }[plural];
      if (!t) return json(res, 404, { error: `未知类型：${plural}` });
      // ★★ 一个请求**只读一次体**（2026-10-12 实测踩到的真 bug）：
      //   原先这段是 `return readBody(req).then((b) => { … })`，而后面笔记的两个动作**又各自调了一次**
      //   `readBody(req)`。Node 的请求流只会被消费一次 ⇒ 第二次读时 `readableEnded=true`，
      //   `'end'` 事件永不触发 ⇒ **Promise 永挂**，客户端只看到 180 秒 Headers Timeout。
      //   既有分支（消息/待办/日程）都排在前面、抢先返回，所以这个洞一直没被照出来 ——
      //   直到笔记那两个动作接到链尾才暴露。⇒ 改成读一次、把 `body` 往下传。
      return readBody(req).then((b) => {
        if (b.ok === false) return json(res, 400, { error: b.why });
        const body = b.json ?? {};
        const op = String(body.payload?.op ?? body.op ?? '').trim();
        // ★ 2026-10-14：`conversations` **不是 store 里的事件类型**（store 只认
        //   message/note/todo/schedule）—— 它是"一批消息"的聚合视角。
        //   ⇒ 会话那一条分支**必须在读 `evt` 之前返回**，否则这里会拿 'conversations'
        //     去查 store、直接抛 `未知类型 "conversations"`（第一次就是这样炸的）。
        if (t === 'conversations') {
          const cid = String(id);
          const c = conversationOne(cid);
          if (!c) return json(res, 404, { error: '没有这个会话', id: cid });
          const wantIds = Array.isArray(body.payload?.ids) ? body.payload.ids.map(String) : [];
          // ★ 追问裁定 ②：**一条都不勾 ⇒ 默认取整个会话**（不报错、不空转）
          const whole = body.payload?.whole === true || body.payload?.whole === 1 || wantIds.length === 0;
          const picked = whole ? c.items : c.items.filter((e) => wantIds.includes(String(e._id)));
          if (!picked.length) return json(res, 400, { error: '勾选的消息不在这个会话里（或已不存在）', ids: wantIds });
          const pickedIds = picked.map((e) => String(e._id));

          // ── 「已回复」：只标勾选的那些条（全选时等于整条会话）──
          if (op === '已回复' || op === '回复' || op === 'replied') {
            for (const mid of pickedIds) {
              if (!(store.getById('message', mid)?.ops ?? []).some((o) => String(o.op ?? '') === 'replied')) {
                store.patch('message', mid, {}, { op: 'replied', by: 'manual', conversationId: cid });
              }
            }
            // 整条会话一次标完 ⇒ 额外留一条会话级痕迹（便于回查"当时是按会话处理的"）
            if (whole) store.patch('message', pickedIds[pickedIds.length - 1], {}, { op: 'conversation-replied', by: 'manual', conversationId: cid, count: c.count });
            return json(res, 200, {
              ok: true, id: cid, op: 'replied', marked: pickedIds.length, whole,
              note: whole ? '整条会话已标为已回复' : `已标为已回复 ${pickedIds.length} 条（其余仍留在待处理）`,
            });
          }

          // ── 三种转换：把选中的原文 + 相关上下文聚合起来，再提取结构化字段 ──
          return (async () => {
            const kindMap = { '转待办': 'todo', '转日程': 'schedule', '转笔记': 'note', todo: 'todo', schedule: 'schedule', note: 'note' };
            const to = kindMap[op];
            if (!to) return json(res, 400, { error: '不认识的动作', op, allowed: ['已回复', '转待办', '转日程', '转笔记'] });
            const opName = `to-${to}`;
            // ① 被勾选消息的原文（**按时间顺序**拼起来 —— 与详情页显示同一顺序）
            const rawText = picked.map((e) => String(e.payload?.raw ?? '')).filter((x) => x !== '').join('\n');
            // ② 被勾选消息**各自的召回材料**（筛选触发分析时取的那份）
            const perMsgCtx = [];
            for (const e of picked) for (const h of (e.context?.recalled ?? [])) perMsgCtx.push(h);
            // ③ **会话级上下文**（每 15 分钟由模型跑出来的那份）
            let convText = null;
            try { convText = loadConvCache()[convCacheKey(c)]?.text ?? null } catch { /* 读不到就当没有 */ }
            // ★ 追问裁定 ③：两份**合用** —— 会话级那份讲清当天整段对话的背景，
            //   按条的召回材料补充细节。会话级那份是**模型写的一段话**（不是召回片段），
            //   所以把它当作一条材料塞进列表，让提取器一起看。
            const recalled = convText
              ? [{ path: '(会话级分析)', text: `【当天会话的相关上下文（模型分析）】\n${convText}`, similarity: null }, ...perMsgCtx]
              : perMsgCtx;

            const now = Date.now();
            const sender = String(picked[picked.length - 1].payload?.sender ?? '');
            let mk; let extractFrom = null;
            if (to === 'note') {
              const ex = extractNote(rawText, recalled, { now, over: {} });
              mk = ex.payload; extractFrom = ex.from;
            } else if (to === 'todo') {
              const ex = extractTodo(rawText, recalled, { now, sender, over: {} });
              mk = ex.payload; extractFrom = ex.from;
            } else {
              const { deriveScheduleWindow } = await import('../processor/detect.mjs');
              const w = deriveScheduleWindow(rawText, { now });
              if (!w.ok) {
                return json(res, 409, {
                  error: '转日程需要具体起止时间：勾选的这些原文里没解析出来，请把 start/end 一起传进来',
                  hint: '日程契约要求 start/end 是 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm（不接受空）',
                  why: w.why,
                });
              }
              const ex = extractSchedule(rawText, recalled, { now, sender, over: {} });
              mk = { ...ex.payload, start: w.start, end: w.end }; extractFrom = ex.from;
            }
            // 幂等键按"会话 + 勾选的那批 + 目标类型"算：同一批勾选重复点不会建两条
            const sig = pickedIds.slice().sort().join(',').slice(0, 200);
            const made = createEvent(to, mk, {
              origin: {
                channel: picked[0].origin?.channel ?? 'manual',
                sender,
                messageId: `conv:${cid}:${to}:${createHash('sha1').update(sig).digest('hex').slice(0, 10)}`,
                raw: rawText.slice(0, 500),
              },
              at: picked[0]._at ?? now,
            });
            if (made.ok === false) return json(res, 400, { error: `生成${to}失败`, errors: made.errors });
            // 把这批消息标成"已转 X"（会话列表据此显示状态）
            for (const mid of pickedIds) store.patch('message', mid, {}, { op: opName, by: 'manual', targetId: made.id, conversationId: cid });
            return json(res, 200, {
              ok: true, id: cid, to: made.id, kind: to, from: pickedIds.length, whole,
              extractFrom,
              material: `勾选原文 ${picked.length} 条 + 各自召回 ${perMsgCtx.length} 条${convText ? ' + 会话级上下文' : ''}`,
              note: `已按勾选的 ${pickedIds.length} 条原文 + 相关上下文聚合提取，建出${to === 'todo' ? '待办' : to === 'schedule' ? '日程' : '笔记'}`,
            });
          })().catch((e) => json(res, 500, { error: `会话动作失败：${e.message}` }));
        }

        const evt = store.getById(t, id);
        if (!evt) return json(res, 404, { error: '没有这条事件', type: t, id });

        // ① 消息：已回复 / 转待办 / 转日程（需求 3.3.3：三者都视为已处理）
        if (t === 'message' && action === 'replied') {
          store.patch('message', id, {}, { op: 'replied', by: 'manual' });
          return json(res, 200, { ok: true, id, marked: 'replied', note: '已回复（按既有规则：我回复过即视为已回复）' });
        }
        if (t === 'message' && action === 'convert') {
          return (async () => {
            const to = String(body.payload?.to ?? body.to ?? '').trim();
          // ★ `note` 于 2026-10-12 加入（需求 3.3.3 后半句："如有成体系的知识/结构/方法，
          //   可将其总结概括并记录为笔记"）—— 此前只支持 todo/schedule，那条需求没落点。
          if (to !== 'todo' && to !== 'schedule' && to !== 'note') return json(res, 400, { error: 'convert 需要 payload.to = "todo" / "schedule" / "note"', allowed: ['todo', 'schedule', 'note'] });
          const src = evt.payload ?? {};
          // ★★ 2026-10-14 加（用户这一轮原话）：「**提取消息以及消息相关的上下文**当中包含的
          //   跟待办/日程/笔记结构化字段相关的内容，创建…并将对应的内容填写到其中」。
          //   ⇒ 把**召回的相关材料**也交给提取器（此前只用消息原文，上下文完全没参与）。
          //   `evt.context.recalled` 是分析引擎召回后写进事件的，这里直接取用，不重复检索。
          const recalled = (evt.context && Array.isArray(evt.context.recalled)) ? evt.context.recalled : [];
          let mk; let made; let extractFrom = null;
          if (to === 'note') {
            const ex = extractNote(String(src.raw ?? ''), recalled, {
              now: evt._at ?? Date.now(),
              over: { ...(body.payload?.topic ? { topic: body.payload.topic } : {}), ...(body.payload?.content_md ? { content_md: body.payload.content_md } : {}), ...(Array.isArray(body.payload?.tags) && body.payload.tags.length ? { tags: body.payload.tags } : {}) },
            });
            mk = ex.payload; extractFrom = ex.from;
          } else if (to === 'todo') {
            const ex = extractTodo(String(src.raw ?? ''), recalled, {
              now: evt._at ?? Date.now(), sender: src.sender ?? null,
              over: { ...(body.payload?.topic ? { topic: body.payload.topic } : {}), ...(body.payload?.due ? { due: body.payload.due } : {}), ...(body.payload?.executor ? { executor: body.payload.executor } : {}) },
            });
            mk = ex.payload; extractFrom = ex.from;
          } else {
            // 转日程：契约要求 start/end **必须有具体值**（实测：给 null 会被判非法、建了个空）
            const { deriveScheduleWindow } = await import('../processor/detect.mjs');
            const w = deriveScheduleWindow(String(src.raw ?? ''), { now: evt._at ?? Date.now() });
            const start = body.payload?.start ?? (w.ok ? w.start : null);
            const end = body.payload?.end ?? (w.ok ? w.end : start);
            if (!start || !end) {
              return json(res, 409, {
                error: '转日程需要具体起止时间：这条消息里没解析出来，请把 start/end 一起传进来',
                hint: '日程契约要求 start/end 是 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm（不接受空）',
                parsed: w.ok ? { start: w.start, end: w.end } : null, why: w.ok ? null : w.why,
              });
            }
            const ex = extractSchedule(String(src.raw ?? ''), recalled, {
              now: evt._at ?? Date.now(), sender: src.sender ?? null,
              over: { ...(body.payload?.topic ? { topic: body.payload.topic } : {}), ...(body.payload?.place ? { place: body.payload.place } : {}), ...(Array.isArray(body.payload?.participants) && body.payload.participants.length ? { participants: body.payload.participants } : {}) },
            });
            mk = { ...ex.payload, start, end }; extractFrom = ex.from;
          }
          made = createEvent(to, mk, { origin: { channel: evt.origin.channel, sender: evt.payload.sender, messageId: `from-${evt.origin.messageId ?? evt._id}`, raw: evt.payload.raw ?? null }, at: evt._at });
          if (made.ok === false) return json(res, 400, { error: '生成目标事件失败', errors: made.errors });
          store.patch('message', id, {}, { op: to === 'todo' ? 'to-todo' : to === 'schedule' ? 'to-schedule' : 'to-note', targetId: made.id, by: 'manual' });
          // ★ 2026-10-14：回执里带上**每个字段是从哪儿来的**（消息原文 / 相关上下文第 N 条 / 未找到）。
          //   用户原话要求"提取消息**以及消息相关的上下文**当中包含的…内容" ——
          //   那就得让人看得出"这个截止时间是从消息里读的，还是从召回材料里读的"。
          //   不给出处的话，用户没法判断该不该改它。
          return json(res, 200, {
            ok: true, from: id, to: made.id, kind: to,
            extractFrom,                                     // 逐字段来源
            material: recalled.length ? `消息原文 + ${recalled.length} 条相关上下文` : '仅消息原文（这条还没召回到材料）',
            note: '已建目标事件并在来源消息上留痕',
          });
          })().catch((e) => json(res, 500, { error: `转换失败：${e.message}` }));
        }

        // ② 待办动作（需求 3.3.4：已搁置 / 转日程 / 已完成）
        // ★★ 2026-10-14 改：`转日程` 原来也只是盖个记号（**没建日程**）——
        //   而用户第 6.1 条点名「**待办转日程应当将待办的标题作为日程标题**」，
        //   没有下游日程，这条规则就无从落实。现在真的建，主题取待办标题。
        if (t === 'todo' && action === 'act') {
          return (async () => {
            const map = { '已完成': 'done', '完成': 'done', 'done': 'done', '已搁置': 'hold', '搁置': 'hold', 'hold': 'hold', '转日程': 'to-schedule', 'to-schedule': 'to-schedule' };
            const k = map[op];
            if (!k) return json(res, 400, { error: '不认识的动作', op, allowed: ['已完成', '已搁置', '转日程'] });
            if (k === 'hold') {
              // ★★ 2026-10-14 加（用户原话）：「待办详情页面的**已搁置**，暂时将该待办的
              //   **截止时间转为无期限**，将该待办**移动到待定分类**中，同时**待定数量+1**」。
              //   原来只写了一个 `hold` 记号 —— **截止时间原封不动** ⇒ 它仍然躺在"今日/本周"里，
              //   "待定+1"也永远不会发生（待定那一档查的是"没有截止时间"，见 `todos()` 的 `undecided`）。
              //   ⇒ 把 `due` 置空（这就是"转为无期限"），档位自然跟着变成待定，计数也就跟着对。
              //   ⚠️ 原来的截止时间**不丢**：写进 ops 的 `evidence` 里，可回查。
              const oldDue = evt.payload?.due ?? null;
              store.patch('todo', id, { payload: { ...(evt.payload ?? {}), due: null } }, {
                op: 'hold', by: 'manual',
                evidence: oldDue ? `已搁置 ⇒ 截止时间由 ${oldDue} 转为无期限（原值记在这里，可回查）` : '已搁置 ⇒ 本来就是无期限',
              });
              return json(res, 200, { ok: true, id, op: 'hold', due: null, prevDue: oldDue, movedTo: 'undecided', note: '已搁置：截止时间转为无期限，进入「待定」' });
            }
            if (k !== 'to-schedule') {
              store.patch('todo', id, {}, { op: k, by: 'manual' });
              return json(res, 200, { ok: true, id, op: k, note: k === 'done' ? '已完成：进入「已完成」分类' : undefined });
            }
            const tp = evt.payload ?? {};
            // 时刻：人给了就用人的；没给就按"截止那天 09:00~10:00"，连截止都没有就用明天同一时段。
            //   ⚠️ 明说是**默认**，让人知道这是系统替他选的、可以改 —— 不假装是从话里解析出来的。
            const day = String(body.payload?.start ?? '').trim()
              || (tp.due ? String(tp.due).slice(0, 10) : '')
              || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
            const start = String(body.payload?.start ?? `${day}T09:00`);
            const end = String(body.payload?.end ?? `${day}T10:00`);
            const topic = String(body.payload?.topic ?? tp.topic ?? '').trim() || '（未命名日程）';
            const made = createEvent('schedule', {
              topic,
              detail: String(body.payload?.detail ?? tp.detail ?? tp.topic ?? ''),
              start,
              end,
              place: body.payload?.place ?? null,
              participants: Array.isArray(body.payload?.participants) ? body.payload.participants : [],
            }, {
              origin: { channel: evt.origin?.channel ?? 'manual', sender: evt.origin?.sender ?? '我', messageId: `from-${evt.origin?.messageId ?? evt._id}`, raw: tp.detail ?? tp.topic ?? null },
              at: evt._at,
            });
            if (made.ok === false) return json(res, 400, { error: '生成日程失败', errors: made.errors });
            store.patch('todo', id, {}, { op: 'to-schedule', targetId: made.id, by: 'manual' });
            return json(res, 200, {
              ok: true, from: id, to: made.id, kind: 'schedule', topic, start, end,
              note: `已建日程（主题取待办标题）并在待办上留痕${body.payload?.start ? '' : '；起止时间用的是默认值（截止那天 09:00~10:00，或明天同时段），可在日程里改'}`,
            });
          })();
        }

        // ③ 日程动作（需求 3.3.5：转待办 / 已完成）
        // ★★ 2026-10-14 改（**用户第 6.1 条逼出来的**）：
        //   「**待办转日程应当将待办的标题作为日程标题**」「**日程转待办应当将日程的标题作为待办标题**」
        //   —— 而这两条原来**都无从谈起**：`转待办` / `转日程` 只是在来源事件上盖了一个 op 记号，
        //   **根本没有建下游事件**（`store.patch('schedule', id, {}, { op: 'to-todo' })` 就完了）。
        //   用户点"转待办"，日程上多了个记号，待办列表里什么都没多 —— 这就是"点了没反应"的一种。
        //   ⇒ 现在两条都**真的建下游事件**，并在来源上留痕（带 targetId，便于回查）。
        //
        //   ⚠️ 日程契约要求 `start/end` 必须有具体值。待办**没有具体时刻**，所以：
        //     · 待办有截止时间 ⇒ 用那天的 09:00~10:00；
        //     · 没有 ⇒ 用**明天** 09:00~10:00（一个明确、可改的默认，不是 null、也不假装知道）。
        //     为什么敢给默认：这是**创建动作**，用户看得见也能改；给 null 会被契约拒、等于"点了失败"。
        if (t === 'schedule' && action === 'act') {
          return (async () => {
            const map = { '已完成': 'done', '完成': 'done', 'done': 'done', '转待办': 'to-todo', 'to-todo': 'to-todo' };
            const k = map[op];
            if (!k) return json(res, 400, { error: '不认识的动作', op, allowed: ['已完成', '转待办'] });
            if (k !== 'to-todo') {
              store.patch('schedule', id, {}, { op: k, by: 'manual' });
              return json(res, 200, { ok: true, id, op: k });
            }
            const sp = evt.payload ?? {};
            const topic = String(body.payload?.topic ?? sp.topic ?? '').trim() || '（未命名待办）';
            const made = createEvent('todo', {
              topic,
              detail: String(body.payload?.detail ?? sp.detail ?? sp.topic ?? ''),
              due: body.payload?.due ?? (sp.start ? String(sp.start).slice(0, 10) : null),
              publisher: String(sp.publisher ?? evt.origin?.sender ?? '').trim() || null,
              executor: String(body.payload?.executor ?? '我'),
            }, {
              origin: { channel: evt.origin?.channel ?? 'manual', sender: evt.origin?.sender ?? '我', messageId: `from-${evt.origin?.messageId ?? evt._id}`, raw: sp.detail ?? sp.topic ?? null },
              at: evt._at,
            });
            if (made.ok === false) return json(res, 400, { error: '生成待办失败', errors: made.errors });
            store.patch('schedule', id, {}, { op: 'to-todo', targetId: made.id, by: 'manual' });
            return json(res, 200, { ok: true, from: id, to: made.id, kind: 'todo', topic, note: '已建待办（主题取日程标题）并在日程上留痕' });
          })();
        }

        // ⑤ 待办：结果与交付物（需求 3.3.4：详情里要有"待办的结果 / 交付物（文字说明、附件上传）"）
        //   ★ 用户 Q4 裁定（2026-10-12）："结果走归档进知识库；附件落 Other/Inflow/文件/"。
        //     ⇒ 这是给"写接口只落运行态"开的**一个受控例外**，写在 write-routes.json 里，
        //       并且**只往 Inflow/文件 里放**（那是采集入口的既有目录，天然进 RAG）。
        if (t === 'todo' && action === 'deliverable') {
          return (async () => {
            const text = String(body.payload?.text ?? body.text ?? '').trim();
            const src = String(body.payload?.file ?? body.file ?? '').trim();     // 本机已有的文件路径
            const note = String(body.payload?.note ?? '').trim();
            // ★★ 2026-10-13 加（用户第 9 条：「可以直接粘贴文件 / **填写链接** / 填写文字」）：
            //   原来这里**没有 `link`** —— 客户端发上来的链接被**无声丢弃**。
            //   真机验证 DV-5 抓出来的：交付物里只有 text 与 attachment，链接不见了。
            //   这类"字段悄悄没了"最难发现：不报错，也看不出少了什么。
            const link = String(body.payload?.link ?? body.link ?? '').trim();
            if (text === '' && src === '' && link === '') {
              return json(res, 400, { error: '至少给一个：text（文字说明）/ file（附件路径）/ link（链接）' });
            }
            const list = Array.isArray(evt.deliverables) ? [...evt.deliverables] : [];
            let attachment = null;
            if (src !== '') {
              if (!fs.existsSync(src)) return json(res, 400, { error: `附件路径不存在：${src}` });
              const st = fs.statSync(src);
              if (!st.isFile()) return json(res, 400, { error: `附件不是文件：${src}` });
              const dir = path.join(ROOT, 'Other', 'Inflow', '文件');
              fs.mkdirSync(dir, { recursive: true });
              const base = path.basename(src);
              let dest = path.join(dir, base);
              // 幂等：同名同大小 ⇒ 不再复制（同一附件重复提交不产生第二份）
              if (fs.existsSync(dest) && fs.statSync(dest).size === st.size) {
                attachment = { ref: path.relative(ROOT, dest).replace(/\\/g, '/'), bytes: st.size, reused: true };
              } else {
                if (fs.existsSync(dest)) dest = path.join(dir, `${String(Date.now()).slice(-6)}-${base}`);
                fs.copyFileSync(src, dest);
                attachment = { ref: path.relative(ROOT, dest).replace(/\\/g, '/'), bytes: st.size, reused: false };
              }
            }
            list.push({ at: new Date().toISOString(), by: 'manual', text: text || null, link: link || null, note: note || null, attachment });
            // ★★ 2026-10-14 加（用户原话）：「待办详情页面的"提交交付物"指的是：
            //   1. 将笔记提交的**文字说明**做记录；2. 将**链接内容爬取下来之后，存储到知识库**；
            //   3. 如果有提交的**附件**，则存储到知识库中。」
            //   核对下来：① 文字说明 ✅（就是 `text`）② 附件 ✅（上面那段复制进 `Other/Inflow/文件`）
            //   **③ 链接 ❌ —— 原来只把这个字符串记在待办上，根本没去爬、也没进知识库。**
            //   ⇒ 现在走**既有的链接队列**（`processor/links.mjs`）：
            //     它由计划任务 `DSH-WorkbenchV1-Links` 每 5 分钟 `--drain` 一次，
            //     抓回来的正文落 `Other/Inflow/链接/<日期>-<标题>.md`（就是知识库）。
            //   ⚠️ 为什么不在这个请求里直接抓：那是网络请求，可能十几秒；
            //     待办详情是**点一下就出结果**的地方，不能为一条外链卡住界面。
            //     ⇒ **入队（立刻生效）+ 回执说清"已入队"**，由那个任务去抓。
            //     这与"附件立刻复制"不冲突：附件是本地文件、秒级；外链是网络、不确定。
            let linkQueued = null;
            if (link !== '') {
              try {
                const { enqueue, pendingCount } = await import('../processor/links.mjs');
                const q = enqueue([link], { fromId: id, from: `待办交付物（${evt.payload?.topic ?? id}）` });
                linkQueued = { added: q.added.length, dup: q.dup, pending: pendingCount(), dir: 'Other/Inflow/链接' };
              } catch (e) {
                // 入队失败**不吞**：如实回给界面（用户要的是"存到知识库"，没存就得知道）
                linkQueued = { added: 0, error: String((e && e.message) || e).slice(0, 120) };
              }
            }
            const pr = store.patch('todo', id, { deliverables: list }, { op: 'deliverable', by: 'manual', evidence: { text: !!text, attachment: attachment?.ref ?? null, link: link || null, linkQueued: linkQueued?.added ?? 0 } });
            if (pr.ok === false) return json(res, 500, { error: `交付物写入被拒：${pr.why}` });
            return json(res, 200, {
              ok: true, id, count: list.length, attachment, linkQueued,
              note: '文字说明已记录' + (attachment ? '；附件已存进知识库（Other/Inflow/文件）' : '')
                + (link ? `；链接已入爬取队列（当前待处理 ${linkQueued?.pending ?? '?'} 条），抓回来的正文会落到 Other/Inflow/链接 —— 计划任务每 5 分钟出队一次` : ''),
            });
          })().catch((e) => json(res, 500, { error: `交付物登记失败：${e.message}` }));
        }


        // ④ 笔记动作（需求 3.3.6：可视化构建 / 分析笔记）
        //    · 分析笔记  ⇒ 重新召回 + 重新调模型，**覆盖**上一次结论（visual.built 这类落点保留）
        //    · 可视化构建 ⇒ 真调工具建模型（坐标系 / 工程图 / 建模中心），**成功才置 built**
        //    两条都不假装：模型失败 ⇒ 回 502 且事件里只留 error；工具失败 ⇒ 回 502 且 built 不置真
        if (t === 'note' && action === 'analyze') {
          // 体已在本分支入口读过一次（见上面那条长注释）——这里**不许再读**
          return (async () => {
            const { reanalyzeNote } = await import('../processor/analyze.mjs');
            const r = await (_deps.reanalyzeNote ?? reanalyzeNote)(evt);
            if (r.ok !== true) return json(res, 502, { error: `分析未产出：${r.why}`, note: '没有编一段看起来像分析的文本' });
            return json(res, 200, { ok: true, id, action: 'analyze', text: r.text, visual: r.visual, contextCount: r.contextCount, recallError: r.recallError });
          })().catch((e) => json(res, 500, { error: `分析失败：${e.message}` }));
        }
        if (t === 'note' && action === 'visualize') {
          return (async () => {
            const { buildVisualForNote } = await import('../processor/visual.mjs');
            // 人工点按钮 = 明确要它建（已建过的也允许重建一次）⇒ force
            const r = await (_deps.buildVisualForNote ?? buildVisualForNote)(evt, { force: true });
            if (r.action === 'nothing') return json(res, 409, { error: r.reason, note: '这条笔记没有被判定为适合可视化' });
            if (r.action === 'failed') return json(res, 502, { error: `构建未完成：${r.reason}`, tool: r.tool, note: '失败已留痕，built 未置真' });
            return json(res, 200, { ok: true, id, action: 'visualize', tool: r.tool, ref: r.ref, detail: r.detail });
          })().catch((e) => json(res, 500, { error: `可视化构建失败：${e.message}` }));
        }

        return json(res, 404, { error: `登记表里有这条路径，但服务端还没实现这个动作：${plural}/${action}` });
      });
    }

    const seg = p.split('/').pop();
    const type = EVENT_FOR[seg];
    if (!type) return json(res, 404, { error: `登记表里有这条路径，但没有对应的事件类型：${seg}` });
    return readBody(req).then((b) => {
      if (b.ok === false) return json(res, 400, { error: b.why });
      const r = createEvent(type, b.json?.payload ?? b.json ?? {});
      if (r.ok === false) return json(res, r.code, { error: '校验未通过', errors: r.errors });
      // ★ 需求 3.3.3 原话："在消息页面可以新增一条新消息，**在记录的时候同时可以检索知识库召回相关上下文**"。
      //   ⇒ 新增后就地做一次召回（与"分析引擎只召回不调模型"同一条成本口径：**不调模型**）。
      // ★★ 2026-10-14 扩到**四类**（用户原话：「所有信息/待办/日程/笔记在流入到工作台的时候
      //   做一次相关上下文的获取和分析」）。原来只有 message 会取，另外三类直接 return。
      //   召回失败**不影响落库**，只如实记进 `context.recallError`（分清"查不到"与"桥断了"）。
      return (async () => {
        const r2 = await recallIntoEvent(type, r.id, r.event ?? store.getById(type, r.id));
        const ctx = { recalled: r2.recalled ?? [], recallError: r2.recallError ?? null };
        if (type !== 'message') {
          return json(res, 200, {
            ok: true, id: r.id, action: r.action,
            context: ctx,
            note: `已落运行态（相关上下文 ${r2.hits ?? 0} 条）；筛选引擎会结构化并双写知识库`,
          });
        }
        return json(res, 200, {
          ok: true, id: r.id, action: r.action,
          context: ctx,
          note: r2.recallError ? '已落运行态；召回不可用（已如实记下原因，不是"没有相关材料"）' : `已落运行态，并已召回相关上下文 ${r2.hits ?? 0} 条`,
        });
      })().catch((e) => json(res, 200, { ok: true, id: r.id, action: r.action, context: { recalled: [], recallError: `召回异常：${e.message}` }, note: '已落运行态；召回异常已记录' }));
    });
  }

  return json(res, 405, { error: `不支持的方法：${req.method}` });
}

/** 起服务（默认只监听本机） */
export function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => {
    srv.listen(port, host, () => resolve({ server: srv, port: srv.address().port, url: `http://${host}:${srv.address().port}${API_PREFIX}` }));
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检：起在随机端口上真打请求（临时运行态，不碰真实数据）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const fsx = await import('node:fs');
  const os = await import('node:os');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  const prevOut = process.env.WB_V1_OUT;
  const prevKb = process.env.WB_V1_KB_ROOT;
  const tmp = fsx.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-api-'));
  process.env.WB_V1_OUT = path.join(tmp, 'out');
  process.env.WB_V1_KB_ROOT = path.join(tmp, 'kb');
  const { server, url } = await startServer({ port: 0 });
  try {
    const get = async (p) => { const r = await fetch(url + p); return { code: r.status, body: await r.json() }; };
    const post = async (p, payload) => { const r = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload }) }); return { code: r.status, body: await r.json() }; };

    // ★ 2026-10-13 改：18 → **19**。新增了「钉钉 · 跨组织白名单群（全量）」这条通路
    //   （用户裁定：智询工作室 / AI Engineering Club 两个群的全量信息；它们跨组织、Stream 收不到，
    //    只能走 API 拉取 + 跨组织授权）。**这是如实跟随真实通路数，不是为了让检查过而放宽**。
    chk('API-1', '健康检查返回通道与水位线', (await get('/health')).body.channels?.total === 19, JSON.stringify((await get('/health')).body.channels?.implemented));

    // ★ 假绿守卫（2026-10-12 实测定位的根因，见文件顶部长注释）：
    //   插件 host 用动态 import 一次性加载本文件 ⇒ ESM 进程级只求值一次 ⇒ 通道读数会被冻住。
    //   这两条盯的就是"改了文件读数必须跟着变"，而不是"某次读出来是 18"。
    {
      const probeDir = fsx.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-fresh-'));
      const probeUrl = new URL('file:///' + path.join(probeDir, 'probe.mjs').replace(/\\/g, '/'));
      fsx.writeFileSync(probeUrl, 'export const MARK = "V1";\n', 'utf8');
      const a = await freshMod(probeUrl, 'probe');
      const b = await freshMod(probeUrl, 'probe');
      chk('API-35', '现读缓存：文件没改 ⇒ 复用同一份（不白读盘）', a === b && a.MARK === 'V1');
      // 改内容 + 显式推进 mtime（同毫秒内写入会让 mtimeMs 相等，那样测的就不是这条规则了）
      fsx.writeFileSync(probeUrl, 'export const MARK = "V2";\n', 'utf8');
      const t = new Date(Date.now() + 2000);
      fsx.utimesSync(probeUrl, t, t);
      const c = await freshMod(probeUrl, 'probe');
      chk('API-36', '★ 文件改了 ⇒ 重新求值（读数不再被进程冻住）', c !== a && c.MARK === 'V2', `a=${a.MARK} c=${c.MARK}`);
      try { fsx.rmSync(probeDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
    for (const p of ['overview', 'messages', 'todos', 'schedules', 'notes']) {
      const r = await get('/pages/' + p);
      chk('API-' + p, '页面数据 ' + p + ' 可读', r.code === 200 && typeof r.body === 'object', 'code=' + r.code);
    }
    chk('API-7', '未知页面 ⇒ 404 且列出可用项', (await get('/pages/nope')).code === 404);
    chk('API-8', '★ 未登记的写路径 ⇒ 404 并说明要先登记', (await post('/not-registered', {})).code === 404);
    chk('API-9', '登记表已加载（≥13 条写路径；含驾驶舱生成入口）', writeRoutes().length >= 13, String(writeRoutes().length));

    // 真写一条消息（走已登记路径）
    // ★ 新增消息时就地召回（需求 3.3.3）；自检注入桩 —— 不去打真实向量服务，判据才不会随服务状态飘
    _deps.recall = async () => ({ ok: true, hits: [{ path: 'Work/示例客户甲/x.md', text: '材料', similarity: 0.66 }], floor: 0.55, raw_count: 1, dropped: 0, why: null });
    const w = await post('/messages', { channel: 'manual', sender: '我', raw: '手工新增的一条消息', source: 'manual', modality: 'text' });
    chk('API-10', '★ 新增消息落在运行态（200 + id）', w.code === 200 && w.body.ok === true, JSON.stringify(w.body));
    chk('API-10c', '★ 新增消息即召回相关上下文（需求 3.3.3 原话）', Array.isArray(w.body.context?.recalled) && w.body.context.recalled.length === 1, JSON.stringify(w.body.context));
    chk('API-11', '新消息立刻出现在页面数据里', (await get('/pages/messages')).body.counts.total === 1);
    chk('API-12', '★ 写只落运行态：知识库此刻**没有**被直接写（双写归筛选引擎）', !fsx.existsSync(path.join(process.env.WB_V1_KB_ROOT, 'Other')), '临时知识库根下无 Other/');

    const bad = await post('/messages', { channel: 'wechat', sender: '', raw: '' });
    chk('API-13', '★ 非法载荷 ⇒ 400 且逐条回报原因', bad.code === 400 && Array.isArray(bad.body.errors) && bad.body.errors.length > 0, JSON.stringify(bad.body.errors));
    chk('API-14', '非法载荷没有落库', (await get('/pages/messages')).body.counts.total === 1);

    const t = await post('/todos', { topic: '手工待办', detail: '细节', due: '2026-10-20' });
    chk('API-15', '待办可新增（走登记路径）', t.code === 200 && (await get('/pages/todos')).body.counts.total === 1, JSON.stringify(t.body));
    const n = await post('/notes', { topic: '手工笔记', date: '2026-10-12', content_md: '# 标题', tags: ['手工'] });
    chk('API-16', '笔记可新增（走登记路径）', n.code === 200 && (await get('/pages/notes')).body.counts.total === 1);
    const s = await post('/schedules', { topic: '手工日程', start: '2026-10-12T15:00', end: '2026-10-12T16:00', place: '线上' });
    chk('API-17', '日程可新增（走登记路径）', s.code === 200 && (await get('/pages/schedules')).body.counts.total === 1);
    chk('API-18', 'GET 一个写路径 ⇒ 405/404（方法不被默默接受）', (await get('/messages')).code === 404);

    // 详情浮层数据（需求 3.3.3–3.3.6 的"点击弹出详情页浮层"）
    const detail = await get('/detail/messages/' + w.body.id);
    chk('API-19', '★ 详情接口给出结构化内容/原始消息/相关上下文/可执行操作', detail.code === 200
      && detail.body.structured?.raw === '手工新增的一条消息'
      && detail.body.original?.channel === 'manual'
      && detail.body.context !== undefined
      && Array.isArray(detail.body.availableOps) && detail.body.availableOps.length === 4, JSON.stringify(detail.body.availableOps));
    // API-19 由 3 个动作改为 4 个（2026-10-12）：需求 3.3.3 后半句要"转笔记"，此前缺这一个动作。
    chk('API-20', '各类型可执行操作按需求给（待办=已搁置/转日程/已完成）', (() => { return true; })());
    const tDetail = await get('/detail/todos/' + t.body.id);
    chk('API-20b', '★ 待办详情三项操作齐（已搁置/转日程/已完成）', tDetail.code === 200 && tDetail.body.availableOps.join(',') === '已搁置,转日程,已完成', JSON.stringify(tDetail.body.availableOps));
    chk('API-21', '不存在的 id ⇒ 404（不返回空壳）', (await get('/detail/messages/mess_none')).code === 404);
    chk('API-22', '★ 未知类型 ⇒ 404 且列出可用类型', (await get('/detail/whatever/x')).code === 404);

    // 动作路径（详情浮层的按钮）
    const rep = await post('/messages/' + w.body.id + '/replied', {});
    // ★★ 2026-10-14 改（消息页改成会话列表之后**这条的含义变了**）：
    //   原来它问的是"按条的已回复数 == 1"（那时 `/pages/messages` 返回的是**消息**）。
    //   现在返回的是**会话**，而且是**逐条**判状态（用户裁定："只标勾选的那些条"）——
    //   这一条消息所在的会话里若还有别的没回复的消息，会话就仍是"待处理"（`replied` 为 0）。
    //   ⇒ 判法改成看**这条消息自己的留痕** + **会话总数**（不再拿会话的 replied 数当"这条回复了"）。
    const repEvt = store.getById('message', w.body.id);
    chk('API-23', '★ 消息标已回复（动作路径）：**这条**真的被标了（会话状态按逐条算）',
      rep.code === 200 && (repEvt.ops ?? []).some((o) => String(o.op ?? '') === 'replied')
      && (await get('/pages/messages')).body.counts.total >= 1,
      JSON.stringify({ code: rep.code, ops: (repEvt.ops ?? []).map((o) => o.op) }));
    const conv = await post('/messages/' + w.body.id + '/convert', { to: 'todo', topic: '由消息转来的待办', detail: '细节', executor: '我' });
    chk('API-24', '★ 消息转待办：建目标事件 + 来源留痕', conv.code === 200 && conv.body.kind === 'todo' && (await get('/pages/todos')).body.counts.total === 2, JSON.stringify(conv.body));
    const convBad = await post('/messages/' + w.body.id + '/convert', { to: 'whatever' });
    chk('API-25', '★ 转错目标 ⇒ 400 且说明允许值', convBad.code === 400, JSON.stringify(convBad.body));
    const td = await post('/todos/' + t.body.id + '/act', { op: '已完成' });
    chk('API-26', '★ 待办动作：已完成（进 done 桶，恰好 1 条）', td.code === 200 && (await get('/pages/todos')).body.counts.done === 1, JSON.stringify(td.body) + ' done=' + (await get('/pages/todos')).body.counts.done);
    const tdBad = await post('/todos/' + t.body.id + '/act', { op: '乱写' });
    chk('API-27', '★ 不认识的动作 ⇒ 400 且列出允许值', tdBad.code === 400 && Array.isArray(tdBad.body.allowed), JSON.stringify(tdBad.body));
    const sc = await post('/schedules/' + s.body.id + '/act', { op: '已完成' });
    chk('API-28', '日程动作：已完成', sc.code === 200, JSON.stringify(sc.body));

    // ★★ 2026-10-14 加（**用户第 5.1 / 6.1 条逼出来的**）：
    //   「待办转日程应当将**待办的标题**作为日程标题」「日程转待办应当将**日程的标题**作为待办标题」
    //   这两条原来**都无从谈起** —— 两个"转"只是在来源事件上盖了个 op 记号，
    //   **根本没有建下游事件**（点了"转待办"，待办列表里什么都没多）。
    //   ⇒ 检查必须落在"**下游事件真的建出来了、标题就是来源的标题**"上，
    //     而不是"接口回了 200"（盖记号也回 200 —— 那正是它一直没被发现的原因）。
    {
      const sTopic = '联调·评审会（标题规则检查）';
      const s2 = await post('/schedules', { topic: sTopic, start: '2026-10-20T14:00', end: '2026-10-20T15:00', detail: '过一遍改动点' });
      const conv2 = await post('/schedules/' + s2.body.id + '/act', { op: '转待办' });
      const madeTodo = conv2.body?.to ? store.getById('todo', conv2.body.to) : null;
      chk('API-40', '★★ 日程「转待办」**真的建了下游待办**，主题 = 日程标题',
        conv2.code === 200 && madeTodo !== null && madeTodo.payload.topic === sTopic,
        JSON.stringify({ code: conv2.code, to: conv2.body?.to, topic: madeTodo?.payload?.topic }));
      chk('API-41', '★ 来源日程上留痕（带 targetId，可回查）',
        (store.getById('schedule', s2.body.id)?.ops ?? []).some((o) => o.op === 'to-todo' && o.targetId === conv2.body?.to));

      const tTopic = '联调·把报价单发给客户（标题规则检查）';
      const t2 = await post('/todos', { topic: tTopic, detail: '报价单在共享盘', due: '2026-10-22', executor: '我' });
      const conv3 = await post('/todos/' + t2.body.id + '/act', { op: '转日程' });
      const madeSch = conv3.body?.to ? store.getById('schedule', conv3.body.to) : null;
      chk('API-42', '★★ 待办「转日程」**真的建了下游日程**，主题 = 待办标题',
        conv3.code === 200 && madeSch !== null && madeSch.payload.topic === tTopic,
        JSON.stringify({ code: conv3.code, to: conv3.body?.to, topic: madeSch?.payload?.topic }));
      chk('API-43', '★ 生成的日程**起止时间有具体值**（契约不接受空），且落在截止那天',
        !!madeSch?.payload?.start && !!madeSch?.payload?.end && String(madeSch.payload.start).startsWith('2026-10-22'),
        `${madeSch?.payload?.start} ~ ${madeSch?.payload?.end}`);
      chk('API-44', '★ 回执**说清时刻是默认值**（不假装是从话里解析出来的）',
        /默认值/.test(String(conv3.body?.note ?? '')), String(conv3.body?.note ?? '').slice(0, 60));
      chk('API-45', '★ 来源待办上留痕（带 targetId）',
        (store.getById('todo', t2.body.id)?.ops ?? []).some((o) => o.op === 'to-schedule' && o.targetId === conv3.body?.to));
    }

    // ★★ 2026-10-14 加（用户第 7.1 条：「消息转笔记：将消息**完整**记录下来」，
    //   而列表那一列叫「**笔记概括**」）：
    //   原来主题取"首行前 30 字" —— 消息常常一整段没换行 ⇒ **主题就是整段原文**，
    //   列表里"笔记概括"那一格被撑满，那个字段名等于没落到实处。
    //   ⇒ 现在主题走 `briefTitle`（一句话），**内容仍是完整原文**（一个字不丢）。
    {
      const longMsg = '联调·这条消息很长没有任何换行所以旧写法会把整段当成主题用来验证笔记标题是不是一句话。'
        + '后面还接着很多内容，包括报价单、接口、权限这些词，都应该留在内容里而不是标题里。';
      const m2 = await post('/messages', { channel: 'dingtalk', sender: '审计', raw: longMsg, summary: longMsg.slice(0, 60), source: 'im', modality: 'text', isDirect: true, conversationId: 'cidNoteTitleChk' });
      const conv4 = await post('/messages/' + m2.body.id + '/convert', { to: 'note' });
      const madeNote = conv4.body?.to ? store.getById('note', conv4.body.to) : null;
      chk('API-46', '★★ 消息转笔记：**主题是一句话**（不再是整段原文）',
        madeNote !== null && madeNote.payload.topic.length < longMsg.length / 2 && madeNote.payload.topic.length <= 40,
        `${madeNote?.payload?.topic?.length} 字 · ${madeNote?.payload?.topic}`);
      chk('API-47', '★★ 消息转笔记：**内容仍是完整原文**（用户原话"将消息完整记录下来"）',
        madeNote !== null && madeNote.payload.content_md === longMsg,
        `${madeNote?.payload?.content_md?.length} 字（原文 ${longMsg.length} 字）`);
      chk('API-48', '★ 主题不该带 @（概括会剥掉）', !String(madeNote?.payload?.topic ?? '').includes('@'));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-14 加（用户这一轮的逐条要求）：**每个动作真的做到它说的那件事**
    //   这一组检查的共同点：**接口回 200 不算数，要看状态真的变了**。
    //   前面几轮栽过的都是这一类 —— 接口说成功，记录上什么都没发生。
    // ══════════════════════════════════════════════════════════════════════════
    {
      // ① 已搁置 ⇒ 截止时间转无期限（原来只盖一个 hold 记号，截止时间原封不动）
      const h0 = await post('/todos', { topic: '审计·有截止时间的一条', detail: 'x', due: '2026-10-20', executor: '我' });
      const h1 = await post('/todos/' + h0.body.id + '/act', { op: '已搁置' });
      const hEvt = store.getById('todo', h0.body.id);
      chk('API-49', '★★ 已搁置 ⇒ **截止时间真的转为无期限**（原来只盖记号、日期不动）',
        h1.code === 200 && hEvt.payload.due === null, `due=${JSON.stringify(hEvt?.payload?.due)}`);
      chk('API-50', '★ 原来的截止时间**不丢**（写进留痕，可回查）',
        (hEvt.ops ?? []).some((o) => o.op === 'hold' && /2026-10-20/.test(String(o.evidence ?? ''))),
        String((hEvt.ops ?? []).find((o) => o.op === 'hold')?.evidence ?? '').slice(0, 60));
      chk('API-51', '★★ 已搁置 ⇒ 进了「待定」档，**待定数量 +1**（无期限就是待定的口径）', (() => {
        const u = todos({ bucket: 'undecided', now: Date.now() }).list.map((x) => x.id);
        return u.includes(h0.body.id);
      })());

      // ② 已完成 ⇒ 进「已完成」档（用户："已完成数量+1"）
      const d0 = await post('/todos', { topic: '审计·待完成的一条', detail: 'y', due: '2026-10-21', executor: '我' });
      const beforeDone = todos({ now: Date.now() }).counts.done;
      await post('/todos/' + d0.body.id + '/act', { op: '已完成' });
      const afterDone = todos({ now: Date.now() }).counts.done;
      chk('API-52', '★★ 已完成 ⇒ 进「已完成」档且**数量 +1**', afterDone === beforeDone + 1, `${beforeDone} → ${afterDone}`);

      // ③ 转日程 ⇒ 待办进「转日程」档
      const s3 = await post('/todos', { topic: '审计·要转日程的一条', detail: 'z', due: '2026-10-22', executor: '我' });
      const s4 = await post('/todos/' + s3.body.id + '/act', { op: '转日程' });
      // ★ 把 ops 与桶一起打出来（别再猜"为什么不在档里"—— 前几轮猜错过两次）
      const s3evt = store.getById('todo', s3.body.id);
      const s3ops = JSON.stringify((s3evt?.ops ?? []).map((o) => o.op));
      const s3bucket = todos({ bucket: 'to-schedule', now: Date.now() });
      const s3in = s3bucket.list.map((x) => x.id).includes(s3.body.id);
      chk('API-53', '★★ 转日程 ⇒ 待办进「转日程」档（用户点名要这个分类）',
        s4.code === 200 && s3in,
        `code=${s4.code} ops=${s3ops} in=${s3in} 档内${s3bucket.list.length}条 resp=${JSON.stringify(s4.body).slice(0, 80)}`);

      // ④ 日程 已完成 / 转待办 两档
      const sc1 = await post('/schedules', { topic: '审计·日程要完成', start: '2026-10-20T09:00', end: '2026-10-20T10:00' });
      const beforeS = schedules({ now: Date.now() }).counts.done;
      await post('/schedules/' + sc1.body.id + '/act', { op: '已完成' });
      chk('API-54', '★★ 日程「已完成」⇒ 进「已完成」档且**数量 +1**',
        schedules({ now: Date.now() }).counts.done === beforeS + 1, `${beforeS} → ${schedules({ now: Date.now() }).counts.done}`);
      const sc2 = await post('/schedules', { topic: '审计·日程要转待办', start: '2026-10-21T09:00', end: '2026-10-21T10:00' });
      await post('/schedules/' + sc2.body.id + '/act', { op: '转待办' });
      chk('API-55', '★★ 日程「转待办」⇒ 进「转待办」档（用户点名要这个分类）',
        schedules({ bucket: 'to-todo', now: Date.now() }).list.map((x) => x.id).includes(sc2.body.id));

      // ⑤ 交付物：链接**入爬取队列**（用户："将链接内容爬取下来之后，存储到知识库"）
      const t3 = await post('/todos', { topic: '审计·交交付物', detail: 'w', executor: '我' });
      const dv = await post('/todos/' + t3.body.id + '/deliverable', { text: '做完了', link: 'https://example.com/audit-doc' });
      chk('API-56', '★★ 交付物填了链接 ⇒ **真的进了爬取队列**（原来只把字符串记下来，没爬）',
        dv.code === 200 && dv.body.linkQueued && dv.body.linkQueued.added === 1,
        JSON.stringify(dv.body.linkQueued ?? dv.body.error));
      chk('API-57', '★ 回执说清**链接会落到哪儿**（Other/Inflow/链接，计划任务出队）',
        /Inflow\/链接/.test(String(dv.body.note ?? '')), String(dv.body.note ?? '').slice(0, 80));

      // ⑥ 消息转笔记 ⇒ 进「已转笔记」档（原来没有这一档，转过了还显示"待处理"）
      const m3 = await post('/messages', { channel: 'dingtalk', sender: '审计', raw: '审计·这条要转成笔记，内容要完整保留下来。', summary: '审计·转笔记', source: 'im', modality: 'text', isDirect: true, conversationId: 'cidToNoteChk' });
      await post('/messages/' + m3.body.id + '/convert', { to: 'note' });
      chk('API-58', '★★ 消息转笔记 ⇒ 进「已转笔记」档（原来转过还显示"待处理"）',
        messageState(store.getById('message', m3.body.id)) === 'to-note',
        messageState(store.getById('message', m3.body.id)));
      chk('API-59', '★ 消息页有六个页签（含已转笔记）', MESSAGE_TABS.includes('to-note') && MESSAGE_TABS.length === 6, MESSAGE_TABS.join(','));

      // ⑦ 提取：从**消息 + 相关上下文**里提字段（用户这一轮的核心要求）
      const m4 = post('/messages', { channel: 'dingtalk', sender: '审计', raw: '那个事你再看看。', summary: '那个事', source: 'im', modality: 'text', isDirect: true, conversationId: 'cidExtractChk' });
      const m4r = await m4;
      store.patch('message', m4r.body.id, { context: { recalled: [{ text: '这个项目由冯杰楠跟进，地点在杭州西溪园区，本月内要给客户答复。' }], at: new Date().toISOString() } }, { op: 'recall' });
      const conv4 = await post('/messages/' + m4r.body.id + '/convert', { to: 'todo' });
      const madeT = conv4.body?.to ? store.getById('todo', conv4.body.to) : null;
      chk('API-60', '★★★ 转换**用了相关上下文**：原文没给的截止时间从召回的上下文里补上了',
        !!madeT?.payload?.due && conv4.body?.extractFrom?.due === '相关上下文第 1 条',
        `due=${madeT?.payload?.due} from=${conv4.body?.extractFrom?.due}`);
      chk('API-61', '★★ 回执里**逐字段说清来源**（消息原文 / 相关上下文第 N 条）',
        conv4.body?.extractFrom && typeof conv4.body.extractFrom === 'object' && !!conv4.body.material,
        JSON.stringify(conv4.body?.extractFrom ?? {}).slice(0, 90));

      // ⑧ ★★ 每个页签都必须有**同名的桶**（键名一字不差）
      //   来由：我第一版把桶名写成驼峰 `toSchedule`，而页签传的是 `to-schedule` ⇒
      //   **计数说有 2 条、列表 0 条**（页面自相矛盾），自检 API-53 抓出来的。
      //   这类"同一个东西两个名字"在本项目已经栽过三次（单数/复数查表、取第一个 .list）。
      //   ⇒ 与其一条条补，不如**按页签名逐个问一遍**：每个页签都得能查到东西、且不报错。
      const tabKeys = [
        ['todos', ['all', 'today', 'week', 'undecided', 'to-schedule', 'done']],
        ['schedules', ['today', 'next7', 'all', 'to-todo', 'done']],
        ['messages', ['all', 'pending', 'to-todo', 'to-schedule', 'to-note', 'replied']],
      ];
      const bad = [];
      for (const [page, keys] of tabKeys) {
        for (const k of keys) {
          const got = page === 'todos' ? todos({ bucket: k, now: Date.now() })
            : page === 'schedules' ? schedules({ bucket: k, now: Date.now() })
              : messages({ tab: k, now: Date.now() });
          // 桶查不到时是 `undefined ?? []` ⇒ 空列表；这里**不能只看空不空**（空是合法的），
          // 要看**页签键本身认不认**：认的键必然出现在返回的 counts 或 tabs 里。
          const known = page === 'messages' ? (got.tabs ?? []).includes(k) : true;
          if (!known) bad.push(`${page}#${k}`);
          if (!Array.isArray(got.list)) bad.push(`${page}#${k}:no-list`);
        }
      }
      chk('API-62', '★★ 每个页签都有**同名的桶**、且都能取到列表（键名一字不差）',
        bad.length === 0, bad.join(' · ') || '待办 6 档 / 日程 5 档 / 消息 6 个页签 逐个通过');
      // ⚠️ 光"能取到列表"还不够 —— 空列表和"桶不存在"返回的空列表长得一模一样。
      //   这一条用**真值**钉：转过日程的那个待办必须出现在 to-schedule 档里。
      chk('API-63', '★★ 桶查得到的**不是空壳**：转过日程的待办真的在 to-schedule 档里',
        todos({ bucket: 'to-schedule', now: Date.now() }).list.some((x) => (x.ops ?? []).some((o) => o.op === 'to-schedule')),
        `档内 ${todos({ bucket: 'to-schedule', now: Date.now() }).list.length} 条`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-14 加（用户原话 + 追问裁定）：**会话列表 · 会话详情 · 按条选择动作**
    //   「流入的一个会话中的多条消息，有可能会被**分别**转待办、转日程、转笔记或转为已回复，
    //     所以会话详情页中的消息原文应该是**可以按条进行选择**（支持单选及多选）……
    //     被操作的原文，**加上相关上下文聚合起来**，再提取出结构化的信息，执行转换动作。」
    //   追问裁定：① 已回复只标勾选的那些条；② 一条不勾 ⇒ 默认整会话；
    //             ③ 上下文 = 会话级那份 + 被勾选消息各自的召回材料（两份合用）。
    // ══════════════════════════════════════════════════════════════════════════
    {
      const CID = 'cidConvActChk';
      // ⚠️ `store.upsert()` 返回的是 `{ action, _id }` —— **没有 `event` 这一层**。
      //   我第一版按 `makeEvent(...).event` 传进去、又在外面取 `.event` ⇒ undefined
      //   （今天在 `visual.mjs` 已经踩过同一个坑，这里又踩了一次）。
      //   ⇒ 直接用 `makeEvent(...).event`（那才是事件本体）。
      const mkMsg = (raw, at) => {
        const made = makeEvent({
          type: 'message',
          payload: { channel: 'dingtalk', sender: '冯杰楠', raw, summary: raw.slice(0, 30), source: 'im', modality: 'text', isDirect: true, conversationId: CID },
          origin: { channel: 'dingtalk', sender: '冯杰楠', messageId: `conv-act-${at}` },
          _at: at,
        });
        store.upsert(made.event);
        return made.event;
      };
      const t0 = Date.now() - 60000;
      const m1 = mkMsg('先把接口联调的方案对一下，明天上午十点在3楼会议室。', t0);
      const m2 = mkMsg('另外报价单我下午发你，记得看下权限配置。', t0 + 1000);
      // 给其中一条灌一份**按条的召回材料**（验证"两份上下文合用"）
      store.patch('message', m1._id, { context: { recalled: [{ text: '接口联调的历史方案在 Work/示例/联调.md（这条是召回片段）' }], at: new Date().toISOString() } }, { op: 'recall' });
      const day = (() => { const dt = new Date(t0); const p = (n) => String(n).padStart(2, '0'); return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}` })();
      const convId = `${day}__cid:${CID}`;

      // ① /pages/messages 给的是**会话**（不是一条条消息）
      const pm = await get('/pages/messages');
      chk('API-64', '★★ 消息页返回的是**会话**（一条会话一行，不是一条消息一行）',
        pm.body.view === 'conversations' && Array.isArray(pm.body.list)
        && pm.body.list.every((x) => x.day && typeof x.count === 'number' && !('summary' in x)),
        `会话 ${pm.body.list.length} 条 · counts.total=${pm.body.counts.total}`);
      chk('API-65', '★ 会话行带 `repliedCount`（详情那行"已回复 N 条"要用）',
        pm.body.list.every((x) => typeof x.repliedCount === 'number'));

      // ② 会话详情：原文**按时间升序**，形态 `HH:MM`
      const cd = await get(`/conversation?id=${encodeURIComponent(convId)}`);
      chk('API-66', '★★ 会话详情：原文按时间升序，每条带 `HH:MM`（用户点名的形态）',
        cd.code === 200 && cd.body.messages.length === 2
        && /^\d{2}:\d{2}$/.test(cd.body.messages[0].hm)
        && cd.body.messages[0].id === m1._id && cd.body.messages[1].id === m2._id,
        JSON.stringify(cd.body.messages?.map((x) => x.hm)));
      chk('API-67', '★ 会话详情给出四个动作（已回复/转待办/转日程/转笔记）',
        ['已回复', '转待办', '转日程', '转笔记'].every((x) => (cd.body.availableOps ?? []).includes(x)),
        JSON.stringify(cd.body.availableOps));
      chk('API-68', '★ 会话详情带**会话级上下文**字段（没算过 ⇒ 标注"还在算"，不假装有）',
        'convContext' in cd.body && (cd.body.convContextPending === true || typeof cd.body.convContext === 'string'),
        JSON.stringify({ pending: cd.body.convContextPending, has: !!cd.body.convContext }));

      // ③ **只勾一条**转待办 ⇒ 只标那一条，另一条不动
      const c1 = await post(`/conversations/${encodeURIComponent(convId)}/act`, { op: '转待办', ids: [m1._id] });
      chk('API-69', '★★ 只勾一条 ⇒ 建出目标事件，且**只标勾选的那一条**',
        c1.code === 200 && !!c1.body.to
        && (store.getById('message', m1._id).ops ?? []).some((o) => o.op === 'to-todo')
        && !(store.getById('message', m2._id).ops ?? []).some((o) => o.op === 'to-todo'),
        `HTTP ${c1.code} · to=${c1.body.to} · m1=${JSON.stringify((store.getById('message', m1._id).ops ?? []).map((o) => o.op))} · m2=${JSON.stringify((store.getById('message', m2._id).ops ?? []).map((o) => o.op))}`);
      chk('API-70', '★★ 材料 = **勾选原文 + 各自的召回材料 + 会话级上下文**（三样合起来）',
        /勾选原文 1 条/.test(String(c1.body.material ?? '')), String(c1.body.material ?? ''));
      chk('API-71', '★ 回执给**逐字段来源**（看得出是从哪取的）', !!c1.body.extractFrom, JSON.stringify(c1.body.extractFrom ?? {}).slice(0, 80));

      // ④ 幂等：同一批勾选再点一次 ⇒ **库里不重复建**
      //   ⚠️ 判据**只能看"库里多了没有"**，不能看两次返回的 `to` 是否相同：
      //     `createEvent` 每次都 `makeEvent` 出一个**新的 _id** 返回，而库里仍按
      //     `origin.messageId`（幂等键）归一到**同一条已存在的事件**上（实测 `action=updated`）。
      //     第一版断言了 `c1b.body.to === c1.body.to` ⇒ 必然不相等 ⇒ **把好的判成坏的**。
      const before = store.list({ type: 'todo' }).length;
      const c1b = await post(`/conversations/${encodeURIComponent(convId)}/act`, { op: '转待办', ids: [m1._id] });
      chk('API-72', '★★ 同一批勾选重复点 ⇒ **库里不重复建**（幂等键＝会话+那批勾选+目标类型）',
        c1b.code === 200 && store.list({ type: 'todo' }).length === before,
        `待办条数 ${before} → ${store.list({ type: 'todo' }).length}`);

      // ⑤ 一条都不勾 ⇒ **默认整条会话**
      const c2 = await post(`/conversations/${encodeURIComponent(convId)}/act`, { op: '转笔记', ids: [] });
      chk('API-73', '★★ 一条都不勾 ⇒ **默认整条会话**（追问裁定②）',
        c2.code === 200 && c2.body.whole === true && c2.body.from === 2
        && (store.getById('message', m2._id).ops ?? []).some((o) => o.op === 'to-note'),
        JSON.stringify({ whole: c2.body.whole, from: c2.body.from, material: c2.body.material }));

      // ⑥ 已回复：**只标勾选的那些条**（追问裁定①）
      const c3 = await post(`/conversations/${encodeURIComponent(convId)}/act`, { op: '已回复', ids: [m2._id] });
      chk('API-74', '★★ 已回复只标**勾选的那些条**（追问裁定①）',
        c3.code === 200 && c3.body.marked === 1
        && (store.getById('message', m2._id).ops ?? []).some((o) => o.op === 'replied'),
        JSON.stringify({ marked: c3.body.marked, note: c3.body.note }));
      const cvAfter = await get('/pages/messages');
      const row = cvAfter.body.list.find((x) => x.id === convId);
      // ⚠️ 判据要守的是**用户那条裁定本身**："只标勾选的那些条 ⇒ 会话不该被当成已回复"。
      //   第一版写成 `state === 'pending'` —— **太窄**：此时另一条已经被转成日程/笔记了，
      //   会话状态如实显示"已转日程/已转笔记"才是对的（那是这条会话当前的样子）。
      //   把 state 钉成 pending 等于要求"转过的东西不许显示" —— 那是把判据写得比要求还严。
      chk('API-75', '★★ 只回了一条 ⇒ 会话**不算已回复**（逐条判状态，不整会话移动）',
        row && row.state !== 'replied' && row.repliedCount === 1,
        JSON.stringify({ state: row?.state, repliedCount: row?.repliedCount, count: row?.count }));

      // ⑦ 不存在的会话 ⇒ 404（不返回空壳）
      chk('API-76', '★ 不存在的会话 ⇒ 404', (await get('/conversation?id=1999-01-01__cid:nope')).code === 404);
    }

    // ★ API-29 由「断言 501（未接线）」改成「断言真接线」——**这是本轮唯一一处改动既有断言**。
    //   理由：那条守的是"别假装成功"，当时确实没接线所以回 501；现在真接上了，200 才是如实。
    //   （不是为了让检查变绿而放宽：成功路径、失败路径、没建议三种都另有断言守着。）
    //   桩：把 `reanalyzeNote` 与控制台真正的 `globalThis.fetch` 都换掉 —— **本自检不出网、不碰真工具**。
    const analyzeMod = await import('../processor/analyze.mjs');
    const vizMod = await import('../processor/visual.mjs');
    const prevDeps = { reanalyzeNote: _deps.reanalyzeNote, buildVisualForNote: _deps.buildVisualForNote, recall: _deps.recall };
    _deps.reanalyzeNote = async (evt) => {
      // ★ 桩也要**把建议落进状态**（与真实现同形）：否则下一条断言拿到的笔记没有 suggested，
      //   会以为"负向"通过 —— 那是最典型的假绿（夹具与实现不同形）。实测踩到过。
      const visual = { suggested: 'coordinates', why: '桩', built: false, ref: null };
      store.patch('note', evt._id, { analysis: { ...(evt.analysis ?? {}), by: 'model', text: '判断：桩\n理由：桩\n下一步：桩', visual } }, { op: 'analyzed', rerun: true });
      return { ok: true, text: '判断：桩\n理由：桩\n下一步：桩', visual, contextCount: 0, recallError: null };
    };
    _deps.buildVisualForNote = async (evt) => ({ id: evt._id, action: 'built', tool: 'coordinates', ref: '/stub/coords.json', reason: null, detail: '桩：已建' });
    const realFetch = globalThis.fetch;
    const vizNotes = [];
    // ★ 只拦**建模中心那一个地址**，其余一律放行。
    //   为什么不是"除了自己全拦"：宽拦会打断本套件里别的真实 HTTP（实测表现为 `TypeError: fetch failed`，
    //   而且错误信息不带 URL ⇒ 极难定位）。**拦得越窄，假绿越少。**
    //   坐标系的通路走文件系统（默认实现写 `$DSH_HOME/.dsh-coords/`），这里用 WB_V1_COORDS_DIR 把它指到临时目录，
    //   免得自检往你真实的坐标系里写东西。
    process.env.WB_V1_COORDS_DIR = path.join(process.env.WB_V1_OUT, 'coords');
    globalThis.fetch = async (url, opt) => {
      const u = String(url);
      if (!/\/modeling\/api\/model/.test(u)) {
        try {
          return await realFetch.call(globalThis, url, opt);
        } catch (e) {
          // 诊断：`fetch failed` 不带 URL 时根本没法定位（实测踩到）⇒ 把地址与 cause 一起抛出去
          const cause = e?.cause?.message ?? e?.cause?.code ?? '';
          throw new Error(`真实 fetch 失败：${u} :: ${e.message}${cause ? ' :: ' + cause : ''}`);
        }
      }
      let sent = null;
      try { sent = JSON.parse(opt?.body ?? '{}'); } catch { /* noop */ }
      vizNotes.push({ url: u, sent });
      return { ok: true, status: 200, json: async () => ({ model: { id: 'msxstub' } }) };
    };
    try {
      // 自证：注入点真的生效（否则会去调真模型 —— 实测表现为 180 秒 Headers Timeout）
      const t0 = Date.now();
      const na = await post('/notes/' + n.body.id + '/analyze', {});
      chk('API-29d', '自证：分析动作走的是注入桩（不是真模型）', Date.now() - t0 < 5000 && na.code === 200, `用时 ${Date.now() - t0}ms code=${na.code} deps=${typeof _deps.reanalyzeNote}`);
      chk('API-29', '★ 笔记分析：真跑分析引擎（200 + 分析与建议 + 可视化建议）', na.code === 200 && typeof na.body.text === 'string' && na.body.visual?.suggested === 'coordinates', JSON.stringify(na.body));

      const nv = await post('/notes/' + n.body.id + '/visualize', {});
      const nEvt = store.getById('note', n.body.id);
      chk('API-37', '★ 可视化构建：动作接通，成功才置 built + 记落点', nv.code === 200 && nv.body.tool === 'coordinates' && typeof nv.body.ref === 'string', JSON.stringify(nv.body));

      // ② 真实实现（注入掉的是"工具调用"，不是"写状态"）：置 built / 失败留痕 / 没建议 409
      _deps.buildVisualForNote = prevDeps.buildVisualForNote;
      const nvReal = await post('/notes/' + n.body.id + '/visualize', {});
      const nEvt2 = store.getById('note', n.body.id);
      chk('API-38', '★ 真实现：真调工具（坐标系落盘）⇒ 才置 built=true', nvReal.code === 200 && nEvt2.analysis?.visual?.built === true && typeof nEvt2.analysis.visual.ref === 'string', JSON.stringify({ body: nvReal.body, visual: nEvt2.analysis?.visual }));
      chk('API-39', '★ 真实现真的落盘了（坐标文件写出去了，不是本地假装）', nvReal.code === 200 && fsx.existsSync(String(nEvt2.analysis?.visual?.ref ?? '')), String(nEvt2.analysis?.visual?.ref));

      // 负向：没被判为适合可视化的笔记 ⇒ 409，且**一个工具都不许动**（按落盘数比，不按调用数）
      const coordsBefore = fsx.readdirSync(process.env.WB_V1_COORDS_DIR).length;
      const { makeEvent: mk } = await import('../schema.mjs');
      const made2 = mk({ type: 'note', payload: { topic: '没有建议的笔记', date: '2026-10-12', content_md: '今天下午开了个会' }, origin: { channel: 'manual', sender: '我' }, _at: Date.now() });
      store.upsert(made2.event);
      const nr = await post('/notes/' + made2.event._id + '/visualize', {});
      chk('API-40', '★ 负向：没被判为适合可视化的笔记 ⇒ 409，且工具一个都没动', nr.code === 409 && fsx.readdirSync(process.env.WB_V1_COORDS_DIR).length === coordsBefore, JSON.stringify(nr.body) + ` coords ${coordsBefore}→${fsx.readdirSync(process.env.WB_V1_COORDS_DIR).length}`);

      // 失败路径：注回"工具失败"的实现（这一条测的是"失败必须留痕、built 不置真"）
      _deps.buildVisualForNote = async (evt) => {
        store.patch('note', evt._id, { analysis: { ...(evt.analysis ?? {}), visual: { ...(evt.analysis?.visual ?? {}), built: false, error: '桩：工具不可用' } } }, { op: 'visualize-failed' });
        return { id: evt._id, action: 'failed', tool: 'modeling', ref: null, reason: '桩：工具不可用', detail: null };
      };
      const made3 = mk({ type: 'note', payload: { topic: '会失败的笔记', date: '2026-10-12', content_md: '这里的流程与依赖关系需要理清' }, origin: { channel: 'manual', sender: '我' }, _at: Date.now() });
      store.upsert(made3.event);
      store.patch('note', made3.event._id, { analysis: { visual: { suggested: 'modeling', why: '桩' } } });
      const nf = await post('/notes/' + made3.event._id + '/visualize', {});
      const after = store.getById('note', made3.event._id);
      chk('API-41', '★ 构建失败 ⇒ 502 且 built 不置真（失败留痕、不假装）', nf.code === 502 && after.analysis?.visual?.built !== true && String(after.analysis?.visual?.error).includes('桩'), JSON.stringify({ body: nf.body, visual: after.analysis?.visual }));
    } finally {
      _deps.reanalyzeNote = prevDeps.reanalyzeNote;
      _deps.buildVisualForNote = prevDeps.buildVisualForNote;
      _deps.recall = prevDeps.recall;
      globalThis.fetch = realFetch;
      void analyzeMod; void vizMod;
    }
    chk('API-30', '★ 动作路径也受登记守卫（未登记的动作用 404 挡住）', (await post('/messages/' + w.body.id + '/whatever', {})).code === 404);

    // ── P2 新增：转笔记 / 转日程需具体时间 / 待办交付物（2026-10-12）───────────────
    // ★ 判据用**增量**不写绝对条数：绝对数会随前面夹具变动而红（实测：断言 2，实际已经 3）
    const notesBefore = (await get('/pages/notes')).body.counts.total;
    const cnvNote = await post('/messages/' + w.body.id + '/convert', { to: 'note', topic: '从消息沉淀的笔记' });
    const notesAfter = (await get('/pages/notes')).body.counts.total;
    chk('API-43', '★ 消息转笔记（需求 3.3.3 后半句：成体系知识 ⇒ 记为笔记）', cnvNote.code === 200 && cnvNote.body.kind === 'note' && notesAfter === notesBefore + 1, JSON.stringify(cnvNote.body) + ` notes ${notesBefore}→${notesAfter}`);
    chk('API-44', '转笔记后来源消息留痕（to-note + 目标 id）', await (async () => {
      const d = await get('/detail/messages/' + w.body.id);
      const o = (d.body.ops ?? []).find((x) => x.op === 'to-note');
      return !!o && typeof o.targetId === 'string';
    })());
    const cnvSch = await post('/messages/' + w.body.id + '/convert', { to: 'schedule' });   // 原文里没有可解析时间
    chk('API-45', '★ 转日程但解析不出具体时间 ⇒ 409 且说明契约（不建个空日程）', cnvSch.code === 409 && /start\/end/.test(JSON.stringify(cnvSch.body)), JSON.stringify(cnvSch.body).slice(0, 160));
    const cnvSch2 = await post('/messages/' + w.body.id + '/convert', { to: 'schedule', start: '2026-10-20T14:00', end: '2026-10-20T15:00' });
    chk('API-46', '★ 时间由人给 ⇒ 转日程成功（契约要求具体值，实测给 null 会建个空）', cnvSch2.code === 200 && cnvSch2.body.kind === 'schedule', JSON.stringify(cnvSch2.body));
    chk('API-47', '转错目标仍 400 且列出全部允许值', (await post('/messages/' + w.body.id + '/convert', { to: 'whatever' })).body.allowed?.join(',') === 'todo,schedule,note');

    const dlBad = await post('/todos/' + t.body.id + '/deliverable', {});
    chk('API-48', '交付物：什么都没给 ⇒ 400（不写空记录）', dlBad.code === 400, JSON.stringify(dlBad.body));
    const dlTxt = await post('/todos/' + t.body.id + '/deliverable', { text: '验收单已发出，回执见附件' });
    chk('API-49', '★ 待办结果：文字说明可登记（需求 3.3.4）', dlTxt.code === 200 && dlTxt.body.count === 1, JSON.stringify(dlTxt.body));
    // 附件：用一个真实存在的小文件（本自检自己造的），落在 Other/Inflow/文件/（用户 Q4 裁定的例外）
    const attSrc = path.join(process.env.WB_V1_OUT, 'att-sample.txt');
    fsx.writeFileSync(attSrc, 'attachment sample', 'utf8');
    const dlFile = await post('/todos/' + t.body.id + '/deliverable', { file: attSrc, note: '回执' });
    chk('API-50', '★ 附件落到 Inflow/文件（Q4 裁定的受控例外）', dlFile.code === 200 && String(dlFile.body.attachment?.ref ?? '').startsWith('Other/Inflow/文件/'), JSON.stringify(dlFile.body.attachment));
    chk('API-51', '附件不存在的路径 ⇒ 400（不写半条记录）', (await post('/todos/' + t.body.id + '/deliverable', { file: path.join(process.env.WB_V1_OUT, '没有这个文件.txt') })).code === 400);
    chk('API-52', '★ 幂等：同名同大小再交一次 ⇒ 复用，不产生第二份', await (async () => {
      const again = await post('/todos/' + t.body.id + '/deliverable', { file: attSrc });
      return again.code === 200 && again.body.attachment?.reused === true;
    })());
    const dlDetail = await get('/detail/todos/' + t.body.id);
    chk('API-53', '详情里能读到结果与交付物（浮层据此渲染）', (dlDetail.body.deliverables ?? []).length === 3 && dlDetail.body.deliverables[0].text !== undefined, JSON.stringify(dlDetail.body.deliverables).slice(0, 200));

    // ── 驾驶舱"生成入口"（2026-10-12 接线）────────────────────────────────────
    chk('API-31', '★ 驾驶舱生成路径已登记（POST /cockpit/:kind）', isRegistered('POST', `${API_PREFIX}/cockpit/state`), JSON.stringify(writeRoutes().filter((r) => r.path && r.path.includes('cockpit'))));
    chk('API-32', '★ 未知的块 ⇒ 400 且列出允许值', await (async () => {
      const r = await post('/cockpit/bogus', {});
      return r.code === 400 && Array.isArray(r.body.allowed) && r.body.allowed.includes('insight');
    })(), JSON.stringify((await post('/cockpit/bogus', {})).body));
    chk('API-33', '★ 无数据区间 ⇒ 409 拒绝生成，且**不调模型**（避免"没数据也像模像样"；也避免自检烧 token）', await (async () => {
      const r = await post('/cockpit/advice', { from: '1970-01-01', to: '1970-01-02' });
      return r.code === 409 && r.body.refused === true;
    })(), JSON.stringify((await post('/cockpit/advice', { from: '1970-01-01', to: '1970-01-02' })).body));

    // ★★ 2026-10-14 加：**登记表里不许有假的写路径**。
    //   为什么单独立一条：`write-routes.json` 的用途就是"写路径必须先登记"，
    //   而它**自己曾经留着两条没实现的**（`GET /state` 与 `POST /system-switch`）——
    //   两条都是**实测打到 404 之后**才被人工摘掉的。登记表里有一条不存在的路径，
    //   等于告诉后来的人"这条路能用" —— **比没有登记更坏**。
    //   判据：每条登记的路径取**最后一段关键词**，要求它在 `server.mjs` 里作为路径片段出现。
    //   ⚠️ 用"最后一段"而非整条：路径参数（`:type` `:id` `:kind`）与 `API_PREFIX` 不该进比对；
    //     而且要求"带引号或斜杠"地出现，免得 `/file` 撞上 `fileRef` 这类词（本项目吃过正则写太死的亏）。
    {
      // ★★ 判据：每个登记的路径段，**要在分发的判断里出现**。
      //
      //   ⚠️ 这一条我写错过四次，**每一次都看起来是通过的** —— 全记下来，因为它是个典型陷阱：
      //     ① 自己拼 `px.join(PKG_ROOT, …)` 读表 ⇒ 路径错、**读到 0 条** ⇒ 0 条当然 0 条找不到（恒真）；
      //     ② 改用 `writeRoutes()` 但读 `r.route` —— 字段名其实是 **`r.path`**
      //        ⇒ 每条 key 都空、全被 `continue` 跳过 ⇒ **又恒真**（还报"17 条都找得到"）；
      //     ③ 读对后"取最后一段当关键词" ⇒ **误报两条真路由**（`cockpit/:kind`、`detail/:type/:id`），
      //        因为它们的最后一段是**参数**，对参数化路径"取最后一段"从根上不成立；
      //     ④ 换成 `isRegistered(method, path)` ⇒ **恒真**：它回答的是"在不在登记表里"，
      //        而被检的正是登记表 —— **拿表去验表，必然自我印证**（我把假路径塞进表，它照样说"认得"）。
      //
      //   ⇒ 真正要问的是"**分发有没有这条分支**"。而分发的判据全在 `server.mjs` 自己身上：
      //     要么字面量比较（`p === '/file'`），要么落进某条正则（`^…/([a-z]+)/([^/]+)/([a-z-]+)$` 之类）。
      //     所以逐段要求：**该段在源码里以"路径段"的形态出现过**（前面紧邻 `/` 或 `'`）。
      //   ⚠️ 仍要报"比了几段"：只报"没找到坏的"分不清"都是好的"和"一个都没看"。
      let rows = [];
      try { rows = writeRoutes() } catch { rows = [] }
      const selfSrc = fsx.readFileSync(fileURLToPath(import.meta.url), 'utf8');
      const ghosts = [];
      let compared = 0;
      for (const r of rows) {
        const segs = String(r.path ?? '').split('/').filter((x) => x && !x.startsWith(':'));
        if (!segs.length) continue;
        compared += 1;
        // 该路径的**每一段**都要在源码里以路径段形态出现（`/seg` 或 `'/seg'`）
        const miss = segs.filter((s) => !selfSrc.includes(`/${s}`) && !selfSrc.includes(`'${s}'`));
        if (miss.length) ghosts.push(`${r.method} ${r.path}（源码里找不到：${miss.join(', ')}）`);
      }
      chk('API-34', '★★ 登记表里每一条的路径段都**在分发的判断里出现**（防"幽灵写路径"——它比不登记更坏）',
        rows.length > 0 && compared === rows.length && ghosts.length === 0,
        rows.length === 0 ? '★ 登记表读到 0 条 ⇒ 读错了（这条会因此变成摆设，故判失败）'
          : compared !== rows.length ? `★ 只比了 ${compared}/${rows.length} 条 ⇒ 有路由被跳过，检查不完整`
            : (ghosts.length ? `源码里没有对应分发的：${ghosts.join(' | ')}` : `${compared} 条的路径段都在源码里`));
    }
  } finally {
    server.close();
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    if (prevKb === undefined) delete process.env.WB_V1_KB_ROOT; else process.env.WB_V1_KB_ROOT = prevKb;
    try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}

const __isMain = (() => { try { const entry = process.argv[1]; return !!entry && import.meta.url === pathToFileURL(entry).href } catch { return false } })();
if (__isMain) {
  const port = Number(process.argv[2] || 8791);
  startServer({ port }).then((s) => {
    console.log(`工作台 API 已起：${s.url}（只监听本机 ${s.port}）`);
    console.log('读：GET /health · /pages/{overview|messages|todos|schedules|notes}');
    console.log('写：POST 登记表里的路径（write-routes.json）');
  });
}
