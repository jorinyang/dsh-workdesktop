/**
 * v1/collector/minutes.mjs —— **钉钉听记 → v1 笔记事件**（P1-5 的 A 类：复用现有引擎）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 复用哪一部分（需求 2 说"把当前引擎中可用部分功能提取出来"）
 *   取数/镜像/幂等/水位线不冒进 —— 这些**已经在 `minutes-sync.mjs` 里做对了**，不重写。
 *   本文件只补**缺失的最后一段**：把镜像出来的 MD **映射成 v1 笔记事件**。
 *
 * 镜像文件的实际形状（实测，不是猜的）
 *   文件名：`听记_<YYYY-MM-DD>_<HHmm>_<标题>_<hash8>.md`
 *   正文：`# <标题>` · `- 时间：YYYY-MM-DD HH:mm` · `- 时长：N 分钟`
 *         · `- 来源：钉钉听记（dws minutes）｜taskUuid \`…\`` · `- 原链接：…`
 *         · `## 关键词`（` · ` 分隔）· `## 摘要` · …
 *
 * 幂等键：文件名里的 `<hash8>`（由 taskUuid 派生，同一场听记恒定）
 *   ⇒ 重复扫描同一份 MD 不会产生第二条笔记（事件层 originKey 挡住）。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { get as getState, advanceIfClean } from './state.mjs';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const STATE_KEY = 'dd-minutes';
/** 镜像目录（与 `minutes-sync.mjs` 的 MIRROR_REL 同一处 —— 单一真相源，别改一处） */
export const MIRROR_REL = 'Other/Input/钉钉听记';
export function mirrorDir() { return process.env.WB_V1_MINUTES_DIR || path.join(ROOT, MIRROR_REL); }

/** 解析镜像文件名：`听记_2026-10-08_1554_10-08 示例客户甲…_33deb2a9.md` */
export function parseMirrorName(name) {
  const m = /^听记_(\d{4}-\d{2}-\d{2})_(\d{4})_(.+)_([0-9a-f]{6,12})\.md$/.exec(String(name));
  if (!m) return null;
  return { date: m[1], hhmm: m[2], title: m[3], hash: m[4] };
}

/** 从正文里补取结构化字段（标题/时间/关键词/原链接）——取不到就如实为 null，不编 */
export function parseMinutesMd(text) {
  const s = String(text ?? '');
  const pick = (re) => { const m = re.exec(s); return m ? m[1].trim() : null; };
  const kw = pick(/##\s*关键词\s*\n+([^\n#]+)/);
  return {
    title: pick(/^#\s+(.+)$/m),
    time: pick(/^-\s*时间：\s*(.+)$/m),
    keywords: kw ? kw.split(/\s*·\s*/).map((x) => x.trim()).filter(Boolean) : [],
    url: pick(/^-\s*原链接：\s*(\S+)$/m),
  };
}

/**
 * 跑一轮。
 * @param {{since?:string|number|null, dryRun?:boolean, maxNew?:number}} o
 * @returns {{inCount:number,outCount:number,skipped:number,quarantined:number,errors:string[],dataAsOf:string|null,why?:string,truncated:boolean}}
 */
export function ingestOnce({ since = null, dryRun = false, maxNew = 200 } = {}) {
  const errors = [];
  const sinceMs = since === null ? null : (typeof since === 'number' ? since : Date.parse(String(since).replace(' ', 'T')));
  let inCount = 0; let outCount = 0; let skipped = 0; let quarantined = 0;

  if (!fs.existsSync(mirrorDir())) {
    return { inCount: 0, outCount: 0, skipped: 0, quarantined: 0, errors, dataAsOf: null, truncated: false, why: `镜像目录不存在：${MIRROR_REL}` };
  }
  const files = fs.readdirSync(mirrorDir()).filter((f) => f.endsWith('.md'));
  let maxAt = null;
  let truncated = false;

  for (const f of files) {
    inCount += 1;
    const meta = parseMirrorName(f);
    if (!meta) { quarantined += 1; continue; }                    // 命名不合规 ⇒ 留证不猜
    const at = Date.parse(`${meta.date}T${meta.hhmm.slice(0, 2)}:${meta.hhmm.slice(2)}:00`);
    if (!Number.isFinite(at)) { quarantined += 1; continue; }
    if (sinceMs !== null && at < sinceMs) { skipped += 1; continue; }   // Q18 起点之前 ⇒ 只读，不入流
    if (outCount >= maxNew) { truncated = true; break; }               // 上限保护：宁可下一轮再来

    let body = '';
    try { body = fs.readFileSync(path.join(mirrorDir(), f), 'utf8'); } catch (e) { errors.push(`读 ${f} 失败：${e.message}`); continue; }
    const parsed = parseMinutesMd(body);
    const topic = parsed.title || meta.title || f.replace(/\.md$/, '');
    maxAt = Math.max(maxAt ?? 0, at);

    const made = makeEvent({
      type: 'note',
      payload: {
        topic,
        date: meta.date,                                   // 需求 3.1.4：时间（YYYY-MM-DD）
        content_md: body,                                  // 需求 3.1.4：内容（md 格式）
        tags: parsed.keywords,
        source: 'minutes',
      },
      origin: {
        channel: 'dingtalk',
        sender: '钉钉听记',
        messageId: meta.hash,                              // 幂等键：同一场听记恒定
        raw: parsed.url ?? f,
      },
      _at: at,
    });
    if (made.ok === false) { quarantined += 1; errors.push(`听记 ${f} 归一失败：${made.errors.join('；')}`); continue; }
    if (dryRun) { outCount += 1; continue; }
    const r = store.upsert(made.event);
    if (r.action === 'rejected') { quarantined += 1; errors.push(`听记 ${f} 落库被拒：${r.reason}`); continue; }
    if (r.action === 'added') outCount += 1;
  }

  const dataAsOf = maxAt ? new Date(maxAt).toISOString() : null;
  if (!dryRun) advanceIfClean(STATE_KEY, { inCount, outCount, errors, truncated, dataAsOf, extra: { files: files.length, skipped, quarantined } });
  return { inCount, outCount, skipped, quarantined, errors, dataAsOf, truncated, why: truncated ? `达到本轮上限 ${maxNew}，余量留给下一轮` : null };
}
