#!/usr/bin/env node
/**
 * v1/processor/selftest-processor.mjs —— **P2 筛选引擎验收套件**（离线 · 用临时知识库根，不碰真库）
 *
 * 覆盖：INT 段（意图判定，Q6）· FLT 段（筛选主链：双写 / 转笔记 / 命令打标 / 幂等 / 干跑 / 台账）
 * 用法：node _meta/workbench/v1/processor/selftest-processor.mjs
 * 末行：PASS = n   FAIL = m
 */

import * as filter from './filter.mjs';

let pass = 0; let fail = 0;
const res = await filter.selfTest();

console.log('############ 工作台 v1.0 · P2 筛选引擎自检 ############\n');
console.log('── INT/FLT · 意图判定 + 筛选主链 ──');
for (const d of res.details) {
  if (d.ok) pass++; else fail++;
  console.log(`  ${d.ok ? '✓' : '✗'} ${String(d.id).padEnd(9)} ${d.desc}${!d.ok && d.detail ? `\n        ${d.detail}` : ''}`);
}
console.log('');
console.log('############ 合计 ############');
console.log(`PASS = ${pass}   FAIL = ${fail}`);
if (fail) {
  console.log('\n未通过项：');
  for (const d of res.details.filter((x) => !x.ok)) console.log(`  - ${d.id} ${d.desc}${d.detail ? ` — ${d.detail}` : ''}`);
}
process.exit(fail === 0 ? 0 : 1);
