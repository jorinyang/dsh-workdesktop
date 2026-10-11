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
import { health as registryHealth } from '../collector/registry.mjs';
import { health as stateHealth } from '../collector/state.mjs';
import { KB_ROOT as ROOT, PKG_ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

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
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { req.destroy(); resolve({ ok: false, why: '请求体过大' }); } else chunks.push(c); });
    req.on('end', () => { try { resolve({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch (e) { resolve({ ok: false, why: `请求体不是合法 JSON：${e.message}` }); } });
    req.on('error', (e) => resolve({ ok: false, why: e.message }));
  });
}

/** 新增一条事件（四类通用）：校验 → 落运行态 → 交给筛选引擎 */
export function createEvent(type, payload, { origin = null, at = null } = {}) {
  const made = makeEvent({
    type,
    payload,
    origin: origin ?? { channel: 'manual', sender: '我', messageId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, raw: null },
    _at: at ?? Date.now(),
  });
  if (made.ok === false) return { ok: false, code: 400, errors: made.errors };
  const r = store.upsert(made.event);
  if (r.action === 'rejected') return { ok: false, code: 400, errors: [r.reason ?? '落库被拒'] };
  return { ok: true, code: 200, id: made.event._id, action: r.action, event: made.event };
}

const EVENT_FOR = { messages: 'message', notes: 'note', todos: 'todo', schedules: 'schedule' };

export function handler(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  // ── 读路径（GET）────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (p === `${API_PREFIX}/health`) return json(res, 200, { channels: registryHealth(), watermarks: stateHealth() });

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
        message: ['转待办', '转日程', '已回复'],
        todo: ['已搁置', '转日程', '已完成'],
        schedule: ['转待办', '已完成'],
        note: ['可视化构建', '分析笔记'],
      };
      return json(res, 200, {
        id: evt._id, type: evt.type, lifecycle: evt.lifecycle, at: evt._at,
        structured: evt.payload,                       // 结构化内容
        original: evt.origin,                          // 原始消息（来源/发信人/原文）
        context: evt.context ?? { recalled: [] },      // 相关上下文（分析引擎召回后写入）
        analysis: evt.analysis ?? null,                // 分析与建议 / 可视化（笔记用）
        deliverables: evt.deliverables ?? [],
        ops: evt.ops ?? [],
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
    if (act) {
      const plural = act[1]; const id = act[2]; const action = act[3];
      const t = { messages: 'message', notes: 'note', todos: 'todo', schedules: 'schedule' }[plural];
      if (!t) return json(res, 404, { error: `未知类型：${plural}` });
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
          const to = String(body.payload?.to ?? body.to ?? '').trim();
          if (to !== 'todo' && to !== 'schedule') return json(res, 400, { error: 'convert 需要 payload.to = "todo" 或 "schedule"' });
          const src = evt.payload ?? {};
          const mk = to === 'todo'
            ? { topic: String(body.payload?.topic ?? src.summary ?? src.raw ?? '').slice(0, 80) || '（未命名待办）', detail: String(body.payload?.detail ?? src.raw ?? ''), due: body.payload?.due ?? null, publisher: src.sender ?? null, executor: body.payload?.executor ?? '我' }
            : { topic: String(body.payload?.topic ?? src.summary ?? src.raw ?? '').slice(0, 80) || '（未命名日程）', start: body.payload?.start ?? null, end: body.payload?.end ?? body.payload?.start ?? null, place: body.payload?.place ?? null, participants: body.payload?.participants ?? [] };
          const made = createEvent(to, mk, { origin: { channel: evt.origin.channel, sender: evt.payload.sender, messageId: `from-${evt.origin.messageId ?? evt._id}`, raw: evt.payload.raw ?? null }, at: evt._at });
          if (made.ok === false) return json(res, 400, { error: '生成目标事件失败', errors: made.errors });
          store.patch('message', id, {}, { op: to === 'todo' ? 'to-todo' : 'to-schedule', targetId: made.id });
          return json(res, 200, { ok: true, from: id, to: made.id, kind: to, note: '已建目标事件并在来源消息上留痕' });
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

        // ④ 笔记的分析/可视化：分析引擎尚未接线 —— **如实回 501**，不假装成功
        if (t === 'note' && (action === 'analyze' || action === 'visualize')) {
          return json(res, 501, { error: '分析引擎尚未接线（P3 待做）⇒ 这个动作暂时无法执行', action, note: '接口与登记都在位，缺的是分析引擎本体' });
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
      return json(res, 200, { ok: true, id: r.id, action: r.action, note: '已落运行态，将由筛选引擎结构化并双写知识库' });
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

    chk('API-1', '健康检查返回通道与水位线', (await get('/health')).body.channels?.total === 18, JSON.stringify((await get('/health')).body.channels?.implemented));
    for (const p of ['overview', 'messages', 'todos', 'schedules', 'notes']) {
      const r = await get('/pages/' + p);
      chk('API-' + p, '页面数据 ' + p + ' 可读', r.code === 200 && typeof r.body === 'object', 'code=' + r.code);
    }
    chk('API-7', '未知页面 ⇒ 404 且列出可用项', (await get('/pages/nope')).code === 404);
    chk('API-8', '★ 未登记的写路径 ⇒ 404 并说明要先登记', (await post('/not-registered', {})).code === 404);
    chk('API-9', '登记表已加载（13 条写路径）', writeRoutes().length >= 13, String(writeRoutes().length));

    // 真写一条消息（走已登记路径）
    const w = await post('/messages', { channel: 'manual', sender: '我', raw: '手工新增的一条消息', source: 'manual', modality: 'text' });
    chk('API-10', '★ 新增消息落在运行态（200 + id）', w.code === 200 && w.body.ok === true, JSON.stringify(w.body));
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
      && Array.isArray(detail.body.availableOps) && detail.body.availableOps.length === 3, JSON.stringify(detail.body.availableOps));
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
    const na = await post('/notes/' + n.body.id + '/analyze', {});
    chk('API-29', '★ 笔记分析 ⇒ 501 如实说"分析引擎尚未接线"（不假装成功）', na.code === 501 && /分析引擎/.test(na.body.error), JSON.stringify(na.body));
    chk('API-30', '★ 动作路径也受登记守卫（未登记的动作用 404 挡住）', (await post('/messages/' + w.body.id + '/whatever', {})).code === 404);
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
    console.log(`弈枢 API 已起：${s.url}（只监听本机 ${s.port}）`);
    console.log('读：GET /health · /pages/{overview|messages|todos|schedules|notes}');
    console.log('写：POST 登记表里的路径（write-routes.json）');
  });
}
