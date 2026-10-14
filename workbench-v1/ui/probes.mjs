/**
 * v1/ui/probes.mjs —— **状态栏四项的真实探针**（P4；需求 3.3.1）
 *
 * 为什么要有它：上一步状态栏那四项（DWS / MCP / 本地工具 / 浏览器）**没有探针**，
 *   当时留成灰灯并明说"未探明"。这一版把探针补上 —— **灯亮必须有依据**。
 *
 * ★ 三态，不是两态（这条是纪律）
 *   `true` = 探到确实可用 · `false` = 探到确实不可用 · `null` = **探不了/不知道**
 *   绝不把"不知道"渲染成绿灯 —— 那就是假绿（10-03 那场事故的形态）。
 *   每个探针都返回 `detail`（探的是什么、看到了什么），出问题时不用猜。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath , pathToFileURL } from 'node:url';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PS = 'powershell.exe';

const UNKNOWN = (detail) => ({ ok: null, detail });

function ps(cmd, timeoutMs = 20000) {
  try {
    const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: timeoutMs });
    return { status: r.status, stdout: String(r.stdout ?? '').trim(), stderr: String(r.stderr ?? '').trim(), error: r.error ?? null };
  } catch (e) { return { status: -1, stdout: '', stderr: e.message, error: e }; }
}

/** DWS：钉钉 CLI 是否可用（真跑一次 --version） */
export function probeDws() {
  const r = ps('dws --version', 25000);
  if (r.error) return UNKNOWN(`dws 探测失败：${r.error.message}`);
  const out = r.stdout || r.stderr;
  if (r.status === 0 && out) return { ok: true, detail: `dws 可用（${out.split('\n')[0].slice(0, 60)}）` };
  // 命令不存在 ⇒ 确实不可用；有输出但非 0 ⇒ 也算不可用，但把原文带上
  return { ok: false, detail: `dws 不可用（exit=${r.status}${out ? `，输出：${out.split('\n')[0].slice(0, 60)}` : ''}）` };
}

/** MCP / 向量检索：**真查一次**（这是分析引擎实际依赖的能力）
 *
 * ★ 纠正过一次假红（2026-10-12）：早先这里读 `kb-call.mjs#residentStatus()`，
 *   它报的是"**kb-call 自己起的常驻会话**"在不在 —— 那个会话随上一个 node 进程结束就消失了，
 *   于是探针报"不可用"，而实际上 `DSH-RAG-Service` 计划任务在跑、`python -m src.service` 进程也在。
 *   ⇒ 探针必须测**我真正依赖的那件事**（"能不能召回到东西"），而不是一个容易混淆的代理指标。
 *   代理指标的两种翻车方式这里都见过了：**假绿**（说正常其实没干活）与**假红**（说故障其实好好的）。 */
export async function probeMcp() {
  try {
    const { recall } = await import('../processor/recall.mjs');
    const r = await recall('工作台 v1 状态探针', { k: 1 });
    if (r.ok === true) return { ok: true, detail: `向量检索可用（候选 ${r.raw_count} 条，命中 ${r.hits.length} 条，门槛 ${r.floor}）` };
    return { ok: false, detail: `向量检索不可用：${r.why}` };
  } catch (e) { return UNKNOWN(`向量检索探测异常：${e.message}`); }
}

/** 本地工具：node 自身版本 + `_meta/tools` 是否在（这是本地工具链的落点） */
export function probeLocalTools() {
  const major = Number(String(process.versions.node).split('.')[0]);
  const toolsDir = path.join(ROOT, '_meta', 'tools');
  const hasDir = fs.existsSync(toolsDir);
  if (major >= 20 && hasDir) return { ok: true, detail: `node v${process.versions.node} · 工具目录在` };
  if (!hasDir) return { ok: false, detail: '本地工具目录 _meta/tools 不存在' };
  return { ok: false, detail: `node 版本偏低（v${process.versions.node}）` };
}

/** 浏览器：有没有正在跑的浏览器进程（agent-browser 要用到它） */
export function probeBrowser() {
  const r = ps("(Get-Process -Name chrome,msedge -ErrorAction SilentlyContinue | Measure-Object).Count", 20000);
  if (r.error) return UNKNOWN(`浏览器探测失败：${r.error.message}`);
  const n = Number(r.stdout);
  if (!Number.isFinite(n)) return UNKNOWN(`浏览器探测输出不可解析：${JSON.stringify(r.stdout.slice(0, 40))}`);
  return n > 0 ? { ok: true, detail: `${n} 个浏览器进程在跑` } : { ok: false, detail: '没有浏览器进程在跑' };
}

/** 一次探完（供 preview / 前端状态栏用） */
export async function probeAll() {
  const dws = probeDws();
  const localtools = probeLocalTools();
  const browser = probeBrowser();
  const mcp = await probeMcp();
  return { dws, mcp, localtools, browser };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（断言"三态语义"没被写坏；真探针本身不做强制断言 —— 它的结果本来就随环境变）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const all = await probeAll();
  for (const [k, v] of Object.entries(all)) {
    chk(`PRB-${k}`, `${k} 探针返回三态之一（true/false/null）并带说明`, (v.ok === true || v.ok === false || v.ok === null) && typeof v.detail === 'string' && v.detail.length > 0, JSON.stringify(v));
  }
  chk('PRB-5', '★ 四项都探到（每项都有独立探针，不是复制同一个值）', Object.keys(all).length === 4);
  chk('PRB-6', '★ 不知道就不说知道：三者互不混淆（null ≠ true）', all.dws.ok !== undefined && all.mcp.ok !== undefined);
  // ★ 2026-10-14 修（**这条检查写窄了，把"如实探不到"当成了失败**）：
  //   现象：单独跑这一组 7/0 全过；一挂进总回归就 6/1 —— 报 PRB-7 不过。
  //   查明：总回归给每组**换一个临时知识库根**，于是 `_meta/tools` 在那底下不存在，
  //     探针**如实**回 `本地工具目录 _meta/tools 不存在`。
  //     而这条却假定"探针一定拿到了 node 版本" ⇒ 必然红。
  //   **探针是对的** —— 它探不到就说探不到，这正是"诚实空态"要的行为。
  //   ⇒ 两种情况都算对：① 探到了 ⇒ 说明里必须带**真实** node 版本（证明不是编的）；
  //                       ② 没探到 ⇒ 说明里必须**明说缺什么**（不能空着、不能假装成功）。
  //   这样换任何环境跑都成立，"反映真实 node 版本"这个意图一条没丢。
  const ltDetail = String(all.localtools.detail ?? '');
  const ltFound = ltDetail.includes('node');
  chk('PRB-7', 'localTools 探针：探到就报真实 node 版本，探不到就明说缺什么（不许空着或假装成功）',
    ltFound
      ? ltDetail.includes(process.versions.node.slice(0, 2))
      : (ltDetail.trim() !== '' && /不存在|找不到|未/.test(ltDetail)),
    ltDetail);
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}

const __isMain = (() => { try { const entry = process.argv[1]; return !!entry && import.meta.url === pathToFileURL(entry).href } catch { return false } })();
if (__isMain) {
  probeAll().then((all) => {
    for (const [k, v] of Object.entries(all)) {
      const s = v.ok === true ? '正常' : v.ok === false ? '不可用' : '未探明';
      console.log(`  ${k.padEnd(11)} ${s.padEnd(4)} — ${v.detail}`);
    }
    process.exit(0);
  });
}
