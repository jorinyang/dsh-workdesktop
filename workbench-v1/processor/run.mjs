#!/usr/bin/env node
/**
 * v1/processor/run.mjs —— **筛选引擎调度入口**（被 5 分钟 tick 调用）
 *
 * 为什么单独一个入口而不是塞进采集器：采集与筛选是**两个引擎**，各自记账（台账里 engine 不同），
 * 出问题时能一眼看出是"没采到"还是"筛不动"。
 *
 * 用法：node _meta/workbench/v1/processor/run.mjs [--dry-run]
 * 末行：PASS = n   FAIL = m
 */

import { runFilter } from './filter.mjs';

const DRY = process.argv.includes('--dry-run');

let pass = 0; let fail = 0;
const chk = (id, desc, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${id}  ${desc}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${id}  ${desc}${detail ? `\n        ${detail}` : ''}`); }
};

console.log(`############ 工作台 v1.0 · 筛选引擎${DRY ? '（干跑）' : ''} ############`);

const r = await runFilter({ dryRun: DRY });
// ★★ 2026-10-14 修（**这里原来是句自认**）：
//   原文写的是「提示：当前入口的干跑开关尚未接线（本轮按真跑执行）—— 如实标注，不假装已干跑」。
//   **"如实标注"在这里是不够的** —— `--dry-run` 这个参数的存在本身就会让人以为安全，
//   而实际是一次真写库（打标 + 双写）。真正该做的是**把它接上**，不是标注它没接。
//   ⇒ `DRY` 现在一路传到 `runFilter({dryRun})` → `runFilterOnce({dryRun})`，
//     且干跑时**不触发分析**（分析会写 context 并调模型，干跑里做那两件事就白干了）。
//   下面这两行是**回执**：让跑的人当场看到"这次到底写没写"。
if (DRY) console.log('  干跑：只读统计 —— 不打标、不双写、不触发分析、不调模型');

chk('FLT-RUN-1', '本轮读数', true, `进 ${r.inCount} / 出 ${r.outCount} / 转笔记 ${r.toNote} / 转命令 ${r.toCommand} / 双写 ${r.kbWritten}${r.why ? ` · ${r.why}` : ''}`);
if (r.errors?.length) chk('FLT-RUN-2', '本轮有错误（未打标，下轮重试）', false, r.errors.join('；'));
else chk('FLT-RUN-2', '无错误', true);

console.log(`\nPASS = ${pass}   FAIL = ${fail}`);
process.exit(fail === 0 ? 0 : 1);
