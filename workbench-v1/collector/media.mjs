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

    const rel = dirRel ?? `${resolveDir({ kind: 'file' })}/${ym(ctx.at ?? Date.now())}`;
    const dir = path.join(kbRoot(), rel);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, why: `建目录失败：${e.message}` }; }

    // ══════════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-15 加：**钉钉云盘那条路**（`fileId:` ⇒ `dws drive download`）。
    //
    //   来由：`deferred.jsonl` 里那 4 条含 `fileId:` 的文件一直躺着，why 是"没有 mediaId"。
    //   它们**不是聊天媒体** —— 提示语自己就写了该用哪条命令：
    //     `注意：如需下载使用dws drive download命令下载`
    //   实测（2026-10-15）真跑一条：
    //     `dws drive download --node QG53mjyd801qbBY3ue2M9rLqW6zbX04v --output <目录>`
    //     ⇒ 成功，落盘 `海报文案-竞品情报场景V2.md`（3506 字节）。
    //
    //   ⚠️ 两个接口**不能混用**（混了服务端会回"取不到该资源的下载地址"，那正是这 4 条的历史）：
    //     · `mediaId=` ⇒ 聊天媒体 ⇒ `dws chat message download-media --resource-id`
    //     · `fileId:`  ⇒ 钉钉云盘 ⇒ `dws drive download --node`
    //   ⚠️ 判据用 `ctx.viaDrive`（由 `modality.mjs` 明确传下来），**不靠"看这个 id 像不像"** ——
    //     两种 id 都是无规律的字母数字串，形态上分不出来；靠猜迟早猜错。
    //   ⚠️ 这条**不需要** `messageId`/`conversationId`（那是聊天媒体那条要的）——
    //     早退会让本来能下的下不来（图那条已经吃过一次这个亏）。
    // ══════════════════════════════════════════════════════════════════════════════
    if (ctx.viaDrive === true) {
      const q0 = (v) => `'${String(v).replace(/'/g, "''")}'`;
      const cmd0 = `dws drive download --node ${q0(mediaId)} --output ${q0(dir + path.sep)}`;
      const r0 = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd0],
        { encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 });
      const out0 = String(r0.stdout ?? ''); const err0 = String(r0.stderr ?? '');
      if (r0.error) return { ok: false, why: `云盘下载调用失败：${r0.error.message}` };
      // 这条命令**不回 JSON**，只打 `[INFO] 下载完成: <绝对路径>`（实测）。
      // ⚠️ 所以不能沿用下面那条"解析 JSON"的路 —— 那条在这里必然判失败，
      //   而它在上面那条（聊天媒体）是对的。两种输出格式，两套解析。
      const m0 = /下载完成[:：]\s*(.+?)\s*$/m.exec(out0) ?? /下载完成[:：]\s*(.+?)\s*$/m.exec(err0);
      if (!m0) return { ok: false, why: `云盘下载未回报完成（exit=${r0.status}）：${(err0 || out0).trim().slice(0, 200)}` };
      const abs0 = path.resolve(m0[1].trim());
      if (!fs.existsSync(abs0)) return { ok: false, why: `云盘下载回报完成但文件不存在：${abs0}` };
      return { ok: true, path: path.relative(kbRoot(), abs0).split(path.sep).join('/') };
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-15 加：**mediaId 本身是网址时，直接 HTTP 取，不交 dws**。
    //
    //   来由（这一轮要"对齐所有功能与数据链路"，这是实测断掉的一处）：
    //     `deferred.jsonl` 里有 **4 条图片**一直下不来，why 全文是
    //       `下载未成功：{"error":{"category":"api","code":1,
    //         "message":"[UNCLASSIFIED] failed to get download url for resource"}}`
    //     而它们的 `mediaId` 长这样：
    //       `https://youcheng-oct-campaign.app.workbuddy.host/xind1s2.jpg`
    //     —— **那是一个完整的网址，不是资源 id**。
    //     旧路径把它当 mediaId 交给 `dws chat message download-media --resource-id`，
    //     而那个接口要的是钉钉侧的**资源 id**（形如 `$iwEc…` / `@lQL…`）；
    //     拿一个网址去问，服务端自然回"取不到该资源的下载地址"。
    //
    //   实测（2026-10-15）：那 4 个网址**直接取就 200**、`content-type: image/jpeg`、各约 240 KB。
    //     ⇒ 它们**根本不需要 dws** —— 多绕一层反而必然失败。
    //
    //   ⚠️ 判据用 `^https?://`，**不猜"像不像网址"**：钉钉资源 id 带 `$`/`@`/`=`，与网址形态不会混。
    //   ⚠️ **不要**在这一支上要求 `mid/cid` —— 这条路上它们用不上，
    //     早退（放在下面那两行之后）会让本来能下的下不来。
    //   ⚠️ 文件名从 URL 末段取、去查询串；取不到或没有扩展名就按"下载-<时间>"兜底（不产坏文件名）。
    // ══════════════════════════════════════════════════════════════════════════════
    if (/^https?:\/\//i.test(mediaId)) {
      const base = (() => {
        try {
          const u = new URL(mediaId);
          const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
          return last.replace(/[^\w.\-()\u4e00-\u9fa5]+/g, '_').slice(0, 80);
        } catch { return '' }
      })();
      const fname = base && /\.[A-Za-z0-9]{2,5}$/.test(base) ? base : `下载-${Date.now()}${base ? '-' + base : ''}`;
      const abs = path.join(dir, fname);
      // ★★ 2026-10-15：**用 Node 内置 fetch，不 shell 出去调 curl**。
      //   原来写的是 `spawnSync('curl', [...])`，实测在本机**不通**：
      //     自检里起一个本地 HTTP 服务，`curl.exe` 三条调用形态（含绝对路径）
      //     **全部超时**（`exit=28 · HTTP 000`），而服务端**一个请求都没收到**。
      //     而同一台机器上从 Node 里 fetch 是真通的（那 4 个真实网址实测 200）。
      //   ⇒ 两件事一起解决：
      //     ① **可移植**：curl 在 Windows 上是 PowerShell 别名、在 Node 里靠 PATH+PATHEXT 解析到 curl.exe，
      //        这套"别名 vs 真 exe"的差别本身就是坑；Node 内置的没有这个问题。
      //     ② **能测**：自检要能起一个本地服务当真源 —— 用外部程序时，测不了就是测不了。
      //   ⚠️ 因此这一支**是异步的**（fetch 是异步的）。
      //     调用方 `dingtalk-im.mjs` 在 `async` 的 `ingestOnce` 里，已经 `await convert(...)`。
      //     只写同步 hook 的调用方（自检里的 `asr` 等）不受影响。
      return (async () => {
        let res;
        try {
          res = await fetch(mediaId, { redirect: 'follow', signal: AbortSignal.timeout(timeoutSec * 1000) });
        } catch (e) { return { ok: false, why: `直接下载失败：${String(e?.message ?? e).slice(0, 120)}` } }
        if (!res.ok) { try { fs.rmSync(abs, { force: true }) } catch { /* noop */ } return { ok: false, why: `直接下载失败：HTTP ${res.status}` } }
        try {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length === 0) { try { fs.rmSync(abs, { force: true }) } catch { /* noop */ } return { ok: false, why: '直接下载失败：响应为空' } }
          fs.writeFileSync(abs, buf);
        } catch (e) {
          try { fs.rmSync(abs, { force: true }) } catch { /* noop */ }
          return { ok: false, why: `直接下载失败：落盘出错 ${String(e?.message ?? e).slice(0, 100)}` };
        }
        return { ok: true, path: path.relative(kbRoot(), abs).split(path.sep).join('/') };
      })();
    }

    if (!mid || !cid) return { ok: false, why: '缺 messageId / conversationId（download-media 必需）' };

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

// ══════════════════════════════════════════════════════════════════════════════
// 自检
//
// ★★ 2026-10-15 补（**这个模块此前一个自检都没有** —— 所以它没进回归，
//   而用户这一轮要的"对齐数据链路"正好断在这里：4 条图片永远下不来、没人发现）。
//
// 判据取向：**起一个本地 HTTP 服务当真源**，不依赖外网。
//   为什么不用那 4 个真实网址：自检要能在**任何机器**上跑（也会在别人机器上跑），
//   拿真实网址当夹具 = 检查会随"那个网站还在不在"红绿（本项目已经吃过这种亏）。
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  const http = await import('node:http');
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-selftest-'));
  const prevKb = process.env.WB_V1_KB_ROOT;
  process.env.WB_V1_KB_ROOT = tmp;

  // 起一个本地服务：/ok.jpg 回一张真图；/missing.jpg 回 404
  // ⚠️ 判路径要用 `new URL(req.url, ...).pathname`，**不能 `req.url === '/ok.jpg'`**：
  //   带查询串时 `req.url` 是 `/ok.jpg?token=abc&x=1`，精确匹配会回 404 ——
  //   而那不是被测代码的问题，是**测试服务写窄了**（第一版就是这么误报 MED-2 的）。
  const server = http.createServer((req, res) => {
    const p = (() => { try { return new URL(req.url, 'http://x').pathname } catch { return req.url } })();
    if (p === '/ok.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end('FAKEJPEGBYTES'); return }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const BASE = `http://127.0.0.1:${port}`;

  try {
    const hook = dwsDownloadHook();

    // ① 真网址 ⇒ 直接取，且落盘
    const r1 = await hook(`${BASE}/ok.jpg`, { at: Date.now() });
    const abs1 = r1.ok ? path.join(tmp, r1.path) : '';
    chk('MED-1', '★★ mediaId 是网址 ⇒ **直接 HTTP 取**（不交 dws 那条只会失败的路）',
      r1.ok === true && abs1 !== '' && fs.existsSync(abs1) && fs.statSync(abs1).size > 0,
      `ok=${r1.ok} path=${r1.path ?? '—'} why=${r1.why ?? '—'}`);

    // ② 文件名取自 URL 末段（不是随机名、也不带查询串）
    const r2 = await hook(`${BASE}/ok.jpg?token=abc&x=1`, { at: Date.now() });
    chk('MED-2', '★ 文件名取自 URL 末段（带查询串时也要剥掉）',
      r2.ok === true && path.basename(path.join(tmp, r2.path)) === 'ok.jpg',
      `${r2.path ?? r2.why ?? ''}`);

    // ③ 负向对照：取不到 ⇒ **如实失败**，不许假装成功
    const r3 = await hook(`${BASE}/missing.jpg`, { at: Date.now() });
    chk('MED-3', '★ 负向对照：HTTP 404 ⇒ 如实失败（不假装下载成功）',
      r3.ok === false && /HTTP 404/.test(String(r3.why)), `ok=${r3.ok} why=${String(r3.why ?? '').slice(0, 60)}`);

    // ④ 负向对照：404 时**不许留下半个文件**
    chk('MED-4', '★ 负向对照：下载失败不留残缺文件（否则会有一堆 0 字节的"下载结果"）', (() => {
      const dir = path.join(tmp, 'Other/Inflow/文件', ym(Date.now()));
      if (!fs.existsSync(dir)) return true;                       // 没建目录也算干净
      return fs.readdirSync(dir).every((f) => fs.statSync(path.join(dir, f)).size > 0);
    })(), '');

    // ⑤ 负向对照：**真 mediaId 不该被新分支截走**（要走去 dws 那条路）
    //   ⚠️ 不断言"成功"（dws 在不在、网通不通都不一定）—— 只断言**失败原因来自 dws 那条路**。
    const r5 = await hook('$iwEcAqNwbmcDAQTRBwgF0QKuBrCOZ73', { messageId: 'm1', conversationId: 'c1' });
    chk('MED-5', '★ 负向对照：真 mediaId（`$`/`@` 形态）仍走 dws 那条路，没被"网址"分支截走',
      r5.ok === true || /download-media|下载未成功|CLI|dws|缺 messageId/i.test(String(r5.why ?? '')),
      `ok=${r5.ok} why=${String(r5.why ?? '').slice(0, 70)}`);

    // ⑥★ 云盘那条路：`viaDrive` 为真 ⇒ 必须走 `dws drive download`，**不许**走聊天媒体那条。
    //   判据取"命令形态"而不是"成功"：dws 在不在、那个 id 还有没有效都不一定
    //   （自检要能在任何机器上跑）。用**编的 id** ⇒ 必然失败，但失败原因必须来自云盘那条命令。
    const r6 = await hook('THIS-IS-NOT-A-REAL-DENTRY-UUID', { viaDrive: true, at: Date.now() });
    chk('MED-6', '★ 云盘形态（viaDrive）走 `dws drive download --node`，不走聊天媒体那条',
      r6.ok === false && /云盘下载/.test(String(r6.why ?? '')),
      `ok=${r6.ok} why=${String(r6.why ?? '').slice(0, 90)}`);

    // ⑦ 负向对照：**没带 viaDrive 的同一个 id 不该走云盘那条** ——
    //   两种 id 都是无规律字母数字串、形态上分不出来，只能靠这个旗标分。
    //   这条守的正是"别把两条路混起来"：混了服务端会回"取不到该资源的下载地址"。
    const r7 = await hook('THIS-IS-NOT-A-REAL-DENTRY-UUID', { messageId: 'm', conversationId: 'c', at: Date.now() });
    chk('MED-7', '★ 负向对照：没带 viaDrive ⇒ 不走云盘那条（两条路靠旗标分，不靠猜 id 形态）',
      !/云盘下载/.test(String(r7.why ?? '')),
      `ok=${r7.ok} why=${String(r7.why ?? '').slice(0, 90)}`);
  } finally {
    server.close();
    if (prevKb === undefined) delete process.env.WB_V1_KB_ROOT; else process.env.WB_V1_KB_ROOT = prevKb;
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
  }

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}

