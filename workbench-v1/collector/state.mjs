/**
 * v1/collector/state.mjs —— **采集水位线 / 偏移量**（P1-8 幂等的持久层）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 幂等靠两道保险（缺一不可）
 *   ① **本层（水位线）**：记住"每条通路读到哪儿了" —— 下次从这儿接着读，不重扫。
 *   ② **事件层（originKey）**：同一条消息（同 messageId）只落一条事件 —— 挡住重放与重复投递。
 *   ⇒ 只有 ① 会漏（偏移丢了就重放）；只有 ② 会重（每次都全量扫，白花时间）。两个都要。
 *
 * ★ 铁律：**有错就绝不前进**（沿用现有 `minutes-sync.mjs` 的实测经验）
 *   如果这一轮有错或被上限截断还把水位线推到底，那些**没处理成功的条目会被永久跳过** ——
 *   这是"静默丢数据"，比重复处理严重得多。故 `advanceIfClean()` 只在
 *   `errors.length === 0 && !truncated` 时才移动水位线；否则如实记录本轮读数并**原地不动**。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function stateDir() {
  return process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1');
}
export function statePath() {
  return path.join(stateDir(), 'watermarks.json');
}

const EMPTY = () => ({ schema: 'workbench-v1-watermarks/1', updatedAt: null, channels: {} });

export function readAll() {
  const p = statePath();
  if (!fs.existsSync(p)) return EMPTY();
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!d || typeof d !== 'object' || typeof d.channels !== 'object') return EMPTY();
    return { ...EMPTY(), ...d };
  } catch {
    return EMPTY();   // 坏了就当空 —— 代价是重放一轮（事件层幂等兜得住），不会丢数据
  }
}

export function writeAll(doc) {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = { ...doc, schema: 'workbench-v1-watermarks/1', updatedAt: new Date().toISOString() };
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return body;
}

export function get(key) {
  return readAll().channels[key] ?? null;
}

/**
 * 记一轮读数；**只有干净的一轮才推进水位线**。
 * @param {string} key 通道 key（registry 里的）
 * @param {{offset?:number, dataAsOf?:string, inCount?:number, outCount?:number, errors?:string[], truncated?:boolean, extra?:object}} r
 * @returns {{advanced:boolean, why:string, entry:object}}
 */
export function advanceIfClean(key, r = {}) {
  const doc = readAll();
  const prev = doc.channels[key] ?? { offset: 0, dataAsOf: null, runs: 0 };
  const errors = Array.isArray(r.errors) ? r.errors : [];
  const clean = errors.length === 0 && r.truncated !== true;

  const entry = {
    ...prev,
    runs: (prev.runs ?? 0) + 1,
    errorRuns: (prev.errorRuns ?? 0) + (errors.length > 0 ? 1 : 0),   // 累计"带错轮数"：间歇性出错也不至于看不见
    lastAt: new Date().toISOString(),
    lastIn: Number(r.inCount) || 0,
    lastOut: Number(r.outCount) || 0,
    lastErrors: errors.length,
    offset: clean && Number.isFinite(r.offset) ? r.offset : prev.offset,           // 不干净就原地不动
    dataAsOf: clean && r.dataAsOf ? r.dataAsOf : prev.dataAsOf,
    extra: r.extra ?? prev.extra ?? null,
  };
  doc.channels[key] = entry;
  writeAll(doc);

  const why = clean
    ? (Number.isFinite(r.offset) && r.offset !== prev.offset ? `水位线 ${prev.offset} → ${r.offset}` : '水位线未变（无新内容）')
    : `**水位线原地不动**（errors=${errors.length} truncated=${r.truncated === true}）⇒ 未处理成功的条目下轮重试`;
  return { advanced: clean, why, entry };
}

/** 采集健康（驾驶舱/前端底栏读）：每条通路上次读了什么、有没有连续出错 */
export function health() {
  const doc = readAll();
  return Object.entries(doc.channels).map(([key, v]) => ({
    key, runs: v.runs ?? 0, lastAt: v.lastAt ?? null, lastIn: v.lastIn ?? 0, lastOut: v.lastOut ?? 0,
    lastErrors: v.lastErrors ?? 0, errorRuns: v.errorRuns ?? 0, dataAsOf: v.dataAsOf ?? null,
    // 连续出错容易被忽略 ⇒ 显式标出来
    suspicious: (v.lastErrors ?? 0) > 0,
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（临时目录，不碰真实状态）
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prev = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-wm-'));
  process.env.WB_V1_OUT = tmp;
  try {
    // ① 干净的一轮 ⇒ 推进
    const a = advanceIfClean('t-clean', { offset: 100, inCount: 3, outCount: 3, dataAsOf: '2026-10-12T00:00:00+08:00' });
    chk('WM-1', '干净的一轮 ⇒ 水位线推进', a.advanced === true && get('t-clean').offset === 100, a.why);
    chk('WM-2', 'dataAsOf 被记录', get('t-clean').dataAsOf === '2026-10-12T00:00:00+08:00');

    // ② 有错 ⇒ 绝不推进（这是"防静默丢数据"的核心）
    const b = advanceIfClean('t-clean', { offset: 999, inCount: 5, outCount: 2, errors: ['第 3 条解析失败'] });
    chk('WM-3', '★ 有错 ⇒ 水位线原地不动（offset 仍 100）', b.advanced === false && get('t-clean').offset === 100, b.why);
    chk('WM-4', '有错也如实记录本轮读数（lastIn/lastOut/lastErrors）', get('t-clean').lastIn === 5 && get('t-clean').lastOut === 2 && get('t-clean').lastErrors === 1);

    // ③ 被截断 ⇒ 也不推进（沿用 minutes-sync 的经验）
    const c = advanceIfClean('t-clean', { offset: 2000, inCount: 999, outCount: 999, truncated: true });
    chk('WM-5', '★ 被上限截断 ⇒ 不推进（下轮接着读）', c.advanced === false && get('t-clean').offset === 100, c.why);

    // ④ runs 累加
    chk('WM-6', 'runs 每轮累加', get('t-clean').runs === 3, String(get('t-clean').runs));

    // ⑤ 原子写：无残留 tmp
    chk('WM-7', '无残留 .tmp（原子写）', fs.readdirSync(tmp).filter((f) => f.includes('.tmp-')).length === 0);

    // ⑥ 再来一轮带错的：health 必须把"最近一轮有错"标出来
    advanceIfClean('t-clean', { offset: 3000, inCount: 1, outCount: 0, errors: ['模拟 I/O 失败'] });
    chk('WM-8', '★ health 把"最近一轮有错"的通路标 suspicious（不会因后续干净轮次而洗白）', health().some((h) => h.key === 't-clean' && h.suspicious === true), JSON.stringify(health().find((h) => h.key === 't-clean')));
    chk('WM-9', 'errorRuns 累计带错轮数（间歇性出错也看得见）', get('t-clean').errorRuns === 2, String(get('t-clean').errorRuns));
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
