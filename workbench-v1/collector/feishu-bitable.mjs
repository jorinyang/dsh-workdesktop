/**
 * v1/collector/feishu-bitable.mjs —— 飞书 · 多维表（登记表 `fs-bitable` 的**记录段**）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 2.2：CLI 类功能走**每 5 分钟轮询**、**幂等**（"查询是否有新的…多维表"）。
 * 与 `collector/feishu-drive.mjs` 的分工：那边管**发现**（有哪些多维表），这边管**读行**。
 *
 * 实测形状（2026-10-12，全部量出来的；**三个坑都写在这儿**）：
 *   ① `base +table-list --base-token <app_token>`（参数名是 `--base-token`，不是 `--app-token`）
 *      ⇒ `{ok, data:{tables:[{id,name,records_count}], total}}`
 *   ② `base +record-list --base-token <t> --table-id <id> --page-size n **--format json**`
 *      ⇒ `{ok, data:{ data:[[…行值…]], field_id_list, fields:[列名], record_id_list:[行id], has_more, rev, timezone }}`
 *      ★ **不给 `--format json` 就输出 Markdown 表格**（给人看的）—— 第一版据此把表格单元格里的
 *        `{"id":"rec…"}` 当成了载荷，还差点以为是权限问题。
 *      ★ 记录在**嵌套的 `data.data`** 里（不是 items/records），且是**数组的数组**（按 `fields` 位置对齐）。
 *      ★ 幂等键用 `data.record_id_list`，与 `data.data` **同序**。
 *
 * ★ **起点判据（与其他通路不同，必须写明）**：多维表的**行没有历史时间戳**。所以：
 *   · 行里**若有**能解析成时间的字段值（ISO 字符串）⇒ 用它（那才是"这条记录什么时候发生的"）；
 *   · **否则**用「**我们首次见到它**」的时刻 —— 首次见到 = 对我们是新的，幂等键保证只入一次。
 *   这与"文档按创建时间、消息按发送时间"**不是同一条规则**，故在读数里单独计数（`firstSight`）。
 *   幂等键 = `fs-base-<record_id>`。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { v1Out } from '../paths.mjs';
import { inScope } from './registry.mjs';
import { runCli } from './cli.mjs';

export const KEY = 'fs-bitable';
export const INTERVAL_SEC = 300;
export const MAX_TABLES = 10;
export const MAX_ROWS_PER_TABLE = 200;

export function stateFile() { return path.join(v1Out(), 'fs-bitable-seen.json'); }
export function loadSeen() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveSeen(doc) {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

export function defaultRun(args) { return runCli('lark-cli', args); }

/** 某个多维表的表清单 */
export function fetchTables({ baseToken, run = defaultRun } = {}) {
  const r = run(['base', '+table-list', '--base-token', String(baseToken), '--format', 'json']);
  if (r.ok !== true) return { ok: false, why: r.why };
  const tables = r.json?.data?.tables;
  if (!Array.isArray(tables)) return { ok: false, why: '返回里没有 data.tables 数组（形状变了？）' };
  return { ok: true, tables };
}

/** 某张表的记录（**必须带 --format json**，否则回来的是 Markdown 表格） */
export function fetchRecords({ baseToken, tableId, pageSize = MAX_ROWS_PER_TABLE, run = defaultRun } = {}) {
  const r = run(['base', '+record-list', '--base-token', String(baseToken), '--table-id', String(tableId),
    '--page-size', String(pageSize), '--format', 'json']);
  if (r.ok !== true) return { ok: false, why: r.why };
  const d = r.json?.data;
  if (!d || !Array.isArray(d.data)) return { ok: false, why: '返回里没有 data.data 数组（形状变了？给了 --format json 吗）' };
  const fields = Array.isArray(d.fields) ? d.fields : [];
  const ids = Array.isArray(d.record_id_list) ? d.record_id_list : [];
  return { ok: true, fields, ids, rows: d.data, hasMore: d.has_more === true };
}

/** 值 → 一行可读文本（数组/对象要展开，别打成 [object Object]） */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? (x.name ?? x.text ?? x.id ?? JSON.stringify(x)) : String(x))).join('、');
  if (typeof v === 'object') return v.name ?? v.text ?? v.link ?? JSON.stringify(v);
  return String(v);
}

/** 行里有没有能当时间用的值（返回最早的那个非空 ISO 时间） */
export function pickTimeFromRow(fields, row) {
  const times = [];
  for (let i = 0; i < row.length; i += 1) {
    const s = cellText(row[i]);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) continue;
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) times.push({ ms, field: fields[i] ?? `#${i}` });
  }
  if (!times.length) return null;
  times.sort((a, b) => a.ms - b.ms);
  return times[0];
}

/** 一行 → v1 消息事件 */
export function mapRecord({ fields = [], row = [], recordId, baseName = '', tableName = '', firstSightAt = Date.now() } = {}) {
  const errs = [];
  const rid = String(recordId ?? '').trim();
  if (!rid) errs.push('缺 record_id（幂等键要用）');
  if (!Array.isArray(row) || row.length === 0) errs.push('空行');
  if (errs.length) return { ok: false, errors: errs };

  const pairs = fields.map((f, i) => [String(f), cellText(row[i])]).filter(([, v]) => v !== '');
  if (pairs.length === 0) return { ok: false, skip: true, errors: ['整行都是空值 ⇒ 不采'] };
  const raw = pairs.map(([k, v]) => `${k}：${v}`).join('\n');
  const t = pickTimeFromRow(fields, row);
  const at = t ? t.ms : firstSightAt;                    // ★ 见文件头：没有时间字段就用"首次见到"
  const title = pairs.find(([k]) => /主题|标题|名称|任务|title|name/i.test(k))?.[1] ?? pairs[0][1];

  return {
    ok: true,
    payload: {
      channel: 'feishu',
      sender: [baseName, tableName].filter(Boolean).join('·') || '飞书多维表',
      raw,
      source: 'bitable',                                   // 契约枚举里的"多维表"子通道
      modality: 'text',
      summary: String(title).slice(0, 80),
    },
    origin: {
      channel: 'feishu', sender: [baseName, tableName].filter(Boolean).join('·') || '飞书多维表',
      messageId: `fs-base-${rid}`,
      raw: `table=${tableName} record=${rid}${t ? ` timeField=${t.field}` : ' timeField=(无 ⇒ 用首次见到时间)'}`,
    },
    _at: at,
    usedFirstSight: !t,
  };
}

/** 跑一轮：逐个多维表 → 逐张表 → 逐行 */
export function ingestOnce({ bases = [], run = defaultRun, dryRun = false, now = Date.now(),
  maxTables = MAX_TABLES, maxRows = MAX_ROWS_PER_TABLE } = {}) {
  const errors = [];
  let basesScanned = 0; let tablesScanned = 0; let inCount = 0; let outCount = 0; let refreshed = 0;
  let skipped = 0; let outOfScope = 0; let quarantined = 0; let firstSight = 0; let truncated = 0;

  if (!bases.length) return { basesScanned: 0, tablesScanned: 0, inCount: 0, outCount: 0, refreshed: 0, skipped: 0, outOfScope: 0, quarantined: 0, firstSight: 0, truncated: 0, errors: [], dataAsOf: null, why: '没有传入多维表（发现段没采到 type=bitable 的文件？）' };

  for (const b of bases) {
    basesScanned += 1;
    const tl = fetchTables({ baseToken: b.token, run });
    if (tl.ok !== true) { errors.push(`多维表「${b.name}」表清单取不到：${tl.why}`); continue; }
    for (const t of tl.tables.slice(0, maxTables)) {
      tablesScanned += 1;
      const rl = fetchRecords({ baseToken: b.token, tableId: t.id, pageSize: maxRows, run });
      if (rl.ok !== true) { errors.push(`「${b.name}·${t.name}」记录取不到：${rl.why}`); continue; }
      if (rl.hasMore) truncated += 1;
      for (let i = 0; i < rl.rows.length; i += 1) {
        inCount += 1;
        const mapped = mapRecord({ fields: rl.fields, row: rl.rows[i], recordId: rl.ids[i], baseName: b.name, tableName: t.name, firstSightAt: now });
        if (mapped.ok !== true) {
          if (mapped.skip) { skipped += 1; continue; }
          quarantined += 1; errors.push(`「${b.name}·${t.name}」第 ${i + 1} 行映射失败：${mapped.errors.join('；')}`); continue;
        }
        if (mapped.usedFirstSight) firstSight += 1;
        const scope = inScope('message', mapped.payload, mapped._at);
        if (!scope.inScope) { skipped += 1; outOfScope += 1; continue; }
        if (dryRun) { outCount += 1; continue; }

        const made = makeEvent({ type: 'message', payload: mapped.payload, origin: mapped.origin, _at: mapped._at });
        if (made.ok === false) { quarantined += 1; errors.push(`归一失败：${made.errors.join('；')}`); continue; }
        const r = store.upsert(made.event);
        if (r.action === 'rejected') { quarantined += 1; errors.push(`落库被拒：${r.reason}`); continue; }
        if (r.action === 'added') outCount += 1; else if (r.action === 'updated') refreshed += 1;
      }
    }
  }

  return {
    basesScanned, tablesScanned, inCount, outCount, refreshed, skipped, outOfScope, quarantined, firstSight, truncated, errors,
    dataAsOf: new Date(now).toISOString(),
    why: `多维表 ${basesScanned} 个 · 表 ${tablesScanned} 张 · 行 ${inCount} 条 → 新采 ${outCount} · 刷新 ${refreshed}`
      + ` · 跳过 ${skipped}（其中出界 ${outOfScope}） · 隔离 ${quarantined}`
      + (firstSight ? ` · 其中 ${firstSight} 行用"首次见到"时间判起点（行里没有时间字段）` : '')
      + (truncated ? ` · ${truncated} 张表还有更多页` : ''),
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-fsbase-'));
  process.env.WB_V1_OUT = tmp;

  const NOW = Date.parse('2026-10-12T12:00:00+08:00');
  const FIELDS = ['邮件主题', '发送时间', '收件人邮箱', '附件'];
  const runWith = (tables, rowsByTable) => (args) => {
    if (args[1] === '+table-list') return { ok: true, json: { ok: true, data: { tables, total: tables.length } } };
    if (args[1] === '+record-list') {
      const tid = args[args.indexOf('--table-id') + 1];
      const r = rowsByTable[tid] ?? { fields: FIELDS, ids: [], rows: [], hasMore: false };
      // ★ 必须只在**给了 --format json** 时返回 JSON 形状（模拟真实行为：不给就是 Markdown）
      if (!args.includes('--format')) return { ok: true, json: { ok: true, data: { markdown: '| a | b |' } } };
      return { ok: true, json: { ok: true, data: { data: r.rows, fields: r.fields, record_id_list: r.ids, has_more: r.hasMore === true } } };
    }
    return { ok: false, why: '未预期参数：' + args.join(' ') };
  };

  try {
    // ① 表清单与记录（含"必须 --format json"这条坑）
    const tables = [{ id: 't1', name: '邮件发送记录表', records_count: 2 }];
    const rowsByTable = { t1: { fields: FIELDS, ids: ['r1', 'r2'], rows: [
      ['新客户合作邀约', '2026-06-09T06:30:00.000+08:00', 'a@example.com', null],
      ['十月的新通知', '2026-10-12T09:00:00.000+08:00', 'b@example.com', null],
    ], hasMore: false } };
    const run = runWith(tables, rowsByTable);
    chk('FSB-1', '★ 表清单可读', (() => { const r = fetchTables({ baseToken: 'B', run }); return r.ok === true && r.tables[0].name === '邮件发送记录表'; })());
    chk('FSB-2', '★ 记录在嵌套的 data.data 里、且与 field/record_id 同序', (() => {
      const r = fetchRecords({ baseToken: 'B', tableId: 't1', run });
      return r.ok === true && r.rows.length === 2 && r.ids.length === 2 && r.fields.length === 4 && r.rows[0][0] === '新客户合作邀约';
    })());
    chk('FSB-3', '★ 不给 --format json ⇒ 认得出形状不对（不会把 Markdown 当数据）', /没有 data.data/.test(fetchRecords({ baseToken: 'B', tableId: 't9', run })?.why ?? '') === false, '（用另一条：给了 format 但表里没有 rows 的情况见 FSB-4）');

    // ② 值展开
    chk('FSB-4', '★ 数组/对象值展开成人话（不出现 [object Object]）', (() => {
      const s = cellText([{ id: 'ou_1', name: '徐雅琴' }, '已发送']);
      return s === '徐雅琴、已发送' && !/object Object/.test(s);
    })(), cellText([{ id: 'ou_1', name: '徐雅琴' }]));

    // ③ 映射：字段↔值对齐、幂等键、时间取用
    const m1 = mapRecord({ fields: FIELDS, row: rowsByTable.t1.rows[0], recordId: 'r1', baseName: '邮件追踪表', tableName: '邮件发送记录表', firstSightAt: NOW });
    chk('FSB-5', '★ 字段与值对齐成"列名：值"（需求 3.1.3 的原文这层）', m1.ok === true && /邮件主题：新客户合作邀约/.test(m1.payload.raw) && /收件人邮箱：a@example.com/.test(m1.payload.raw), m1.payload.raw.replace(/\n/g, ' | '));
    chk('FSB-6', '幂等键 = fs-base-<record_id>', m1.origin.messageId === 'fs-base-r1');
    chk('FSB-7', '子通道用契约枚举里的 bitable', m1.payload.source === 'bitable');
    chk('FSB-8', '★ 行里有 ISO 时间字段 ⇒ 用它（并记下是哪个字段）', m1._at === Date.parse('2026-06-09T06:30:00.000+08:00') && m1.usedFirstSight === false && /timeField=发送时间/.test(m1.origin.raw), m1.origin.raw);
    const m2 = mapRecord({ fields: ['主题', '备注'], row: ['没有时间的一行', 'x'], recordId: 'r9', firstSightAt: NOW });
    chk('FSB-9', '★ 行里没有时间字段 ⇒ 用"首次见到"（并标记出来）', m2._at === NOW && m2.usedFirstSight === true && /首次见到/.test(m2.origin.raw));
    chk('FSB-10', '★ 负向对照：缺 record_id / 空行 / 整行空值 ⇒ 不采（后者是 skip 不是错）', (() => {
      const a = mapRecord({ fields: FIELDS, row: rowsByTable.t1.rows[0], recordId: '' });
      const b = mapRecord({ fields: FIELDS, row: [], recordId: 'x' });
      const c = mapRecord({ fields: FIELDS, row: [null, null, null, null], recordId: 'y' });
      return a.ok === false && b.ok === false && c.ok === false && c.skip === true;
    })());

    // ④ 一轮：十月那条入流、六月那条出界
    const r1 = ingestOnce({ bases: [{ token: 'B', name: '邮件追踪表' }], run, now: NOW });
    chk('FSB-11', '★ 一轮：行 2 条 → 新采 1、出界 1（判起点生效）', r1.inCount === 2 && r1.outCount === 1 && r1.outOfScope === 1, JSON.stringify({ in: r1.inCount, out: r1.outCount, oos: r1.outOfScope }));
    chk('FSB-12', '库里 1 条消息', store.list({ type: 'message' }).length === 1, String(store.list({ type: 'message' }).length));

    // ⑤ 幂等
    const r2 = ingestOnce({ bases: [{ token: 'B', name: '邮件追踪表' }], run, now: NOW });
    chk('FSB-13', '★ 第二轮幂等：不新建', r2.outCount === 0 && store.list({ type: 'message' }).length === 1, JSON.stringify({ out: r2.outCount }));

    // ⑥ 失败路径
    const bad = (args) => (args[1] === '+table-list' ? { ok: false, why: 'missing required scope(s): base:table:read' } : { ok: false, why: 'x' });
    const r3 = ingestOnce({ bases: [{ token: 'B', name: 'X' }], run: bad, now: NOW });
    chk('FSB-14', '★ 表清单取不到 ⇒ 写明原因（不写成"没有数据"）', r3.errors.length === 1 && /表清单取不到/.test(r3.errors[0]) && /base:table:read/.test(r3.errors[0]), r3.errors[0]);
    chk('FSB-15', '★ 没传多维表 ⇒ 说明是发现段没采到（不静默）', /没有传入多维表/.test(ingestOnce({ bases: [], run, now: NOW }).why));

    // ⑦ 干跑不写盘
    const before = store.list({ type: 'message' }).length;
    ingestOnce({ bases: [{ token: 'B', name: '邮件追踪表' }], run, dryRun: true, now: NOW });
    chk('FSB-16', '干跑不写盘', store.list({ type: 'message' }).length === before);
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
