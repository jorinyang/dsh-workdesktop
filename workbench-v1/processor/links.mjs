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
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

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
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
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
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
