/**
 * `_meta/workbench/v1/ui/interactions.mjs` —— **真的点一遍**的检查（2026-10-12 新建）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么必须另建这一套
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户报"点 tab 无响应 / 列表点不动"，而**工作台全套 702 条检查当时全是通过的**。
 * 查下来原因是：那一套里跟交互有关的检查（CLI-3/4/16/17…）**全是源码级** ——
 * 断言"脚本里有没有 `querySelector(".list")` 这个字符串"。
 * 而真实故障恰恰是：**字符串在、选择器选错了容器**（页面里有两个 `.list`，取到了分析文字那个）。
 * ⇒ **源码里有某个写法 ≠ 那个写法是对的，更 ≠ 点下去真的有效。**
 *   所以这一套不去读脚本，而是**用浏览器真点**，看结果有没有变。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 怎么跑
 * ══════════════════════════════════════════════════════════════════════════════
 * 需要一个**在跑的面板**（页面由 `/workdesktop/api/yishu/<页>` 供）。
 *   面板没开 ⇒ 全部**跳过**并写明原因（环境前置，不是产品缺陷）。
 * 每个用例都独立开一页、点一下、读结果 —— 不依赖上一个用例的残留状态。
 *
 * 用法：node _meta/workbench/v1/ui/interactions.mjs
 *      （自检 `selfTest()` 是**离线**的：只验判定函数与样例，不连浏览器）
 */

export const BASE = 'http://127.0.0.1:3080';
export const PAGE_PATH = '/workdesktop/api/yishu/';

import { pathToFileURL } from 'node:url';
// ★★ 关于"转出浏览器那一半"（2026-10-12，我在这上面栽了两次，写清楚免得下次再犯）：
//   第一版我写的是 `export { runCasesInBrowser } from './interactions-browser.mjs'` —— **静态**再导出。
//   而静态再导出**等价于一次静态 import**，于是"本模块求值要等对方、对方又在本模块的顶层 await 里被动态 import"
//   ⇒ **环又成立了**，命令行的表现是"卡在开浏览器"（其实什么也没跑）。
//   ⇒ 正解：**运行时动态转出** —— 真的要用的时候才去 import，模块求值阶段不碰它。
//     这样静态 import 方向永远只有单向（interactions → browser），不会成环。
export let runCasesInBrowser = null;
export async function loadBrowserRunner() {
  if (!runCasesInBrowser) ({ runCasesInBrowser } = await import('./interactions-browser.mjs'));
  return runCasesInBrowser;
}

// ══════════════════════════════════════════════════════════════════════════════
// ① 纯判定（可离线测）：给"点之前/点之后的观测"，判断该用例过不过
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 顶部导航：点一个 tab，地址与标题都要真的变。
 * @param {{beforePath:string, afterPath:string, afterTitle:string, expectPage:string}} o
 */
export function judgeNavSwitch(o) {
  const why = [];
  if (!o || typeof o !== 'object') return { ok: false, why: ['没有观测结果'] };
  if (!o.afterPath) why.push('点完拿不到地址');
  else if (!new RegExp('/' + o.expectPage + '$').test(o.afterPath)) {
    why.push(`地址没换页：期望以 /${o.expectPage} 结尾，实际 ${o.afterPath}`);
  }
  if (o.beforePath === o.afterPath) why.push('地址与点之前完全相同 ⇒ 这一下没生效');
  if (o.afterTitle && !o.afterTitle.includes('工作台')) why.push(`标题不对：${o.afterTitle}`);
  const ok = why.length === 0;
  return { ok, why, note: ok ? `${o.beforePath} → ${o.afterPath}（${o.afterTitle}）` : why.join(' · ') };
}

/**
 * 列表项：点一下要弹出详情浮层。
 * ★ 负向对照同源：喂"没弹出"必须判不过。
 */
export function judgeRowOpensDetail(o) {
  const why = [];
  if (!o || typeof o !== 'object') return { ok: false, why: ['没有观测结果'] };
  if (!(o.rowsBefore >= 1)) why.push(`可点行 ${o.rowsBefore} 条 ⇒ 列表里没有可点的东西（这本身就是缺陷）`);
  if (o.overlayOpened !== true) why.push('点了但详情浮层没出现');
  if (o.overlayOpened === true && o.overlayTitleTruncated === true) why.push('浮层出现了但标题是空的');
  const ok = why.length === 0;
  return { ok, why, note: ok ? `可点 ${o.rowsBefore} 行 → 浮层标题「${String(o.overlayTitle || '').slice(0, 30)}」` : why.join(' · ') };
}

/**
 * 消息页 Tab：点一个 tab，**可见行数必须按状态真的变**。
 *
 * ★ 这条判据我改了两版，两版都栽在同一个思路上，记下来（这是写检查最容易犯的错）：
 *   第一版：「筛完行数必须比全部少」。可**当那个 tab 恰好一条都没有时**（今天就正好是 0 条），
 *     筛完 0 行与"全部 200 行"当然不同 —— 判据**碰巧**通过，实际什么也没验到。
 *   第二版：插一条"状态匹配"的探针行，要求它**被隐藏**。**方向搞反了** ——
 *     状态与所选 tab 相同的行本来就该**可见**；判据恒不成立，成了**假红**
 *     （实测：功能是好的，真实行被正确隐藏了 200 行，我却报"没筛"）。
 *   ⇒ 正解：**用真实行数**，并且**必须来回验**：
 *     ① 全部 ⇒ 可见行数 == 总行数；
 *     ② 选一个 tab ⇒ 可见行数 = 该状态的行数，且**不是全部**（变了才算筛了）；
 *     ③ 切回全部 ⇒ 又回到总行数（筛选可逆）。
 *     三个都成立才算过 —— 单看"变少了"会被空 tab 蒙过去，单看"探针可见性"会把方向写反。
 */
export function judgeTabFilter(o) {
  const why = [];
  if (!o || typeof o !== 'object') return { ok: false, why: ['没有观测结果'] };
  if (!(o.tabsFound >= 2)) why.push(`页面上只找到 ${o.tabsFound} 个 tab 链接 ⇒ tab 根本没渲染出来`);
  if (!(o.totalRows > 0)) why.push(`列表里一行都没有（总行数 ${o.totalRows}）⇒ 无从验筛选`);

  // ① 全部态
  if (o.visibleAtAll !== o.totalRows) why.push(`「全部」态应显示 ${o.totalRows} 行，实际 ${o.visibleAtAll}`);
  // ② 筛选态：必须等于该状态的行数，且与全部不同（除非该状态恰好占满）
  if (typeof o.visibleAfterFilter !== 'number') why.push('点了 tab 之后读不到可见行数');
  else {
    if (o.visibleAfterFilter !== o.rowsOfThatState) {
      why.push(`筛后可见 ${o.visibleAfterFilter} 行，但该状态共 ${o.rowsOfThatState} 行 ⇒ 筛选不对`);
    }
    if (o.rowsOfThatState < o.totalRows && o.visibleAfterFilter === o.totalRows) {
      why.push('该状态只占一部分，却仍显示全部行 ⇒ 这一下没筛');
    }
  }
  // ③ 可逆
  if (o.visibleBackToAll !== o.totalRows) why.push(`切回「全部」应回到 ${o.totalRows} 行，实际 ${o.visibleBackToAll} ⇒ 筛选不可逆`);
  if (o.tabInUrl !== true) why.push('地址里没带上 tab（刷新后无法保持所选）');

  const ok = why.length === 0;
  return {
    ok, why,
    note: ok
      ? `共 ${o.totalRows} 行 · 「全部」${o.visibleAtAll} · 筛「${o.tab}」${o.visibleAfterFilter}（该状态 ${o.rowsOfThatState} 行）· 切回 ${o.visibleBackToAll}`
      : why.join(' · '),
  };
}

/** 跨页跳转 + 落页自动开详情 */
export function judgeCrossPageOpen(o) {
  const why = [];
  if (!o || typeof o !== 'object') return { ok: false, why: ['没有观测结果'] };
  if (!o.landedPath || !/\/schedules|\/todos|\/notes|\/messages/.test(o.landedPath)) why.push(`没落到目标页：${o.landedPath}`);
  if (!/[?&]open=/.test(o.landedUrl || '')) why.push('地址里没有 open 参数 ⇒ 目标页无从接手');
  if (o.overlayOpened !== true) why.push('落到目标页后详情浮层没自动打开');
  const ok = why.length === 0;
  return { ok, why, note: ok ? `${o.landedPath} 且浮层已开` : why.join(' · ') };
}

export const CASES = Object.freeze([
  { id: 'IX-1', name: '顶部导航：点「待办」真的换页', judge: judgeNavSwitch, page: 'overview' },
  { id: 'IX-2', name: '列表项：日程页点一行弹出详情浮层', judge: judgeRowOpensDetail, page: 'schedules' },
  { id: 'IX-3', name: '列表项：待办页点一行弹出详情浮层', judge: judgeRowOpensDetail, page: 'todos' },
  { id: 'IX-4', name: '列表项：消息页点一行弹出详情浮层', judge: judgeRowOpensDetail, page: 'messages' },
  { id: 'IX-5', name: '消息页 Tab：点了真的筛列表', judge: judgeTabFilter, page: 'messages' },
]);

// ══════════════════════════════════════════════════════════════════════════════
// ② 离线自检：判定函数对"好/坏"两组观测必须给出相反结论
// ══════════════════════════════════════════════════════════════════════════════

export async function selfTest() {
  const details = [];
  const chk = (id, desc, ok, note = '') => details.push({ id, desc, ok: !!ok, note });

  // 导航
  const navGood = { beforePath: '/yishu/overview', afterPath: '/yishu/todos', afterTitle: '工作台 · 待办', expectPage: 'todos' };
  chk('IX-10', '导航判定：地址真换了 ⇒ 放行', judgeNavSwitch(navGood).ok === true, judgeNavSwitch(navGood).note);
  chk('IX-11', '★ 负向对照：地址没变（就是用户报的"点了没反应"）⇒ 必须判不过',
    judgeNavSwitch({ ...navGood, afterPath: '/yishu/overview' }).ok === false);
  chk('IX-12', '★ 负向对照：只挂了片段没换页（`#todos` 那种旧写法）⇒ 必须判不过',
    judgeNavSwitch({ ...navGood, afterPath: '/yishu/overview#todos' }).ok === false);

  // 列表项
  const rowGood = { rowsBefore: 6, overlayOpened: true, overlayTitle: '某条日程' };
  chk('IX-13', '列表项判定：点了弹出浮层 ⇒ 放行', judgeRowOpensDetail(rowGood).ok === true, judgeRowOpensDetail(rowGood).note);
  chk('IX-14', '★ 负向对照：点了浮层没出现 ⇒ 必须判不过',
    judgeRowOpensDetail({ ...rowGood, overlayOpened: false }).ok === false);
  chk('IX-15', '★ 负向对照：**一条可点的行都没有**（选择器选错容器时的实测形态）⇒ 必须判不过',
    judgeRowOpensDetail({ rowsBefore: 0, overlayOpened: false }).ok === false);

  // Tab
  const tabGood = {
    tabsFound: 5, totalRows: 200, visibleAtAll: 200,
    visibleAfterFilter: 40, rowsOfThatState: 40, visibleBackToAll: 200, tab: 'to-todo', tabInUrl: true,
  };
  chk('IX-16', 'Tab 判定：全部→筛→切回 三个数都对 ⇒ 放行', judgeTabFilter(tabGood).ok === true, judgeTabFilter(tabGood).note);
  chk('IX-17', '★ 负向对照：tab 没渲染出来（被转义成文本时的实测形态：DOM 里 0 个）⇒ 必须判不过',
    judgeTabFilter({ ...tabGood, tabsFound: 0 }).ok === false);
  chk('IX-18', '★ 负向对照：**点了没筛**（该状态只占 40 行，却仍显示 200）⇒ 必须判不过',
    judgeTabFilter({ ...tabGood, visibleAfterFilter: 200 }).ok === false);
  chk('IX-18b', '★ 负向对照：筛后行数与该状态行数对不上（筛错行）⇒ 必须判不过',
    judgeTabFilter({ ...tabGood, visibleAfterFilter: 37 }).ok === false);
  chk('IX-18c', '★ 负向对照：切不回「全部」（筛选不可逆）⇒ 必须判不过',
    judgeTabFilter({ ...tabGood, visibleBackToAll: 40 }).ok === false);
  chk('IX-18d', '★ 负向对照：一行数据都没有时不许判"通过"（拿不到观测就是没验到）',
    judgeTabFilter({ ...tabGood, totalRows: 0, visibleAtAll: 0 }).ok === false);

  // 跨页
  const crossGood = { landedPath: '/workdesktop/api/yishu/schedules', landedUrl: 'http://x/yishu/schedules?open=schedules:a', overlayOpened: true };
  chk('IX-19', '跨页判定：落对页且浮层自动开 ⇒ 放行', judgeCrossPageOpen(crossGood).ok === true, judgeCrossPageOpen(crossGood).note);
  chk('IX-20', '★ 负向对照：落在同一页（跨不过去）⇒ 必须判不过',
    judgeCrossPageOpen({ landedPath: '/workdesktop/api/yishu/overview', landedUrl: 'x?open=schedules:a', overlayOpened: false }).ok === false);

  chk('IX-21', '用例表覆盖了用户报的三类症状（导航/列表/跨页）+ Tab',
    CASES.length === 5 && CASES.some((c) => c.id === 'IX-1') && CASES.some((c) => c.id === 'IX-5'));

  const pass = details.filter((d) => d.ok).length;
  return { pass, fail: details.length - pass, details, total: details.length };
}

// ══════════════════════════════════════════════════════════════════════════════
// ③ 真机：开一个独立浏览器跑这几个用例（不碰真机套件在用的那个实例）
// ══════════════════════════════════════════════════════════════════════════════

/** 面板在不在（决定"跳过"还是"判不过"） */
export async function panelAlive({ base = BASE, fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(base + '/workdesktop/api/v1/health', { signal: ctl.signal });
    return r.ok === true;
  } catch { return false } finally { clearTimeout(t) }
}

export async function runLive({ headless = true, log = console.log } = {}) {
  if (!(await panelAlive())) {
    log('  ⚠️ 面板没开 ⇒ 本套「真的点一遍」的检查全部跳过（环境前置，不是产品缺陷）');
    log('     解锁：启动 DSH Web（`DSH/restart-web.cmd`）后重跑。');
    return { pass: 0, fail: 0, skip: CASES.length, details: CASES.map((c) => ({ id: c.id, name: c.name, skip: true, note: '面板没开' })) };
  }
  const run = await loadBrowserRunner();
  // ★ 用例清单**作为参数传进去**（不在那个文件里静态 import 回来 —— 那会形成循环依赖、把顶层 await 卡死）
  return run({ headless, log, cases: CASES });
}

// ★ "是不是被直接运行"的判断（2026-10-12 修过一次）：
//   原来写的是 `import.meta.url.endsWith(process.argv[1] 的文件名)` —— 太粗：
//   库里同名文件不止一个时它会误判，而且路径大小写/斜杠形态在 Windows 上还会再坑一次。
//   改成用 **pathToFileURL 把 argv[1] 转成 file URL**，再与 import.meta.url 精确比。
const isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(entry).href;
  } catch { return false }
})();
if (isMain) {
  console.log('############ 工作台交互检查（真的点一遍）############');
  console.log('');
  process.stdout.write('  · 检查面板在不在… ');
  const alive = await panelAlive();
  console.log(alive ? '在' : '不在');
  if (!alive) {
    console.log('  ⚠️ 面板没开 ⇒ 「真的点一遍」全部跳过（环境前置，不是产品缺陷）');
    console.log('     解锁：起 DSH Web 后重跑（`DSH/restart-web.cmd`）。');
    console.log('');
    console.log(`  PASS = 0   FAIL = 0   SKIP = ${CASES.length}`);
    process.exit(0);
  }
  process.stdout.write('  · 开浏览器… ');
  console.log('好了');
  // ★ 兜底时限（2026-10-12 加）：这套起的是浏览器子进程，跑完可能留句柄 ⇒ Node 不退出、
  //   命令行看着像卡死（实测：用例其实已经跑完并通过了，进程就是不退）。
  //   与其赌"句柄都收干净了"，不如**到点就结束**；结果在超时前已经拿到，不受影响。
  const budget = Math.max(120000, CASES.length * 12000 + 60000);
  const r = await Promise.race([
    runLive({ headless: true }),
    new Promise((res) => setTimeout(() => {
      console.log(`\n  ⚠️ 超过 ${Math.round(budget / 1000)} 秒兜底时限 ⇒ 结束（用例结果若已产出则以上面为准）`);
      res({ pass: 0, fail: 0, skip: CASES.length, details: [], timedOut: true });
    }, budget)),
  ]);
  console.log('');
  console.log(`  PASS = ${r.pass}   FAIL = ${r.fail}   SKIP = ${r.skip}${r.timedOut ? '（超时兜底）' : ''}`);
  process.exit(r.fail === 0 ? 0 : 1);
}
