/**
 * v1/collector/dingtalk-wiki.mjs —— 钉钉 · 知识库（登记表 `dd-kb`）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 2.2：CLI 类功能走**每 5 分钟轮询**、**幂等**（"查询是否有新的知识库/文档…"）
 * 登记表原话：「全新通路（现有代码 0 命中），待写适配器」← 本文件就是那个适配器。
 *
 * 实测依据（2026-10-12，全部是量出来的，不是猜的）：
 *   · `dws wiki space list` ⇒ `{success, hasMore, wikiSpaces:[{name, workspaceId, rootNodeId}]}`
 *     —— 本机实测 **5 个知识库**（育钉-千问办公大客户 / 课件素材 / 悟空商业化课程 / 诊断自咨询工具 / 电商专班课程）。
 *   · `dws wiki feed list --workspace <id> [--limit n] [--cursor t]`
 *     ⇒ `{success, hasMore, nextToken, feeds:[{content, time, type}]}`；**`content` 是内嵌 JSON 字符串**。
 *   · **`--limit` 有上限**：实测 20 可用、**25 就被 API 拒**（"参数 pageSize 超过最大允许值"）
 *     ⇒ 本模块把上限**写成常量并守住**（超了直接说清楚，不去撞 API）。
 *   · **`hasMore=true` + `nextToken`** ⇒ 必须**翻页**（第一版只读第一页，会漏）。
 *
 * ★★ 那条动态流里混着**四种东西**（实测同一页里就有 4 种 `type`）：
 *   | type | 内嵌键 | 是什么 | 本模块怎么处理 |
 *   |---|---|---|---|
 *   | 0 / 1 | `doc` | 文档新建/访问 | **采**（幂等键 `dd-kb-<dentryUuid>`） |
 *   | 7 / 8 | `fileList` | 文件（zip/md/…）上传/移动 | **采**（同上；**文件项没有 createTime**，用动态时间当发送时间，如实登记） |
 *   | 9 | `folder` | 文件夹 | **不采**（文件夹不是内容）——但**计数上报**，不静默丢 |
 *   | 未知 | 别的键 | 认不出 | **计数 + 报出键名**（不是含糊的"形状变了"） |
 *
 * **两处如实说明**：
 *   ① **正文还没抓**：`dws doc +export`（提交 → 轮询 → 下载）是另一段活，本轮未接
 *      ⇒ `raw` 只到"名字 + 所属知识库"这一层，**不假装存了正文**；
 *   ② 起点判据：文档按**创建时间**（用户裁定"消息/听记/邮件/笔记按发送/创建时间"）；
 *      **文件项没有创建时间 ⇒ 用动态时间**（它是"什么时候动过这个文件"）——这一处与文档不同，如实写明。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { v1Out, KB_ROOT } from '../paths.mjs';
import { inScope } from './registry.mjs';
import { buildCommand } from './cli.mjs';
// 文档落盘命名只有一份实现（需求 3.1.2 的"日期+主题"）—— 从 links 借用，**不复制**
import { suggestDocName } from '../processor/links.mjs';

export const KEY = 'dd-kb';
export const INTERVAL_SEC = 300;
/** `--limit` 的实测上限（25 被拒、20 可用）⇒ 写到 20，超了就**不撞 API**、直接说清楚 */
export const MAX_PAGE = 20;
/** 一轮最多翻几页（防止某个特别活跃的库把一轮拖很久） */
export const MAX_PAGES = 3;

export function stateFile() { return path.join(v1Out(), 'dd-kb-seen.json'); }
export function loadSeen() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveSeen(doc) {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

/** 取数：经 PowerShell 调 `dws`（Windows 上它是 .cmd 垫片，直接 spawn 会 ENOENT） */
export function defaultRun(args, { timeoutMs = 60000 } = {}) {
  const PS = 'powershell.exe';
  const cmd = buildCommand('dws', args);   // 统一走 collector/cli.mjs（引号规则只有一份）
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
    // 超时可调：正文导出是异步任务（实测要等），给它更长的窗口；查询类保持 60s
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `dws 退出码 ${r.status}：${(err || out).slice(0, 240)}` };
  try { const parsed = JSON.parse(out); return { ok: true, json: parsed, parsed }; } catch (e) { return { ok: false, why: `输出不是 JSON：${e.message}（前 120 字：${out.slice(0, 120)}）` }; }
}

/** 知识库清单 */
export function fetchSpaces({ run = defaultRun } = {}) {
  const r = run(['wiki', 'space', 'list']);
  if (r.ok !== true) return { ok: false, why: r.why };
  const arr = r.json?.wikiSpaces;
  if (!Array.isArray(arr)) return { ok: false, why: '返回里没有 wikiSpaces 数组' };
  return { ok: true, spaces: arr.map((s) => ({ id: String(s?.workspaceId ?? ''), name: String(s?.name ?? '') })).filter((s) => s.id) };
}

/** 某一页动态（`limit` 超上限时**不发请求**，直接给可执行的下一步） */
export function fetchFeed({ workspaceId, limit = MAX_PAGE, cursor = null, run = defaultRun } = {}) {
  if (!Number.isFinite(Number(limit)) || Number(limit) < 1 || Number(limit) > MAX_PAGE) {
    return { ok: false, why: `limit=${limit} 超出实测上限 ${MAX_PAGE}（实测 25 被 API 拒："参数 pageSize 超过最大允许值"）⇒ 请用 ≤ ${MAX_PAGE}` };
  }
  const args = ['wiki', 'feed', 'list', '--workspace', String(workspaceId), '--limit', String(limit)];
  if (cursor) args.push('--cursor', String(cursor));
  const r = run(args);
  if (r.ok !== true) return { ok: false, why: r.why };
  const arr = r.json?.feeds;
  if (!Array.isArray(arr)) return { ok: false, why: '返回里没有 feeds 数组' };
  return { ok: true, feeds: arr, hasMore: r.json.hasMore === true, nextToken: r.json.nextToken ?? null };
}

/** 翻页取全（直到 hasMore=false / 没有 nextToken / 到 MAX_PAGES） */
export function fetchFeedPages({ workspaceId, limit = MAX_PAGE, maxPages = MAX_PAGES, run = defaultRun } = {}) {
  const all = []; let cursor = null; let pages = 0; let truncated = false;
  for (;;) {
    const p = fetchFeed({ workspaceId, limit, cursor, run });
    if (p.ok !== true) return { ok: pages > 0, feeds: all, pages, truncated, why: p.why, partial: pages > 0 };
    all.push(...p.feeds); pages += 1;
    if (!p.hasMore || !p.nextToken) break;
    if (pages >= maxPages) { truncated = true; break; }
    cursor = p.nextToken;
  }
  return { ok: true, feeds: all, pages, truncated };
}

/**
 * 动态的一条 → 认种类。
 * @returns {{ok:true, kind:'doc'|'file'|'folder', items:object[], feedTime:number|null, type:any}
 *          |{ok:false, kind:'unknown', why:string, keys:string[], type:any}}
 */
export function parseActivity(f) {
  const feedTime = Number.isFinite(Number(f?.time)) ? Number(f.time) : null;
  const type = f?.type ?? null;
  let c = f?.content;
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch { return { ok: false, kind: 'unknown', why: `content 不是合法 JSON（前 80 字：${String(f.content).slice(0, 80)}）`, keys: [], type }; }
  }
  if (!c || typeof c !== 'object') return { ok: false, kind: 'unknown', why: 'content 不是对象', keys: [], type };
  const keys = Object.keys(c).sort();
  if (c.doc && typeof c.doc === 'object') return { ok: true, kind: 'doc', items: [c.doc], feedTime, type };
  // ★ `fileList` 存在但**为空**也算"文件类"动态（实测有：删/移之类的动作用同一个键）——
  //   第一版要求 `length > 0` 才认，于是一批空 fileList 被误报成"认不出"。
  if (Array.isArray(c.fileList)) return { ok: true, kind: 'file', items: c.fileList, feedTime, type };
  // ★ 还有**单个 `file`** 这种形状（实测键：file + parent + totalUserCount + users，type=6）——与 fileList 同类。
  //   ⚠️ 这一行第一次没进去：那次编辑因为"文件已被改动"失败，而我随后又改了别处，**把这次失败盖过去了**
  //   （读数一直是"认不出 2"才回头发现）。教训：编辑失败要么立刻回头补，要么当场记下来。
  if (c.file && typeof c.file === 'object') return { ok: true, kind: 'file', items: [c.file], feedTime, type };
  if (c.folder && typeof c.folder === 'object') return { ok: true, kind: 'folder', items: [c.folder], feedTime, type };
  // ★ 成员变动（实测键：avatarUrl + id + memberType + name + staffId）—— 不是内容，计数即可
  if (c.memberType !== undefined || c.staffId !== undefined) return { ok: true, kind: 'member', items: [], feedTime, type };
  return { ok: false, kind: 'unknown', why: `认不出的动态（键：${keys.join('+')}）`, keys, type };
}

/** 文档/文件 → v1 消息事件（需求 3.1.3：来源 / 发信人 / 原文） */
export function mapDoc(doc, { feedTime = null, type = null, kind = 'doc' } = {}) {
  const errs = [];
  const uuid = String(doc?.dentryUuid ?? '').trim();
  if (!uuid) errs.push('缺 dentryUuid（幂等键要用）');
  const name = String(doc?.name ?? '').trim();
  if (!name) errs.push('缺名字（name）');
  // 文档有 createTime；**文件项没有** ⇒ 这一路用动态时间（如实：那是"什么时候动过它"）
  const created = Number(doc?.createTime);
  const at = Number.isFinite(created) && created > 0 ? created : (feedTime ?? null);
  if (!Number.isFinite(at) || at <= 0) errs.push('既没有创建时间、也没有动态时间 ⇒ 无法判起点');
  if (errs.length) return { ok: false, errors: errs };

  const space = String(doc?.workspaceName ?? '').trim() || '钉钉知识库';
  const ext = String(doc?.extension ?? '').trim();
  const isFile = kind === 'file';
  const payload = {
    channel: 'dingtalk',
    sender: space,
    raw: `【${space}】${name}${ext ? `（${ext}）` : ''}`,
    source: 'doc',
    modality: 'text',
    summary: name,
  };
  return {
    ok: true,
    payload,
    origin: {
      channel: 'dingtalk', sender: space, messageId: `dd-kb-${uuid}`,
      raw: `kind=${kind} workspace=${doc?.workspaceKey ?? ''} node=${doc?.workspaceNodeKey ?? ''} dentry=${doc?.dentryKey ?? ''} docKey=${doc?.docKey ?? ''} type=${type ?? ''} feedTime=${feedTime ?? ''}${isFile ? ' （文件项无创建时间 ⇒ 起点用动态时间）' : ''}`,
    },
    _at: at,
    usedFeedTime: !(Number.isFinite(created) && created > 0),
  };
}

/** 跑一轮：每个库翻页取动态 → 认种类 → 去重 → 判起点 → 落库；文件夹与认不出的**计数上报** */
export function ingestOnce({ run = defaultRun, dryRun = false, limit = MAX_PAGE, maxPages = MAX_PAGES, maxNew = 200, maxSpaces = 20 } = {}) {
  const errors = [];
  const kinds = { doc: 0, file: 0, folder: 0, member: 0, unknown: 0 };
  let inCount = 0; let outCount = 0; let refreshed = 0; let skipped = 0; let outOfScope = 0; let quarantined = 0; let spacesScanned = 0; let truncatedSpaces = 0; let feedTimeUsed = 0;
  // ★ `seen` 台账（幂等依据）：记下"已经采到过的节点 + 它是什么"，
  //   同时给**正文抓取**提供候选（kind=doc 且 ext=adoc 才值得抓）。
  const seen = loadSeen();

  const sp = fetchSpaces({ run });
  if (sp.ok !== true) return { inCount: 0, outCount: 0, refreshed: 0, skipped: 0, outOfScope: 0, quarantined: 0, spacesScanned: 0, kinds, errors: [sp.why], dataAsOf: null, why: `知识库清单取不到：${sp.why}` };

  for (const s of sp.spaces.slice(0, maxSpaces)) {
    spacesScanned += 1;
    const fd = fetchFeedPages({ workspaceId: s.id, limit, maxPages, run });
    if (fd.ok !== true) { errors.push(`知识库「${s.name}」动态取不到：${fd.why}（其余知识库照采）`); continue; }
    if (fd.truncated) truncatedSpaces += 1;
    if (fd.partial) errors.push(`知识库「${s.name}」翻页中途失败：${fd.why}（已取到的页照采）`);

    // 同一个对象在动态里会出现多次 ⇒ 按 dentryUuid 去重，保留**最新那次动态**
    const byDoc = new Map();
    for (const f of fd.feeds) {
      inCount += 1;
      const a = parseActivity(f);
      kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
      if (a.ok !== true) { errors.push(`知识库「${s.name}」有条动态认不出：${a.why}`); continue; }
      if (a.kind === 'folder' || a.kind === 'member') continue;   // 文件夹/成员变动都不是内容 ⇒ 不采（已计数）
      for (const item of a.items) {
        const uuid = String(item?.dentryUuid ?? '');
        if (!uuid) { quarantined += 1; errors.push(`知识库「${s.name}」有条 ${a.kind} 没有 dentryUuid，跳过（不猜）`); continue; }
        const prev = byDoc.get(uuid);
        // `ext` 一起带上：正文抓取要靠它分辨"真文档（adoc）"与"AI 表格（able）"，
        // 后者喂给 `doc +export` 会被明确拒绝（实测原话见文件末尾正文抓取那一节）。
        if (!prev || (a.feedTime ?? 0) > (prev.feedTime ?? 0)) byDoc.set(uuid, { doc: item, feedTime: a.feedTime, type: a.type, kind: a.kind, ext: String(item?.extension ?? item?.ext ?? '') });
      }
    }

    for (const [, it] of byDoc) {
      const mapped = mapDoc(it.doc, { feedTime: it.feedTime, type: it.type, kind: it.kind });
      if (mapped.ok !== true) { quarantined += 1; errors.push(`知识库「${s.name}」有条 ${it.kind} 映射失败：${mapped.errors.join('；')}`); continue; }
      if (mapped.usedFeedTime) feedTimeUsed += 1;
      // ★ 先记 seen（**不分界内界外**）：`kind`/`ext`/`name` 是正文抓取的候选依据，
      //   而界外项占了绝大多数（今天实测 66/66）—— 只在界内记，等于候选永远是空的。
      //   这边登记的是"这个节点是什么"，与"它的内容该不该在采集起点之后入流"是两件事。
      seen[String(it.doc?.dentryUuid ?? '')] = {
        at: new Date().toISOString(), kind: it.kind,
        name: String(it.doc?.name ?? ''), ext: String(it.ext ?? ''),
        feedTime: it.feedTime ?? null,
      };
      const scope = inScope('message', mapped.payload, mapped._at);
      if (!scope.inScope) { skipped += 1; outOfScope += 1; continue; }
      if (dryRun) { outCount += 1; continue; }
      if (outCount + refreshed >= maxNew) { errors.push(`达到上限 ${maxNew} 条，其余下一轮再来`); break; }

      const made = makeEvent({ type: 'message', payload: mapped.payload, origin: mapped.origin, _at: mapped._at });
      if (made.ok === false) { quarantined += 1; errors.push(`归一失败：${made.errors.join('；')}`); continue; }
      const r = store.upsert(made.event);
      if (r.action === 'rejected') { quarantined += 1; errors.push(`落库被拒：${r.reason}`); continue; }
      if (r.action === 'added') outCount += 1; else if (r.action === 'updated') refreshed += 1;
      seen[String(it.doc?.dentryUuid ?? '')].eventId = made.event._id;
    }
  }

  if (!dryRun) saveSeen(seen);
  return {
    inCount, outCount, refreshed, skipped, outOfScope, quarantined, spacesScanned, truncatedSpaces, kinds, feedTimeUsed, errors, seen,
    dataAsOf: new Date().toISOString(),
    why: `知识库 ${spacesScanned} 个 · 动态 ${inCount} 条（文档 ${kinds.doc} · 文件 ${kinds.file} · 文件夹 ${kinds.folder}（不采） · 成员 ${kinds.member}（不采） · 认不出 ${kinds.unknown}）`
      + ` → 去重后新采 ${outCount} · 刷新 ${refreshed} · 跳过 ${skipped}（其中出界 ${outOfScope}） · 隔离 ${quarantined}`
      + (feedTimeUsed ? ` · 其中 ${feedTimeUsed} 条用动态时间判起点（文件项无创建时间）` : '')
      + (truncatedSpaces ? ` · ${truncatedSpaces} 个库翻到页数上限` : ''),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 正文抓取（需求 3.1.1 / 3.1.2 的"内容"层；2026-10-12 补）
//
// 实证（全部量出来的，不是猜的）：
//   · 命令：`dws doc +export --node <dentryUuid> --export-format markdown --max-polls 30 --output <目录>/`
//   · **`--node` 认的就是 `dentryUuid`**（实测：换别的键会被判节点不存在）
//   · 返回：`{ok:true, data:{jobId, localPath, sizeBytes}, steps:[submit,poll,download]}`
//   · **导出是异步任务**：第一次实测撞到 `status=INIT / Export job is still processing`
//     ⇒ **不能塞进 5 分钟节拍**（一轮等几十秒会把节拍拖垮）⇒ 单独入口，由低频定时任务跑。
//   · `--output` 给目录时**固定落成 `document.md`**（同名会覆盖）⇒ **每条一个临时目录**，
//     再按"日期+主题"挪进知识库（复用 `links.mjs#suggestDocName`，**不复制一份命名规则**）。
//   · ⚠️ `--output` 必须是**工作目录内相对路径**（CLI 自己限制）。
//   · 钉钉 AI 表格（扩展名 `able`）**不是文档**：喂给 `+export` 会被明确拒绝（实测原话：
//     "当前节点是钉钉AI表格…不是钉钉在线文档…无法使用文档相关工具操作"）⇒ 只抓真文档，其余如实跳过。
//
// 纪律：抓不到**不算失败**（标 `failed` + 写原因，正文留空，**绝不假装有**）；按节点幂等，不重复导出。
// ══════════════════════════════════════════════════════════════════════════════

/** 一次最多抓几条（低频任务，别一口吃太多） */
export const BODY_MAX_PER_RUN = 5;
/** 单条导出的最大轮询次数（提交→轮询→下载由 CLI 一条命令走完） */
export const BODY_MAX_POLLS = 30;
/** 单条导出的取数超时（毫秒）：异步任务，实测 3 秒回来，但排队时要等 */
export const BODY_EXPORT_TIMEOUT_MS = 240000;
/** 连败这个次数后不再反复撞（留痕即可，别每轮都去磨）
 *  ★ 实测校准（2026-10-12 真跑）：导出是**服务端异步队列** —— 同一条命令，
 *    有的 3 秒回来、有的十分钟还在 `status=INIT / Export job is still processing`。
 *    ⇒ 失败**绝大多数是"排队中"，不是"抓不到"**，所以：
 *      · 上限放到 8 次（按每日一轮算，约一周窗口，够把它排完）；
 *      · 失败照实记 `why`，下次自然重试；成功后才永久跳过。 */
export const BODY_MAX_TRIES = 8;
/** 正文落库目录（与飞书文档正文同一个落点） */
export function bodyDir() { return path.join(KB_ROOT, 'Other', 'Inflow', '文档'); }
/** 正文抓取进度（按 dentryUuid 记，幂等） */
export function bodyStateFile() { return path.join(v1Out(), 'dd-kb-bodies.json'); }
export function loadBodyState() { try { return JSON.parse(fs.readFileSync(bodyStateFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveBodyState(doc) {
  fs.mkdirSync(v1Out(), { recursive: true });
  const tmp = `${bodyStateFile()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1), 'utf8');
  fs.renameSync(tmp, bodyStateFile());
}

/** 导出正文：一条命令走完提交→轮询→下载（不自己拼轮询） */
export function exportBody({ nodeId, relOut, run = defaultRun, maxPolls = BODY_MAX_POLLS } = {}) {
  const args = ['doc', '+export', '--node', String(nodeId), '--export-format', 'markdown', '--max-polls', String(maxPolls), '--output', String(relOut)];
  // ★ 导出是异步任务（提交→轮询→下载），可能远超查询类的 60s ⇒ 单独给 240s 窗口。
  //   80% 的情况 3 秒就回来了（实测），放宽只是兜底，不是常态等待。
  const r = run(args, { timeoutMs: BODY_EXPORT_TIMEOUT_MS });
  if (r.ok !== true) return { ok: false, why: r.why ?? '导出失败' };
  const p = r.parsed ?? null;
  const d = p?.data ?? null;
  if (!d || typeof d.localPath !== 'string') return { ok: false, why: `返回里没有 localPath：${JSON.stringify(p).slice(0, 200)}` };
  return { ok: true, localPath: d.localPath, sizeBytes: Number(d.sizeBytes ?? 0), jobId: d.jobId ?? null };
}

/**
 * 抓一批正文（跑一轮；按节点幂等）。
 * @returns {{inCount:number, fetched:number, failed:number, total:object, rows:Array, why:string|null}}
 */
export function fetchBodiesOnce({ run = defaultRun, dryRun = false, max = BODY_MAX_PER_RUN, now = Date.now() } = {}) {
  const st = loadBodyState();
  const seen = loadSeen();
  const cands = [];
  // ★ 候选**排序**（2026-10-12 补，实测教训）：一轮只抓 max 条，而失败项会留在池子里。
  //   不排序的话，名单头永远是那几个卡在队列里的 ⇒ **后面的候选永远轮不到**（池子不流动）。
  //   排序口径：① 没试过的优先；② 都试过 ⇒ 试得少的优先；③ 再同 ⇒ 按名字稳定排（可复现）。
  const rank = (k) => (st[k] ? (st[k].tries ?? 0) : 0);
  const all = [];
  for (const [key, rec] of Object.entries(seen)) {
    if (!rec || rec.kind !== 'doc') continue;
    const ext = String(rec.ext ?? '').toLowerCase();
    if (ext !== '' && ext !== 'adoc') continue;                 // able/adraw 等不是"文档"，跳过
    if (st[key] && st[key].ok === true) continue;               // 已抓到 ⇒ 幂等跳过
    if (st[key] && (st[key].tries ?? 0) >= BODY_MAX_TRIES) continue;   // 连败到上限 ⇒ 不再磨
    all.push({ key, ...rec });
  }
  all.sort((a, b) => (rank(a.key) - rank(b.key)) || String(a.name ?? '').localeCompare(String(b.name ?? '')) || a.key.localeCompare(b.key));
  cands.push(...all.slice(0, max));
  const remainingPool = all.length - cands.length;   // 池里还剩多少（排序后剩下的就是下一轮的头部）
  let fetched = 0; let failed = 0;
  const rows = [];
  for (const c of cands) {
    if (dryRun) { rows.push({ key: c.key, action: 'dryRun', name: c.name ?? '' }); continue; }
    const rel = `_meta/out/v1/.runtime/kb-export/${c.key}`.replace(/\\/g, '/');
    const absDir = path.join(v1Out(), '.runtime', 'kb-export', c.key);
    fs.mkdirSync(absDir, { recursive: true });
    const ex = exportBody({ nodeId: c.key, relOut: `${rel}/`, run });
    const tries = (st[c.key]?.tries ?? 0) + 1;
    if (ex.ok !== true) {
      st[c.key] = { ok: false, tries, why: String(ex.why).slice(0, 240), at: new Date(now).toISOString(), name: c.name ?? '', ext: c.ext ?? '' };
      saveBodyState(st); failed += 1;
      rows.push({ key: c.key, action: 'failed', why: st[c.key].why });
      continue;
    }
    // 落库：按"日期 + 主题"命名（需求 3.1.2）。★ 日期用**本地日期** ——
    //   `toISOString()` 是 UTC，东八区会把日期减一天（飞书那条正文抓取真跑踩过）。
    const d = new Date(now);
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dest = path.join(bodyDir(), suggestDocName({ date: localDate, topic: c.name ?? c.key }));
    try {
      fs.mkdirSync(bodyDir(), { recursive: true });
      const srcAbs = path.isAbsolute(String(ex.localPath)) ? String(ex.localPath) : path.join(KB_ROOT, String(ex.localPath));
      if (!fs.existsSync(srcAbs)) throw new Error(`导出说落在这里但文件不在：${ex.localPath}`);
      const md = fs.readFileSync(srcAbs, 'utf8');
      if (md.trim() === '') throw new Error('导出内容为空');
      fs.writeFileSync(dest, md, 'utf8');
      try { fs.rmSync(absDir, { recursive: true, force: true }); } catch { /* noop */ }
      st[c.key] = { ok: true, tries, at: new Date(now).toISOString(), name: c.name ?? '', ext: c.ext ?? '', file: path.relative(KB_ROOT, dest).replace(/\\/g, '/'), bytes: md.length };
      saveBodyState(st); fetched += 1;
      rows.push({ key: c.key, action: 'fetched', file: st[c.key].file, bytes: md.length });
    } catch (e) {
      st[c.key] = { ok: false, tries, why: `落库失败：${e.message}`.slice(0, 240), at: new Date(now).toISOString(), name: c.name ?? '', ext: c.ext ?? '' };
      saveBodyState(st); failed += 1;
      rows.push({ key: c.key, action: 'failed', why: st[c.key].why });
    }
  }
  const allState = Object.values(st);
  return {
    inCount: cands.length, fetched, failed, remaining: remainingPool,
    total: { ok: allState.filter((x) => x.ok === true).length, failed: allState.filter((x) => x.ok !== true).length },
    rows,
    why: cands.length === 0 ? (remainingPool === 0 ? '候选池已空（该抓的都抓过了）' : `本轮没有可抓的候选（池里剩 ${remainingPool} 条但都到重试上限）`) : null,
  };
}

// 命令行入口（定时任务用；包装脚本 `_meta/tools/v1-kb-bodies.cmd`）。
// ★ 为什么必须有入口：本项目已三次踩到"没有命令行入口 ⇒ 计划任务只看到 exit=0"这种假绿。
if (process.argv[1] && process.argv[1].endsWith('dingtalk-wiki.mjs') && process.argv.includes('--bodies')) {
  // 命令行入口（定时任务用；`_meta/tools/v1-kb-bodies.cmd`）。
  // ★ 为什么必须有入口：本项目已三次踩到"没有命令行入口 ⇒ 计划任务只看到 exit=0"这种假绿。
  const dry = process.argv.includes('--dry-run');
  const t0 = Date.now();
  try {
    const r = fetchBodiesOnce({ dryRun: dry });
    console.log(`[kb-bodies] 候选 ${r.inCount} · 抓到 ${r.fetched} · 失败 ${r.failed} · 池里还剩 ${r.remaining}（累计 成功 ${r.total.ok} / 失败 ${r.total.failed}）用时 ${Math.round((Date.now() - t0) / 1000)}s`);
    for (const row of r.rows) console.log(`  ${row.action.padEnd(7)} ${row.key} ${row.file ?? row.why ?? ''}`);
    if (r.why) console.log(`  （${r.why}）`);
    // 有候选却一条都没成功 ⇒ 判失败（否则计划任务会把它记成成功，又是一次假绿）
    const ok = !(r.inCount > 0 && r.fetched === 0 && !dry);
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`[kb-bodies] 抛异常：${e.stack ?? e.message}`);
    console.log('FAIL');
    process.exit(1);
  }
}

export async function selfTest() {
  const os = await import('node:os');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-ddkb-'));
  process.env.WB_V1_OUT = tmp;

  const NOW = Date.parse('2026-10-12T12:00:00+08:00');
  const DOC = (uuid, name, created, extra = {}) => ({ dentryUuid: uuid, name, createTime: created, dentryKey: 'dk-' + uuid, docKey: 'doc-' + uuid, extension: 'able', workspaceKey: 'ws1', workspaceName: '示例知识库', workspaceNodeKey: 'n1', ...extra });
  // 文件项**没有 createTime**（实测如此）
  const FILE = (uuid, name, ext) => ({ dentryUuid: uuid, name, extension: ext, dentryKey: 'fk-' + uuid, workspaceKey: 'ws1', workspaceName: '示例知识库', workspaceNodeKey: 'n1' });
  const FEED = (content, time, type) => ({ content: JSON.stringify(content), time, type });
  const runWith = (spaces, feeds) => (args) => {
    if (args[1] === 'space' && args[2] === 'list') return { ok: true, json: { success: true, hasMore: false, wikiSpaces: spaces } };
    if (args[1] === 'feed' && args[2] === 'list') {
      const ws = args[args.indexOf('--workspace') + 1];
      const cur = args.includes('--cursor') ? args[args.indexOf('--cursor') + 1] : null;
      const pages = feeds[ws] ?? [];
      const idx = cur ? Number(cur) : 0;
      const page = pages[idx];
      if (!page) return { ok: true, json: { feeds: [], hasMore: false, nextToken: null } };
      const hasMore = idx + 1 < pages.length;
      return { ok: true, json: { feeds: page, hasMore, nextToken: hasMore ? String(idx + 1) : null } };
    }
    return { ok: false, why: '未预期参数：' + args.join(' ') };
  };

  try {
    // ① 认种类（四种）
    const aDoc = parseActivity(FEED({ doc: DOC('U1', '讲师预约管理系统', NOW - 3600000), users: [], totalUserCount: 1 }, NOW, 1));
    chk('KB-1', '★ 认出"文档"（type 1，内嵌 JSON 字符串）', aDoc.ok === true && aDoc.kind === 'doc' && aDoc.items[0].dentryUuid === 'U1');
    const aFile = parseActivity(FEED({ fileList: [FILE('F1', 'a.zip', 'zip')], totalFileCount: 1, userInfo: {} }, NOW, 7));
    chk('KB-2', '★ 认出"文件"（type 7 的 fileList）', aFile.ok === true && aFile.kind === 'file' && aFile.items.length === 1 && aFile.items[0].name === 'a.zip');
    const aFolder = parseActivity(FEED({ folder: DOC('D1', '某文件夹', NOW), parent: {}, userInfo: {} }, NOW, 9));
    chk('KB-3', '★ 认出"文件夹"（type 9）—— 它**不是内容**，不采但要计数', aFolder.ok === true && aFolder.kind === 'folder');
    const aUnknown = parseActivity(FEED({ somethingElse: 1 }, NOW, 42));
    chk('KB-4', '★ 认不出的**报出键名**（不是含糊的"形状变了"）', aUnknown.ok === false && /somethingElse/.test(aUnknown.why), aUnknown.why);
    chk('KB-5', '★ content 不是合法 JSON ⇒ 也分清', parseActivity({ content: '{坏', time: NOW, type: 1 }).ok === false);

    // ② 映射：需求 3.1.3 三项 + 起点口径
    const m = mapDoc(DOC('U1', '讲师预约管理系统', NOW - 3600000));
    chk('KB-6', '★ 来源/发信人/原文三项', m.ok === true && m.payload.channel === 'dingtalk' && m.payload.sender === '示例知识库' && /讲师预约管理系统/.test(m.payload.raw));
    chk('KB-7', '幂等键 = dd-kb-<dentryUuid>', m.origin.messageId === 'dd-kb-U1');
    chk('KB-8', '★ 文档按**创建时间**判起点', m._at === NOW - 3600000 && m.usedFeedTime === false);
    const mf = mapDoc(FILE('F1', 'a.zip', 'zip'), { feedTime: NOW - 600000, kind: 'file', type: 7 });
    chk('KB-9', '★ 文件项无创建时间 ⇒ 用动态时间（并标记出来）', mf._at === NOW - 600000 && mf.usedFeedTime === true, String(mf.usedFeedTime));
    chk('KB-10', '可回查的 id 留在 origin.raw', /dentry=dk-U1/.test(m.origin.raw) && /kind=file/.test(mf.origin.raw));
    chk('KB-11', '★ 负向对照：缺 uuid / 缺名字 / 两个时间都没有 ⇒ 映射失败',
      mapDoc({ name: 'x', createTime: NOW }).ok === false && mapDoc({ dentryUuid: 'U', createTime: NOW }).ok === false && mapDoc({ dentryUuid: 'U', name: 'x' }).ok === false);

    // ③ 一轮：多库 + 多页 + 四种种类
    const spaces = [{ name: '示例知识库', workspaceId: 'ws1' }, { name: '第二个库', workspaceId: 'ws2' }];
    const feeds = {
      ws1: [
        [FEED({ doc: DOC('A', '新文档甲', NOW - 7200000) }, NOW - 3600000, 1),
         FEED({ doc: DOC('A', '新文档甲', NOW - 7200000) }, NOW - 600000, 0),      // 同一文档第二次 ⇒ 去重
         FEED({ fileList: [FILE('F1', '工具包.md', 'md')], totalFileCount: 1 }, NOW - 300000, 7),
         FEED({ folder: DOC('DIR1', '某文件夹', NOW - 100000) }, NOW - 200000, 9)],  // 文件夹 ⇒ 不采
        [FEED({ doc: DOC('B', '八月的老文档', Date.parse('2026-08-20T10:00:00+08:00')) }, NOW - 120000, 1)],  // 第二页
      ],
      ws2: [[FEED({ doc: DOC('C', '另一个库的新文档', NOW - 1800000, { workspaceName: '第二个库' }) }, NOW - 600000, 1)]],
    };
    const r1 = ingestOnce({ run: runWith(spaces, feeds) });
    chk('KB-12', '★ 两个库都扫到', r1.spacesScanned === 2, String(r1.spacesScanned));
    chk('KB-13', '★ 认种类计数齐全（文档/文件/文件夹）', r1.kinds.doc === 4 && r1.kinds.file === 1 && r1.kinds.folder === 1, JSON.stringify(r1.kinds));
    chk('KB-14', '★ 同一文档两次动态 ⇒ 去重成一条（A 只产一条）', store.list({ type: 'message' }).filter((e) => e.origin.messageId === 'dd-kb-A').length === 1);
    chk('KB-15', '★ 三样内容入流（A 文档 · F1 文件 · C 文档）、老文档出界、文件夹不采',
      r1.outCount === 3 && r1.outOfScope === 1 && store.list({ type: 'message' }).length === 3, JSON.stringify({ out: r1.outCount, outOfScope: r1.outOfScope, total: store.list({ type: 'message' }).length }));
    chk('KB-16', '★ 说明了有几条用动态时间判起点', r1.feedTimeUsed === 1, String(r1.feedTimeUsed));

    // ④ 幂等
    const r2 = ingestOnce({ run: runWith(spaces, feeds) });
    chk('KB-17', '★ 第二轮幂等：不新建', r2.outCount === 0 && store.list({ type: 'message' }).length === 3, JSON.stringify({ out: r2.outCount }));

    // ⑤ 页大小守卫：超上限**不发请求**
    let called = false;
    const spy = (args) => { called = true; return { ok: true, json: { feeds: [] } }; };
    const over = fetchFeed({ workspaceId: 'ws1', limit: 25, run: spy });
    chk('KB-18', '★ limit 超实测上限 ⇒ 直接说清楚、**不去撞 API**', over.ok === false && !called && /上限/.test(over.why), over.why);

    // ⑥ 翻页：三页数据都能取到
    const many = { ws1: [[FEED({ doc: DOC('P1', 'p1', NOW - 1000) }, NOW, 1)], [FEED({ doc: DOC('P2', 'p2', NOW - 1000) }, NOW, 1)], [FEED({ doc: DOC('P3', 'p3', NOW - 1000) }, NOW, 1)]] };
    const pg = fetchFeedPages({ workspaceId: 'ws1', run: runWith(spaces, many), maxPages: 5 });
    chk('KB-19', '★ 翻页：三页都取到（不只看第一页）', pg.ok === true && pg.feeds.length === 3 && pg.pages === 3, JSON.stringify({ n: pg.feeds.length, pages: pg.pages }));
    const pg2 = fetchFeedPages({ workspaceId: 'ws1', run: runWith(spaces, many), maxPages: 2 });
    chk('KB-20', '★ 页数上限守住，并标记"翻到上限"', pg2.feeds.length === 2 && pg2.truncated === true, JSON.stringify({ n: pg2.feeds.length, truncated: pg2.truncated }));

    // ⑦ 一个库取不到 ⇒ 其余照采；清单取不到 ⇒ 如实说
    const run3 = (args) => {
      if (args[1] === 'space' && args[2] === 'list') return { ok: true, json: { wikiSpaces: spaces } };
      const ws = args[args.indexOf('--workspace') + 1];
      if (ws === 'ws1') return { ok: false, why: '模拟该库不可用' };
      return { ok: true, json: { feeds: [FEED({ doc: DOC('D', '新库新文档', NOW - 1800000, { workspaceName: '第二个库' }) }, NOW - 300000, 1)], hasMore: false } };
    };
    const r3 = ingestOnce({ run: run3 });
    chk('KB-21', '★ 一个库取不到 ⇒ 其余照采 + 如实记错', r3.outCount === 1 && r3.errors.some((e) => /动态取不到/.test(e)), JSON.stringify({ out: r3.outCount }));
    const r4 = ingestOnce({ run: () => ({ ok: false, why: 'dws 退出码 1：模拟不可用' }) });
    chk('KB-22', '★ 清单取不到 ⇒ 写明原因（不写成"没有新文档"）', /知识库清单取不到/.test(r4.why), r4.why);

    // ⑧ 干跑不写盘
    const before = store.list({ type: 'message' }).length;
    ingestOnce({ run: runWith(spaces, feeds), dryRun: true });
    chk('KB-23', '干跑不写盘', store.list({ type: 'message' }).length === before);

    // ⑨ ★ 正文抓取（需求 3.1.1/3.1.2 的"内容"层；2026-10-12 补）
    const tmpKb = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-kb-bodies-'));
    const prevKb = process.env.WB_V1_KB_ROOT;
    process.env.WB_V1_KB_ROOT = tmpKb;
    try {
      // 造一份 seen：一个真文档（adoc）+ 一个 AI 表格（able）+ 一个已抓过的
      saveSeen({
        N1: { kind: 'doc', name: '01-课程大纲', ext: 'adoc', at: new Date().toISOString() },
        N2: { kind: 'doc', name: '邮件追踪表', ext: 'able', at: new Date().toISOString() },
        N3: { kind: 'doc', name: '已抓过的', ext: 'adoc', at: new Date().toISOString() },
      });
      saveBodyState({ N3: { ok: true, tries: 1, file: 'Other/Inflow/文档/x.md' } });
      // 假 run：模拟 `doc +export` 成功。
      // ⚠️ 它必须把 `document.md` 落在 **v1Out() 下面**（不是假的知识库根）——
      //    `--output` 是相对**工作目录（知识库根）**的路径，而运行态目录是真实那一个。
      //    夹具写错地方 ⇒ 断言假红（实测踩到过一次：又是"夹具与实现不同形"）。
      const fakeExport = (args) => {
        const outIdx = args.indexOf('--output');
        const rel = outIdx >= 0 ? String(args[outIdx + 1]) : '';
        const abs = path.join(KB_ROOT, rel);
        fs.mkdirSync(abs, { recursive: true });
        fs.writeFileSync(path.join(abs, 'document.md'), '# 课程大纲\n\n正文内容', 'utf8');
        return { ok: true, parsed: { ok: true, status: 'success', data: { jobId: 'j1', localPath: `${rel}document.md`, sizeBytes: 12 } } };
      };
      const b1 = fetchBodiesOnce({ run: fakeExport, now: Date.UTC(2026, 9, 12, 4, 0, 0) });
      chk('KB-24', '★ 正文抓到并落库（按"日期+主题"命名）', b1.fetched === 1 && b1.rows.some((r) => r.action === 'fetched'), JSON.stringify(b1.rows));
      chk('KB-25', '★ AI 表格（ext=able）**不抓**（不是文档，CLI 会拒）', b1.inCount === 1 && b1.rows.every((r) => r.key !== 'N2'), JSON.stringify(b1.rows.map((r) => r.key)));
      chk('KB-26', '★ 已抓过的节点幂等跳过（不重复导出）', b1.rows.every((r) => r.key !== 'N3'));
      chk('KB-27', '★ 落盘名用**本地日期**（UTC 会少一天：UTC 04:00 = 东八区 12:00 同日）', (() => {
        const p = Object.values(loadBodyState()).find((x) => x.ok === true && x.file && x.file.includes('课程大纲'));
        return !!p && /2026-10-12-01-课程大纲\.md$/.test(p.file);
      })(), JSON.stringify(Object.values(loadBodyState()).map((x) => x.file)));
      chk('KB-28', '★ 导出失败 ⇒ 如实记 failed + 原因（正文留空，绝不假装有）', (() => {
        saveSeen({ N4: { kind: 'doc', name: '抓不到的', ext: 'adoc', at: new Date().toISOString() } });
        const b2 = fetchBodiesOnce({ run: () => ({ ok: false, why: '导出任务仍处理中（模拟）' }) });
        const rec = loadBodyState().N4;
        return b2.failed === 1 && rec.ok === false && /处理中/.test(rec.why);
      })());
      chk('KB-29', '★ 返回里没有 localPath ⇒ 也算失败（不写空文件）', (() => {
        saveSeen({ N5: { kind: 'doc', name: '形状变了', ext: 'adoc', at: new Date().toISOString() } });
        const b3 = fetchBodiesOnce({ run: () => ({ ok: true, parsed: { ok: true, data: {} } }) });
        return b3.failed === 1 && loadBodyState().N5.ok === false && /localPath/.test(loadBodyState().N5.why);
      })());
    } finally {
      if (prevKb === undefined) delete process.env.WB_V1_KB_ROOT; else process.env.WB_V1_KB_ROOT = prevKb;
      try { fs.rmSync(tmpKb, { recursive: true, force: true }); } catch { /* noop */ }
    }
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
