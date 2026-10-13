/**
 * v1/collector/cli.mjs —— **取数层命令行拼装（唯一一处）**
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件（三次实测踩出来的）：
 *   1. `spawnSync('dws', …)` 在 Windows 上直接 **ENOENT** —— `dws`/`lark-cli` 是 `.cmd` 垫片，
 *      Node 不做 PATHEXT 解析 ⇒ 统一**经 PowerShell 调**（`media.mjs` 早就这么做了）。
 *   2. 第一版的引号规则是"**含空格**才加引号"⇒ 飞书云文档那条 URL
 *      `/open-apis/drive/v1/files?folder_token=…&page_size=20` **没有空格、却有 `&`**，
 *      而 `&` 在 PowerShell 里是特殊字符 ⇒ **整条命令解析失败**（真跑首轮就报错）。
 *   3. 同一条规则原先**抄在 6~7 个通路里**（钉钉待办/日程、飞书日程/任务、飞书云文档、钉钉知识库、iMessage）
 *      ⇒ 改一处不漏一处是迟早的事。**这与 `inScope` 是同一课**：一处定义，别处只调用。
 *
 * 现在的规则（**白名单**，只放行安全字符，其余一律加引号）：
 *   安全 = `[A-Za-z0-9._:@/\-]`（字母数字 + 点 下划线 冒号 @ 斜杠 反斜杠 连字符）
 *   —— 覆盖了子命令、id、flag、纯路径；**任何含 `& ? = 空格 引号 中文 等**的参数都会被引号包住。
 *   ⚠️ 注意：**多词子命令要拆成多个参数传**（例：`event.attendees list` 必须写成两个词），
 *      否则会被引号包成一个整体、CLI 当成未知子命令（飞书日程那条实测踩过）。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ★★ 2026-10-13 加：**把 CLI 名解析成绝对路径再说**（`dws` / `lark-cli` 都是 npm 装的 `.cmd` 垫片）。
 *
 * 为什么必须做 —— 这是本项目一个**已经付过代价**的坑：
 *   计划任务环境里 **PATH 不一定展开**（`%NVM_SYMLINK%` 那次）。后果不是报错，而是
 *   **"exit=0、0 秒、零输出"连续 9 天**，看起来一切正常，实际 node 根本没启动。
 *   `_meta/tools/v1-collect.ps1` 就是为这件事存在的（它对 node 用 `Get-Command` + 绝对路径兜底）。
 *   而 `dws` 走的是**另一条路**（node 起来之后，由本文件经 powershell 去调），
 *   所以它**没有被那个包装脚本保护到** —— 实测去掉 PATH 里的 npm 目录，`dws` 就找不到了。
 *
 * 做法与那个包装脚本一致：**先 `Get-Command`，再按已知位置兜底**，全程不假设 PATH 可用。
 * 解析结果**缓存**（每个采集进程只解析一次）。
 */
const _cliCache = new Map();
export function resolveCli(bin) {
  const b = String(bin);
  if (_cliCache.has(b)) return _cliCache.get(b);
  let found = null;

  // ① 先问系统（登录会话里通常这一步就够）
  //   ★★ 两个实测教训（第一版都踩了）：
  //     ① `where.exe dws` 回的是 **`…\npm\dws`（没有扩展名）** —— 直接 `existsSync` 是 false，
  //        真机上第一版就这么先判成"找不到"；
  //     ② 但**那个无扩展名的 shim 在 PowerShell 里根本执行不了**
  //        （实测 `"…\npm\dws" chat …` → 退出码 1、`CommandNotFoundException` 一类）。
  //        ⇒ 所以**只认可执行的扩展名**（`.cmd` / `.exe` / `.bat`），无扩展名的一律不要。
  //        第二版曾把它排在候选里"能用就用"，结果**比不改还糟**（PATH 正常时反而不通）。
  const exts = ['.cmd', '.exe', '.bat'];
  try {
    const r = spawnSync('where.exe', [b], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const rows = String(r.stdout ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const row of rows) {
      for (const e of exts) {
        const p = row + e;
        // 同名但**扩展名不同**的文件是两回事（`dws` 无扩展名 ≠ `dws.cmd`），必须都验
        if (fs.existsSync(p)) { found = p; break }
      }
      if (found) break;
    }
  } catch { /* 下面兜底 */ }

  // ② 按已知位置兜底（不依赖 PATH）。npm 全局目录在 Windows 上就这两处常见：
  if (!found) {
    const cands = [];
    if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', `${b}.cmd`), path.join(process.env.APPDATA, 'npm', `${b}.ps1`));
    if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'nodejs', `${b}.cmd`));
    // nvm 的当前版本目录（本机在 %LOCALAPPDATA%\nvm\<版本>\ 下）
    if (process.env.LOCALAPPDATA) {
      const nvm = path.join(process.env.LOCALAPPDATA, 'nvm');
      try {
        for (const d of fs.readdirSync(nvm)) cands.push(path.join(nvm, d, `${b}.cmd`));
      } catch { /* 没装 nvm 就算了 */ }
    }
    // ★ 注意：**不要把本机的绝对路径写死在这里**。
    //   第一版写了一处 `C:\nvm4w\nodejs`（顺手从 `$env:PATH` 抄的），
    //   **被发布前的脱敏核对当场拦下**（"本机绝对路径 0 → 1"）。
    //   上面这些候选**全部来自环境变量**，换机器也能用；写死的路径换台机器就是错的。
    found = cands.find((p) => { try { return fs.existsSync(p) } catch { return false } }) ?? null;
  }

  // ③ 都没找到 ⇒ **原样返回名字**（让调用方照旧按 PATH 试一次，并在失败时报出来）
  const out = found ?? b;
  _cliCache.set(b, out);
  return out;
}

/** 只放行这些字符；其余（含 `& ? = 空格 " ' 中文` 等）一律加引号。
 *  `+` 必须在白名单里：两个 CLI 的快捷子命令都写作 `+get-my-tasks` 这种形式
 *  （第一版漏了它 ⇒ CLI-3 当场判红；虽然加引号也能跑，但命令会变得难读，且不利于排错）。 */
const SAFE_ARG = /^[A-Za-z0-9._:@+/\\-]+$/;

/** 拼一条经 PowerShell 执行的命令（**可单独测试**，不必真跑） */
export function buildCommand(bin, args) {
  const b = String(bin);
  if (!SAFE_ARG.test(b)) throw new Error(`可执行名含不安全字符：${JSON.stringify(bin)}`);
  return b + ' ' + (args ?? []).map((a) => {
    const s = String(a);
    if (SAFE_ARG.test(s)) return s;
    // ★ 2026-10-12（升级 lark-cli 1.0.97 后新增 `--params <JSON>` 传参）：含双引号的参数（典型是 JSON）
    //   在 Windows 上要穿**两层**解析，实测踩了三次才通：
    //     ① 用反斜杠转义 + 双引号包裹 ⇒ **PowerShell 自己先按 `"` 断词**（CLI 报 `accepts 2 arg(s), received 3`）；
    //     ② 用单引号包裹 ⇒ PowerShell 原样传了，但 **MSVCRT 又把里面的 `"` 吃掉**（CLI 报 `expected JSON object`）；
    //     ③ 正解 = **单引号包裹 + 把每个 `"` 写成 `\"`**：PowerShell 原样输出，MSVCRT 还原成真引号。
    if (s.includes('"')) {
      if (s.includes("'")) return `"${s.replace(/"/g, '\\"')}"`;   // 罕见：本身带单引号，退回双引号方案
      return `'${s.replace(/"/g, '\\"')}'`;
    }
    return `"${s}"`;
  }).join(' ');
}

/**
 * 经 PowerShell 跑一条 CLI 命令，并把结果解析成 `{ok, json}` / `{ok:false, why}`。
 *
 * ★★ 2026-10-13 加：**在这里把可执行名解析成绝对路径**（`resolveCli`），不是在 `buildCommand`。
 *   为什么分开放：`buildCommand` 是**纯拼串函数**，有自己的一组检查钉着它的输出形状
 *   （安全参数不加引号、多词子命令拆开、JSON 参数的引号规则）。把路径解析塞进去会改掉它的形状，
 *   那三条检查当场就红了 —— **它们红得对**：拼串与"去哪儿找可执行文件"是两件事。
 *   实测去掉 PATH 里的 npm 目录时 `dws` 找不到；而计划任务环境**PATH 不一定展开**（项目已付过代价），
 *   所以真正的调用点必须自己解析。
 */
export function runCli(bin, args, { timeoutMs = 60000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  const resolved = resolveCli(bin);
  // 解析到了绝对路径 ⇒ 用 `&` 调用运算符拼（带引号的路径加 `&` 最稳，不与后面的参数歧义）；
  // 没解析到 ⇒ 照旧按名字跑（让 PATH 再试一次；失败会如实报出来，不会静默）。
  const cmd = resolved === String(bin)
    ? buildCommand(bin, args)
    : `& ${quotePowerShell(resolved)} ` + buildArgs(args);
  return runCmd(cmd, { timeoutMs, maxBuffer, bin: String(bin) });
}

/** 单引号包住一个路径（PowerShell 单引号内反斜杠是字面量；内部单引号写两遍） */
function quotePowerShell(p) { return `'${String(p).replace(/'/g, "''")}'` }

/** 只拼参数部分（与 `buildCommand` 同一套引号规则 —— 从它那里复用，不再抄一份） */
function buildArgs(args) {
  const full = buildCommand('x', args);      // `x` 一定过 SAFE_ARG，拿到的是 `x <参数...>`
  return full.slice(2);                      // 去掉 `x `
}

function runCmd(cmd, { timeoutMs, maxBuffer, bin = '?' }) {
  const PS = 'powershell.exe';
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer,
  });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
  // ★★ 这里曾经引用了一个**不存在的 `bin`** —— 而我重构时把参数名换掉了却没改这一行。
  //   后果不是"报错不清楚"，而是**只要任何一次 CLI 调用失败，整个采集进程就崩**
  //   （实测：`ReferenceError: bin is not defined`，钉钉知识库那条通路一失败，
  //    19 条通路**全部没跑完**，采集节拍从此停摆）。
  //   为什么检查没抓到：已有那些检查全走**成功路径**，"命令失败时报什么"这条分支**一条都没覆盖**。
  //   ⇒ 现在既修好这行，也在 `selfTest` 里补一条**专门让它失败**的检查。
  if (r.status !== 0) return { ok: false, why: `${bin} 退出码 ${r.status}：${(err || out).slice(0, 240)}` };
  try {
    // ★ 有些命令会**先打几行进度/说明再打 JSON**：
    //   · `lark-cli minutes +detail` ⇒ `[minutes +detail] querying …`
    //   · `lark-cli base +record-list` ⇒ 一行带反引号的说明（**里面也有花括号**）
    //   第一版"整段就是 JSON"、第二版"从第一个 `{` 取到最后一个 `}`"都不够：
    //   第二版在"说明里含 `{` 且其后还有别的 `}`"时会把范围取歪 ⇒ 解析报
    //   `Unexpected non-whitespace character after JSON`。
    //   ⇒ 现在**枚举所有能解析成功的候选**，然后**优先选带 `ok` 字段的那个**（我们的 CLI 一律返回 `{ok:…}`）；
    //     没有带 `ok` 的就取**最大**的那个。
    //   ⚠️ 只"取第一个能解析的"还不够：说明文字里可能带**小 JSON 示例**（实测 `base +record-list` 的说明里
    //     就有个 `{"id":"rec…"}`）⇒ 会被抢先选中，拿回一个只有 id 的假结果。
    const s = out.indexOf('{');
    const e = out.lastIndexOf('}');
    if (s < 0 || e <= s) return { ok: false, why: `输出里没有 JSON 对象（前 120 字：${out.slice(0, 120)}）` };
    const cands = [];
    let from = s;
    for (let tries = 0; tries < 12 && from >= 0 && from < e; tries += 1) {
      const text = out.slice(from, e + 1);
      try { cands.push({ text, j: JSON.parse(text) }); } catch { /* 不是这个位置 */ }
      from = out.indexOf('{', from + 1);
    }
    if (cands.length === 0) return { ok: false, why: `输出不是 JSON（前 120 字：${out.slice(0, 120)}）` };
    const withOk = cands.filter((c) => c.j && typeof c.j === 'object' && 'ok' in c.j);
    const pick = (withOk.length ? withOk : cands).sort((a, b) => b.text.length - a.text.length)[0];
    const j = pick.j;
    // 飞书 CLI 用 `ok:false` 表示业务错误（退出码仍是 0）⇒ 这里一并翻成失败，别让调用方以为成功
    if (j && j.ok === false) return { ok: false, why: `${bin} 报错：${String(j.error?.message ?? '未知错误').slice(0, 200)}` };
    return { ok: true, json: j, stdout: out };
  } catch (e) {
    return { ok: false, why: `输出不是 JSON：${e.message}（前 120 字：${out.slice(0, 120)}）` };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  chk('CLI-1', '★ 含 `&` 的 URL 必须加引号（飞书云文档真跑踩过）',
    /"\/open-apis\/drive\/v1\/files\?folder_token=ROOT&page_size=20"/.test(buildCommand('lark-cli', ['api', 'GET', '/open-apis/drive/v1/files?folder_token=ROOT&page_size=20'])));
  chk('CLI-2', '含 `?` 的也加引号',
    buildCommand('dws', ['api', 'GET', '/x?y=1']).includes('"/x?y=1"'));
  chk('CLI-3', '安全参数不加引号（保持可读）',
    buildCommand('dws', ['todo', '+get-my-tasks']) === 'dws todo +get-my-tasks');
  chk('CLI-4', '★ 多词子命令拆开传 ⇒ 不会被当成一个整体',
    buildCommand('lark-cli', ['calendar', 'event.attendees', 'list', '--event-id', 'X']) === 'lark-cli calendar event.attendees list --event-id X');
  chk('CLI-5', '反例对照：**整串**多词子命令会被加引号（所以必须拆）',
    buildCommand('lark-cli', ['calendar', 'event.attendees list']).includes('"event.attendees list"'));
  chk('CLI-6', '中文/空格参数加引号',
    buildCommand('dws', ['x', '一条 中文']).includes('"一条 中文"'));
  chk('CLI-7', '可执行名含危险字符 ⇒ 直接抛（不给"拼出怪命令"的机会）', (() => {
    try { buildCommand('dws; rm -rf /', []); return false; } catch { return true; }
  })());
  chk('CLI-8', '参数里的双引号被转义（不逃逸）',
    buildCommand('dws', ['a"b']).includes('\\"'));

  // CLI-9/10：`runCli` 要能容忍"命令先打进度行、再打 JSON"（实测 `lark-cli minutes +detail` 就是这样）
  //   用一个不依赖外部命令的方式验证解析逻辑：直接调一个只打印文本的 node 进程太绕，
  //   这里改用**同样的提取规则**对两段样本做断言（规则本身被测，不引入网络/外部依赖）。
  const extractJson = (out) => {
    // 与 runCli 同款策略：枚举候选，优先带 `ok` 的，其次取最大
    const e = out.lastIndexOf('}');
    const cands = [];
    let from = out.indexOf('{');
    for (let i = 0; i < 12 && from >= 0 && from < e; i += 1) {
      const text = out.slice(from, e + 1);
      try { cands.push({ text, j: JSON.parse(text) }); } catch { /* 换下一个位置 */ }
      from = out.indexOf('{', from + 1);
    }
    if (!cands.length) throw new Error('没有可解析的 JSON 对象');
    const withOk = cands.filter((c) => c.j && typeof c.j === 'object' && 'ok' in c.j);
    return (withOk.length ? withOk : cands).sort((a, b) => b.text.length - a.text.length)[0].j;
  };
  chk('CLI-9', '★ 进度行 + JSON ⇒ 能取出 JSON（否则这类命令一律判失败）', (() => {
    try { const j = extractJson('[minutes +detail] querying 1 minute_token(s)\n{"ok":true,"data":{"minutes":[]}}\n'); return j.ok === true && Array.isArray(j.data.minutes); } catch { return false; }
  })());
  chk('CLI-10', '反例对照：整段就是 JSON 时也照常解析', (() => {
    try { return extractJson('{"ok":true}').ok === true; } catch { return false; }
  })());
  chk('CLI-11', '★ 说明文字里**含花括号**时也要取对（base +record-list 实测）', (() => {
    const out = '`_record_id` is metadata, e.g. {"a":1} is not the payload\n{"ok":true,"data":{"items":[{"record_id":"r1"}]}}\n';
    try { const j = extractJson(out); return j.ok === true && j.data.items[0].record_id === 'r1'; } catch { return false; }
  })());
  chk('CLI-12', '★ 说明里带**小 JSON 示例**时，不能被它抢先选中（实测踩到：只拿回一个 {"id":…}）', (() => {
    const out = 'notes: {"id":"recXDFiAHamU0d"} is an example\n{"ok":true,"data":{"items":[{"record_id":"r1","fields":{"a":1}}],"has_more":false}}\n';
    try { const j = extractJson(out); return j.ok === true && j.data.items.length === 1 && j.data.items[0].record_id === 'r1'; } catch { return false; }
  })());
  // CLI-13/14：JSON 参数要穿过 PowerShell 与 MSVCRT **两层**解析（升级 lark-cli 1.0.97 后新增 `--params <JSON>`）
  chk('CLI-13', '★ JSON 参数：单引号包裹 + 每个 `"` 写成 `\\"`（两层解析都过）', (() => {
    const c = buildCommand('lark-cli', ['api', 'GET', '/x', '--params', '{"a":1}']);
    return c === `lark-cli api GET /x --params '{\\"a\\":1}'`;
  })(), buildCommand('lark-cli', ['api', 'GET', '/x', '--params', '{"a":1}']));
  chk('CLI-14', '★ JSON 参数里不能留着裸 `"`（会被 MSVCRT 吃掉 ⇒ CLI 报 expected JSON object）', (() => {
    const c = buildCommand('lark-cli', ['api', 'GET', '/x', '--params', '{"a":1}']);
    const body = c.slice(c.indexOf("'") + 1, c.lastIndexOf("'"));
    return !/^[^\\]*"[^\\]*$/.test(body) && body.includes('\\"');
  })());

  // ══════════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-13 加：**命令失败那条分支**必须单独钉住。
  //
  // 为什么补这一条 —— 这是一次真实停摆的根因：
  //   我重构 `runCli` 时把参数名换了，而 `runCmd` 里有一行仍引用旧的 `bin`。
  //   后果不是"报错文字难看"，而是**只要任何一次 CLI 调用失败，整个采集进程就崩**：
  //   实测 `ReferenceError: bin is not defined`，钉钉知识库那条通路一失败，
  //   **19 条通路全部没跑完**，采集节拍从 11:58 停到晚上，四五个小时没进新消息。
  //
  // 为什么原来的检查抓不到：**所有 CLI 检查走的都是成功路径**（拼命令、解析 JSON）。
  //   "命令失败时返回什么"这条分支**一条检查都没有** —— 于是那个错字安安稳稳活到了线上。
  //   ⇒ 这一条**故意让命令失败**，要求它**如实返回原因、且绝不抛异常**。
  //     用一个必定非 0 退出的命令（不存在的子命令），不必联网也不必真调 CLI。
  chk('CLI-15', '★★ 命令失败时如实返回原因、**不抛异常**（曾因引用错变量名把整个采集打停）', (() => {
    try {
      const r = runCli('dws', ['chat', '+这个子命令不存在-cli-15']);
      if (r.ok !== false) return false;                        // 失败就该是 ok:false
      if (typeof r.why !== 'string' || r.why.length === 0) return false;   // 必须给得出原因
      return r.why.includes('dws');                            // 原因里要能看出是哪个命令
    } catch (e) {
      return false;                                            // ★ 抛了就是这条检查要抓的病
    }
  })());

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
