#!/usr/bin/env node
/**
 * v1/ui/preview.mjs —— 渲染工作台预览页到 `Other/data/workbench-v1/`（P4 手工查看用）
 *
 * 为什么不直接用命令行内联脚本：Windows 下 PowerShell 会吃掉内联脚本里的引号与括号
 * （实测：正则里的 `( off)?` 被当成命令执行）。落到文件里就没有这层转义问题。
 *
 * 用法：node _meta/workbench/v1/ui/preview.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath , pathToFileURL } from 'node:url';
import { renderPage, PAGE_DEFS, SWITCHES, STATUS_ITEMS } from './shell.mjs';
import { probeAll } from './probes.mjs';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'Other', 'data', 'workbench-v1');

/** 读真实开关状态（单一来源：system-switches.json；开关名 = 能力名，不做映射改名） */
export function readSwitches() {
  const f = path.join(ROOT, '_meta', 'out', 'system-switches.json');
  const out = {};
  try {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const [k, v] of Object.entries(doc.capabilities ?? {})) out[k] = v.enabled === true;
    return { ok: true, switches: out, updatedAt: doc.updated_at ?? null };
  } catch (e) {
    return { ok: false, switches: out, why: `开关文件读不到：${e.message}` };
  }
}

/** 四个系统状态：走真实探针（三态：true/false/null=未探明） */
export function readStatus() { return {}; }

// ★ 接口基址用**相对路径**（2026-10-12 改）：页面既要能由 v1 自己的独立服务提供，
//   也要能被 DSH 插件 host 内嵌（`/workdesktop/api/yishu/<页>`）。
//   写死 `http://127.0.0.1:8791/...` 时，嵌进面板后会去调 8791 —— 只有那个独立服务在跑才出数据。
//   相对路径两种场景都对：独立服务下同源、插件下由 host 透传到 v1 处理器。
export async function renderAll({ api = '/workdesktop/api/v1' } = {}) {
  const { ok, switches, updatedAt, why } = readSwitches();
  // 真实探针：灯亮必须有依据（探测失败 ⇒ null ⇒ 灰灯 + 说明，不假装）
  const probes = await probeAll();
  const status = {};
  const statusDetail = {};
  for (const [k, v] of Object.entries(probes)) { status[k] = v.ok; statusDetail[k] = String(v.detail ?? '') }
  fs.mkdirSync(OUT, { recursive: true });
  // ★★ 2026-10-14 加：**把会话数据喂给消息页**。
  //   原来 `renderAll` 一个 `snap` 都不喂 ⇒ 静态页的消息列表**永远是空的**
  //   （页面渲染时 `snap.messages` 拿不到就回落到内存里的空聚合）。
  //   实测：面板里看到的是"消息列表 · 暂无"，而库里明明有几百条 —— 看着像没数据。
  //   ⇒ 这里读一次会话聚合交给渲染层。**只喂消息页**（另外三页的静态渲染本来就有数据路径）。
  let messagesSnap = null;
  // ★★ 2026-10-21 改：消息页已升级为**事件页**，快照改喂事件聚合。
  //   `pageMessages`（旧的会话列表渲染器）保留不动，但不再是 `messages` 这个 key 的渲染器。
  //   ⚠️ 快照仍要放在 `snap` 这一层（`renderPage` 读的是 `opt.snap.events`）——
  //     第一版曾把快照传成 `opt.messages`（外面少包一层）⇒ 页面显示"暂无"、而统计卡有数，自相矛盾。
  let eventsSnap = null;
  try {
    const ev = await import('../processor/events.mjs');
    // ★★ 2026-10-21 改：**把最近几天一起渲染进静态页**，端上按天显隐。
    //   为什么：页面是服务端渲染好的静态文件，`?day=` 不会让它重渲染（点了没反应）。
    //   代价：页面变大、渲染变慢。所以**限 5 天**，且每天只取前 40 件（一般一天不到 30 件）。
    const DAYS = 5;
    const recent = ev.recentDays({ limit: DAYS });
    const days = recent.map((d) => {
      const r = ev.buildEvents({ day: d, limit: 40 });
      return { day: r.day, events: r.events, counts: r.counts, why: r.why, clustered: r.clustered };
    });
    // 今天的数字卡要用它；`days[0]` 不一定就是今天（今天可能一条会话都没有），所以单独取
    const today = ev.buildEvents({ day: null, limit: 40 });
    eventsSnap = { events: today.events, counts: today.counts, day: today.day, why: today.why, clustered: today.clustered, days };
  } catch (e) {
    console.log(`注意：事件聚合读不到（事件页将为空）：${String(e && e.message).slice(0, 120)}`);
  }
  // 旧的会话快照仍算一份：`/pages/messages` 那条路由还在（回退用），页面也能随时切回旧渲染器
  try {
    const { conversations } = await import('../processor/conversations.mjs');
    const cv = conversations({ tab: 'all' });
    // 形状与接口一致（`pageMessages` 认 `counts` / `list`）
    messagesSnap = { counts: cv.counts, list: cv.list, tab: cv.tab, view: 'conversations' };
  } catch (e) {
    console.log(`注意：会话聚合读不到（回退渲染器将为空）：${String(e && e.message).slice(0, 120)}`);
  }
  const written = [];
  for (const p of PAGE_DEFS) {
    const f = path.join(OUT, `${p.key}.html`);
    // api 注入 ⇒ 页面可点（详情浮层/新增）；不起服务时页面仍能静态看，只是按钮点了会报"取详情失败"
    // ⚠️ 快照要放在 **`snap` 这一层**（`renderPage` 读的是 `opt.snap.*`）。
    //   第一版我传成了 `opt.messages`（外面少包一层）⇒ 渲染层取不到 ⇒ 消息页显示"暂无"，
    //   而统计卡却是有数的（那条路走的是另一份数据）—— **页面自相矛盾**，正是这次要修的那类。
    //   ★ 2026-10-21：`messages` 这个 key 现在渲染的是**事件页**，所以喂事件快照；
    //     会话快照一并带上（旧渲染器若被切回来仍能用）。
    //     ⚠️ `days` 要放在 **snap 顶层** —— `pageEvents` 读 `snap.days` 画日期切换条，
    //       塞进 `snap.events` 里面它读不到（那样的表现是"日期条消失"，不报错，很难发现）。
    const snap = p.key === 'messages' && eventsSnap
      ? { events: eventsSnap, days: eventsSnap.days, messages: messagesSnap }
      : undefined;
    fs.writeFileSync(f, renderPage(p.key, { switches, status, statusDetail, api, snap }), 'utf8');
    written.push(f);
  }
  return { written, switches, switchesOk: ok, updatedAt, why: why ?? null, probes, api, conversations: messagesSnap?.counts ?? null, events: eventsSnap?.counts ?? null };
}

const __isMain = (() => { try { const entry = process.argv[1]; return !!entry && import.meta.url === pathToFileURL(entry).href } catch { return false } })();
if (__isMain) {
  const r = await renderAll();
  console.log(`已渲染 ${r.written.length} 页 → ${path.relative(ROOT, OUT)}`);
  console.log(`开关（真实来源${r.switchesOk ? '' : '读取失败'}${r.updatedAt ? ` · ${r.updatedAt}` : ''}）：` + SWITCHES.map((s) => `${s.label}=${r.switches[s.key] === true ? '开' : r.switches[s.key] === false ? '关' : '未知'}`).join('  '));
  console.log('系统状态（真实探针）：');
  for (const it of STATUS_ITEMS) {
    const p = r.probes[it.key];
    const s = p && p.ok === true ? '正常' : p && p.ok === false ? '不可用' : '未探明';
    console.log(`  ${it.label.padEnd(5)} ${s.padEnd(4)} — ${p ? p.detail : '(无探针)'}`);
  }
  if (r.why) console.log('注意：' + r.why);
}
