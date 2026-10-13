/**
 * v1/collector/dingtalk-todo.mjs —— 钉钉 · 待办（登记表 `dd-todo`）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 3.1.6：「接收到的待办需要结构化拆解：待办任务主题 / 任务详情 / 截止时间 / 发布人 / 执行人」
 * 需求 2.2：其他 CLI 功能走**每 5 分钟轮询**，有新内容就采，**遵循幂等**。
 *
 * 实测依据（2026-10-12，不是猜的）：
 *   · `dws todo +get-my-tasks` ⇒ `{count, todos:[{taskId, subject, dueTime, finalStatusStage, priority}]}`
 *   · `dws todo +get --taskId X` ⇒ `{result:{todoDetailModel:{...}}}`，其中权威状态字段是 **`isDone`**
 *     （实测：stage 0 ⇒ isDone=false；stage 2 ⇒ isDone=true ⇒ **不要拿 stage 数字当完成判据**），
 *     另有 `creatorInfo.name`（发布人）、`executorIds`、`dueTime`（毫秒）、`sourceTitle`（来源，如 OA审批）。
 *
 * 幂等键 = `dd-todo-<taskId>`（同一个待办恒定）⇒ 重复轮询不会产生第二条。
 * 状态同步：库里已有该待办、而这次 `isDone=true` ⇒ 追加一条 `done` 操作（带依据），**不新建事件**。
 *
 * 与其它通路一致：**取数与映射分离**（`run` 可注入）⇒ 自检不碰真 CLI、不联网。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { makeEvent } from '../schema.mjs';
// 「关闭条件」的产地只有一处（`processor/close.mjs`）—— 采集器与服务端共用同一个函数，不各写一份。
import { withCloseCondition } from '../processor/close.mjs';
import * as store from '../store.mjs';
import { inScope } from './registry.mjs';
import { v1Out } from '../paths.mjs';
import { buildCommand } from './cli.mjs';

export const KEY = 'dd-todo';
export const INTERVAL_SEC = 300;

const pad = (n) => String(n).padStart(2, '0');
/** 毫秒 → 本地 `YYYY-MM-DD`（登记契约：日程/待办的日期只有日期或本地分钟，不带时区） */
export function localDate(ms) {
  if (!ms || !Number.isFinite(Number(ms)) || Number(ms) <= 0) return null;
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 状态文件：记住已见过的 taskId 与其 stage，用于判断"要不要再拉详情" */
export function stateFile() { return path.join(v1Out(), 'dd-todo-seen.json'); }
export function loadSeen() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveSeen(doc) {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

/** 默认取数：真跑 `dws`（自检一律注入假 run，不碰它）
 *
 * ★ Windows 坑（实测 2026-10-12）：`spawnSync('dws', …)` 直接报 **ENOENT** ——
 *   `dws` 在 Windows 上是 `.cmd` 垫片，Node 不认（它不做 PATHEXT 解析）。
 *   ⇒ 与 `media.mjs` 保持一致：**经 PowerShell 调**（那条路已被证明可用），
 *     不自己拼 `.cmd`/`shell:true`（前者依赖安装形态，后者有引号注入风险）。
 */
export function defaultRun(args) {
  const PS = 'powershell.exe';
  const cmd = buildCommand('dws', args);   // 统一走 collector/cli.mjs（引号规则只有一份）
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `dws 退出码 ${r.status}：${(err || out).slice(0, 200)}` };
  try { return { ok: true, json: JSON.parse(out) }; } catch (e) { return { ok: false, why: `输出不是 JSON：${e.message}（前 120 字：${out.slice(0, 120)}）` }; }
}

/** 取"我的待办"列表 */
export function fetchList({ run = defaultRun } = {}) {
  const r = run(['todo', '+get-my-tasks']);
  if (r.ok !== true) return { ok: false, why: r.why };
  const todos = r.json?.todos;
  if (!Array.isArray(todos)) return { ok: false, why: '返回里没有 todos 数组' };
  return { ok: true, count: Number(r.json.count ?? todos.length), todos };
}

/** 取单条详情（权威 isDone / 发布人 / 执行人都在这里） */
export function fetchDetail(taskId, { run = defaultRun } = {}) {
  const r = run(['todo', '+get', '--taskId', String(taskId)]);
  if (r.ok !== true) return { ok: false, why: r.why };
  const d = r.json?.result?.todoDetailModel;
  if (!d || typeof d !== 'object') return { ok: false, why: '返回里没有 result.todoDetailModel' };
  return { ok: true, detail: d };
}

/** 详情 → v1 待办事件（需求 3.1.6 的五项：主题/详情/截止/发布人/执行人） */
export function mapTodo(d) {
  const errs = [];
  const topic = String(d?.subject ?? '').trim();
  if (!topic) errs.push('缺主题（subject）');
  const taskId = String(d?.taskId ?? '').trim();
  if (!taskId) errs.push('缺 taskId（幂等键要用）');
  if (errs.length) return { ok: false, errors: errs };

  // 执行人：优先真名（executorInfos），没有就退回 id（**如实标注，不假装是名字**）
  const infos = Array.isArray(d.executorInfos) ? d.executorInfos : [];
  const names = infos.map((x) => String(x?.name ?? '').trim()).filter(Boolean);
  const ids = Array.isArray(d.executorIds) ? d.executorIds.map(String) : (d.executorIds ? [String(d.executorIds)] : []);
  const executor = names.length ? names.join('、') : (ids.length ? ids.join('、') : '');

  // ★ 只填**登记过**的字段（契约守卫会拒未登记字段："否则前端不会读它"）。
  //   两个想加但**没加**的字段，以及为什么：
  //     · `ddTaskId` —— 任务号已经有登记的归属：`origin.messageId = dd-todo-<taskId>`，不必再抄一份；
  //     · `isDone`   —— 完成状态也有登记的归属：`ops` 里的 `done`（且带依据）。放进 payload 会与 ops 形成两份真相。
  //   （第一条命中的就是这两个字段，被 `makeEvent` 的 PAYLOAD_SPEC 校验挡住 —— 守卫是对的。）
  const payload = {
    topic,
    detail: String(d.sourceTitle ?? d.source ?? '').trim() || topic,
    due: localDate(d.dueTime),                       // 无期限 ⇒ null（不是编一个日期）
    publisher: String(d.creatorInfo?.name ?? '').trim() || (d.creatorId ? String(d.creatorId) : ''),
    executor,
    source: 'dingtalk-todo',
  };
  const at = Number(d.createdTime) > 0 ? Number(d.createdTime) : Date.now();
  return {
    ok: true,
    payload,
    origin: { channel: 'dingtalk', sender: payload.publisher || '钉钉待办', messageId: `dd-todo-${taskId}`, raw: payload.detail },
    _at: at,
    isDone: d.isDone === true,
  };
}

/**
 * 跑一轮：列表 → （新任务或状态变了才拉详情）→ 落运行态 / 同步完成状态。
 * @param {{run?:Function, dryRun?:boolean, maxNew?:number, since?:number|null}} o
 */
export function ingestOnce({ run = defaultRun, dryRun = false, maxNew = 200, since = null } = {}) {
  const errors = [];
  let inCount = 0; let outCount = 0; let refreshed = 0; let updated = 0; let skipped = 0; let outOfScope = 0; let quarantined = 0; let detailFetches = 0;

  const listed = fetchList({ run });
  if (listed.ok !== true) return { inCount: 0, outCount: 0, refreshed: 0, updated: 0, skipped: 0, outOfScope: 0, quarantined: 0, detailFetches: 0, errors: [listed.why], dataAsOf: null, why: `列表取不到：${listed.why}` };

  const seen = loadSeen();
  const existing = new Map(store.list({ type: 'todo' }).map((e) => [e.origin?.messageId, e]));

  for (const row of listed.todos) {
    inCount += 1;
    const taskId = String(row?.taskId ?? '');
    if (!taskId) { quarantined += 1; errors.push('列表里有一条没有 taskId，跳过（不猜）'); continue; }
    const mid = `dd-todo-${taskId}`;
    const stage = String(row?.finalStatusStage ?? '');
    const rowDue = Number(row?.dueTime ?? 0) || 0;
    const prev = seen[taskId];
    const have = existing.get(mid);

    // 拉详情的条件：没见过 / 状态位变了 / **截止时间变了** / 库里还没有这条（且不是已知的界外项）
    //   ★ `!have && !prev?.outOfScope`：界外项永远不入库，不能只看 `!have` ——
    //     否则每轮都为它重复拉一次详情（实测 DTD-12 抓到这个低效）。
    //   ★ 把 `dueMs` 纳入比较：界外项若被改了截止时间，要重新评估能不能入流。
    const needDetail = !prev || prev.stage !== stage || prev.dueMs !== rowDue || (!have && !prev?.outOfScope);
    let d = null;
    if (needDetail) {
      if (dryRun) { outCount += 1; continue; }
      if (outCount >= maxNew) { errors.push(`达到上限 ${maxNew} 条，其余下一轮再来`); break; }
      const got = fetchDetail(taskId, { run });
      detailFetches += 1;
      if (got.ok !== true) { errors.push(`待办 ${taskId} 详情取不到：${got.why}`); continue; }
      d = got.detail;
    } else {
      skipped += 1;
      // 已知任务：只处理"完成状态翻转"这件事
      if (row.finalStatusStage === '2' && have && !(have.ops ?? []).some((o) => o.op === 'done')) {
        if (!dryRun) store.patch('todo', have._id, {}, { op: 'done', by: 'dingtalk-todo', evidence: `钉钉待办「${have.payload?.topic ?? taskId}」已被标记完成（finalStatusStage=2）` });
        updated += 1;
      }
      continue;
    }

    const mapped = mapTodo(d);
    if (mapped.ok !== true) { quarantined += 1; errors.push(`待办 ${taskId} 映射失败：${mapped.errors.join('；')}`); continue; }
    // ★ 采集起点判据（用户 2026-10-12 裁定）：待办**按截止时间**；**没有截止时间 ⇒ 算起点之后**。
    //   统一走 `registry.inScope`，各通路不各写一遍（避免口径漂移）。
    const scope = inScope('todo', mapped.payload, mapped._at);
    if (!scope.inScope) {
      skipped += 1; outOfScope += 1;
      // 界外项也记进 seen（带 dueMs），否则每轮都要为它再拉一次详情（DTD-12 抓到的低效）
      seen[taskId] = { stage, dueMs: rowDue, outOfScope: true, why: scope.why, at: new Date().toISOString() };
      continue;
    }

    // ★★ 2026-10-13 加（需求 3.3.4 / 用户第 9 条）：**采集进来的待办也要有"关闭条件"**。
    //
    // 我上一轮把这个功能加在了服务端的 `createEvent` 里，并以为那是"唯一的创建入口"——
    //   **错了**：采集器不走 `createEvent`，它们是 `makeEvent` + `store.upsert` 各自建事件。
    //   所以**采集进来的待办永远拿不到关闭条件**，而库里那 11 条恰好全是从这里进来的
    //   （真机跑出来的：11 条待办、带关闭条件 0 条）。
    //   教训：**"唯一入口"要在全库范围内确认，不能只看一个文件里那条路。**
    const made = makeEvent({ type: 'todo', payload: withCloseCondition(mapped.payload), origin: mapped.origin, _at: mapped._at });
    if (made.ok === false) { quarantined += 1; errors.push(`待办 ${taskId} 归一失败：${made.errors.join('；')}`); continue; }

    const r = store.upsert(made.event);
    if (r.action === 'rejected') { quarantined += 1; errors.push(`待办 ${taskId} 落库被拒：${r.reason}`); continue; }
    // ★ 按 store 的真实动作分账（第一版把 `updated` 也记成"新采"，数字虚高 —— 实测 DTD-14 抓到）
    if (r.action === 'added') outCount += 1; else if (r.action === 'updated') refreshed += 1;
    // 钉钉那边已完成 ⇒ 直接补一条完成操作（带依据），不再等自动关闭去猜
    if (mapped.isDone) {
      const id = r._id ?? made.event._id;
      const cur = store.getById('todo', id);
      if (cur && !(cur.ops ?? []).some((o) => o.op === 'done')) {
        store.patch('todo', id, {}, { op: 'done', by: 'dingtalk-todo', evidence: `钉钉待办已标记完成（isDone=true，taskId=${taskId}）` });
      }
    }
    seen[taskId] = { stage, dueMs: rowDue, at: new Date().toISOString(), done: mapped.isDone };
  }

  if (!dryRun) saveSeen(seen);
  return {
    inCount, outCount, refreshed, updated, skipped, outOfScope, quarantined, detailFetches, errors,
    dataAsOf: new Date().toISOString(),
    why: `列表 ${listed.count} 条 · 新采 ${outCount} · 刷新 ${refreshed} · 状态同步 ${updated} · 跳过 ${skipped}（其中出界 ${outOfScope}） · 隔离 ${quarantined} · 详情请求 ${detailFetches}`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（注入假 run：不碰真 CLI）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const os = await import('node:os');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-ddtodo-'));
  process.env.WB_V1_OUT = tmp;

  // 假 CLI：三条 —— A 无截止（按用户口径**算起点之后**⇒入流）、B 截止在起点之后且已完成、
  //   C 截止在起点之前（**应被挡在界外**）。第三条是专门为"采集起点判据"造的。
  const DUE_AFTER = Date.parse('2026-11-15T08:00:00+08:00');    // 起点之后
  const DUE_BEFORE = Date.parse('2026-09-02T08:00:00+08:00');   // 起点之前
  const detailOf = (id) => ({
    taskId: id,
    subject: id === 'A' ? '把验收单发给张伟' : (id === 'B' ? '千问办公的配置变更审批' : '一条九月的老待办'),
    dueTime: id === 'A' ? 0 : (id === 'B' ? DUE_AFTER : DUE_BEFORE),
    isDone: id === 'B',
    creatorInfo: { name: id === 'A' ? '张伟' : '李强', userId: '1' },
    executorIds: ['9'], executorInfos: [], sourceTitle: id === 'A' ? '' : 'OA审批',
    createdTime: 1788000000000, finalStatusStage: id === 'B' ? 2 : 0,
  });
  const fakeRun = (args) => {
    if (args[1] === '+get-my-tasks') {
      return { ok: true, json: { count: 3, todos: [
        { taskId: 'A', subject: '把验收单发给张伟', dueTime: 0, finalStatusStage: 0 },
        { taskId: 'B', subject: '千问办公的配置变更审批', dueTime: DUE_AFTER, finalStatusStage: 2 },
        { taskId: 'C', subject: '一条九月的老待办', dueTime: DUE_BEFORE, finalStatusStage: 0 },
      ] } };
    }
    if (args[1] === '+get') { const id = args[3]; return { ok: true, json: { result: { todoDetailModel: detailOf(id) } } }; }
    return { ok: false, why: '未预期的参数：' + args.join(' ') };
  };

  try {
    // ① 映射：五项齐全 + 日期口径
    const m = mapTodo(detailOf('B'));
    chk('DTD-1', '★ 映射出需求 3.1.6 的五项（主题/详情/截止/发布人/执行人）',
      m.ok === true && m.payload.topic === '千问办公的配置变更审批' && m.payload.detail === 'OA审批'
      && m.payload.publisher === '李强' && m.payload.due === localDate(DUE_AFTER) && 'executor' in m.payload,
      JSON.stringify(m.payload));
    chk('DTD-2', '★ 无期限 ⇒ due 为 null（不编日期）', mapTodo(detailOf('A')).payload.due === null, JSON.stringify(mapTodo(detailOf('A')).payload.due));
    chk('DTD-3', '★ 权威完成标志用 isDone（不是 stage 数字）', mapTodo(detailOf('B')).isDone === true && mapTodo(detailOf('A')).isDone === false);
    chk('DTD-4', '执行人没有真名时退回 id（如实，不假装是名字）', mapTodo(detailOf('A')).payload.executor === '9', mapTodo(detailOf('A')).payload.executor);
    chk('DTD-5', '幂等键 = dd-todo-<taskId>', mapTodo(detailOf('A')).origin.messageId === 'dd-todo-A');
    chk('DTD-6', '★ 负向对照：缺主题/缺 taskId ⇒ 映射失败而不是造一条空待办', (() => { const r = mapTodo({ taskId: 'X' }); const r2 = mapTodo({ subject: 'x' }); return r.ok === false && r2.ok === false; })());

    // ② 一轮采集：两条都进来，且已完成那条带 done
    const r1 = ingestOnce({ run: fakeRun });
    chk('DTD-7', '★ 一轮采到 2 条、第三条（截止早于起点）挡在界外', r1.inCount === 3 && r1.outCount === 2 && r1.outOfScope === 1, JSON.stringify({ in: r1.inCount, out: r1.outCount, outOfScope: r1.outOfScope }));
    const stored = store.list({ type: 'todo' });
    chk('DTD-8', '库里 2 条待办', stored.length === 2, String(stored.length));
    const b = stored.find((e) => e.origin.messageId === 'dd-todo-B');
    chk('DTD-9', '★ 钉钉已完成 ⇒ 落库即带 done（含依据，可回查）', (b.ops ?? []).some((o) => o.op === 'done' && /taskId=B/.test(String(o.evidence))), JSON.stringify((b.ops ?? []).map((o) => o.op)));
    const a = stored.find((e) => e.origin.messageId === 'dd-todo-A');
    chk('DTD-10', '未完成的那条**不**带 done（不误标）', !(a.ops ?? []).some((o) => o.op === 'done'));

    // ③ 幂等 + 省详情请求：第二轮不该再造事件
    const r2 = ingestOnce({ run: fakeRun });
    chk('DTD-11', '★ 第二轮幂等：不再新建（outCount=0）', r2.outCount === 0 && r2.skipped >= 2, JSON.stringify({ out: r2.outCount, skipped: r2.skipped }));
    chk('DTD-12', '★ 第二轮不重复拉详情（省 CLI 调用）', r2.detailFetches === 0, String(r2.detailFetches));
    chk('DTD-13', '库里仍是 2 条（没被重复写）', store.list({ type: 'todo' }).length === 2);

    // ④ 状态翻转：A 在钉钉那边完成了 ⇒ 下一轮补 done，且**不新建事件**
    const fakeRun2 = (args) => {
      if (args[1] === '+get-my-tasks') return { ok: true, json: { count: 2, todos: [{ taskId: 'A', subject: '把验收单发给张伟', dueTime: 0, finalStatusStage: 2 }, { taskId: 'B', subject: '千问办公的配置变更审批', dueTime: DUE_AFTER, finalStatusStage: 2 }] } };
      if (args[1] === '+get') { const id = args[3]; const d = detailOf(id); if (id === 'A') d.isDone = true; return { ok: true, json: { result: { todoDetailModel: d } } }; }
      return { ok: false, why: 'unexpected' };
    };
    const r3 = ingestOnce({ run: fakeRun2 });
    const a2 = store.list({ type: 'todo' }).find((e) => e.origin.messageId === 'dd-todo-A');
    // ★ 状态翻转走的是"刷新既有事件"这条路（stage 变了 ⇒ 重新拉详情 ⇒ upsert 成 updated），
    //   不是"新建" ⇒ 断言应该看 outCount=0 且 refreshed=1（第一版把 updated 也算成新采，DTD-14 抓到）。
    chk('DTD-14', '★ 状态翻转 ⇒ 刷新既有事件并补 done（带依据），**不新建**', r3.outCount === 0 && r3.refreshed === 1 && (a2.ops ?? []).some((o) => o.op === 'done'), JSON.stringify({ out: r3.outCount, refreshed: r3.refreshed, updated: r3.updated }));
    chk('DTD-15', '翻转后库里仍是 2 条', store.list({ type: 'todo' }).length === 2);

    // ⑤ 取数失败 ⇒ 如实上报，不当成"没有待办"
    const r4 = ingestOnce({ run: () => ({ ok: false, why: '模拟 CLI 不可用' }) });
    chk('DTD-16', '★ 取数失败 ⇒ 写明原因（不写成"没有待办"）', r4.errors.length === 1 && /列表取不到/.test(r4.why), r4.why);

    // ⑥ 干跑不写盘
    const before = store.list({ type: 'todo' }).length;
    ingestOnce({ run: fakeRun2, dryRun: true });
    chk('DTD-17', '干跑不写盘', store.list({ type: 'todo' }).length === before);
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
