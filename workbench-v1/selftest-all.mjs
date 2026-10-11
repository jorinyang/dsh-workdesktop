#!/usr/bin/env node
/**
 * v1/selftest-all.mjs —— **v1 全部套件的聚合入口**（P8 守卫迁移）
 *
 * 为什么要有它：v1 的套件分散在 collector / processor / storage / api / ui 各处，
 *   有的自带 CLI、有的只导出 `selfTest()`。若把每条都登记进 `verify-all.mjs` 的 PLAN，
 *   将来增删一条就要动两处（易漂）。⇒ 收成**一个入口**，总回归里只登记这一条。
 *
 * 输出与既有套件同一约定：末尾一行 `PASS = n   FAIL = m`；有 FAIL 则退出码 1。
 * 用法：node _meta/workbench/v1/selftest-all.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rows = [];
let pass = 0; let fail = 0;

async function run(id, label, loader) {
  // 每条套件在**自己的临时运行态**里跑，互不污染；同时也保证不碰真实数据
  const prevOut = process.env.WB_V1_OUT;
  const prevKb = process.env.WB_V1_KB_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `wb-v1-all-${id}-`));
  process.env.WB_V1_OUT = path.join(tmp, 'out');
  process.env.WB_V1_KB_ROOT = path.join(tmp, 'kb');
  try {
    const res = await loader();
    const p = res?.pass ?? 0; const f = res?.fail ?? 0;
    pass += p; fail += f;
    rows.push({ id, label, pass: p, fail: f, failed: (res?.details ?? []).filter((d) => !d.ok).map((d) => `${d.id} ${d.desc}`) });
    console.log(`  ${f === 0 ? '✓' : '✗'} ${label.padEnd(22)} PASS=${String(p).padStart(3)} FAIL=${f}`);
  } catch (e) {
    fail += 1;
    rows.push({ id, label, pass: 0, fail: 1, failed: [`抛异常：${e.message}`] });
    console.log(`  ✗ ${label.padEnd(22)} 抛异常：${e.message}`);
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    if (prevKb === undefined) delete process.env.WB_V1_KB_ROOT; else process.env.WB_V1_KB_ROOT = prevKb;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

console.log('############ 工作台 v1.0 · 全部套件 ############');
const base = new URL('.', import.meta.url).href;

await run('P0', 'P0 骨架与契约', async () => {
  // 既有入口自带 CLI（会自己 process.exit）⇒ 这里自己做同样的事：用它们的 selfTest 导出
  const mod = await import(base + 'schema.mjs');
  const store = await import(base + 'store.mjs');
  const ledger = await import(base + 'ledger.mjs');
  const pages = await import(base + 'pages.mjs');
  const s = mod.selfTest(); const st = store.selfTest(); const lg = ledger.selfTest(); const pg = pages.selfTest();
  const details = [...s.details, ...st.details, ...lg.details, ...pg.details];
  return { pass: pass_(details), fail: details.length - pass_(details), details };
});
function pass_(ds) { return ds.filter((d) => d.ok).length; }

await run('P1', 'P1 采集器', async () => (await import(base + 'collector/registry.mjs')).selfTest());
await run('P1b', 'P1 水位线', async () => (await import(base + 'collector/state.mjs')).selfTest());
await run('P1c', 'P1 模态转换', async () => (await import(base + 'collector/modality.mjs')).selfTest());
await run('P1d', 'P1 钉钉待办通路', async () => (await import(base + 'collector/dingtalk-todo.mjs')).selfTest());
await run('P1e', 'P1 钉钉日程通路', async () => (await import(base + 'collector/dingtalk-calendar.mjs')).selfTest());
await run('P1f', 'P1 飞书日程通路', async () => (await import(base + 'collector/feishu-calendar.mjs')).selfTest());
await run('P1g', 'P1 飞书任务通路', async () => (await import(base + 'collector/feishu-task.mjs')).selfTest());
await run('P1h', 'P1 iMessage 通路', async () => (await import(base + 'collector/imessage.mjs')).selfTest());
await run('P1i', 'P1 钉钉知识库通路', async () => (await import(base + 'collector/dingtalk-wiki.mjs')).selfTest());
await run('P2', 'P2 意图判定', async () => (await import(base + 'processor/intent.mjs')).selfTest());
await run('P2b', 'P2 链接队列', async () => (await import(base + 'processor/links.mjs')).selfTest());
await run('P2c', 'P2 筛选主链', async () => (await import(base + 'processor/filter.mjs')).selfTest());
await run('P2d', 'P3 召回层', async () => (await import(base + 'processor/recall.mjs')).selfTest());
await run('P3', 'P3 分析引擎', async () => (await import(base + 'processor/analyze.mjs')).selfTest());
await run('P5b', 'P5 审计与归档', async () => (await import(base + 'processor/archive.mjs')).selfTest());
await run('P5', 'P5 自动关闭', async () => (await import(base + 'processor/close.mjs')).selfTest());
await run('P6', 'P6 存储周期', async () => (await import(base + 'storage/cycles.mjs')).selfTest());
await run('P4a', 'P4 设计 token', async () => (await import(base + 'ui/tokens.mjs')).selfTest());
await run('P4b', 'P4 渲染外壳', async () => (await import(base + 'ui/shell.mjs')).selfTest());
await run('P4c', 'P4 客户端脚本', async () => (await import(base + 'ui/client.mjs')).selfTest());
await run('P4d', 'P4 页面数据接口', async () => (await import(base + 'api/pages.mjs')).selfTest());
await run('P7a', 'P7 驾驶舱数据', async () => (await import(base + 'api/cockpit.mjs')).selfTest());
await run('P7b', 'P7 驾驶舱页面', async () => (await import(base + 'ui/cockpit-page.mjs')).selfTest());
await run('API', 'P4/P5 本地接口', async () => (await import(base + 'api/server.mjs')).selfTest());

console.log('');
const bad = rows.filter((r) => r.fail > 0);
if (bad.length) {
  console.log('未通过项：');
  for (const r of bad) for (const f of r.failed) console.log(`  - [${r.id}] ${f}`);
  console.log('');
}
console.log(`PASS = ${pass}   FAIL = ${fail}`);
process.exit(fail === 0 ? 0 : 1);
