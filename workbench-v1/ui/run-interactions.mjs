/**
 * `run-interactions.mjs` —— 「真的点一遍」的**命令行入口**（2026-10-12）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么入口要单独一个文件（我在这上面栽了四轮，写清楚免得下次再犯）
 * ══════════════════════════════════════════════════════════════════════════════
 * 原设计是 `interactions.mjs` 既当**判定库**、又当**命令行入口**（末尾一个 `isMain` 分支跑顶层 await），
 * 而那一段要动态 import `interactions-browser.mjs`；后者又需要前者里的常量与用例清单。
 * 于是无论我把那个 import 写成静态、静态再导出、还是运行时动态转出，**环一直在**：
 *
 *   · 静态 import 回常量 → 环（**连常量都不行**）
 *   · `export { … } from` 静态再导出 → 那等价于静态 import，环照旧
 *   · 运行时 `await import()` → 若父模块仍在顶层 await 中，导入一样要等它求值完 → 环
 *
 * 命令行表现全都一样：**卡在"开浏览器…"那一步，其实什么也没跑**，Node 只给一句
 * `unsettled top-level await`，很难看出是模块图的问题。
 *
 * ⇒ 正解是**换形状**，不是接着调 import 写法：
 *     这个入口文件**只做编排**（静态 import 两个库，然后在函数里调它们），
 *     `interactions.mjs` 不再自己当入口 —— 于是模块图是一条直线，没有环：
 *
 *        run-interactions.mjs  →  interactions.mjs
 *                              ↘  interactions-browser.mjs   （用到时才动态取）
 *
 * 用法：node _meta/workbench/v1/ui/run-interactions.mjs
 */
import { CASES, panelAlive } from './interactions.mjs';
import { loadBrowserRunner } from './interactions.mjs';

console.log('############ 工作台交互检查（真的点一遍）############');
console.log('');

process.stdout.write('  · 检查面板在不在… ');
const alive = await panelAlive();
console.log(alive ? '在' : '不在');

if (!alive) {
  // 面板没开 ⇒ 跳过（环境前置，不是产品缺陷）。本项目反复强调：这两件事不能互相冒充。
  console.log('  ⚠️ 面板没开 ⇒ 「真的点一遍」全部跳过（环境前置，不是产品缺陷）');
  console.log('     解锁：起 DSH Web 后重跑（`DSH/restart-web.cmd`）。');
  console.log('');
  console.log(`  PASS = 0   FAIL = 0   SKIP = ${CASES.length}`);
  process.exit(0);
}

process.stdout.write('  · 开浏览器… ');
const run = await loadBrowserRunner();
console.log('好了');
console.log('');

// ★ 兜底时限：这套起浏览器子进程，跑完可能留句柄 ⇒ Node 不退出、命令行看着像卡死
//   （实测过：用例其实已经跑完并通过了，进程就是不退）。与其赌"句柄都收干净了"，不如**到点就结束**；
//   结果在超时前已经写进 details，不受影响。
const budgetMs = Math.max(120000, CASES.length * 15000 + 60000);
let done = false;
const timer = setTimeout(() => {
  if (!done) {
    console.log(`\n  ⚠️ 超过 ${Math.round(budgetMs / 1000)} 秒兜底时限 ⇒ 结束（已产出的用例结果见上）`);
    process.exit(0);
  }
}, budgetMs);
const r = await run({ log: console.log, cases: CASES });
done = true;
clearTimeout(timer);

console.log('');
console.log(`  PASS = ${r.pass}   FAIL = ${r.fail}   SKIP = ${r.skip}`);
process.exit(r.fail === 0 ? 0 : 1);
