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
  const written = [];
  for (const p of PAGE_DEFS) {
    const f = path.join(OUT, `${p.key}.html`);
    // api 注入 ⇒ 页面可点（详情浮层/新增）；不起服务时页面仍能静态看，只是按钮点了会报"取详情失败"
    fs.writeFileSync(f, renderPage(p.key, { switches, status, statusDetail, api }), 'utf8');
    written.push(f);
  }
  return { written, switches, switchesOk: ok, updatedAt, why: why ?? null, probes, api };
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
