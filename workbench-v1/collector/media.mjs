/**
 * v1/collector/media.mjs —— **多媒体下载通道**（P1-7 的 hook 实现，需求 2.2"图片视频则转为文件"）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 实测确认（2026-10-12，用排队里的真实媒体跑通）：
 *   `dws chat message download-media --type mediaId --resource-id <mediaId>
 *        --message-id <messageId> --open-conversation-id <conversationId> --output <dir>`
 *   · 事件里的 `message_id` / `conversation_id` **就是** CLI 要的 open 形态 —— **不需要转换**
 *     （这是接线前必须先验的一个参数，验完才动手，否则接上去也是白跑）；
 *   · 成功时 stdout 是一段 JSON：`{"downloadUrl":…, "output":…, "success":true}`；
 *   · `--output` 给**目录**时会按 URL 自动命名（保留原扩展名）。
 *
 * 为什么用 powershell 包一层而不是直接 spawn `dws`：
 *   本机 `dws` 是 PowerShell 垫片（.ps1），Node 直接 spawn 走不到；用 `-Command` 单引号包参，
 *   参数里的 `$`、`+`、`/`、`=` 都安全（已实测）。
 *
 * 落盘位置：**直接进知识库**（需求 3.1.1"保存到知识库对应目录"）——
 *   走 `processor/kb.mjs` 的目录规则（单一来源），命中客户则进客户目录、否则 `Other/Inflow/文件/<月>/`。
 *   这样"归档"这一步天然完成，不需要事后再搬一遍。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { kbRoot, resolveDir, ym } from '../processor/kb.mjs';

const PS = 'powershell.exe';

/** 解析 CLI 的 JSON 输出（宽松：容忍前置噪声） */
export function parseDwsJson(s) {
  const t = String(s ?? '');
  const i = t.indexOf('{'); const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}

/**
 * 造一个下载 hook（供 `modality.convert` 注入）。
 * @param {{dirRel?:string|null, timeoutSec?:number}} o
 * @returns {(mediaId:string, ctx:object) => {ok:boolean, path?:string, why?:string}}
 */
export function dwsDownloadHook({ dirRel = null, timeoutSec = 120 } = {}) {
  return (mediaId, ctx = {}) => {
    if (!mediaId) return { ok: false, why: '没有 mediaId' };
    const mid = ctx.messageId; const cid = ctx.conversationId;
    if (!mid || !cid) return { ok: false, why: '缺 messageId / conversationId（download-media 必需）' };

    const rel = dirRel ?? `${resolveDir({ kind: 'file' })}/${ym(ctx.at ?? Date.now())}`;
    const dir = path.join(kbRoot(), rel);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, why: `建目录失败：${e.message}` }; }

    const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
    const cmd = `dws chat message download-media --type mediaId --resource-id ${q(mediaId)} --message-id ${q(mid)} --open-conversation-id ${q(cid)} --output ${q(dir + path.sep)}`;
    const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 });
    const out = String(r.stdout ?? ''); const err = String(r.stderr ?? '');
    const j = parseDwsJson(out) ?? parseDwsJson(err);
    if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
    if (!j) return { ok: false, why: `CLI 无 JSON 输出（exit=${r.status}）：${(err || out).slice(0, 200)}` };
    if (j.success !== true || !j.output) return { ok: false, why: `下载未成功：${j.message ?? JSON.stringify(j).slice(0, 200)}` };
    // j.output 是绝对路径（CLI 回报），转成相对知识库根的引用存进事件
    const abs = path.resolve(String(j.output));
    const relOut = path.relative(kbRoot(), abs).split(path.sep).join('/');
    if (!fs.existsSync(abs)) return { ok: false, why: `CLI 报成功但文件不存在：${relOut}` };
    return { ok: true, path: relOut };
  };
}

/** 只判断通道是否可用（不下载）—— 供健康检查 */
export function downloadChannelAvailable() {
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'dws chat message download-media --help'], { encoding: 'utf8', timeout: 30_000 });
  return String(r.stdout ?? '').includes('download-media');
}
