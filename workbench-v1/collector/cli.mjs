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
    return SAFE_ARG.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
  }).join(' ');
}

/**
 * 经 PowerShell 跑一条 CLI 命令，并把结果解析成 `{ok, json}` / `{ok:false, why}`。
 * @param {string} bin 可执行名（`dws` / `lark-cli` / …）
 * @param {string[]} args 参数（**多词子命令要拆开传**）
 */
export function runCli(bin, args, { timeoutMs = 60000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  const PS = 'powershell.exe';
  const cmd = buildCommand(bin, args);
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer,
  });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `${bin} 退出码 ${r.status}：${(err || out).slice(0, 240)}` };
  try {
    // ★ 有些命令（实测 `lark-cli minutes +detail`）会**先打几行进度再打 JSON**：
    //     `[minutes +detail] querying 1 minute_token(s)` …
    //   第一版要求"整段 stdout 就是 JSON"⇒ 这类命令一律被判失败。
    //   ⇒ 改成**从第一个 `{` 到最后一个 `}` 取子串**再解析（仍严格 JSON，不做宽松修补）。
    const s = out.indexOf('{');
    const e = out.lastIndexOf('}');
    const candidate = s >= 0 && e > s ? out.slice(s, e + 1) : out;
    const j = JSON.parse(candidate);
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
    const s = out.indexOf('{'); const e = out.lastIndexOf('}');
    return JSON.parse(s >= 0 && e > s ? out.slice(s, e + 1) : out);
  };
  chk('CLI-9', '★ 进度行 + JSON ⇒ 能取出 JSON（否则这类命令一律判失败）', (() => {
    try { const j = extractJson('[minutes +detail] querying 1 minute_token(s)\n{"ok":true,"data":{"minutes":[]}}\n'); return j.ok === true && Array.isArray(j.data.minutes); } catch { return false; }
  })());
  chk('CLI-10', '反例对照：整段就是 JSON 时也照常解析', (() => {
    try { return extractJson('{"ok":true}').ok === true; } catch { return false; }
  })());

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
