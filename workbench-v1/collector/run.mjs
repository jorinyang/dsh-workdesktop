#!/usr/bin/env node
/**
 * v1/collector/run.mjs —— **采集器调度入口**（P1-1；计划任务每 5 分钟调它）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 做什么
 *   跑一遍所有**已接线**的采集通路（Stream 跟随 + 轮询），每条记一条引擎台账；
 *   未接线的通路**如实记为 skipped 并写明 why**（不是静默不跑）。
 *
 * 为什么入口要自己记台账（而不是只靠计划任务的成功/失败）
 *   10-03 那次事故的教训：包装脚本自报 `exit=0 耗时=0s`，而真相是 node 根本没启动。
 *   ⇒ 采集器每轮都要留下**真实读数**（进了几条、出了几条、几条在排队），
 *     台账里 `0 进 0 出 + <50ms` 会被自动标 `suspicious`（见 v1/ledger.mjs）。
 *
 * 用法
 *   node _meta/workbench/v1/collector/run.mjs              # 跑一轮
 *   node _meta/workbench/v1/collector/run.mjs --dry-run    # 只读不写（不动水位线、不落库）
 *   node _meta/workbench/v1/collector/run.mjs --health     # 只报通道健康（不跑采集）
 * 输出末行：PASS = n   FAIL = m
 */

import { runEngine } from '../ledger.mjs';
import { health as registryHealth, implementedRoutes, missingRoutes, ROUTES, POLL_INTERVAL_SEC, V1_START } from './registry.mjs';
import { health as stateHealth } from './state.mjs';
import { ingestOnce, STATE_KEY } from './dingtalk-im.mjs';
import { dwsDownloadHook } from './media.mjs';
import { ingestOnce as minutesIngest } from './minutes.mjs';
import { ingestOnce as mailIngest } from './mail.mjs';
import { ingestOnce as weixinIngest } from './weixin.mjs';
import { ingestOnce as todoIngest } from './dingtalk-todo.mjs';
import { ingestOnce as calIngest } from './dingtalk-calendar.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const HEALTH_ONLY = args.includes('--health');
const sinceIdx = args.indexOf('--since');
/** 采集起点：默认 = Q18 裁定的 v1.0 起点（更早的一律跳过、只读） */
const SINCE = sinceIdx >= 0 ? args[sinceIdx + 1] : V1_START;

let pass = 0; let fail = 0;
const chk = (id, desc, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${id}  ${desc}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${id}  ${desc}${detail ? `\n        ${detail}` : ''}`); }
};

const H = registryHealth();
console.log('############ 工作台 v1.0 · 采集器 ############');
console.log(`  通路：${H.implemented}/${H.total} 已接线 · 轮询间隔 ${POLL_INTERVAL_SEC}s${DRY ? ' · **干跑**' : ''}`);
for (const b of H.byChannel) console.log(`    ${b.channel.padEnd(9)} ${b.implemented}/${b.total}${b.missing.length ? `  缺：${b.missing.join(', ')}` : ''}`);

if (HEALTH_ONLY) {
  const sh = stateHealth();
  console.log('\n  水位线（有读数的通路）：');
  for (const s of sh) console.log(`    ${s.key.padEnd(16)} runs=${s.runs} 进=${s.lastIn} 出=${s.lastOut} 错=${s.lastErrors}${s.suspicious ? ' ⚠️' : ''}`);
  console.log(`\nPASS = ${pass}   FAIL = ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

console.log('');

// ── 已接线的通路：逐条跑并记账 ────────────────────────────────────────────────
const IMPL = {
  // 四条钉钉 Stream 逻辑通路共用一个跟随器（同一文件、同一消费位置）
  'dd-im-o2o':       { engine: 'collector', fn: async () => ingestOnce({ dryRun: DRY, since: SINCE, hooks: { download: dwsDownloadHook() } }) },
  'dd-im-group':     { engine: 'collector', fn: null, shareWith: 'dd-im-o2o' },   // 与上面同一次运行
  'dd-im-at':        { engine: 'collector', fn: null, shareWith: 'dd-im-o2o' },
  'dd-im-selfvoice': { engine: 'collector', fn: null, shareWith: 'dd-im-o2o' },
  // A 类（复用现有引擎的最后一段映射）
  'dd-minutes':      { engine: 'collector', fn: async () => minutesIngest({ dryRun: DRY, since: SINCE }) },
  'dd-mail':         { engine: 'collector', fn: async () => mailIngest({ dryRun: DRY, since: SINCE }) },
  'wx-chat':         { engine: 'collector', fn: async () => weixinIngest({ dryRun: DRY, since: SINCE }) },
  // 2026-10-12 新增：钉钉待办（轮询落库，产 v1 待办事件）
  // ★ **故意不传 `since`**（与其他通路不同，这是我的判断，已向用户说明）：
  //   Q18 的采集起点是给**事件流**用的（消息/听记/邮件：历史无限、回填无意义）；
  //   而"我的待办列表"是**当前状态**（13 条，有界）——按创建时间过滤会把**今天仍然打开**的
  //   待办也挡在外面，那么待办页会一直是空的，直到将来出现新待办为止。
  //   ⇒ 待办/日程这类"状态型"通路不看创建时间；完成状态由钉钉侧 `isDone` 决定。
  'dd-todo':         { engine: 'collector', fn: async () => todoIngest({ dryRun: DRY }) },
  // 2026-10-12 新增：钉钉日程（窗口取数 → 产 v1 日程事件）。同样不传 since（日程也是"状态型"，
  //   窗口本身就把它限制在 前 30 天 ~ 后 7 天，按创建时间过滤没有意义）。
  'dd-calendar':     { engine: 'collector', fn: async () => calIngest({ dryRun: DRY }) },
};

let sharedRun = null;
let ddImRun = null;          // 钉钉 IM 那一次跟随的读数（四条逻辑通路共用）
for (const r of implementedRoutes()) {
  const spec = IMPL[r.key];
  if (!spec) { chk(`RUN-${r.key}`, `${r.label} —— 已在注册表标 implemented 但入口没实现`, false, '注册表与入口不一致（必须补上或改回 implemented:false）'); continue; }
  if (spec.fn === null) continue;                      // 共享同一次运行，稍后统一报
  const res = await runEngine(spec.engine, async () => {
    const out = await spec.fn();
    return { inCount: out.inCount, outCount: out.outCount, why: out.why ?? null, extra: { deferred: out.deferred, quarantined: out.quarantined, offset: out.offset, truncated: out.truncated, errors: out.errors } };
  });
  sharedRun = res;
  if (r.key === 'dd-im-o2o') ddImRun = res;      // ★ 只由 dd-im-o2o 决定"共享跟随"的读数（别被后续通路覆盖）
  chk(`RUN-${r.key}`, `${r.label}：进 ${res.inCount} / 出 ${res.outCount}${res.deferred ? ` / 排队 ${res.deferred}` : ''}${res.quarantined ? ` / 隔离 ${res.quarantined}` : ''}`, true, res.why ?? '');
  if (res.errors?.length) chk(`RUN-${r.key}-errors`, `${r.label}：本轮有 I/O 错误（水位线未前进）`, false, res.errors.join('；'));
}

// 共享同一次运行的其它三条逻辑通路：如实说明（不是"没跑"）
for (const r of implementedRoutes()) {
  const spec = IMPL[r.key];
  if (spec?.shareWith === 'dd-im-o2o' && ddImRun) {
    chk(`RUN-${r.key}`, `${r.label}：与 ${spec.shareWith} 共用同一次跟随（进 ${ddImRun.inCount} / 出 ${ddImRun.outCount}）`, true);
  }
}

// ── 未接线的通路：如实记 skipped + why（缺口看得见，不是静默不跑）──────────────
const miss = missingRoutes();
if (miss.length) {
  console.log(`\n  未接线 ${miss.length} 条（如实登记，不静默）：`);
  for (const m of miss) console.log(`    · ${m.label} —— ${m.why ?? '(未写明)'}`);
  const { record } = await import('../ledger.mjs');
  if (!DRY) {
    record({ engine: 'collector', status: 'skipped', ms: 0, inCount: 0, outCount: 0, why: `未接线通路 ${miss.length} 条：${miss.map((m) => m.key).join(',')}` });
  }
}

console.log(`\nPASS = ${pass}   FAIL = ${fail}`);
process.exit(fail === 0 ? 0 : 1);
