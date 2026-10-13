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
// 跨组织白名单群（API 拉取型）——与上面那条 Stream 通路是两回事，见 registry.mjs `dd-cross-org` 的说明
import { ingestOnce as crossOrgIngest } from './dingtalk-cross-org.mjs';
import { dwsDownloadHook } from './media.mjs';
import { ingestOnce as minutesIngest } from './minutes.mjs';
import { ingestOnce as mailIngest } from './mail.mjs';
import { ingestOnce as weixinIngest } from './weixin.mjs';
import { ingestOnce as todoIngest } from './dingtalk-todo.mjs';
import { ingestOnce as calIngest } from './dingtalk-calendar.mjs';
import { ingestOnce as fsCalIngest } from './feishu-calendar.mjs';
import { ingestOnce as fsTaskIngest } from './feishu-task.mjs';
import { ingestOnce as imIngest } from './imessage.mjs';
import { ingestOnce as kbIngest } from './dingtalk-wiki.mjs';
import { ingestOnce as fsMinIngest } from './feishu-minutes.mjs';
import { ingestOnce as fsBaseIngest } from './feishu-bitable.mjs';
import { ingestOnce as fsEvtIngest } from './feishu-events.mjs';
import { ingestOnce as fsDriveIngest, listAll as fsDriveListAll, fetchBodiesOnce as fsDriveBodies } from './feishu-drive.mjs';

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
  // ★ 2026-10-13 加（用户裁定）：**跨组织白名单群的全量**。
  //   单独一条、不共用上面的跟随器 —— 它走的是 **API 拉取**（`dws chat +chat-messages`），
  //   与 Stream 那条完全不同的路：跨组织群的事件不会推过来，只能主动去拉。
  //   前提是跨组织读取授权在；不在时这一步报 `CrossOrgPermissionDenied`（**如实报错，不静默空转**）。
  'dd-cross-org':    { engine: 'collector', fn: async () => crossOrgIngest({ since: SINCE ?? '2026-10-12 00:00:00' }) },
  // 2026-10-12 新增：飞书聊天实时（Stream 长链接）。**一条事件流同时含单聊与群聊** ⇒ 两条登记共用一次读取。
  // 事件由常驻消费者 `collector/feishu-events.mjs` 写进 NDJSON，本步只读文件（与钉钉那条同款做法）。
  'fs-im-group':     { engine: 'collector', fn: async () => fsEvtIngest({ dryRun: DRY }) },
  'fs-im-p2p':       { engine: 'collector', fn: null, shareWith: 'fs-im-group' },
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
  // 2026-10-12 新增：飞书日程（窗口取数 → 产 v1 日程事件）。同样不传 since（状态型，窗口本身有界）。
  'fs-calendar':     { engine: 'collector', fn: async () => fsCalIngest({ dryRun: DRY }) },
  // 2026-10-12 新增：飞书任务（分派给我的 → 产 v1 待办事件）。同样是"状态型"，不传 since。
  'fs-task':         { engine: 'collector', fn: async () => fsTaskIngest({ dryRun: DRY }) },
  // 2026-10-12 新增：iMessage / 短信（读库内 digest → 产 v1 消息事件）。
  // ★ **故意不传 `since`**：它内部已按统一判据 `inScope('message', …)` 按**发送时间**判起点
  //   （与其他事件流同一条规则）。传 `since` 反而是冗余参数 —— 而本模块并不收它，
  //   传了会被**静默忽略**，那正是"参数被悄悄无视"的坏味道（本轮差点就这么写下去）。
  'im-imessage':     { engine: 'collector', fn: async () => imIngest({ dryRun: DRY }) },
  // 2026-10-12 新增：钉钉知识库（库清单 → 各库动态 → 去重 → 产 v1 消息事件，子通道 doc）。
  // 同样不传 since：内部按统一判据按**文档创建时间**判起点。
  'dd-kb':           { engine: 'collector', fn: async () => kbIngest({ dryRun: DRY }) },
  // 2026-10-12 新增：飞书云文档（原始 API 列文件；同时是 fs-bitable 的"发现段"）。
  // 不传 since：内部按统一判据按**创建时间**判起点（注意源字段是秒，已在映射里 ×1000）。
  // ★ 同一轮里**顺带抓正文**（需求 3.1.1/3.1.2 要的是内容）：按 revision_id 缓存，不重复抓。
  'fs-doc':          { engine: 'collector', fn: async () => {
    const r = fsDriveIngest({ dryRun: DRY });
    const ld = fsDriveListAll({});
    if (ld.ok === true) {
      const b = fsDriveBodies({ files: ld.files, dryRun: DRY });
      r.bodyFetch = b.why;
      if (b.errors?.length) r.errors = [...(r.errors ?? []), ...b.errors];
    } else {
      r.bodyFetch = `正文抓取跳过（列表取不到：${ld.why}）`;
    }
    return r;
  } },
  // 2026-10-12 新增：飞书妙记（按笔记入流；权限由用户 2026-10-12 授权后解锁）。不传 since：内部按开始时间判起点。
  'fs-minutes':      { engine: 'collector', fn: async () => fsMinIngest({ dryRun: DRY }) },
  // 2026-10-12 新增：飞书多维表**记录段**。**发现段复用 fs-doc 的原始 API 列表**（type=bitable 的 token 即 base token），
  // 本步只管读行。起点判据与其他通路不同：行里有 ISO 时间字段就用它，没有就用"首次见到"（见模块头说明）。
  'fs-bitable':      { engine: 'collector', fn: async () => {
    const ld = fsDriveListAll({});                       // 复用发现段：列出云文档
    if (ld.ok !== true) return { why: `多维表发现段取不到：${ld.why}`, errors: [ld.why] };
    const bases = ld.files.filter((f) => String(f?.type) === 'bitable').map((f) => ({ token: f.token, name: f.name }));
    return fsBaseIngest({ bases, dryRun: DRY });
  } },
};

let sharedRun = null;
let ddImRun = null;          // 钉钉 IM 那一次跟随的读数（四条逻辑通路共用）
let fsImRun = null;          // 飞书聊天那一次读取的读数（单聊/群聊两条共用）
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
  if (r.key === 'fs-im-group') fsImRun = res;    // ★ 飞书聊天：由 fs-im-group 决定，单聊那条共用
  chk(`RUN-${r.key}`, `${r.label}：进 ${res.inCount} / 出 ${res.outCount}${res.deferred ? ` / 排队 ${res.deferred}` : ''}${res.quarantined ? ` / 隔离 ${res.quarantined}` : ''}`, true, res.why ?? '');
  if (res.errors?.length) chk(`RUN-${r.key}-errors`, `${r.label}：本轮有 I/O 错误（水位线未前进）`, false, res.errors.join('；'));
}

// 共享同一次运行的其它逻辑通路：如实说明（不是"没跑"）
for (const r of implementedRoutes()) {
  const spec = IMPL[r.key];
  if (spec?.shareWith === 'dd-im-o2o' && ddImRun) {
    chk(`RUN-${r.key}`, `${r.label}：与 ${spec.shareWith} 共用同一次跟随（进 ${ddImRun.inCount} / 出 ${ddImRun.outCount}）`, true);
  }
  if (spec?.shareWith === 'fs-im-group' && fsImRun) {
    chk(`RUN-${r.key}`, `${r.label}：与 ${spec.shareWith} 共用同一条事件流（进 ${fsImRun.inCount} / 出 ${fsImRun.outCount}）`, true);
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
