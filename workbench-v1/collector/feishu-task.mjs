/**
 * v1/collector/feishu-task.mjs —— 飞书 · 任务（登记表 `fs-task`）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 3.1.6：「待办结构化拆解：主题 / 详情 / 截止时间 / 发布人 / 执行人」
 * 需求 2.2：CLI 类功能走**每 5 分钟轮询**、**幂等**。
 *
 * 实测依据（2026-10-12，不是猜的）：`lark-cli task +get-my-tasks`
 *   ⇒ `{ok:true, data:{items:[…]}}`，字段并集实测为
 *   **`guid / summary / completed / completed_at / created_at / due_at / url`**
 *   （手上三条全是这个集合；`due_at` 存在但可为空）。
 *
 * **拿不到就不填**（不编）：
 *   · `detail`（任务详情）—— 此视图不给描述字段 ⇒ 不填；
 *   · `publisher` / `executor`（发布人/执行人）—— 此视图不给归属 ⇒ 不填。
 *   （钉钉那条有 `creatorInfo.name` 与 `executorIds`，所以那边能填；**两边如实不同**。）
 *
 * 字段按登记契约（`schema.mjs` PAYLOAD_SPEC.todo）：必填 `topic`；可选其余。
 * 采集起点判据走 `registry.inScope('todo', …)`：**没有截止时间 ⇒ 算起点之后**（用户裁定）。
 * 幂等键 = `fs-task-<guid>`；飞书侧 `completed=true` ⇒ 落库即补一条带依据的 `done`。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { v1Out } from '../paths.mjs';
import { inScope } from './registry.mjs';

export const KEY = 'fs-task';
export const INTERVAL_SEC = 300;

const pad = (n) => String(n).padStart(2, '0');

/** 时间戳/ISO → 本地 `YYYY-MM-DD`（拿不到就给 null，不编） */
export function toLocalDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const ms = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function stateFile() { return path.join(v1Out(), 'fs-task-seen.json'); }
export function loadSeen() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveSeen(doc) {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

/** 取数：经 PowerShell 调 `lark-cli`（Windows 上它是 .cmd 垫片，直接 spawn 会 ENOENT） */
export function defaultRun(args) {
  const PS = 'powershell.exe';
  const cmd = 'lark-cli ' + args.map((a) => {
    const s = String(a);
    return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
  }).join(' ');
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `lark-cli 退出码 ${r.status}：${(err || out).slice(0, 200)}` };
  try {
    const j = JSON.parse(out);
    if (j && j.ok === false) return { ok: false, why: `lark-cli 报错：${String(j.error?.message ?? '未知错误').slice(0, 200)}` };
    return { ok: true, json: j };
  } catch (e) { return { ok: false, why: `输出不是 JSON：${e.message}（前 120 字：${out.slice(0, 120)}）` }; }
}

/** 取"分派给我的任务" */
export function fetchMine({ run = defaultRun } = {}) {
  const r = run(['task', '+get-my-tasks']);
  if (r.ok !== true) return { ok: false, why: r.why };
  const items = r.json?.data?.items;
  if (!Array.isArray(items)) return { ok: false, why: '返回里没有 data.items 数组' };
  return { ok: true, count: items.length, items };
}

/** 飞书任务 → v1 待办事件（需求 3.1.6 里**能给的那几项**） */
export function mapTask(t) {
  const errs = [];
  const topic = String(t?.summary ?? '').trim();
  if (!topic) errs.push('缺主题（summary）');
  const guid = String(t?.guid ?? '').trim();
  if (!guid) errs.push('缺 guid（幂等键要用）');
  if (errs.length) return { ok: false, errors: errs };

  const payload = {
    topic,
    // ★ `detail`（任务详情）在登记契约里是**必填**，而飞书这个视图**不给描述字段**
    //   ⇒ 与钉钉那条同样的兜底写法：退回主题（钉钉在 `sourceTitle/source` 为空时也是这么做的）。
    //   **不是**编造描述，只是"没有单独详情"时的既有兜底；真给了描述就该走描述。
    detail: topic,
    due: toLocalDate(t.due_at),                 // 没有截止时间 ⇒ 不填（`inScope` 会按"算起点之后"处理）
    source: 'feishu-task',
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined || payload[k] === null) delete payload[k];

  const at = toLocalDate(t.created_at) ? Date.parse(`${toLocalDate(t.created_at)}T00:00:00`) : Date.now();
  return {
    ok: true,
    payload,
    origin: { channel: 'feishu', sender: '飞书任务', messageId: `fs-task-${guid}`, raw: String(t.url ?? topic) },
    _at: at,
    completed: t.completed === true,
  };
}

/** 跑一轮 */
export function ingestOnce({ run = defaultRun, dryRun = false, maxNew = 200 } = {}) {
  const errors = [];
  let inCount = 0; let outCount = 0; let refreshed = 0; let skipped = 0; let outOfScope = 0; let quarantined = 0;

  const listed = fetchMine({ run });
  if (listed.ok !== true) return { inCount: 0, outCount: 0, refreshed: 0, skipped: 0, outOfScope: 0, quarantined: 0, errors: [listed.why], dataAsOf: null, why: `任务列表取不到：${listed.why}` };

  const seen = loadSeen();
  const existing = new Map(store.list({ type: 'todo' }).map((e) => [e.origin?.messageId, e]));

  for (const t of listed.items) {
    inCount += 1;
    const guid = String(t?.guid ?? '');
    if (!guid) { quarantined += 1; errors.push('列表里有一条没有 guid，跳过（不猜）'); continue; }
    const mid = `fs-task-${guid}`;
    const completed = t.completed === true;
    const prev = seen[guid];
    const have = existing.get(mid);

    if (dryRun) { outCount += 1; continue; }
    if (outCount >= maxNew && !have) { errors.push(`达到上限 ${maxNew} 条，其余下一轮再来`); break; }

    const mapped = mapTask(t);
    if (mapped.ok !== true) { quarantined += 1; errors.push(`任务 ${guid} 映射失败：${mapped.errors.join('；')}`); continue; }
    const scope = inScope('todo', mapped.payload, mapped._at);
    if (!scope.inScope) {
      skipped += 1; outOfScope += 1;
      seen[guid] = { completed, outOfScope: true, why: scope.why, at: new Date().toISOString() };
      continue;
    }

    const made = makeEvent({ type: 'todo', payload: mapped.payload, origin: mapped.origin, _at: mapped._at });
    if (made.ok === false) { quarantined += 1; errors.push(`任务 ${guid} 归一失败：${made.errors.join('；')}`); continue; }
    const r = store.upsert(made.event);
    if (r.action === 'rejected') { quarantined += 1; errors.push(`任务 ${guid} 落库被拒：${r.reason}`); continue; }
    if (r.action === 'added') outCount += 1; else if (r.action === 'updated') refreshed += 1;

    // 飞书侧已完成 ⇒ 补一条带依据的 done（不新建事件）
    const id = r._id ?? made.event._id;
    if (completed) {
      const cur = store.getById('todo', id);
      if (cur && !(cur.ops ?? []).some((o) => o.op === 'done')) {
        store.patch('todo', id, {}, { op: 'done', by: 'feishu-task', evidence: `飞书任务已标记完成（completed=true，guid=${guid}）` });
      }
    }
    seen[guid] = { completed, at: new Date().toISOString() };
  }

  if (!dryRun) saveSeen(seen);
  return {
    inCount, outCount, refreshed, skipped, outOfScope, quarantined, errors,
    dataAsOf: new Date().toISOString(),
    why: `列表 ${listed.count} 条 · 新采 ${outCount} · 刷新 ${refreshed} · 跳过 ${skipped}（其中出界 ${outOfScope}） · 隔离 ${quarantined}`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（注入假 run）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const os = await import('node:os');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-fstask-'));
  process.env.WB_V1_OUT = tmp;

  const T = (guid, summary, completed = false, due = null, created = '2026-10-12T09:00:00+08:00') => ({
    guid, summary, completed, due_at: due, created_at: created,
    completed_at: completed ? '2026-10-12T10:00:00+08:00' : null,
    url: `https://applink.feishu.cn/client/todo/detail?guid=${guid}`,
  });
  const FAKE = {
    A: T('A', '把二维码重新发我'),
    B: T('B', '已经做完的任务', true),
    C: T('C', '九月的旧任务', false, '2026-09-20T00:00:00+08:00'),
  };
  const runWith = (ids) => (args) => {
    if (args[1] === '+get-my-tasks') return { ok: true, json: { ok: true, data: { items: ids.map((i) => FAKE[i]) } } };
    return { ok: false, why: '未预期参数：' + args.join(' ') };
  };

  try {
    // ① 映射
    const m = mapTask(FAKE.A);
    chk('FST-1', '★ 主题与来源进来了', m.ok === true && m.payload.topic === '把二维码重新发我' && m.payload.source === 'feishu-task', JSON.stringify(m.payload));
    chk('FST-2', '★ 没有截止时间 ⇒ **不填**（不编日期）', !('due' in m.payload), JSON.stringify(m.payload));
    chk('FST-3', '有截止时间 ⇒ 转本地日期', mapTask(FAKE.C).payload.due === '2026-09-20', String(mapTask(FAKE.C).payload.due));
    chk('FST-4', '★ 契约必填的 detail 用主题兜底（飞书不给描述，不编造）；发布人/执行人**确实拿不到 ⇒ 不填**',
      m.payload.detail === m.payload.topic && !('publisher' in m.payload) && !('executor' in m.payload), JSON.stringify(Object.keys(m.payload)));
    chk('FST-5', '幂等键 = fs-task-<guid>', m.origin.messageId === 'fs-task-A');
    chk('FST-6', '来源链接留在 origin.raw（可回查）', /applink\.feishu\.cn/.test(String(m.origin.raw)));
    chk('FST-7', '★ 负向对照：缺主题/缺 guid ⇒ 映射失败', mapTask({ guid: 'X' }).ok === false && mapTask({ summary: 'x' }).ok === false);
    chk('FST-8', '★ 完成标志用 completed（不是"有完成时间就算完"）', mapTask(FAKE.B).completed === true && mapTask(FAKE.A).completed === false);

    // ② 一轮：A/B 入流（B 顺带 done）、C 因截止早于起点出界
    const r1 = ingestOnce({ run: runWith(['A', 'B', 'C']) });
    chk('FST-9', '★ 一轮：A/B 入流、C 挡在界外', r1.inCount === 3 && r1.outCount === 2 && r1.outOfScope === 1, JSON.stringify({ in: r1.inCount, out: r1.outCount, outOfScope: r1.outOfScope }));
    const all = store.list({ type: 'todo' });
    chk('FST-10', '库里 2 条待办', all.length === 2, String(all.length));
    const b = all.find((e) => e.origin.messageId === 'fs-task-B');
    chk('FST-11', '★ 飞书侧已完成 ⇒ 落库即带 done（含依据）', (b.ops ?? []).some((o) => o.op === 'done' && /guid=B/.test(String(o.evidence))), JSON.stringify((b.ops ?? []).map((o) => o.op)));
    const a = all.find((e) => e.origin.messageId === 'fs-task-A');
    chk('FST-12', '未完成的那条不带 done（不误标）', !(a.ops ?? []).some((o) => o.op === 'done'));

    // ③ 幂等
    const r2 = ingestOnce({ run: runWith(['A', 'B', 'C']) });
    chk('FST-13', '★ 第二轮幂等：不新建、库里仍是 2 条', r2.outCount === 0 && store.list({ type: 'todo' }).length === 2, JSON.stringify({ out: r2.outCount }));

    // ④ 状态翻转：A 在飞书那边完成了 ⇒ 补 done，不新建
    const run2 = (args) => (args[1] === '+get-my-tasks'
      ? { ok: true, json: { ok: true, data: { items: [T('A', '把二维码重新发我', true), FAKE.B, FAKE.C] } } }
      : { ok: false, why: 'unexpected' });
    const r3 = ingestOnce({ run: run2 });
    const a2 = store.list({ type: 'todo' }).find((e) => e.origin.messageId === 'fs-task-A');
    chk('FST-14', '★ 状态翻转 ⇒ 刷新既有事件并补 done（不新建）', r3.outCount === 0 && (a2.ops ?? []).some((o) => o.op === 'done') && store.list({ type: 'todo' }).length === 2, JSON.stringify({ out: r3.outCount, refreshed: r3.refreshed }));

    // ⑤ 取数失败 ⇒ 如实说
    const r4 = ingestOnce({ run: () => ({ ok: false, why: 'lark-cli 报错：invalid access token' }) });
    chk('FST-15', '★ 取数失败 ⇒ 写明原因（不写成"没有任务"）', r4.errors.length === 1 && /任务列表取不到/.test(r4.why), r4.why);

    // ⑥ 干跑不写盘
    const before = store.list({ type: 'todo' }).length;
    ingestOnce({ run: runWith(['A', 'B', 'C']), dryRun: true });
    chk('FST-16', '干跑不写盘', store.list({ type: 'todo' }).length === before);
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
