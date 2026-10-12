/**
 * `interactions-browser.mjs` —— 「真的点一遍」的浏览器那一半（CDP，零依赖）。
 * 判定逻辑在 `interactions.mjs`（纯函数、可离线测）；**这里只管开页面、点、读观测**。
 *
 * 为什么分两个文件：这个项目反复栽在"取数和判定混在一起"上 ——
 * 取数失败被当成判定失败（或反过来被静默吞掉）。分开之后，"面板没开"和"点了没反应"是两句不同的话。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// ★★ 2026-10-12 修（**我自己造的循环依赖，害我查了四轮**）：
//   原来这里有 `import { BASE, PAGE_PATH, CASES } from './interactions.mjs'`，
//   而 `interactions.mjs` 又在**顶层 await** 里动态 import 本文件
//   ⇒ 模块图成环：本文件求值要等 `interactions.mjs` 求值完，
//     而它正卡在顶层 await 上等本文件 ⇒ **死锁**。Node 只给一句很难懂的
//     `unsettled top-level await` 就退了，看起来像"卡在开浏览器"。
//   ★ 关键点是：**连常量都不行** —— 哪怕是 `BASE` 这种纯字符串，只要**静态 import** 存在，
//     这个环就成立。所以这里**一个都不 import**：需要的值由调用方**作为参数**传进来。
//     （第一版我只把 `CASES` 改成参数、留着 `BASE/PAGE_PATH` 的静态 import，照样死锁。）
export const DEFAULT_BASE = 'http://127.0.0.1:3080';
export const DEFAULT_PAGE_PATH = '/workdesktop/api/yishu/';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/** 极简 CDP 客户端 */
async function withBrowser(port, fn, { base = DEFAULT_BASE, pagePath = DEFAULT_PAGE_PATH } = {}) {
  const exe = findChrome();
  if (!exe) throw new Error('找不到 Chrome/Edge');
  const dir = path.join(os.tmpdir(), 'dsh-ix-' + Date.now());
  const proc = spawn(exe, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  try {
    let list = null;
    for (let i = 0; i < 40; i += 1) {
      try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break } catch { await sleep(500) }
    }
    if (!list) throw new Error('CDP 没起来');
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r });
    let id = 0; const pending = new Map(); const errs = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); return }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        const t = String(m.params.entry.text);
        if (!/favicon/.test(t)) errs.push(t.slice(0, 120));
      }
      if (m.method === 'Runtime.exceptionThrown') errs.push('[异常] ' + String(m.params.exceptionDetails.exception?.description ?? '').slice(0, 160));
    };
    const send = (method, params = {}) => { const x = { id: ++id, method, params }; ws.send(JSON.stringify(x)); return new Promise((r) => pending.set(x.id, r)) };
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r.exceptionDetails ? undefined : r.result?.value;
    };
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
    const goto = async (p) => { await send('Page.navigate', { url: base + pagePath + p }); await sleep(3200) };
    try {
      return await fn({ ev, goto, errs });
    } finally {
      // ★ 2026-10-12 修（**跑完不退出**）：这个函数本身是对的（实测用例能过），
      //   但跑完进程挂着不退 —— WebSocket 与浏览器进程的句柄没释放干净。
      //   ⇒ 三件事都做：摘掉 onmessage、关掉 ws、结束浏览器进程。
      //     （不这么做时 CLI 会一直挂着，看起来像"卡住"，实际活已经干完了。）
      try { ws.onmessage = null } catch { /* ignore */ }
      try { ws.close() } catch { /* ignore */ }
    }
  } finally {
    try { proc.kill('SIGKILL') } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/**
 * ★ 总时限（2026-10-12 加）：这套会起浏览器子进程，跑完即便清理过，也可能留着一两个句柄
 *   ⇒ Node 不退出、命令行**看着像卡死**（实测过：明明用例已经跑完并通过，进程就是不退）。
 *   与其指望"把每一个句柄都收干净"（那件事很容易漏一处、而且每加一个 CDP 调用就多一处风险），
 *   不如给它一个**兜底时限**：到点就结束。
 *   时限算法：用例数 × 单例预算（导航 3.2s + 点击等待 2.2s + 余量）≈ 12s/例，再加 60s 余量。
 *   超时只影响"还挂着的进程"，**不影响已经跑出来的结果**（结果在超时前就写进 details 了）。
 */
const budgetMs = (n) => Math.max(120000, n * 12000 + 60000);

export async function runCasesInBrowser({ log = console.log, cases = null, base = DEFAULT_BASE, pagePath = DEFAULT_PAGE_PATH } = {}) {
  // `cases` 由调用方传（见文件头注释：不在这里静态引用，避免循环依赖死锁）
  const CASES = cases && cases.length ? cases : [];
  if (!CASES.length) { log('  （没有传入用例清单）'); return { pass: 0, fail: 0, skip: 0, details: [] } }
  const details = []; let pass = 0; let fail = 0;
  await withBrowser(9350, async ({ ev, goto, errs }) => {    for (const c of CASES) {
      let obs = null;
      try {
        if (c.id === 'IX-1') {
          await goto('overview');
          const before = await ev('location.pathname');
          await ev(`(function(){var a=Array.from(document.querySelectorAll("header a")).find(function(x){return /待办/.test(x.textContent||"")}); if(!a) return "no-link"; a.click(); return "ok"})()`);
          await sleep(2600);
          obs = { beforePath: before, afterPath: await ev('location.pathname'), afterTitle: await ev('document.title'), expectPage: 'todos' };
          // 这一例要的判定是 judgeNavSwitch，直接在这里调
          const { judgeNavSwitch } = await import('./interactions.mjs');
          const v = judgeNavSwitch(obs);
          v.ok ? pass++ : fail++;
          details.push({ id: c.id, name: c.name, ok: v.ok, note: v.note });
          log(`  [${v.ok ? 'PASS' : 'FAIL'}] ${c.id}  ${c.name}`);
          log(`         ${v.note}`);
          continue;
        }
        if (c.id === 'IX-5') {
          await goto('messages');
          const visExpr = 'Array.from(document.querySelectorAll(".jl-list li")).filter(function(li){return li.style.display!=="none"}).length';
          const tabsFound = await ev('document.querySelectorAll("[data-tab]").length');
          const totalRows = await ev('document.querySelectorAll(".jl-list li").length');
          const visibleAtAll = await ev(visExpr);
          // 挑一个**有行**的状态来筛（拿空 tab 去验，判据会被"0 行"蒙过去）
          const pick = await ev(`(function(){
            var c = {};
            document.querySelectorAll(".jl-list li[data-state]").forEach(function(li){ var s=li.getAttribute("data-state"); c[s]=(c[s]||0)+1 });
            var keys = Object.keys(c);
            if (!keys.length) return null;
            keys.sort(function(a,b){ return c[b]-c[a] });
            return JSON.stringify({ tab: keys[0], count: c[keys[0]] });
          })()`);
          const chosen = pick ? JSON.parse(pick) : { tab: 'pending', count: 0 };
          await ev(`(function(){var a=document.querySelector('[data-tab="${chosen.tab}"]'); if(a) a.click(); return "ok"})()`);
          await sleep(900);
          const visibleAfterFilter = await ev(visExpr);
          const tabInUrl = new RegExp('tab=' + chosen.tab).test(String(await ev('location.search')));
          await ev(`(function(){var a=document.querySelector('[data-tab="all"]'); if(a) a.click(); return "ok"})()`);
          await sleep(700);
          const visibleBackToAll = await ev(visExpr);
          obs = {
            tabsFound, totalRows, visibleAtAll, tab: chosen.tab,
            rowsOfThatState: chosen.count, visibleAfterFilter, visibleBackToAll, tabInUrl,
          };
          const { judgeTabFilter } = await import('./interactions.mjs');
          const v = judgeTabFilter(obs);
          v.ok ? pass++ : fail++;
          details.push({ id: c.id, name: c.name, ok: v.ok, note: v.note });
          log(`  [${v.ok ? 'PASS' : 'FAIL'}] ${c.id}  ${c.name}`);
          log(`         ${v.note}`);
          continue;
        }
        // IX-2/3/4：点一行看浮层
        const p = c.page;
        await goto(p);
        const rowsBefore = await ev('document.querySelectorAll(".jl-list li[data-id]").length');
        await ev('(function(){var e=document.querySelector(".jl-list li[data-id]"); if(!e) return "no-row"; e.click(); return "ok"})()');
        await sleep(2200);
        obs = {
          rowsBefore,
          overlayOpened: await ev('!!document.querySelector(".overlay-back")'),
          overlayTitle: await ev('(document.querySelector(".overlay h2")||{}).textContent'),
          overlayTitleTruncated: !String(await ev('(document.querySelector(".overlay h2")||{}).textContent') || '').trim(),
        };
        const { judgeRowOpensDetail } = await import('./interactions.mjs');
        const v = judgeRowOpensDetail(obs);
        v.ok ? pass++ : fail++;
        details.push({ id: c.id, name: c.name, ok: v.ok, note: v.note });
        log(`  [${v.ok ? 'PASS' : 'FAIL'}] ${c.id}  ${c.name}`);
        log(`         ${v.note}`);
      } catch (e) {
        fail++;
        details.push({ id: c.id, name: c.name, ok: false, note: '执行出错：' + (e && e.message ? e.message : String(e)) });
        log(`  [FAIL] ${c.id}  ${c.name}`);
        log(`         执行出错：${e && e.message ? e.message : e}`);
      }
    }
    if (errs.length) log(`\n  页面报错 ${errs.length} 条：${errs.slice(0, 3).join(' | ')}`);
    else log('\n  页面报错：无');
  }, { base, pagePath });
  return { pass, fail, skip: 0, details };
}
