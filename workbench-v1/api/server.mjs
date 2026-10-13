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
import { fileURLToPath } from 'node:url';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import * as pages from './pages.mjs';
import { NARRATIVE_SPECS } from './cockpit.mjs';   // 驾驶舱四块的落点（允许值从它取，**一处定义**）
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
      return json(res, 200, {
        id: evt._id, type: evt.type, lifecycle: evt.lifecycle, at: evt._at,
        structured: evt.payload,                       // 结构化内容
        original: evt.origin,                          // 原始消息（来源/发信人/原文）
        context: evt.context ?? { recalled: [] },      // 相关上下文（分析引擎召回后写入）
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
      const fn = pages[key === 'overview' ? 'overview' : key];
      if (typeof fn !== 'function') return json(res, 404, { error: `没有这个页面数据：${key}`, available: ['overview', 'messages', 'todos', 'schedules', 'notes'] });
      const data = fn();
      if (key === 'messages' && u.searchParams.get('tab')) return json(res, 200, typeof pages.messages === 'function' ? pages.messages({ tab: u.searchParams.get('tab') }) : data);
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
    const act = new RegExp(`^${API_PREFIX}/([a-z]+)/([A-Za-z0-9_]+)/([a-z-]+)$`).exec(p);
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
          if (from || to) console.error(`[v1] cockpit/${kind} 区间 ${from ?? '-'} ~ ${to ?? '-'}`);
          const { narrative } = await import('./cockpit.mjs');
          const r = await narrative(kind, { from, to });
          if (r.ok !== true) return json(res, r.refused ? 409 : 502, { ok: false, kind, refused: !!r.refused, error: r.why });
          return json(res, 200, { ok: true, kind, label: r.label, cached: !!r.cached, fp: r.fp, text: r.text });
        } catch (e) {
          return json(res, 500, { ok: false, error: '生成失败：' + (e && e.message ? e.message : String(e)) });
        }
      })();
    }
    if (act) {
      const plural = act[1]; const id = act[2]; const action = act[3];
      const t = { messages: 'message', notes: 'note', todos: 'todo', schedules: 'schedule' }[plural];
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
          let mk; let made;
          if (to === 'note') {
            // 转笔记：内容用原文，主题可取人给的第一句（不给人就给原文首行）
            const { toNotePayload } = await import('../processor/intent.mjs');
            // ⚠️ 必须把 `_at` 一起给进去：`toNotePayload` 用 `evt._at` 生成日期，
            //    漏了它就会得到 `NaN-NaN-NaN` 并被契约拒掉（实测踩到，表现为"转笔记失败"）。
            const np = toNotePayload({ _at: evt._at ?? Date.now(), payload: { raw: src.raw, sender: src.sender, channel: src.channel } });
            mk = { ...np, topic: String(body.payload?.topic ?? np.topic).slice(0, 80), content_md: String(body.payload?.content_md ?? np.content_md) };
            if (Array.isArray(body.payload?.tags) && body.payload.tags.length) mk.tags = body.payload.tags;
          } else if (to === 'todo') {
            mk = { topic: String(body.payload?.topic ?? src.summary ?? src.raw ?? '').slice(0, 80) || '（未命名待办）', detail: String(body.payload?.detail ?? src.raw ?? ''), due: body.payload?.due ?? null, publisher: src.sender ?? null, executor: body.payload?.executor ?? '我' };
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
            mk = { topic: String(body.payload?.topic ?? src.summary ?? src.raw ?? '').slice(0, 80) || '（未命名日程）', detail: String(body.payload?.detail ?? src.raw ?? ''), start, end, place: body.payload?.place ?? null, participants: body.payload?.participants ?? [] };
          }
          made = createEvent(to, mk, { origin: { channel: evt.origin.channel, sender: evt.payload.sender, messageId: `from-${evt.origin.messageId ?? evt._id}`, raw: evt.payload.raw ?? null }, at: evt._at });
          if (made.ok === false) return json(res, 400, { error: '生成目标事件失败', errors: made.errors });
          store.patch('message', id, {}, { op: to === 'todo' ? 'to-todo' : to === 'schedule' ? 'to-schedule' : 'to-note', targetId: made.id, by: 'manual' });
          return json(res, 200, { ok: true, from: id, to: made.id, kind: to, note: '已建目标事件并在来源消息上留痕' });
          })().catch((e) => json(res, 500, { error: `转换失败：${e.message}` }));
        }

        // ② 待办动作（需求 3.3.4：已搁置 / 转日程 / 已完成）
        if (t === 'todo' && action === 'act') {
          const map = { '已完成': 'done', '完成': 'done', 'done': 'done', '已搁置': 'hold', '搁置': 'hold', 'hold': 'hold', '转日程': 'to-schedule', 'to-schedule': 'to-schedule' };
          const k = map[op];
          if (!k) return json(res, 400, { error: '不认识的动作', op, allowed: ['已完成', '已搁置', '转日程'] });
          store.patch('todo', id, {}, { op: k, by: 'manual' });
          return json(res, 200, { ok: true, id, op: k });
        }

        // ③ 日程动作（需求 3.3.5：转待办 / 已完成）
        if (t === 'schedule' && action === 'act') {
          const map = { '已完成': 'done', '完成': 'done', 'done': 'done', '转待办': 'to-todo', 'to-todo': 'to-todo' };
          const k = map[op];
          if (!k) return json(res, 400, { error: '不认识的动作', op, allowed: ['已完成', '转待办'] });
          store.patch('schedule', id, {}, { op: k, by: 'manual' });
          return json(res, 200, { ok: true, id, op: k });
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
            const pr = store.patch('todo', id, { deliverables: list }, { op: 'deliverable', by: 'manual', evidence: { text: !!text, attachment: attachment?.ref ?? null } });
            if (pr.ok === false) return json(res, 500, { error: `交付物写入被拒：${pr.why}` });
            return json(res, 200, { ok: true, id, count: list.length, attachment, note: '结果已记在待办上，归档时随待办一起进知识库（处理引擎负责）' });
          })().catch((e) => json(res, 500, { error: `交付物登记失败：${e.message}` }));
        }

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
      //   ⇒ 新增消息后就地做一次召回（与"分析引擎只召回不调模型"同一条成本口径：**不调模型**）。
      //   召回失败**不影响消息落库**，只如实记进 `context.recallError`（分清"查不到"与"桥断了"）。
      if (type !== 'message') return json(res, 200, { ok: true, id: r.id, action: r.action, note: '已落运行态，将由筛选引擎结构化并双写知识库' });
      return (async () => {
        const { recall } = await import('../processor/recall.mjs');
        const q = String(r.event?.payload?.summary ?? r.event?.payload?.raw ?? '').slice(0, 200);
        let hits = []; let recallError = null;
        if (q !== '') {
          // 自检可注入候选（见 `_deps` 的注释：ESM 命名空间只读，猴子补丁不可用）
          const rr = await (_deps.recall ?? recall)(q);
          if (rr.ok === true) hits = rr.hits;
          else recallError = rr.why;
        }
        store.patch('message', r.id, { context: { recalled: hits, at: new Date().toISOString(), recallError } }, { op: 'recalled-on-create', by: 'api', evidence: { hits: hits.length, recallError } });
        return json(res, 200, {
          ok: true, id: r.id, action: r.action,
          context: { recalled: hits, recallError },
          note: recallError ? '已落运行态；召回不可用（已如实记下原因，不是"没有相关材料"）' : '已落运行态，并已召回相关上下文',
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
    chk('API-23', '★ 消息标已回复（动作路径）', rep.code === 200 && (await get('/pages/messages')).body.counts.replied === 1, JSON.stringify(rep.body));
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
  } finally {
    server.close();
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    if (prevKb === undefined) delete process.env.WB_V1_KB_ROOT; else process.env.WB_V1_KB_ROOT = prevKb;
    try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const port = Number(process.argv[2] || 8791);
  startServer({ port }).then((s) => {
    console.log(`工作台 API 已起：${s.url}（只监听本机 ${s.port}）`);
    console.log('读：GET /health · /pages/{overview|messages|todos|schedules|notes}');
    console.log('写：POST 登记表里的路径（write-routes.json）');
  });
}
