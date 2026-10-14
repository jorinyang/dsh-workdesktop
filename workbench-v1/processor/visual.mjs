/**
 * v1/processor/visual.mjs —— **可视化构建器**（P1-1；需求 3.2.2 后半句）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求原文（3.2.2）："如果笔记中的内容适合进行可视化构建，则**调用 DSH 中的工具**
 *   （坐标系/工程图/建模中心）进行可视化构建 …… 其中的可视化构建部分将会由工具构建为
 *   模型，**沉淀到工具中**。"
 *
 * 本轮之前的状态（复查文档 §一 实测）：`analyze.mjs` 只给出 `suggestVisual()` 的**建议**，
 *   `store.mjs` 与 `api/cockpit.mjs` 在读 `visual.built`，**但全库没有一处写它**
 *   ⇒ 驾驶舱"可视化模型数"恒为 0，需求 3.2.2 只做了一半。本文件补的就是这一半。
 *
 * 三条纪律（与项目既有纪律一致）
 *   ① **成功才置 `built:true`**；失败写 `visual.error` + `ok:false`，**绝不假装建过**
 *      （"失败要留痕、不假装"）。
 *   ② **幂等**：同一条笔记已经 `built:true` 且工具/落点都在 ⇒ 不重复建（`skipped`）。
 *   ③ **可测**：三条工具通路全部走**注入**（`deps`），自检里用桩，不出网、不写真实工具；
 *      真跑时才用默认实现。判定（`suggestVisual`）与执行（本文件）分开 —— 与 intent.mjs 同一条做法。
 *
 * 三条工具通路（**取证过的落点**，不是猜的）
 *   · `coordinates`  ⇒ 写 `$DSH_HOME/.dsh-coords/<名>.json`，schema 照 dsh-coords 的 spec
 *                      （version/name/mode/intent/axes/groups/quadrants/points）。
 *   · `modeling`     ⇒ `POST <base>/modeling/api/model`（本机 3080 实测 200）。
 *   · `project_graph`⇒ 由注入的 `graphFn` 提供。**默认实现暂为 null 并如实报
 *                      `ok:false, reason:'project-graph 通路未接'`** —— 因为工程图那条要走
 *                      插件的 `pg-helper/project-graph-prg.mjs`（纯 Node，readPrg/writePrg），
 *                      本轮未接完 ⇒ **不假装能建**。（这是本轮唯一没闭的那条，下一轮补。）
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as store from '../store.mjs';

/** DSH 家目录（坐标系落盘在那里；测试可用 deps.coordsDir 覆盖） */
export function dshHome() {
  return process.env.DSH_HOME && String(process.env.DSH_HOME).trim() !== ''
    ? String(process.env.DSH_HOME)
    : path.join(os.homedir(), '.dsh');
}
export function coordsDir() {
  // 自检用 WB_V1_COORDS_DIR 把它指到临时目录，免得往真实坐标系里写东西
  const override = process.env.WB_V1_COORDS_DIR;
  if (override && String(override).trim() !== '') return String(override);
  return path.join(dshHome(), '.dsh-coords');
}

/** 建模中心基址（本机面板） */
export function modelingBase() { return process.env.WB_V1_MODELING_BASE || 'http://127.0.0.1:3080'; }

/** 工程图（.prg）工作区与模板 */
export function pgDir() {
  const o = process.env.WB_V1_PG_DIR;
  if (o && String(o).trim() !== '') return String(o);
  return path.join(dshHome(), '.dsh-project-graph', 'projects');
}
/**
 * 工程图 helper 所在目录；**找不到就返回 null**（不编一个不存在的路径）。
 *
 * ★★ 2026-10-14 改（**原来这里写死了一条本机绝对路径**）：
 *   原实现是 `process.env.WB_V1_PG_HELPER || 'C:\\Users\\<用户名>\\Desktop\\DSH\\plugins\\dsh-workdesktop\\pg-helper'`
 *   —— 兜底值把**用户名**写进了发布件，而且换台机器就指不到。
 *   ⚠️ 它当时"看起来能用"，只是因为在**那台机器上恰好存在** —— 这类"写死路径 + 本机巧合"最会骗人。
 *
 * ⇒ 改成**按候选逐层探**，谁底下真有 `build-empty-project.mjs` 就用谁：
 *   ① 环境变量 `WB_V1_PG_HELPER`（显式指定优先）
 *   ② 从本文件往上逐层找 `pg-helper/`
 *   ③ `<仓库根>/pg-helper`（仓库布局：`workbench-v1/` 与 `pg-helper/` 平级）
 *   ④ `<仓库根>/workbench-v1` 的**兄弟目录**里找（知识库布局：`_meta/workbench/pg-helper`）
 *   ⑤ DSH 插件目录（`<DSH>/plugins/dsh-workdesktop/pg-helper`）—— 用 `DSH_ROOT`/推算，**不写死用户名**
 * 探不到 → `null`，调用方**如实报"本机没有工程图 helper"**，而不是拿个错目录去建工程。
 */
export function pgHelperDir() {
  const o = process.env.WB_V1_PG_HELPER;
  if (o && String(o).trim() !== '') return String(o);

  const here = path.dirname(fileURLToPath(import.meta.url));   // …/workbench-v1/processor
  const pkgRoot = path.resolve(here, '..');                     // …/workbench-v1
  const parent = path.resolve(pkgRoot, '..');                   // …/（仓库根 或 _meta/workbench）

  const looksRight = (d) => d && fs.existsSync(path.join(d, 'build-empty-project.mjs'));
  const candidates = [
    path.join(pkgRoot, 'pg-helper'),          // 包内（有些布局会把 helper 放进来）
    path.join(parent, 'pg-helper'),           // 与 workbench-v1 平级
    path.resolve(parent, '..', 'pg-helper'),  // 再上一层（知识库：_meta/workbench/pg-helper 的对位）
  ];
  // DSH 插件目录：从环境变量拿根，**不写死用户名**
  const dshRoot = process.env.DSH_ROOT
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop', 'DSH') : null)
    || (process.env.HOME ? path.join(process.env.HOME, 'Desktop', 'DSH') : null);
  if (dshRoot) candidates.push(path.join(dshRoot, 'plugins', 'dsh-workdesktop', 'pg-helper'));

  for (const c of candidates) if (looksRight(c)) return c;
  return null;   // 找不到就说找不到
}

/**
 * ★★ **绝不覆盖已有工程** —— 这条是本文件里最硬的一道闸。
 *
 * 为什么单列一条：`.prg` 是**用户的真实数据**（msgpack+zip 的文档格式），
 *   `project-graph-doc.mjs` 自己的注释里就记着一次真实事故 ——
 *   2026-10-10 把某个路由的"返回摘要"当成舞台数组写回去，`工作台.prg` 被写成 90 字节、**整张图打不开**。
 *   ⇒ 本构建器**只允许创建不存在的新文件**（`<笔记主题>.prg`），
 *     目标已存在 ⇒ **一律拒绝并如实回报**，请人工决定是改名还是先删。
 *   ⇒ 想覆盖既有图，必须**显式**设 `WB_V1_PG_ALLOW_OVERWRITE=1`（默认关）。
 *   宁可少建一次，也不拿你的图去赌。
 *
 * ★★ 2026-10-14 补：**"上一次失败留下的空文件"允许重写**（`allowFailedTarget`）
 *   来由（真机点出来的死结）：构建中途失败时会留下一个**没写完的文件**，
 *   而闸只看"文件在不在" ⇒ 从此每次都拒，那条笔记**永远停在"待构建"**，
 *   用户点多少次都是"目标工程已存在"（实测那条笔记的 ref 指向一个 485 字节的残留）。
 *
 *   ⚠️ **第一版修错了，记在这里免得再犯**：我用"体积 < 3000 字节 ⇒ 空壳"来判，
 *     结果 `VIS-16` 当场变红 —— 自检里那个**真建出来的两节点工程正好也是 485 字节**。
 *     **体积根本分不出"空壳"和"小工程"**（合法的小图可以比残留还小）。
 *     拿体积当判据，等于给"覆盖真数据"开了一道随时可能命中的口子 —— 那是拆闸，不是修闸。
 *   ⇒ 改成**精确判法**：只有在"**这个文件正是上一次失败留下的那一个**"时才允许重写 ——
 *     失败时把目标路径记进事件的 `visual.failedTarget`，下次构建时逐字比对。
 *     这样"能重写"的对象是**点名的、有记录的**，而不是"任何小文件"。
 */
export function assertPgWritable(file, { allowFailedTarget = null } = {}) {
  const allow = process.env.WB_V1_PG_ALLOW_OVERWRITE === '1';
  if (!fs.existsSync(file)) return { ok: true };
  if (allow) return { ok: true };
  // 精确例外：这个路径与"上次失败记下的目标"**逐字相同** ⇒ 它是没写完的残留，可以接着写。
  if (allowFailedTarget && path.resolve(String(allowFailedTarget)) === path.resolve(file)) {
    let bytes = 0;
    try { bytes = fs.statSync(file).size } catch { bytes = 0 }
    return { ok: true, replacedFailedTarget: bytes };
  }
  return { ok: false, why: `目标工程已存在，拒绝覆盖：${file}（要覆盖请显式设 WB_V1_PG_ALLOW_OVERWRITE=1）` };
}

/**
 * 真建一个工程图（**新文件**）：用插件的 `project-graph-doc.mjs`（纯 Node）读模板 → 建节点 → 写回。
 * 模板取 `pg-helper/empty-project.prg`（空工程自带一个根节点）。
 * @returns {{ok:boolean, ref?:string, detail?:string, reason?:string}}
 */
export async function buildProjectGraphFile({ name, lines = [], template = null, dir = null, allowFailedTarget = null } = {}) {
  const target = path.join(dir ?? pgDir(), `${String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.prg`);
  const guard = assertPgWritable(target, { allowFailedTarget });
  if (guard.ok !== true) return { ok: false, reason: guard.why, target };
  // ★ 2026-10-14：`pgHelperDir()` 现在**可能返回 null**（本机确实没有工程图 helper 时）。
  //   这里**如实报"本机没有"**，而不是拿 `null` 拼路径拼出一个乱字符串 ——
  //   那样错误信息会变成 `null/empty-project.prg`，看的人根本不知道发生了什么。
  const helper = pgHelperDir();
  if (helper === null && template === null) {
    return { ok: false, reason: '本机没有工程图 helper（没找到 pg-helper/，可用 WB_V1_PG_HELPER 指定）', target };
  }
  const tpl = template ?? path.join(helper, 'empty-project.prg');
  if (!fs.existsSync(tpl)) return { ok: false, reason: `空工程模板不存在：${tpl}` };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(tpl, target);                       // 先落一份模板，再按文档层改它
    const doc = await import(pathToFileURL(path.join(helper, 'project-graph-doc.mjs')).href);
    // ★ 用法照仓库里既有的脚本（`verify-project-graph-clipboard.mjs:38-52`）：
    //   `const doc0 = readDocument(file)` ⇒ `doc0.stage` 是舞台数组、`doc0.doc` 是文档壳；
    //   `stage = insertObjects(stage, [obj], null)` **直接返回新舞台**；`writeDocument(file, doc0.doc, stage)`。
    const doc0 = doc.readDocument(target);
    const stage = doc0?.stage;
    if (!Array.isArray(stage)) return { ok: false, reason: `模板读出来不是舞台数组（${typeof stage}）—— 拒绝继续` };
    const items = (Array.isArray(lines) ? lines : [lines]).map((s) => String(s ?? '').trim()).filter((s) => s !== '');
    if (items.length === 0) return { ok: false, reason: '没有可写的内容（lines 为空）' };
    const made = [];
    let y = 0;
    for (const text of items) {
      const n = doc.makeTextNode(stage, { text, y: y });
      if (n.ok !== true) return { ok: false, reason: `建节点失败：${n.error}` };
      made.push(n.node);
      y += 120;
    }
    const nextStage = doc.insertObjects(stage, made, null);
    if (!Array.isArray(nextStage)) return { ok: false, reason: '插入后不是舞台数组 —— 拒绝写入（宁可少建一次）' };
    doc.writeDocument(target, doc0.doc, nextStage);   // writeDocument 自带"stage 必须是数组"的防线 + 写前备份
    // 写后回读：能读回来、且节点文本一个不少（不是"写完就算"）
    const back = doc.readDocument(target);
    const backStage = back?.stage;
    if (!Array.isArray(backStage)) return { ok: false, reason: '写后回读失败 ⇒ 已中止（模板副本仍在）' };
    const texts = backStage.filter((o) => o && o._ === 'TextNode').map((o) => o.text);
    const missing = items.filter((t) => !texts.includes(t));
    if (missing.length) return { ok: false, reason: `回读缺少 ${missing.length} 个节点：${missing.join(' / ')}` };
    return { ok: true, ref: target, detail: `已建工程图 ${path.basename(target)}（${items.length} 个节点）` };
  } catch (e) {
    return { ok: false, reason: `建图异常：${e.message}` };
  }
}

/** 默认实现：真写文件 / 真发 HTTP。测试一律注入自己的 deps，不碰这里。 */
export const defaultDeps = Object.freeze({
  // 坐标系：落一个与 coords_save 同 schema 的 JSON
  coordsFn: async ({ name, spec }) => {
    const dir = coordsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(spec, null, 2), 'utf8');
    // 写后回读校验（不是"写完就算"）：能被解析、名字对得上
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (back.name !== spec.name) return { ok: false, reason: `回读名字不符：${back.name}` };
    return { ok: true, ref: file, detail: `已写入坐标系 ${name}` };
  },
  // 建模中心：POST 建一个模型（本机实测 200）
  modelingFn: async ({ name, intent, base = modelingBase() }) => {
    const res = await fetch(`${base}/modeling/api/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'methodology', name, intent, nodes: [], edges: [] }),
    });
    if (!res.ok) return { ok: false, reason: `建模中心返回 ${res.status}` };
    const body = await res.json().catch(() => ({}));
    const id = body?.model?.id ?? null;
    if (!id) return { ok: false, reason: '建模中心未返回模型 id' };
    return { ok: true, ref: id, detail: `已在建模中心建模型 ${name}（id=${id}）` };
  },
  // 工程图：真建一个**新的** .prg（绝不覆盖已有工程 —— 见 assertPgWritable 的长注释）
  // ★ 2026-10-14：把"上次失败留下的那个文件"透下来 —— 只有它与这次的目标**逐字相同**时才允许重写。
  graphFn: async ({ note, name, allowFailedTarget = null }) => {
    const topic = String(note?.payload?.topic ?? '').trim();
    const lines = [topic === '' ? String(name) : topic];
    const md = String(note?.payload?.content_md ?? '').trim();
    if (md !== '') for (const line of md.split(/\r?\n/)) { const t = line.trim(); if (t !== '') lines.push(t.slice(0, 120)); }
    return buildProjectGraphFile({ name, lines: lines.slice(0, 40), allowFailedTarget });
  },
});

const nowIso = () => new Date().toISOString();
const shortId = (id) => String(id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'x';

/**
 * 造坐标系的 spec（2D 四象限：命名空间自己按笔记内容给两根轴）
 * 轴名/范围由调用方决定 —— 这是"每根轴按内容自动匹配"的落点。
 */
export function buildCoordsSpec({ note, name, axisX = {}, axisY = {}, points = [], groups = [], intent = '' }) {
  const t = nowIso();
  const mkAxis = (key, a) => ({
    key,
    name: String(a.name ?? (key === 'x' ? 'X 轴' : 'Y 轴')),
    min: Number.isFinite(Number(a.min)) ? Number(a.min) : 0,
    max: Number.isFinite(Number(a.max)) ? Number(a.max) : 5,
    unit: String(a.unit ?? ''),
    desc: String(a.desc ?? ''),
  });
  return {
    version: 1,
    name: String(name),
    mode: '2d',
    intent: String(intent || `笔记《${note?.payload?.topic ?? ''}》的可视化构建`).slice(0, 400),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: { kind: 'agent', ref: `workbench-v1/note/${note?._id ?? ''}`, brief: `构建于 ${t}` },
    axes: [mkAxis('x', axisX), mkAxis('y', axisY)],
    groups: groups.map((g, i) => ({ id: String(g.id ?? `g${i + 1}`), label: String(g.label ?? `分组 ${i + 1}`), color: g.color ?? ['#4d6bfe', '#d97706', '#1a7f37', '#c2185b'][i % 4] })),
    quadrants: [
      { id: 'q1', label: '高X·高Y' }, { id: 'q2', label: '低X·高Y' },
      { id: 'q3', label: '低X·低Y' }, { id: 'q4', label: '高X·低Y' },
    ],
    points: points.map((p, i) => ({
      id: String(p.id ?? `p${i + 1}`),
      name: String(p.name ?? `点 ${i + 1}`),
      values: { x: Number(p.values?.x ?? 0), y: Number(p.values?.y ?? 0) },
      group: p.group ? String(p.group) : undefined,
      note: String(p.note ?? ''),
    })),
  };
}

/**
 * 真正建一个（按工具分流）。
 * @returns {{ok:boolean, tool:string, ref?:string, detail?:string, reason?:string, name?:string}}
 */
export async function buildOne({ tool, note, name, spec = null, intent = '', deps = {} }) {
  const d = { ...defaultDeps, ...deps };
  const safeName = String(name || `note-${shortId(note?._id)}`).slice(0, 120);
  if (tool === 'coordinates') {
    const s = spec ?? buildCoordsSpec({ note, name: safeName, intent });
    const r = await d.coordsFn({ name: safeName, spec: s });
    return { ok: r.ok === true, tool, ref: r.ref ?? null, detail: r.detail ?? null, reason: r.reason ?? null, name: safeName };
  }
  if (tool === 'modeling') {
    const r = await d.modelingFn({ name: safeName, intent: String(intent || `笔记《${note?.payload?.topic ?? ''}》的可视化构建`) });
    return { ok: r.ok === true, tool, ref: r.ref ?? null, detail: r.detail ?? null, reason: r.reason ?? null, name: safeName };
  }
  if (tool === 'project_graph') {
    if (typeof d.graphFn !== 'function') {
      return { ok: false, tool, ref: null, detail: null, reason: 'project-graph 通路未接（本轮如实报未完成，不假装建过）', name: safeName };
    }
    const r = await d.graphFn({ note, name: safeName, intent, allowFailedTarget: deps?.allowFailedTarget ?? null });
    return { ok: r.ok === true, tool, ref: r.ref ?? null, detail: r.detail ?? null, reason: r.reason ?? null, name: safeName, target: r.target ?? null };
  }
  return { ok: false, tool: String(tool), ref: null, detail: null, reason: `未知工具：${tool}`, name: safeName };
}

/**
 * 对**一条笔记**跑可视化构建（幂等）。
 * 判定来自 `note.analysis.visual.suggested`（由 analyze.mjs 的规则给出）。
 * @returns {{id, action:'built'|'skipped'|'nothing'|'failed', tool, ref, reason, detail}}
 */
export async function buildVisualForNote(evt, { deps = {}, force = false, name = null, spec = null, intent = '', dryRun = false } = {}) {
  const v = evt?.analysis?.visual ?? null;
  if (!v || !v.suggested) return { id: evt?._id ?? null, action: 'nothing', tool: null, ref: null, reason: '这条笔记没有可视化建议（规则未命中）', detail: null };
  const tool = String(v.suggested);
  const already = evt?.analysis?.visual?.built === true;
  if (already && !force) {
    return { id: evt._id, action: 'skipped', tool, ref: evt.analysis.visual.ref ?? null, reason: '已经建过（幂等）', detail: null };
  }
  const nm = name ?? evt.analysis?.visual?.name ?? `笔记-${String(evt.payload?.topic ?? '').slice(0, 20)}-${shortId(evt._id)}`;
  if (dryRun) return { id: evt._id, action: 'built', tool, ref: '(dryRun)', reason: null, detail: '干跑：未真建' };

  // ★ 2026-10-14：把"**上一次失败留下的那个文件**"交给构建器 ——
  //   它是唯一允许被重写的已存在文件（判法精确到"这一个"，见 `assertPgWritable` 的长注释）。
  const allowFailedTarget = evt.analysis?.visual?.failedTarget ?? null;
  const r = await buildOne({ tool, note: evt, name: nm, spec, intent, deps: { ...deps, allowFailedTarget } });
  const at = nowIso();
  if (r.ok) {
    store.patch('note', evt._id, {
      analysis: { ...(evt.analysis ?? {}), visual: { ...(evt.analysis?.visual ?? {}), built: true, tool, ref: r.ref, name: r.name, at, error: null, failedTarget: null } },
    }, { op: 'visualized', by: 'builder', evidence: { tool, ref: r.ref, name: r.name } });
    return { id: evt._id, action: 'built', tool, ref: r.ref, reason: null, detail: r.detail };
  }
  store.patch('note', evt._id, {
    analysis: {
      ...(evt.analysis ?? {}),
      // ★ 记下**这次试图写的目标**：只在这个路径阻塞时才记（别的失败原因与文件无关，记了会把那个文件误判成"残留"）。
      visual: {
        ...(evt.analysis?.visual ?? {}), built: false, tool, at, error: r.reason,
        failedTarget: r.target ?? evt.analysis?.visual?.failedTarget ?? null,
      },
    },
  }, { op: 'visualize-failed', by: 'builder', evidence: { tool, reason: r.reason, target: r.target ?? null } });
  return { id: evt._id, action: 'failed', tool, ref: null, reason: r.reason, detail: null };
}

/** 跑一轮：所有"有建议但还没建"的笔记（受 limit 约束；幂等） */
export async function visualizeOnce({ limit = 20, deps = {}, force = false, dryRun = false } = {}) {
  const notes = store.list({ type: 'note' })
    .filter((e) => e.analysis?.visual?.suggested)
    .filter((e) => force || e.analysis?.visual?.built !== true)
    .slice(0, limit);
  const rows = [];
  for (const n of notes) rows.push(await buildVisualForNote(n, { deps, force, dryRun }));
  return {
    inCount: notes.length,
    built: rows.filter((r) => r.action === 'built').length,
    skipped: rows.filter((r) => r.action === 'skipped').length,
    failed: rows.filter((r) => r.action === 'failed').length,
    rows,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（**全部走注入桩**：不写真实坐标系、不出网、不碰建模中心）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const fsx = await import('node:fs');
  const osx = await import('node:os');
  const px = await import('node:path');
  const { makeEvent } = await import('../schema.mjs');

  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prev = process.env.WB_V1_OUT;
  const prevPg = process.env.WB_V1_PG_DIR;
  const tmp = fsx.mkdtempSync(px.join(osx.tmpdir(), 'wb-v1-visual-'));
  process.env.WB_V1_OUT = tmp;
  // ★ 自检**必须**把工程图工作区也指向临时目录：否则"真建图"那两条会把自检产物
  //   写进你真实的 `.dsh-project-graph/projects/`（实测踩到过一次）——自检不许留垃圾在你的工具里。
  process.env.WB_V1_PG_DIR = px.join(tmp, 'pg');

  // 桩：记录调用、可控成败
  const calls = [];
  const okDeps = {
    coordsFn: async ({ name, spec }) => { calls.push({ tool: 'coordinates', name }); return { ok: true, ref: `/stub/coords/${name}.json`, detail: 'stub' }; },
    modelingFn: async ({ name }) => { calls.push({ tool: 'modeling', name }); return { ok: true, ref: 'msxstub', detail: 'stub' }; },
    graphFn: async ({ name }) => { calls.push({ tool: 'project_graph', name }); return { ok: true, ref: `${name}.prg`, detail: 'stub' }; },
  };
  const failDeps = { ...okDeps, coordsFn: async () => ({ ok: false, reason: '磁盘只读（桩）' }) };

  // ★★ 2026-10-14 再修一次（**第一次修得不对，所以这条检查又红了**）：
  //   第一次我把"取第一条"改成了 `store.getById('note', made.event?._id)` ——
  //   而 `store.upsert` 返回的是 `{ action, _id }`，**没有 `event` 这层**
  //   ⇒ `made.event?._id` 是 `undefined` ⇒ 又退回 `store.list()[0]` ⇒ 病没治好。
  //   （第一次修完单跑是过的，所以没露馅；套件里再跑才红 —— **"改完单跑一次就收工"不够**。）
  //   ⇒ 直接用 `upsert` 返回的 `_id`；取不到就**按 origin.messageId 精确找**，绝不按位置取。
  const mkNote = (id, text, visualTool) => {
    const made = store.upsert(makeEvent({
      type: 'note',
      payload: { topic: '采集器设计的几个维度', date: '2026-10-12', content_md: text, tags: ['设计'] },
      origin: { channel: 'manual', sender: '我', messageId: id },
      _at: Date.now(),
    }).event);
    const e = (made && made._id ? store.getById('note', made._id) : null)
      ?? store.list({ type: 'note' }).find((x) => String(x.origin?.messageId ?? '') === id);
    if (!e) throw new Error(`mkNote 取不回刚建的笔记（id=${id} · upsert=${JSON.stringify(made)}）`);
    // 模拟 analyze.mjs 已经给过建议
    store.patch('note', e._id, { analysis: { by: 'model', text: '判断：…', visual: visualTool ? { suggested: visualTool, why: '桩' } : null } });
    return store.getById('note', e._id);
  };

  try {
    // ① 坐标系：真建（桩）+ 成功才置 built
    const n1 = mkNote('v1', '从维度上看，排序与对比是关键', 'coordinates');
    const r1 = await buildVisualForNote(n1, { deps: okDeps, intent: '两轴定位' });
    const a1 = store.getById('note', n1._id);
    chk('VIS-1', '★ 坐标系通路：建成功 ⇒ built=true + 记落点', r1.action === 'built' && a1.analysis?.visual?.built === true && typeof a1.analysis.visual.ref === 'string', JSON.stringify(r1));
    chk('VIS-2', '★ 建成功留下留痕（visualized + 工具与落点）', (a1.ops ?? []).some((o) => o.op === 'visualized' && o.evidence?.tool === 'coordinates'), JSON.stringify(a1.ops));

    // ② 幂等：再跑不重复建
    const before = calls.length;
    const r2 = await buildVisualForNote(store.getById('note', n1._id), { deps: okDeps });
    chk('VIS-3', '★ 幂等：已建过不再重复（skipped，且没再调工具）', r2.action === 'skipped' && calls.length === before, JSON.stringify(r2));

    // ③ 失败留痕、不假装
    const n2 = mkNote('v2', '这里的流程与依赖关系需要理清', 'coordinates');
    const r3 = await buildVisualForNote(n2, { deps: failDeps });
    const a2 = store.getById('note', n2._id);
    chk('VIS-4', '★ 建失败 ⇒ built 不置真 + 写 error（不假装建过）', r3.action === 'failed' && a2.analysis?.visual?.built === false && a2.analysis.visual.error === '磁盘只读（桩）', JSON.stringify(a2.analysis?.visual));
    chk('VIS-5', '★ 失败也有留痕（visualize-failed + 原因）', (a2.ops ?? []).some((o) => o.op === 'visualize-failed' && String(o.evidence?.reason).includes('只读')));

    // ④ 建模中心通路
    const n3 = mkNote('v3', '这是一套方法论：从边界到验收', 'modeling');
    const r4 = await buildVisualForNote(n3, { deps: okDeps });
    chk('VIS-6', '建模中心通路：建成功 ⇒ built + ref', r4.action === 'built' && r4.tool === 'modeling' && r4.ref === 'msxstub', JSON.stringify(r4));

    // ⑤ 工程图通路：未接时**如实报失败**，不许假装
    const n4 = mkNote('v4', '这里的流程与依赖关系需要理清', 'project_graph');
    const r5 = await buildVisualForNote(n4, { deps: { coordsFn: okDeps.coordsFn, modelingFn: okDeps.modelingFn, graphFn: null } });   // 显式不给 graphFn
    chk('VIS-7', '★ 工程图未接通路 ⇒ 如实报失败（不假装建过）', r5.action === 'failed' && String(r5.reason).includes('未接'), JSON.stringify(r5));
    const r5b = await buildVisualForNote(store.getById('note', n4._id), { deps: okDeps, force: true });
    chk('VIS-8', '工程图通路：给了实现就能建（同一入口）', r5b.action === 'built' && r5b.tool === 'project_graph', JSON.stringify(r5b));

    // ⑥ 没有建议的笔记：什么都不做
    const n5 = mkNote('v5', '今天下午开了个会，聊了聊进度', null);
    const r6 = await buildVisualForNote(n5, { deps: okDeps });
    chk('VIS-9', '★ 负向对照：没有可视化建议 ⇒ 不动工具', r6.action === 'nothing' && calls.filter((c) => c.name.includes('v5')).length === 0, JSON.stringify(r6));

    // ⑦ 干跑不落盘
    const n6 = mkNote('v6', '排序与对比', 'coordinates');
    const r7 = await buildVisualForNote(n6, { deps: okDeps, dryRun: true });
    chk('VIS-10', '干跑：不写状态', r7.action === 'built' && store.getById('note', n6._id).analysis?.visual?.built !== true, JSON.stringify(r7));

    // ⑧ spec 形状（与 dsh-coords 的 spec 对齐）
    const spec = buildCoordsSpec({ note: n1, name: 'T', axisX: { name: 'X', min: 0, max: 10 }, axisY: { name: 'Y' }, points: [{ name: 'A', values: { x: 3, y: 4 } }] });
    chk('VIS-11', '★ 坐标系 spec 形状对齐（2D 两轴 + 四象限 + 点位）', spec.mode === '2d' && spec.axes.length === 2 && spec.axes[0].key === 'x' && spec.axes[0].max === 10 && Array.isArray(spec.quadrants) && spec.quadrants.length === 4 && spec.points[0].values.x === 3, JSON.stringify(spec).slice(0, 160));
    chk('VIS-12', 'spec 带 source.kind=agent 与来源指向（可回溯到哪条笔记）', spec.source?.kind === 'agent' && String(spec.source.ref).includes(n1._id));

    // ⑨ 一轮跑批：只有"有建议且未建"的进
    const r8 = await visualizeOnce({ deps: okDeps, force: true });
    chk('VIS-13', '跑批：只处理有建议的，且逐条给结果', r8.inCount >= 3 && Array.isArray(r8.rows) && r8.built >= 3, JSON.stringify({ in: r8.inCount, built: r8.built, failed: r8.failed }));

    // ⑩ ★ **工程图真建（不注入、走真实现）** —— 工作区已指向临时目录（见上面 WB_V1_PG_DIR），绝不碰你已有的 .prg
    // ⚠️ 2026-10-14 改：原来这里是 `chk('VIS-14', …, false, tpl)` —— **环境不具备就算一次失败**。
    //   后果：只要本机没装工程图 helper（裸 clone、或知识库那份），这条永远红，
    //   而它想说的其实是"这台机器上没有，跑不了"。**"跑不了"和"没通过"是两件事，不能混。**
    //   ⇒ 缺 helper / 缺模板 ⇒ 记成 **skipped**（套件统计里不算失败），并写明要什么。
    const pgTmp = process.env.WB_V1_PG_DIR;
    fsx.mkdirSync(pgTmp, { recursive: true });
    const pgHelper = pgHelperDir();
    const tpl = pgHelper === null ? null : px.join(pgHelper, 'empty-project.prg');
    if (pgHelper === null || !fsx.existsSync(tpl)) {
      out.push({
        id: 'VIS-14', ok: true, skipped: true,
        desc: '★ 工程图真建：**跳过**（本机没有工程图 helper / 空工程模板 ⇒ 这条跑不了，不算失败）',
        detail: pgHelper === null ? '没找到 pg-helper/（可用 WB_V1_PG_HELPER 指定）' : `模板不存在：${tpl}`,
      });
    } else {
      const g1 = await buildProjectGraphFile({ name: '自检用图', lines: ['甲', '乙'], template: tpl, dir: pgTmp });
      chk('VIS-14', '★ 工程图真建：建出 .prg 且回读节点一个不少（真实现，不注入）', g1.ok === true && fsx.existsSync(g1.ref), JSON.stringify(g1));
      if (g1.ok === true) {
        const d = await import(pathToFileURL(px.join(pgHelper, 'project-graph-doc.mjs')).href);
        const texts = (d.readDocument(g1.ref).stage ?? []).filter((o) => o && o._ === 'TextNode').map((o) => o.text);
        chk('VIS-15', '回读确认两个节点都在（甲/乙）', texts.includes('甲') && texts.includes('乙'), JSON.stringify(texts.slice(0, 6)));
      } else {
        chk('VIS-15', '回读确认两个节点都在（甲/乙）', false, 'VIS-14 已失败');
      }
      // ★★ 覆盖闸：同一个名字再建一次 ⇒ **必须拒绝**（这是本文件最硬的一条纪律）
      const g2 = await buildProjectGraphFile({ name: '自检用图', lines: ['丙'], template: tpl, dir: pgTmp });
      chk('VIS-16', '★★ 拒绝覆盖已有工程（宁可少建一次，也不拿你的图去赌）', g2.ok === false && String(g2.reason).includes('拒绝覆盖'), JSON.stringify(g2));

      // ★★ 2026-10-14 加（**真机点出来的死结**）：
      //   构建中途失败会留下**没写完的文件**，原来那道闸只看"文件在不在"
      //   ⇒ 从此每次都拒、那条笔记永远停在"待构建"（实测：一个 485 字节的残留挡住了它自己）。
      //   ⚠️ 判法必须**精确到"这一个文件"**：第一版我用"体积 < 3000 字节"来判，
      //     结果 VIS-16 当场变红 —— 自检里那个**真建出来的两节点工程正好也是 485 字节**。
      //     体积分不出"空壳"与"小工程"；拿体积当判据等于给"覆盖真数据"开了口子。
      const stubFile = px.join(pgTmp, '上次失败留下的那个.prg');
      fsx.writeFileSync(stubFile, Buffer.alloc(485, 7));
      const gs = assertPgWritable(stubFile, { allowFailedTarget: stubFile });
      chk('VIS-17', '★★ 上次失败留下的那个文件 ⇒ **允许重写**（按钮不再被永久卡死）',
        gs.ok === true && gs.replacedFailedTarget === 485, JSON.stringify(gs));
      chk('VIS-18', '★★ 同样大小的**别的**文件 ⇒ 仍然拒绝（精确到"这一个"，不是"这一类小文件"）', (() => {
        const other = px.join(pgTmp, '跟失败无关的小工程.prg');
        fsx.writeFileSync(other, Buffer.alloc(485, 7));
        const r = assertPgWritable(other, { allowFailedTarget: stubFile });
        return r.ok === false && /拒绝覆盖/.test(String(r.why));
      })());
      chk('VIS-19', '★ 没有失败记录时（`allowFailedTarget` 不给）⇒ 一律拒绝，纪律不松',
        assertPgWritable(stubFile).ok === false && assertPgWritable(stubFile).why.includes('拒绝覆盖'));
    }
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    if (prevPg === undefined) delete process.env.WB_V1_PG_DIR; else process.env.WB_V1_PG_DIR = prevPg;
    try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }

  // ★ 2026-10-14：**跳过的不算"过"** —— 它没被验过，算进 pass 就是在虚报覆盖。
  //   三个数分开：pass（真验过且过）· fail（真验过且没过）· skipped（本机跑不了）。
  //   套件层（selftest-all.mjs）对 skipped 也是同一条约定：不计入 PASS/FAIL。
  const skipped = out.filter((x) => x.skipped === true).length;
  const pass = out.filter((x) => x.ok && x.skipped !== true).length;
  return { pass, fail: out.length - pass - skipped, skipped, details: out };
}
