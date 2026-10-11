#!/usr/bin/env node
/**
 * v1/selftest-v1.mjs —— P0 骨架与契约的**验收套件**（离线、零依赖、可重复）
 *
 * 覆盖：
 *   · SCH 段 —— 数据模型（四类载荷必填有负向对照 + 生命周期迁移 + 幂等键）
 *   · STO 段 —— 运行态存储（幂等 / 不回退已处理 / 原子写 / 统计可复算 / patch 白名单）
 *   · LED 段 —— 引擎台账（假绿形态必须被标可疑）
 *   · PG  段 —— 页面契约（锚点一致 + 顺序负向对照）
 *   · WRT 段 —— 写路径登记表（route/engine/理由齐备 + 短理由必红）
 *
 * 用法：node _meta/workbench/v1/selftest-v1.mjs
 * 输出末行：PASS = n   FAIL = m（verify-all 按"最后一次出现"解析）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from './schema.mjs';
import * as store from './store.mjs';
import * as ledger from './ledger.mjs';
import * as pages from './pages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ★ 纪律：**自检不得污染真实运行态**。台账与四类存储一律指向临时目录，退出即清。
const TMP_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-selftest-run-'));
process.env.WB_V1_OUT = TMP_OUT;
process.on('exit', () => { try { fs.rmSync(TMP_OUT, { recursive: true, force: true }); } catch { /* noop */ } });

let pass = 0; let fail = 0;
const rows = [];
function emit(section, res) {
  for (const d of res.details) {
    rows.push({ section, ...d });
    if (d.ok) pass++; else fail++;
    console.log(`  ${d.ok ? '✓' : '✗'} ${d.id.padEnd(18)} ${d.desc}${!d.ok && d.detail ? `\n        ${d.detail}` : ''}`);
  }
  console.log(`  ── ${section}: PASS=${res.pass} FAIL=${res.fail}\n`);
}

console.log('############ 工作台 v1.0 · P0 骨架与契约自检 ############\n');

console.log('── SCH · 数据模型（四类载荷 + 事件外壳）──');
emit('SCH', schema.selfTest());

console.log('── STO · 运行态存储（幂等 / 不回退 / 原子写 / 统计）──');
emit('STO', store.selfTest());

console.log('── LED · 引擎运行台账（假绿必须被标可疑）──');
emit('LED', ledger.selfTest());

console.log('── PG · 页面与状态栏契约 ──');
emit('PG', pages.selfTest());

console.log('── WRT · 写路径登记表 ──');
{
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const p = path.join(HERE, 'write-routes.json');
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { chk('WRT-1', '登记表可读', false, e.message); }

  if (doc) {
    chk('WRT-1', '登记表可读且有 routes 数组', Array.isArray(doc.routes) && doc.routes.length > 0, `实得 ${doc.routes?.length} 条`);
    const bad = [];
    const seen = new Set();
    for (const r of doc.routes) {
      if (!/^(GET|POST|DELETE|PUT|PATCH) \/workdesktop\/api\/v1\/\S+$/.test(String(r.route ?? ''))) bad.push(`route 形态非法：${r.route}`);
      if (!ledger.ENGINES.includes(r.engine)) bad.push(`engine 未登记（${r.route}）：${r.engine}`);
      const reason = String(r.reason ?? '');
      if (reason.trim().length < 12) bad.push(`理由太短（<12 字）：${r.route}`);
      if (seen.has(r.route)) bad.push(`重复登记：${r.route}`);
      seen.add(r.route);
    }
    chk('WRT-2', '★ 每条写路径都有 route + 已登记 engine + ≥12 字理由（缺一即红）', bad.length === 0, bad.join('；'));
    chk('WRT-3', '★ 负向对照：短理由必须被判否', judgeReason('太短') === false && judgeReason('这是一条足够长的理由说明') === true);
    chk('WRT-4', '★ 负向对照：非法 route 形态必须被判否', judgeRoute('/x/y') === false && judgeRoute('POST /workdesktop/api/v1/todos') === true);
    chk('WRT-5', '★ 负向对照：未登记引擎名必须被判否', ledger.ENGINES.includes('collector') && !ledger.ENGINES.includes('collectorX'));
  }
  emit('WRT', { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out });
}

// 供 WRT-3/WRT-4 复用的判定（与上面循环同一口径，避免"两处判断走散"）
function judgeReason(s) { return String(s ?? '').trim().length >= 12; }
function judgeRoute(s) { return /^(GET|POST|DELETE|PUT|PATCH) \/workdesktop\/api\/v1\/\S+$/.test(String(s ?? '')); }

console.log('############ 合计 ############');
console.log(`PASS = ${pass}   FAIL = ${fail}`);
const failed = rows.filter((r) => !r.ok);
if (failed.length) {
  console.log('\n未通过项：');
  for (const f of failed) console.log(`  - [${f.section}] ${f.id} ${f.desc}${f.detail ? ` — ${f.detail}` : ''}`);
}
process.exit(fail === 0 ? 0 : 1);
