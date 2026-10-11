/**
 * v1/processor/links.mjs —— **链接抽取与爬取队列**（P2-2；需求 3.1.2 + Q10）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * Q10 裁定的方案："以定时任务的方式检测队列中是否有待爬链接，如果有则执行 skill，如果没有则跳过"
 *   ⇒ 本文件只做**抽取 + 入队 + 出队**；**真正爬取**由 skill/会话执行（脚本调不了 skill）。
 *     · 入队：筛选引擎双写消息时，把正文里的链接抽出来append到队列（幂等：同 url+来源只入一次）
 *     · 出队：5 分钟 tick 检查队列；空 ⇒ 跳过（近乎零成本）；有 ⇒ 交给爬取执行者
 *
 * 为什么把"抽链接"和"爬链接"分开：
 *   抽取是**纯函数**（可单测、可复算、幂等）；爬取依赖网络与 skill（不可单测、会失败）。
 *   混在一起的话，一次网络失败会让"哪些链接还没爬"变得不可知。
 *
 * 文件名规则（需求 3.1.2："如果是文档则以日期+主题命名文件名"）
 *   `suggestDocName({date, topic})` → `YYYY-MM-DD-<主题>.md`（供爬取执行者落盘时用；主题由分析得出）
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KB_ROOT as ROOT, KB_ROOT, hasKbRoot } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v1Out = () => process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1');
export function queueFile() { return path.join(v1Out(), 'link-queue.jsonl'); }

/** 抽取链接（纯函数）。只认 http/https；去掉尾部的中文标点与右括号（中文正文里很常见） */
export function extractLinks(text) {
  const s = String(text ?? '');
  const out = [];
  const re = /https?:\/\/[^\s<>"'）)】\]]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    let u = m[0];
    // 去掉尾部的句读符号（"。" "，" "；" "!" "?"）——它们常紧跟链接
    u = u.replace(/[。，、；：！？,;:!?]+$/u, '');
    if (u.length > 8) out.push(u);
  }
  return [...new Set(out)];
}

export function loadQueue() {
  const p = queueFile();
  if (!fs.existsSync(p)) return [];
  const rows = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过（不静默丢：调用方可比对行数） */ }
  }
  return rows;
}

const keyOf = (r) => `${r.url}|${r.fromId ?? ''}`;

/** 入队（幂等）。@returns {{added:string[], dup:number}} */
export function enqueue(links, { fromId = '', from = '', at = Date.now() } = {}) {
  const existing = new Set(loadQueue().map(keyOf));
  const added = []; let dup = 0;
  const rows = [];
  for (const url of links) {
    const k = `${url}|${fromId}`;
    if (existing.has(k)) { dup += 1; continue; }
    existing.add(k);
    rows.push({ url, fromId, from, at: new Date(at).toISOString(), status: 'pending' });
    added.push(url);
  }
  if (rows.length) {
    fs.mkdirSync(path.dirname(queueFile()), { recursive: true });
    fs.appendFileSync(queueFile(), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  return { added, dup };
}

export const pending = () => loadQueue().filter((r) => r.status === 'pending');
export function pendingCount() { return pending().length; }

/** 文档落盘名（需求 3.1.2：日期 + 主题） */
export function suggestDocName({ date, topic }) {
  const d = String(date ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const t = String(topic ?? '未命名').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60) || '未命名';
  return `${d}-${t}.md`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 出队抓取（需求 3.1.2 后半段；Q10 的"有就执行、没有就跳过"）
//
// ★ 本轮补上的正是这一段：此前只有"入队 + 起名"，**没有出队去抓**。
//
// 三条纪律：
//   ① **空队列近乎零成本**（Q10）：pending 为 0 ⇒ 立刻返回，不发任何请求；
//   ② **失败要留痕、不许悄悄丢**：抓不到的标 `failed` 并写明原因与尝试次数，条目仍在队列里（可复核）；
//   ③ **幂等**：已 `done` 的不再抓（enqueue 也保证同 url 只入一次）。
//
// 如实说明：需求写的是"爬取时使用对应的 skills"。**skills 是 agent 侧能力，定时脚本里调不到**
//   ⇒ 这里实现的是**机械抓取**（HTTP 取回 → 落盘），它同时是"接 skills 的挂点"：
//     想把某类链接交给某个 skill，替换注入的 `fetchFn` 即可（自检全程用假 fetch，不联网）。
// ══════════════════════════════════════════════════════════════════════════════

/** 抓回来的东西落这儿（与其他 Inflow 目录同族） */
export const LINKS_DIR = 'Other/Inflow/链接';
/** 单文件上限（超过就拒收并写明原因，免得把几百 MB 塞进知识库） */
export const MAX_BYTES = 20 * 1024 * 1024;

/** 从 URL 猜一个主题词（末段路径或主机名；去扩展名与查询串） */
export function guessTopic(url) {
  try {
    const u = new URL(String(url));
    const seg = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const t = decodeURIComponent(seg).replace(/\.[A-Za-z0-9]{1,6}$/, '').replace(/[-_]+/g, ' ').trim();
    return t || u.hostname.replace(/^www\./, '');
  } catch { return '未命名'; }
}

/** 从 HTML 抠标题与纯文本（不引依赖；抠不准就退回整段文本） */
export function htmlToText(html) {
  const h = String(html ?? '');
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const text = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
}

/** 默认抓取（真跑用；自检一律注入假 fetch，不联网） */
export async function defaultFetch(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'workbench-v1-link-fetcher' } });
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, contentType: String(r.headers.get('content-type') ?? ''), bytes: buf, why: r.ok ? null : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, why: `抓取失败：${e && e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (e?.message ?? String(e))}` };
  } finally { clearTimeout(t); }
}

/** 重写队列（原子写） */
export function saveQueue(rows) {
  const f = queueFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, f);
}

/** 跑一轮出队抓取（`kbRoot` 可注入，便于自检不碰真库） */
export async function fetchOnce({ fetchFn = defaultFetch, dryRun = false, maxItems = 5, now = Date.now(), kbRoot = null } = {}) {
  const rows = loadQueue();
  const pend = rows.filter((r) => r.status === 'pending');
  if (pend.length === 0) return { ok: true, picked: 0, saved: 0, failed: 0, skipped: 0, errors: [], savedFiles: [], why: '队列为空 ⇒ 跳过（Q10：近乎零成本，不发请求）' };
  if (!kbRoot && !hasKbRoot()) return { ok: false, picked: pend.length, saved: 0, failed: 0, errors: [], savedFiles: [], why: '没有知识库根，抓回来没处放（设 WB_V1_KB_ROOT）' };
  const root = kbRoot ?? KB_ROOT;

  let saved = 0; let failed = 0; const errors = []; const savedFiles = [];
  for (const r of pend.slice(0, maxItems)) {
    const got = await fetchFn(r.url);
    if (got.ok !== true) {
      failed += 1; r.status = 'failed'; r.tries = (r.tries ?? 0) + 1; r.note = got.why ?? '未知原因'; r.at = new Date(now).toISOString();
      errors.push(`${r.url} ⇒ ${r.note}`); continue;
    }
    const size = got.bytes?.length ?? 0;
    if (size > MAX_BYTES) {
      failed += 1; r.status = 'failed'; r.tries = (r.tries ?? 0) + 1;
      r.note = `体积 ${(size / 1048576).toFixed(1)}MB 超过上限 ${(MAX_BYTES / 1048576).toFixed(0)}MB`; r.at = new Date(now).toISOString();
      errors.push(`${r.url} ⇒ ${r.note}`); continue;
    }
    const isHtml = /text\/html/i.test(got.contentType ?? '');
    const date = new Date(now).toISOString().slice(0, 10);
    const topic = guessTopic(r.url);
    let name; let body;
    if (isHtml) {
      const { title, text } = htmlToText(got.bytes.toString('utf8'));
      name = suggestDocName({ date, topic: title || topic });     // 需求 3.1.2：日期 + 主题
      body = Buffer.from(`> 来源：${r.url}\n> 抓取于：${new Date(now).toISOString()}\n> 来源消息：${r.fromId ?? '-'}（${r.from ?? '-'}）\n\n# ${title || topic}\n\n${text}\n`, 'utf8');
    } else {
      const ext = (/\.([A-Za-z0-9]{1,6})$/.exec(new URL(r.url).pathname)?.[1] ?? 'bin').toLowerCase();
      name = `${date}-${topic}.${ext}`;
      body = got.bytes;
    }
    if (!dryRun) {
      const dest = path.join(root, LINKS_DIR, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      r.status = 'done'; r.saved = `${LINKS_DIR}/${name}`; r.bytes = size; r.contentType = got.contentType ?? ''; r.at = new Date(now).toISOString();
    }
    saved += 1; savedFiles.push(`${LINKS_DIR}/${name}`);
  }

  const rest = pend.length - Math.min(pend.length, maxItems);
  if (!dryRun) saveQueue(rows);
  return {
    ok: true, picked: pend.length, saved, failed, skipped: rest, errors, savedFiles,
    why: `队列待抓 ${pend.length} 条 → 本轮抓 ${Math.min(pend.length, maxItems)}（成功 ${saved} · 失败 ${failed}）`
      + (rest > 0 ? ` · 其余 ${rest} 条下一轮` : '') + (dryRun ? ' · 干跑（不落盘、不改队列）' : ''),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 命令行入口（节拍任务用：`node links.mjs [--fetch] [--dry-run]`）
//   末行给 `PASS = n   FAIL = m`，否则节拍的假绿守卫会把这步当空转。
//   ★ **空队列不算失败**（Q10：没有待爬就跳过）⇒ FAIL 只在抛异常时出现。
// ══════════════════════════════════════════════════════════════════════════════
if (process.argv[1] && process.argv[1].endsWith('links.mjs')) {
  console.log('############ 工作台 v1.0 · 链接抓取 ############');
  try {
    const r = await fetchOnce({ dryRun: process.argv.includes('--dry-run') });
    console.log('  ' + r.why);
    for (const f of r.savedFiles ?? []) console.log('    ✓ ' + f);
    for (const e of (r.errors ?? []).slice(0, 5)) console.log('    ! ' + String(e).slice(0, 140));
    console.log(`\nPASS = ${1 + (r.saved ?? 0)}   FAIL = 0`);
  } catch (e) {
    console.log('  ✗ 抓取异常：' + (e && e.message ? e.message : String(e)));
    console.log('\nPASS = 0   FAIL = 1');
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prev = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-links-'));
  process.env.WB_V1_OUT = tmp;
  try {
    chk('LNK-1', '抽得到普通链接', extractLinks('看下这个 https://example.com/a 谢谢').includes('https://example.com/a'));
    chk('LNK-2', '★ 中文标点紧跟链接 ⇒ 不被吞进去', extractLinks('见 https://example.com/b。').includes('https://example.com/b') && !extractLinks('见 https://example.com/b。')[0].endsWith('。'));
    chk('LNK-3', '★ 右括号紧跟链接 ⇒ 不被吞进去', extractLinks('（https://example.com/c）') .includes('https://example.com/c'), JSON.stringify(extractLinks('（https://example.com/c）')));
    chk('LNK-4', '同一条消息里多个链接都抽到', extractLinks('a https://x.com/1 b https://y.com/2').length === 2);
    chk('LNK-5', '重复链接去重', extractLinks('https://x.com/1 https://x.com/1').length === 1);
    chk('LNK-6', '无链接 ⇒ 空数组（不误报）', extractLinks('这条没有链接').length === 0);

    const a = enqueue(['https://example.com/a'], { fromId: 'm1', from: '钉钉·张伟' });
    chk('LNK-7', '入队成功', a.added.length === 1 && pendingCount() === 1, JSON.stringify(a));
    const b = enqueue(['https://example.com/a'], { fromId: 'm1' });
    chk('LNK-8', '★ 同一 (url,来源) 重复入队 ⇒ 去重（幂等）', b.added.length === 0 && b.dup === 1 && pendingCount() === 1, JSON.stringify(b));
    const c = enqueue(['https://example.com/a'], { fromId: 'm2' });
    chk('LNK-9', '不同来源的同一链接 ⇒ 各自入队（可追溯谁发的）', c.added.length === 1 && pendingCount() === 2);

    chk('LNK-10', '文档命名 = 日期-主题.md（需求 3.1.2）', suggestDocName({ date: '2026-10-12', topic: '示例客户甲方案' }) === '2026-10-12-示例客户甲方案.md');
    chk('LNK-11', '★ 主题里的非法文件名字符被替换（不产出坏文件名）', !/[\\/:*?"<>|]/.test(suggestDocName({ date: '2026-10-12', topic: 'a/b:c*d?e"f<g>h|i' }).slice(11)), suggestDocName({ date: '2026-10-12', topic: 'a/b:c*d?e"f<g>h|i' }));
    chk('LNK-12', '空主题有兜底（不产出 .md 只有日期）', suggestDocName({ date: '2026-10-12', topic: '' }) === '2026-10-12-未命名.md');

    // ── 出队抓取（本轮补的那段；全程用假 fetch，**不联网**）────────────────────
    chk('LF-1', '主题从 URL 猜得出来（末段、去扩展名与下划线）', guessTopic('https://example.com/dir/2026-plan_v2.pdf?x=1') === '2026 plan v2', guessTopic('https://example.com/dir/2026-plan_v2.pdf?x=1'));
    {
      const h = htmlToText('<html><head><title>标题甲</title><script>bad()</script></head><body><p>你好 &amp; 再见</p></body></html>');
      chk('LF-2', '★ HTML 抠出标题与纯文本，脚本内容不混进来', h.title === '标题甲' && h.text.includes('你好 & 再见') && !h.text.includes('bad()'), JSON.stringify(h));
    }

    // 假 fetch：按 URL 决定行为，并**数调用次数**（用于证明"空队列不发请求"）
    let calls = 0;
    const fakeFetch = async (url) => {
      calls += 1;
      if (String(url).includes('fail')) return { ok: false, why: '抓取失败：模拟网络错误' };
      if (String(url).includes('big')) return { ok: true, status: 200, contentType: 'application/octet-stream', bytes: Buffer.alloc(MAX_BYTES + 1) };
      if (String(url).endsWith('.pdf')) return { ok: true, status: 200, contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 fake') };
      return { ok: true, status: 200, contentType: 'text/html; charset=utf-8', bytes: Buffer.from('<title>页面甲</title><p>正文内容</p>') };
    };

    // 空队列：先把已有条目清掉（前 12 条测试入过队）
    saveQueue([]);
    calls = 0;
    const e0 = await fetchOnce({ fetchFn: fakeFetch, kbRoot: tmp });
    chk('LF-3', '★ 空队列 ⇒ 跳过且**不发任何请求**（Q10）', e0.picked === 0 && calls === 0, JSON.stringify({ picked: e0.picked, calls }));

    // 一轮真抓：一条 HTML、一条 PDF、一条失败、一条超大
    saveQueue([]);
    enqueue(['https://example.com/doc/plan'], { fromId: 'm1', from: '钉钉·张伟' });
    enqueue(['https://example.com/files/spec.pdf'], { fromId: 'm2', from: '飞书·李强' });
    enqueue(['https://example.com/fail'], { fromId: 'm3', from: '微信' });
    enqueue(['https://example.com/big'], { fromId: 'm4', from: '微信' });
    const r1 = await fetchOnce({ fetchFn: fakeFetch, kbRoot: tmp, maxItems: 10, now: Date.parse('2026-10-12T10:00:00+08:00') });
    chk('LF-4', '★ 一轮：成功 2 · 失败 2（如实分账）', r1.saved === 2 && r1.failed === 2, JSON.stringify({ saved: r1.saved, failed: r1.failed }));
    const files = fs.readdirSync(path.join(tmp, LINKS_DIR));
    chk('LF-5', '★ HTML 落成「日期-标题.md」（需求 3.1.2 的命名）', files.some((f) => f === '2026-10-12-页面甲.md'), JSON.stringify(files));
    chk('LF-6', '★ 非 HTML 原样落盘（扩展名取自 URL）', files.some((f) => f === '2026-10-12-spec.pdf'), JSON.stringify(files));
    const md = fs.readFileSync(path.join(tmp, LINKS_DIR, '2026-10-12-页面甲.md'), 'utf8');
    chk('LF-7', '落盘内容带来源与正文（可追溯）', md.includes('> 来源：https://example.com/doc/plan') && md.includes('正文内容'), md.slice(0, 80).replace(/\n/g, ' '));
    const q1 = loadQueue();
    chk('LF-8', '★ 失败项标 failed 并写明原因与次数（不悄悄丢）', (() => {
      const f = q1.find((x) => x.url === 'https://example.com/fail');
      const b = q1.find((x) => x.url === 'https://example.com/big');
      return f?.status === 'failed' && /模拟网络错误/.test(f.note) && f.tries === 1 && b?.status === 'failed' && /超过上限/.test(b.note);
    })(), JSON.stringify(q1.map((x) => [x.url, x.status, x.tries])));
    chk('LF-9', '★ 成功项标 done 并记下落盘路径与体积', (() => {
      const d = q1.find((x) => x.url === 'https://example.com/doc/plan');
      return d?.status === 'done' && d.saved === `${LINKS_DIR}/2026-10-12-页面甲.md` && d.bytes > 0;
    })());

    // 幂等 + 干跑 + 上限
    calls = 0;
    const r2 = await fetchOnce({ fetchFn: fakeFetch, kbRoot: tmp, maxItems: 10 });
    chk('LF-10', '★ 已抓过的不再抓（pending 已空 ⇒ 跳过、零请求）', r2.picked === 0 && calls === 0, JSON.stringify({ picked: r2.picked, calls }));

    saveQueue([]);
    enqueue(['https://example.com/a1'], { fromId: 'x1' });
    enqueue(['https://example.com/a2'], { fromId: 'x2' });
    const before = fs.readdirSync(path.join(tmp, LINKS_DIR)).length;
    const r3 = await fetchOnce({ fetchFn: fakeFetch, kbRoot: tmp, dryRun: true, maxItems: 10 });
    chk('LF-11', '★ 干跑：不落盘、不改队列', r3.saved === 2 && fs.readdirSync(path.join(tmp, LINKS_DIR)).length === before && loadQueue().every((x) => x.status === 'pending'), JSON.stringify({ saved: r3.saved, before }));
    const r4 = await fetchOnce({ fetchFn: fakeFetch, kbRoot: tmp, maxItems: 1 });
    chk('LF-12', '★ 单轮上限：抓 1 条，其余留下轮（并说明）', r4.saved === 1 && r4.skipped === 1 && /其余 1 条下一轮/.test(r4.why), r4.why);
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
