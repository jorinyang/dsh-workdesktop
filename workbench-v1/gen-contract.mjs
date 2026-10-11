#!/usr/bin/env node
/**
 * v1/gen-contract.mjs —— 页面契约**锚点生成器**（写面）
 *
 * 为什么要有写面（沿用旧 `gen-card-order.mjs` 的分工，但把锚点收敛成一份）：
 *   · `pages.mjs` = **人写的一手定义**（改页面集合/顺序只改这里）；
 *   · `contract.json` = **冻结锚点**（由本脚本 `--write` 从一手定义生成）；
 *   · 守卫（`selftest-v1.mjs` 的 PG 段）= 校验「锚点 == 一手定义」。
 *   ⇒ 只改 JSON 蒙不过校验（PG 段会红），改了定义不重算锚点也会红。
 *
 * 用法：
 *   node _meta/workbench/v1/gen-contract.mjs            # 等价 --check（只校验不写盘）
 *   node _meta/workbench/v1/gen-contract.mjs --write    # 从 pages.mjs 重算锚点
 * 输出末行：PASS = n   FAIL = m（可被 verify-all 解析）
 */

import fs from 'node:fs';
import { snapshot, loadContract, checkContract, CONTRACT_PATH } from './pages.mjs';

const args = process.argv.slice(2);
const DO_WRITE = args.includes('--write');

let pass = 0; let fail = 0;
const chk = (id, desc, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${id}  ${desc}`); }
  else { fail++; console.log(`  ✗ ${id}  ${desc}${detail ? '\n        ' + detail : ''}`); }
};

const live = snapshot();

console.log('############ v1 页面契约（写面）############');
console.log(`  锚点 : ${CONTRACT_PATH}`);
console.log(`  页面 : ${live.pages.join(' → ')}`);
console.log(`  状态栏: ${live.statusBar.join(' · ')}`);

if (DO_WRITE) {
  const prev = loadContract();
  const doc = {
    schema: live.schema,
    version: (prev?.version ?? 0) + 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    decision: prev?.decision ?? '用户 2026-10-12 需求 3.3.x + Q2（三形态）；页面集合与状态栏的唯一来源 = v1/pages.mjs',
    pages: live.pages,
    pagesSha256: live.pagesSha256,
    statusBar: live.statusBar,
    statusBarSha256: live.statusBarSha256,
    formFactors: live.formFactors,
    defaultPage: live.defaultPage,
  };
  fs.writeFileSync(CONTRACT_PATH, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`\n  已写入锚点（version ${prev?.version ?? 0} → ${doc.version}）`);
}

// 写后（或 --check）复核：锚点必须与一手定义逐项一致
const problems = checkContract();
chk('V1C-1', '★ 锚点 == 一手定义（页面顺序 / 状态栏 / 形态 / 默认页，逐项）', problems.length === 0, problems.join('\n        '));
chk('V1C-2', '锚点文件存在且可解析', !!loadContract().schema);

console.log(`\nPASS = ${pass}   FAIL = ${fail}`);
process.exit(fail === 0 ? 0 : 1);
