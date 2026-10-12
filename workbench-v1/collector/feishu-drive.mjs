/**
 * v1/collector/feishu-drive.mjs —— 飞书 · 云文档 / 多维表（登记表 `fs-doc` + `fs-bitable`）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * **一条通路服务两条登记**：这两条的"发现段"是同一件事（先要知道**有哪些**文档/多维表），
 * 区别只在拿到之后的"记录段"（多维表还要用 `lark-cli base` 读记录，属下一步）。
 *
 * 为什么走**原始 API**（而不是快捷命令）——本轮实测的结论：
 *   · `lark-cli docs +search` **必须带 `--query`**（不给关键词 ⇒ 0 条），页大小上限 20；
 *   · `lark-cli drive` **没有任何"列文件/列最近"的快捷命令**（只有 comments/search/export/download 那些）；
 *   · ⇒ 快捷命令**列不出"最近有哪些文档"**，而轮询的本质就是"问有没有新的"。
 *   · ⇒ **底层接口是逃生口**：
 *       ① `api GET /open-apis/drive/explorer/v2/root_folder/meta` → `{ok:true, data:{token}}`（根目录 token）
 *       ② `api GET /open-apis/drive/v1/files?folder_token=<t>&page_size=20`
 *          → `{ok:true, data:{files:[{token,name,type,created_time,modified_time,url,owner_id,parent_token}], has_more}}`
 *     实测根目录 **11 个文件**；`type` 里就有 `bitable`。
 *
 * ⚠️ **两个必踩的坑（本轮实测记下）**：
 *   1. `created_time` / `modified_time` 是**秒**，不是毫秒 ⇒ 转时间前 **×1000**；
 *   2. 返回里有 `has_more` + `next_page_token` ⇒ **要翻页**。
 *
 * 类型分流：`folder` **不采**（文件夹不是内容，计数上报）；`bitable` 走子通道 `bitable`；
 * 其余（docx/doc/sheet/slides/mindnote/file…）走子通道 `doc`。
 * 幂等键 = `fs-drive-<token>`；起点按 `created_time`（用户裁定："消息/笔记按发送/创建时间"）。
 * **正文未抓**：`docs +fetch` / `base` 读记录是下一步 ⇒ `raw` 只到"名字 + 类型"这一层，不假装存了正文。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { v1Out, KB_ROOT, hasKbRoot } from '../paths.mjs';
import { inScope } from './registry.mjs';
import { runCli } from './cli.mjs';
import { suggestDocName } from '../processor/links.mjs';   // 复用同一套"日期-主题"命名（需求 3.1.2）

export const KEY = 'fs-doc';              // 主登记（fs-bitable 的发现段也走这里，登记表里两条的 consumedBy 都指向本文件）
export const INTERVAL_SEC = 300;
export const MAX_PAGE = 20;               // 实测：页大小上限 20
export const MAX_PAGES = 3;

export function stateFile() { return path.join(v1Out(), 'fs-drive-seen.json'); }
export function loadSeen() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveSeen(doc) {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}


/** 取数：**整段交给公共件**（拼装 + 经 PowerShell 执行 + 解析，只有一份规则）
 *  ⚠️ 统一时踩过一次签名：本地旧版是 `buildCommand(args)`，公共件是 `buildCommand(bin, args)`
 *  ⇒ 直接改成调 `runCli('lark-cli', args)`，不再自己拼、也不再自己 spawn（少一处能写错的地方）。 */
export function defaultRun(args) {
  return runCli('lark-cli', args);
}

/** 根目录 token */
export function rootFolderToken({ run = defaultRun } = {}) {
  const r = run(['api', 'GET', '/open-apis/drive/explorer/v2/root_folder/meta']);
  if (r.ok !== true) return { ok: false, why: r.why };
  const t = r.json?.data?.token;
  if (!t) return { ok: false, why: '返回里没有 data.token（形状变了？）' };
  return { ok: true, token: String(t) };
}

/** 列一层目录（`pageSize` 不许超上限；`folderToken` 缺省用根目录） */
export function listFiles({ folderToken = null, pageSize = MAX_PAGE, pageToken = null, run = defaultRun } = {}) {
  if (!Number.isFinite(Number(pageSize)) || Number(pageSize) < 1 || Number(pageSize) > MAX_PAGE) {
    return { ok: false, why: `pageSize=${pageSize} 超出实测上限 ${MAX_PAGE} ⇒ 不发请求，请用 ≤ ${MAX_PAGE}` };
  }
  let t = folderToken;
  if (!t) {
    const rt = rootFolderToken({ run });
    if (rt.ok !== true) return { ok: false, why: `根目录 token 取不到：${rt.why}` };
    t = rt.token;
  }
  // ★ 2026-10-12 升级 lark-cli 1.0.84 → **1.0.97** 后的**行为变更**（升级当场撞到，不是猜的）：
  //   `api GET <path?query>` ⇒ **`path must not contain a query string or fragment`**，
  //   CLI 的提示写得很清楚：**查询参数改用 `--params`（JSON）传，路径里不要带 `?`**。
  //   ⇒ 下面改成 `--params`；路径保持干净。
  const params = { folder_token: t, page_size: Number(pageSize) };
  if (pageToken) params.page_token = pageToken;
  const r = run(['api', 'GET', '/open-apis/drive/v1/files', '--params', JSON.stringify(params)]);
  if (r.ok !== true) return { ok: false, why: r.why };
  const files = r.json?.data?.files;
  if (!Array.isArray(files)) return { ok: false, why: '返回里没有 data.files 数组（形状变了？）' };
  return { ok: true, files, hasMore: r.json.data.has_more === true, nextPageToken: r.json.data.next_page_token ?? null, folderToken: t };
}

/** 翻页取全 */
export function listAll({ folderToken = null, pageSize = MAX_PAGE, maxPages = MAX_PAGES, run = defaultRun } = {}) {
  const all = []; let token = null; let pages = 0; let truncated = false; let partial = false; let why = null; let ft = folderToken;
  for (;;) {
    const p = listFiles({ folderToken: ft, pageSize, pageToken: token, run });
    if (p.ok !== true) { if (pages === 0) return { ok: false, why: p.why }; partial = true; why = p.why; break; }
    ft = p.folderToken;
    all.push(...p.files); pages += 1;
    if (!p.hasMore || !p.nextPageToken) break;
    if (pages >= maxPages) { truncated = true; break; }
    token = p.nextPageToken;
  }
  return { ok: true, files: all, pages, truncated, partial, why };
}

/** 文件 → v1 消息事件（需求 3.1.3：来源 / 发信人 / 原文） */
export function mapFile(f) {
  const errs = [];
  const token = String(f?.token ?? '').trim();
  if (!token) errs.push('缺 token（幂等键要用）');
  const name = String(f?.name ?? '').trim();
  if (!name) errs.push('缺名字（name）');
  const type = String(f?.type ?? '').trim() || 'file';
  if (type === 'folder') return { ok: false, skip: true, errors: ['folder 不是内容 ⇒ 不采'] };
  // ⚠️ 秒 → 毫秒（这一条不记住必踩）
  const sec = Number(f?.created_time);
  if (!Number.isFinite(sec) || sec <= 0) errs.push(`created_time 无法解析：${JSON.stringify(f?.created_time)}`);
  if (errs.length) return { ok: false, errors: errs };

  const isBase = type === 'bitable';
  const payload = {
    channel: 'feishu',
    sender: '飞书云文档',
    raw: `【飞书${isBase ? '多维表' : '文档'}】${name}（${type}）`,
    source: isBase ? 'bitable' : 'doc',
    modality: 'text',
    summary: name,
  };
  return {
    ok: true,
    payload,
    origin: {
      channel: 'feishu', sender: '飞书云文档', messageId: `fs-drive-${token}`,
      raw: `type=${type} token=${token} url=${f?.url ?? ''} parent=${f?.parent_token ?? ''} modified=${Number(f?.modified_time) || ''}`,
    },
    _at: sec * 1000,                     // ← 秒转毫秒
    kind: isBase ? 'bitable' : 'doc',
  };
}

/** 跑一轮：根目录 → 翻页 → 分流（文件夹不采）→ 判起点 → 落库 */
export function ingestOnce({ run = defaultRun, dryRun = false, pageSize = MAX_PAGE, maxPages = MAX_PAGES, maxNew = 200 } = {}) {
  const errors = [];
  const kinds = { doc: 0, bitable: 0, folder: 0, unknown: 0 };
  let inCount = 0; let outCount = 0; let refreshed = 0; let skipped = 0; let outOfScope = 0; let quarantined = 0;

  const ld = listAll({ pageSize, maxPages, run });
  if (ld.ok !== true) return { inCount: 0, outCount: 0, refreshed: 0, skipped: 0, outOfScope: 0, quarantined: 0, kinds, errors: [ld.why], dataAsOf: null, why: `云文档列表取不到：${ld.why}` };

  const seen = loadSeen();
  for (const f of ld.files) {
    inCount += 1;
    const type = String(f?.type ?? '').trim() || 'file';
    if (type === 'folder') { kinds.folder += 1; skipped += 1; continue; }
    const mapped = mapFile(f);
    if (mapped.ok !== true) {
      if (mapped.skip) { skipped += 1; continue; }
      quarantined += 1; errors.push(`文件 ${String(f?.token ?? '?').slice(0, 16)} 映射失败：${mapped.errors.join('；')}`); continue;
    }
    kinds[mapped.kind] = (kinds[mapped.kind] ?? 0) + 1;
    const scope = inScope('message', mapped.payload, mapped._at);
    if (!scope.inScope) { skipped += 1; outOfScope += 1; continue; }
    if (dryRun) { outCount += 1; continue; }
    if (outCount + refreshed >= maxNew) { errors.push(`达到上限 ${maxNew} 条，其余下一轮再来`); break; }

    const made = makeEvent({ type: 'message', payload: mapped.payload, origin: mapped.origin, _at: mapped._at });
    if (made.ok === false) { quarantined += 1; errors.push(`归一失败：${made.errors.join('；')}`); continue; }
    const r = store.upsert(made.event);
    if (r.action === 'rejected') { quarantined += 1; errors.push(`落库被拒：${r.reason}`); continue; }
    if (r.action === 'added') outCount += 1; else if (r.action === 'updated') refreshed += 1;
    seen[mapped.origin.messageId] = { type, at: new Date().toISOString() };
  }
  if (!dryRun) saveSeen(seen);

  return {
    inCount, outCount, refreshed, skipped, outOfScope, quarantined, kinds, errors,
    dataAsOf: new Date().toISOString(),
    why: `根目录 ${ld.pages} 页 · 文件 ${inCount} 个（文档 ${kinds.doc} · 多维表 ${kinds.bitable} · 文件夹 ${kinds.folder}（不采） · 认不出 ${kinds.unknown}）`
      + ` → 新采 ${outCount} · 刷新 ${refreshed} · 跳过 ${skipped}（其中出界 ${outOfScope}） · 隔离 ${quarantined}`
      + (ld.truncated ? ` · 翻到页数上限` : '') + (ld.partial ? ` · 中途失败：${ld.why}` : ''),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 正文抓取（需求 3.1.1/3.1.2 要的是**内容**，不只是"名字+类型"）
//
// 实测形状（2026-10-12）：
//   `lark-cli docs +fetch --doc <token> --doc-format markdown`（**参数名是 `--doc`**，不是 `--document-id`）
//   ⇒ `{ok, data:{document:{content, document_id, revision_id}}}` —— 正文在 **`document.content`**，
//     是 markdown（含 `<whiteboard token=…>` 这类内嵌块占位符，原样保留、不假装解出来了）。
//
// 三条纪律：
//   ① **按 `revision_id` 缓存** —— 同一个版本不重复抓（5 分钟一轮，10 个文档不能每轮都抓一遍）；
//   ② **落盘到知识库**（`Other/Inflow/文档/日期-标题.md`），与链接抓取同一套命名；
//   ③ **抓不到不算失败** —— 记 `failed` 并写明原因，正文留空，绝不假装有内容。
// ══════════════════════════════════════════════════════════════════════════════

export const DOCS_DIR = 'Other/Inflow/文档';
export const BODY_MAX = 1024 * 1024;          // 单篇正文上限（超过只存前 1MB 并标注截断）

export function bodyCacheFile() { return path.join(v1Out(), 'fs-doc-bodies.json'); }
export function loadBodyCache() { try { return JSON.parse(fs.readFileSync(bodyCacheFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveBodyCache(doc) {
  const f = bodyCacheFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

/** 抓一篇文档的正文 */
export function fetchDocBody({ token, run = defaultRun } = {}) {
  const r = run(['docs', '+fetch', '--doc', String(token), '--doc-format', 'markdown']);
  if (r.ok !== true) return { ok: false, why: r.why };
  const d = r.json?.data?.document;
  if (!d || typeof d.content !== 'string') return { ok: false, why: '返回里没有 data.document.content（形状变了？）' };
  return { ok: true, content: d.content, revisionId: String(d.revision_id ?? ''), documentId: String(d.document_id ?? token) };
}

/**
 * 抓一轮正文。只抓 `doc` 子通道的文件（多维表走记录段，另有其人）。
 * @param {{files?:Array, kbRoot?:string, run?:Function, dryRun?:boolean, now?:number, maxDocs?:number}} o
 */
export function fetchBodiesOnce({ files = [], kbRoot = null, run = defaultRun, dryRun = false, now = Date.now(), maxDocs = 10 } = {}) {
  const docs = files.filter((f) => String(f?.type ?? '') !== 'folder' && String(f?.type ?? '') !== 'bitable' && f?.token);
  if (docs.length === 0) return { ok: true, picked: 0, fetched: 0, cached: 0, failed: 0, savedFiles: [], errors: [], why: '没有可抓正文的文档（全部是文件夹/多维表？）' };
  if (!kbRoot && !hasKbRoot()) return { ok: false, picked: docs.length, fetched: 0, cached: 0, failed: 0, savedFiles: [], errors: [], why: '没有知识库根，正文抓回来没处放（设 WB_V1_KB_ROOT）' };
  const root = kbRoot ?? KB_ROOT;
  const cache = loadBodyCache();

  let fetched = 0; let cachedCount = 0; let failed = 0; const errors = []; const savedFiles = [];
  for (const f of docs.slice(0, maxDocs)) {
    const key = `fs-drive-${f.token}`;
    const body = fetchDocBody({ token: f.token, run });
    if (body.ok !== true) {
      failed += 1; errors.push(`${String(f.name ?? f.token).slice(0, 30)} ⇒ ${body.why}`);
      cache[key] = { ...(cache[key] ?? {}), lastError: body.why, lastTryAt: new Date(now).toISOString() };
      continue;
    }
    if (cache[key]?.revisionId && cache[key].revisionId === body.revisionId && cache[key].saved) {
      cachedCount += 1; continue;                                   // ① 同版本不重复抓
    }
    const truncated = body.content.length > BODY_MAX;
    const text = truncated ? body.content.slice(0, BODY_MAX) : body.content;
    const date = (() => {                                   // ★ 必须用**本地日期**：`toISOString()` 是 UTC，
      const d = new Date(now);                              //   在东八区会把文件名日期减一天（真跑踩到：10-12 存成 10-11）
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    })();
    const name = suggestDocName({ date, topic: String(f.name ?? '未命名') })
      .replace(/\.md$/, '.md');                                     // 与链接抓取同一套命名（日期+主题）
    if (!dryRun) {
      const dest = path.join(root, DOCS_DIR, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // ★★ 2026-10-12 加（**和钉钉知识库正文同一类问题：同名覆盖、内容无声消失**）：
      //   命名规则是"日期 + 主题"（需求 3.1.2 要的就是这个），可**同一天里同名文档是常事**
      //   （实测钉钉那边一次就撞上三篇都叫「工具方法论」，后写的把先写的盖掉，
      //     目录里最后只剩一个文件，另外两篇内容没了、而且没有任何提示）。
      //   这条路原来也是直接 `writeFileSync(dest)` ⇒ 同样的隐患。
      //   ⇒ 落盘前先让名：已存在就用 **file_token 前 8 位**区分（token 才是身份，文件名不是）。
      //     宁可名字多一截，也不丢内容。
      let finalDest = dest;
      if (fs.existsSync(finalDest)) {
        const short = String(f.file_token ?? f.token ?? key ?? '').slice(0, 8) || String(Date.now()).slice(-8);
        const withId = dest.replace(/\.md$/i, `-${short}.md`);
        finalDest = withId;
        let n = 2;
        while (fs.existsSync(finalDest)) finalDest = withId.replace(/\.md$/i, `-${n++}.md`);
      }
      fs.writeFileSync(finalDest, text, 'utf8');
      const relName = path.basename(finalDest);
      cache[key] = { revisionId: body.revisionId, saved: `${DOCS_DIR}/${relName}`, bytes: text.length, truncated, at: new Date(now).toISOString() };
      savedFiles.push(`${DOCS_DIR}/${relName}`);
    }
    fetched += 1;
  }
  if (!dryRun) saveBodyCache(cache);
  return {
    ok: true, picked: docs.length, fetched, cached: cachedCount, failed, savedFiles, errors,
    why: `可抓文档 ${docs.length} 篇 → 本轮实抓 ${fetched} · 命中缓存跳过 ${cachedCount} · 失败 ${failed}`
      + (docs.length > maxDocs ? ` · 其余 ${docs.length - maxDocs} 篇下一轮` : '') + (dryRun ? ' · 干跑（不落盘）' : ''),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（注入假 run）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const os = await import('node:os');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-fsdrive-'));
  process.env.WB_V1_OUT = tmp;

  const NOW = Date.parse('2026-10-12T12:00:00+08:00');
  const SEC = Math.floor(NOW / 1000);
  const F = (token, name, type, createdSec, extra = {}) => ({ token, name, type, created_time: createdSec, modified_time: createdSec + 10, url: `https://x.feishu.cn/${type}/${token}`, owner_id: 'ou_x', parent_token: 'root', ...extra });
  const runWith = (pages) => (args) => {
    if (args[2] === '/open-apis/drive/explorer/v2/root_folder/meta') return { ok: true, json: { ok: true, data: { token: 'ROOT' } } };
    if (String(args[2]).startsWith('/open-apis/drive/v1/files')) {
      // ⚠️ 2026-10-12：升级 1.0.97 后**参数从 URL 挪到 `--params` JSON**，夹具也必须跟着改 ——
      //   第一版仍从 `args[2]` 里正则抓 `page_token` ⇒ 永远抓到空 ⇒ 每轮都返回第一页 ⇒
      //   翻到 `maxPages` 上限、返回 5 条（FSD-13 红）。**这是夹具错，不是实现错。**
      const pi = args.indexOf('--params');
      const params = pi >= 0 ? JSON.parse(args[pi + 1]) : {};
      const idx = params.page_token ? Number(params.page_token) : 0;
      const page = pages[idx];
      if (!page) return { ok: true, json: { ok: true, data: { files: [], has_more: false } } };
      const hasMore = idx + 1 < pages.length;
      return { ok: true, json: { ok: true, data: { files: page, has_more: hasMore, next_page_token: hasMore ? String(idx + 1) : null } } };
    }
    return { ok: false, why: '未预期参数：' + args.join(' ') };
  };

  try {
    // ① 取根目录 token 与列文件
    const rt = rootFolderToken({ run: runWith([[]]) });
    chk('FSD-1', '★ 取到根目录 token', rt.ok === true && rt.token === 'ROOT', JSON.stringify(rt));
    const lf = listFiles({ run: runWith([[F('t1', 'a', 'docx', SEC)]] ) });
    chk('FSD-2', '★ 列出文件（走原始 API）', lf.ok === true && lf.files.length === 1 && lf.folderToken === 'ROOT', JSON.stringify({ n: lf.ok ? lf.files.length : null }));

    // ② 时间：秒 → 毫秒（这一条最容易错）
    const m = mapFile(F('t1', '讲师预约管理系统', 'docx', SEC));
    chk('FSD-3', '★★ 时间按**秒**处理并转成毫秒（不是当毫秒用）', m._at === SEC * 1000, `${m._at} vs ${SEC * 1000}`);
    chk('FSD-4', '★ 幂等键 = fs-drive-<token>', m.origin.messageId === 'fs-drive-t1');
    chk('FSD-5', '★ 普通文档走子通道 doc', m.payload.source === 'doc' && /飞书文档/.test(m.payload.raw), JSON.stringify(m.payload));
    const mb = mapFile(F('b1', '邮件追踪表', 'bitable', SEC));
    chk('FSD-6', '★ 多维表走子通道 bitable（同一份列表里就能认出来）', mb.payload.source === 'bitable' && /飞书多维表/.test(mb.payload.raw), JSON.stringify(mb.payload));
    chk('FSD-7', '★ 文件夹不是内容 ⇒ 明确 skip（不是报错）', mapFile(F('f1', '某目录', 'folder', SEC)).skip === true);
    chk('FSD-8', '★ 负向对照：缺 token / 缺名字 / 时间坏 ⇒ 映射失败',
      mapFile(F('', 'x', 'docx', SEC)).ok === false && mapFile(F('t', '', 'docx', SEC)).ok === false && mapFile(F('t', 'x', 'docx', 0)).ok === false);
    chk('FSD-9', '可回查的 url/parent 留在 origin.raw', /url=https/.test(m.origin.raw) && /parent=root/.test(m.origin.raw));

    // ③ 一轮：界内两条入流、老文档出界、文件夹跳过
    const pages = [[
      F('n1', '新文档甲', 'docx', SEC - 3600),
      F('n2', '新多维表乙', 'bitable', SEC - 1800),
      F('o1', '八月的老文档', 'docx', Math.floor(Date.parse('2026-08-20T10:00:00+08:00') / 1000)),
      F('d1', '某个文件夹', 'folder', SEC - 600),
    ]];
    const r1 = ingestOnce({ run: runWith(pages) });
    chk('FSD-10', '★ 认种类齐全（文档/多维表/文件夹）', r1.kinds.doc === 2 && r1.kinds.bitable === 1 && r1.kinds.folder === 1, JSON.stringify(r1.kinds));
    chk('FSD-11', '★ 两条入流、老文档出界、文件夹不采', r1.outCount === 2 && r1.outOfScope === 1 && store.list({ type: 'message' }).length === 2, JSON.stringify({ out: r1.outCount, oos: r1.outOfScope, total: store.list({ type: 'message' }).length }));

    // ④ 幂等
    const r2 = ingestOnce({ run: runWith(pages) });
    chk('FSD-12', '★ 第二轮幂等：不新建', r2.outCount === 0 && store.list({ type: 'message' }).length === 2, JSON.stringify({ out: r2.outCount }));

    // ⑤ 翻页
    const multi = [[F('p1', 'p1', 'docx', SEC - 100)], [F('p2', 'p2', 'sheet', SEC - 100)], [F('p3', 'p3', 'slides', SEC - 100)]];
    const la = listAll({ run: runWith(multi), maxPages: 5 });
    chk('FSD-13', '★ 翻页取全（三页都取到）', la.ok === true && la.files.length === 3 && la.pages === 3, JSON.stringify({ n: la.files.length, pages: la.pages }));
    const la2 = listAll({ run: runWith(multi), maxPages: 2 });
    chk('FSD-14', '★ 页数上限守住并标记', la2.files.length === 2 && la2.truncated === true, JSON.stringify({ n: la2.files.length, truncated: la2.truncated }));
    const over = listFiles({ pageSize: 50, run: runWith([[]]) });
    chk('FSD-15', '★ 页大小超上限 ⇒ 不发请求', over.ok === false && /上限/.test(over.why), over.why);

    // ⑥ 失败路径分得清
    const rBad = ingestOnce({ run: (a) => (a[2] && String(a[2]).includes('root_folder') ? { ok: true, json: { ok: true, data: {} } } : { ok: false, why: 'x' }) });
    chk('FSD-16', '★ 根目录 token 拿不到 ⇒ 说清楚（不写成"没有文档"）', /云文档列表取不到/.test(rBad.why) && /根目录 token/.test(rBad.why), rBad.why);
    const rBad2 = ingestOnce({ run: () => ({ ok: false, why: 'lark-cli 报错：invalid access token' }) });
    chk('FSD-17', '★ 列文件失败 ⇒ 写明原因', /云文档列表取不到/.test(rBad2.why), rBad2.why);

    // ⑦ 命令拼装的引号规则：**已搬到公共件的自检里**（`collector/cli.mjs` 的 CLI-1..8）。
    //   ⇒ 这里不重复断言（同一条规则两处测 = 迟早两处不一致）。
    //   起因：真跑踩到"含 `&` 的参数没加引号 ⇒ PowerShell 整条解析失败"，统一后规则只有一份。

    // ⑧ 正文抓取（需求 3.1.1/3.1.2 要的是内容）
    {
      let calls = 0;
      const bodyRun = (args) => {
        calls += 1;
        if (args[1] === '+fetch') {
          // ⚠️ 第一版这里判的是 `String(args[3]).includes('bad')`，而坏文档的 token 是 `T2` ⇒ 它被当成好的抓成功了，
          //   于是"失败要如实记"这条检查红着（**夹具写错，不是实现错** —— 但红就是红，改成按 token 判）。
          if (String(args[3]) === 'T2') return { ok: false, why: 'lark-cli 报错：permission denied' };
          return { ok: true, json: { ok: true, data: { document: { content: '# 标题\n\n正文甲', document_id: args[3], revision_id: 'rev-1' } } } };
        }
        return { ok: false, why: '未预期：' + args.join(' ') };
      };
      const fb = fetchDocBody({ token: 'T1', run: bodyRun });
      chk('FDB-1', '★ 正文取得到（在 data.document.content，是 markdown）', fb.ok === true && /正文甲/.test(fb.content) && fb.revisionId === 'rev-1', JSON.stringify(fb).slice(0, 110));

      const files = [F('T1', '智能纪要甲', 'docx', SEC - 100), F('T2', '坏文档', 'docx', SEC - 100)];
      calls = 0;
      const r1 = fetchBodiesOnce({ files, kbRoot: tmp, run: bodyRun, now: NOW });
      chk('FDB-2', '★ 一轮：抓到正文（失败的那篇如实记下原因，不假装有）', r1.fetched === 1 && r1.failed === 1 && /permission denied/.test(r1.errors[0]), JSON.stringify({ f: r1.fetched, bad: r1.failed }));
      const destDir = path.join(tmp, DOCS_DIR);
      const saved = fs.existsSync(destDir) ? fs.readdirSync(destDir) : [];
      chk('FDB-3', '★ 正文落盘到知识库，命名 = 日期-主题.md（与链接抓取同一套）', saved.length === 1 && /^\d{4}-\d{2}-\d{2}-.*\.md$/.test(saved[0]), JSON.stringify(saved));
      chk('FDB-4', '落盘内容就是正文', saved.length === 1 && /正文甲/.test(fs.readFileSync(path.join(destDir, saved[0]), 'utf8')));

      const before = calls;
      const r2 = fetchBodiesOnce({ files: [files[0]], kbRoot: tmp, run: bodyRun, now: NOW });
      chk('FDB-5', '★ 同一版本不重复抓（按 revision_id 命中缓存）', r2.cached === 1 && r2.fetched === 0 && calls > before, JSON.stringify({ cached: r2.cached, fetched: r2.fetched }));

      const nBefore = fs.readdirSync(destDir).length;
      fetchBodiesOnce({ files: [F('T9', '干跑不该写', 'docx', SEC)], kbRoot: tmp, run: bodyRun, dryRun: true, now: NOW });
      chk('FDB-6', '干跑不落盘', fs.readdirSync(destDir).length === nBefore);

      // ★★ 2026-10-12 加（**同名覆盖，内容无声消失** —— 这一类在三条路上都出现过）：
      //   命名是"日期 + 主题"，同一天两篇同名文档是常事 ⇒ 直接 writeFileSync 会让后写的盖掉先写的。
      //   这条检查就是钉住"同名不覆盖"：喂两篇**同一天、同名字**的文档，磁盘上必须**两个文件都在**，
      //   而且**内容各自还在**（只数文件个数不够 —— 覆盖了也可能因为名字不同而显得多）。
      //   ⚠️ 我第一版试数据没造对，白红了一次，记下来：让名用的是 **`token`**，
      //     而我只给了 `revision_id` 没给 `token` ⇒ 两次算出的短号都退到同一个兜底值，
      //     两篇的正文变得一模一样，"互不覆盖"这条自然不成立。**试数据必须让每个样本都能被区分开。**
      const twinRun = (args) => {
        const tok = /--doc\s+(\S+)/.exec(args.join(' '))?.[1] ?? 'x';
        return { ok: true, json: { ok: true, data: { document: { content: `# 正文-${tok}\n\n这是 ${tok} 的内容。`, revision_id: `rev-${tok}` } } } };
      };
      const nTwin = fs.readdirSync(destDir).length;
      fetchBodiesOnce({
        files: [F('T7a', '同名文档', 'docx', SEC), F('T7b', '同名文档', 'docx', SEC)],
        kbRoot: tmp, run: twinRun, now: NOW,
      });
      const twinFiles = fs.readdirSync(destDir);
      const twinNew = twinFiles.filter((f) => /同名文档/.test(f));
      const twinContents = twinNew.map((f) => fs.readFileSync(path.join(destDir, f), 'utf8'));
      chk('FDB-7', '★★ 同一天两篇同名文档 ⇒ **两个文件都在，内容互不覆盖**',
        twinNew.length === 2 && twinFiles.length === nTwin + 2
        && twinContents.some((t) => /T7a/.test(t)) && twinContents.some((t) => /T7b/.test(t)),
        JSON.stringify({ 新增文件: twinNew, 总文件: twinFiles.length, 内容: twinContents.map((t) => t.slice(0, 24)) }));
    }

    // ⑨ 干跑不写盘
    const before = store.list({ type: 'message' }).length;
    ingestOnce({ run: runWith(pages), dryRun: true });
    chk('FSD-18', '干跑不写盘', store.list({ type: 'message' }).length === before);
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
