/**
 * `v1/collector/dingtalk-cross-org.mjs` —— **跨组织白名单群的「全量信息」采集**（用户 2026-10-13 裁定）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户原话
 *   「钉钉群消息，白名单群（智询工作室 / AI Engineering Club）这两个群组的**全量信息**。
 *     其他群组的**非@我**的信息不进入消息。」
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么必须另开一条通路（**实测出来的，不是设计选择**）
 *   这两个群都是**跨组织**的群（我在自己组织里，群在别的组织下）。后果有两条，都实测过：
 *
 *   ① **API 拉取**：直接报 `CrossOrgPermissionDenied`
 *      —— 「没有跨组织拉取权限，请先执行 dws chat data-auth cross-org --all --grant-type timed --ttl 24h」。
 *      授权之后立刻能读到（实测：智询工作室 2026-10-11 14:55 有消息、AI Engineering Club 2026-10-11 20:38 有消息）。
 *   ② **Stream 订阅**：跨组织群的**事件根本不会推过来** ⇒ 库里这两个群都是 **0 条**，
 *      而同一时间库里躺着 38 个**别的**群会话（其中那个 227 条的「Qoder CN(原灵码)用户交流1群」）。
 *      ⇒ 也就是说：**钉钉那条 Stream 通路不是"白名单群"的可靠来源**，
 *        它给的是"订阅范围内所有群"，而你要的那两个恰好不在其中。
 *
 *   ⇒ 结论：这两个群的"全量信息"**只能走 API 拉取**，并且**要先有跨组织授权**。
 *     本模块把这件事做成一条正式通路（有水位线、有幂等键、有健康读数），
 *     而不是一次性脚本 —— 否则下次没人知道它需要授权。
 *
 * ⚠️ **授权是有期限的**（默认 24 小时，`--ttl` 可选 1h/4h/24h/7d）。过期后本模块会**如实报错**，
 *   不会假装"这两个群没消息"。`health()` 会把"授权在不在"单独报出来。
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { v1Out, kbPath } from '../paths.mjs';
// ★ 走 `runCli`（它内部先解析可执行文件的绝对路径）—— **不要自己 buildCommand + spawn**，
//   那会绕过解析，在"PATH 里没有 npm 目录"的环境（计划任务）下直接报"dws 不是可识别的 cmdlet"。
import { runCli } from './cli.mjs';

// 说明：原来这里有个 `const PS = 'powershell.exe'` —— 改成走 `runCli` 之后不再自己 spawn，已去掉。

/** 跨组织白名单群：**从库内 `_meta/im-scope.yml` 读**，不在这里再抄一份名单（两份必然漂）。 */
export function crossOrgGroups({ file = null } = {}) {
  const f = file ?? kbPath('_meta', 'im-scope.yml');
  let t = '';
  try { t = fs.readFileSync(f, 'utf8') } catch { return { ok: false, why: `读不到 ${f}`, groups: [] } }
  // 只在 `full_message_groups:` 这一段里找 `- name:` / `cid:`
  const sec = t.split('full_message_groups:')[1] ?? '';
  const groups = [];
  let cur = null;
  for (const line of sec.split('\n')) {
    const mn = /^\s*-\s*name:\s*(.+?)\s*$/.exec(line);
    if (mn) { if (cur && cur.cid) groups.push(cur); cur = { name: mn[1].replace(/^["']|["']$/g, ''), cid: null } ; continue }
    const mc = /^\s*cid:\s*"([^"]+)"/.exec(line);
    if (mc && cur) cur.cid = mc[1];
  }
  if (cur && cur.cid) groups.push(cur);
  // ★ 用户 2026-10-13 裁定：**只有这两个群收全量**，其余白名单群一律只收 @我。
  //   所以这里按"跨组织"筛：名单里带自定义字段或属于外部组织的，就是跨组织群。
  //   实测可用的判法是**试读一次**（见 `health()`）—— 名单本身不带"是否跨组织"这个字段，
  //   与其在这里猜，不如让实际读取结果说话。
  return { ok: true, file: f, groups };
}

/** 用户裁定的两个群（写死 id，因为它们就是要按会话拉的两个目标；名字用于日志与核对）。 */
export const FULL_MESSAGE_GROUPS = Object.freeze([
  { name: '智询工作室', cid: 'cidYfn8k+5mWU/YcUESFbS5hg==' },
  { name: 'AI Engineering Club', cid: 'cidVsqzvXfWKFV0GDaoDkUWVA==' },
]);

export function stateFile() { return path.join(v1Out(), 'dd-cross-org-seen.json'); }

/**
 * 把 `YYYY-MM-DD HH:mm:ss` 往前挪 n 分钟。
 * 为什么需要：水位线是**闭区间**的起点 ⇒ 从水位线原样继续会把**边界那一条**每轮重读一次
 *   （实测：连跑两次都在"进 1 条"）。往前挪 1 分钟既消掉边界重复，也顺带覆盖**时钟偏差**
 *   （别的机器写的消息时间戳略早于我的水位线）。
 *   多读几条不要紧：**幂等键（`ddx-<messageId>`）会去重**，不会重复入库。
 */
export function shiftBack(ts, minutes = 1) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(ts).trim());
  if (!m) return ts;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - minutes * 60000;
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
export function loadSeen() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) ?? {} } catch { return { messages: {} } } }
export function saveSeen(doc) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(doc, null, 1), 'utf8');
}

export function defaultRun(args) {
  // ★★ 2026-10-13 改：**走 `runCli`，不要自己拼命令**。
  //   第一版这里是 `buildCommand('dws', args)` + 自己 spawn —— 结果**绕过了 `runCli` 里的可执行文件解析**，
  //   在"PATH 里没有 npm 目录"的环境（计划任务就是）下报 `dws 不是可识别的 cmdlet`。
  //   实测抓出来的：把 PATH 收成"只有 node + powershell"再跑，健康读数立刻红。
  //   ⇒ `runCli` 才是那个"先 Get-Command、再按已知位置兜底"的调用点；这里复用它。
  const r = runCli('dws', args, { timeoutMs: 120000, maxBuffer: 64 * 1024 * 1024 });
  // `runCli` 回的是解析后的 `{ok, json, why}`；本模块后面的解析逻辑吃的是 `{stdout, stderr}`，
  // 所以这里**把两种形状都带上**（json 给解析用，stdout 兼容旧路径，why 用于报错）。
  return {
    status: r.ok ? 0 : 1,
    stdout: r.ok ? JSON.stringify(r.json) : '',
    stderr: r.ok ? '' : String(r.why ?? ''),
  };
}

/**
 * 读一个群的消息（一页）。返回 `{ ok, messages, hasMore, nextTime, error }`。
 * ★ 错误**原样带回来**（尤其是 `CrossOrgPermissionDenied`）—— 那是"授权过期"的独有信号，
 *   不能和"这个群没消息"混为一谈。
 */
export function fetchGroupPage({ cid, since, limit = 50, run = defaultRun }) {
  const args = ['chat', '+chat-messages', '--group', cid, '--time', since, '--direction', 'newer', '--limit', String(limit), '--format', 'json'];
  const r = run(args);
  const out = String(r.stdout || '').replace(/^\uFEFF/, '');
  let j = null;
  try { j = JSON.parse(out) } catch { /* 非 JSON：下面按错误处理 */ }
  if (j === null) {
    const err = String(r.stderr || out || '').slice(0, 300);
    const crossOrg = /CrossOrgPermissionDenied|没有跨组织拉取权限/i.test(out + err);
    return { ok: false, messages: [], hasMore: false, crossOrg, error: crossOrg
      ? '跨组织读取权限不在（或已过期）—— 先跑：dws chat data-auth cross-org --all --grant-type timed --ttl 24h'
      : (err || 'dws 没回可读的 JSON') };
  }
  if (j.error) {
    const msg = String(j.error.message ?? JSON.stringify(j.error)).slice(0, 300);
    const crossOrg = /CrossOrgPermissionDenied|没有跨组织拉取权限/i.test(msg);
    return { ok: false, messages: [], hasMore: false, crossOrg, error: msg };
  }
  const msgs = Array.isArray(j.messages) ? j.messages : [];
  return { ok: true, messages: msgs, hasMore: j.hasMore === true, count: j.count ?? msgs.length, complete: j.complete === true };
}

/** 把一条 dws 消息映射成工作台的 message 载荷（契约见 schema.mjs#PAYLOAD_SPEC.message）。 */
export function mapMessage(m, group) {
  // ★★ 字段名以**实测**为准（第一版按 `senderNick` / `text.content` 取，结果两个都取空：
  //   `origin.sender 必须是非空字符串` 报了 49 次）。实测 dws 这条命令回的是：
  //     `{ conversationId, createTime, messageId, resourceRefs, sender, senderId, text }`
  //   其中 `sender` 是**字符串**（昵称），`text` 也是**字符串**（不是对象）。
  //   教训：**先看一条真实数据再写字段名**，别按其它命令的形状类推。
  const sender = String(m.sender ?? m.senderNick ?? m.senderName ?? m.senderId ?? '').trim() || '(未知)';
  const media = Array.isArray(m.resourceRefs) ? m.resourceRefs : [];
  const text = String(typeof m.text === 'string' ? m.text : (m.text?.content ?? m.content ?? '')).trim();
  const types = media.map((r) => String(r?.download?.arguments?.type ?? r?.type ?? '')).join(' ');
  const hasImg = /image|picture/i.test(types) || /\[图片消息\]/.test(text);
  const hasFile = /fileId/i.test(types) || /fileId/i.test(text);
  const raw = text || (hasImg ? '[图片消息]' : (hasFile ? '[文件]' : '(无文本)'));
  // 图片/文件消息的「媒体 id」要留给详情页取图用（与 Stream 那条通路的 `fileRef` 语义对齐：
  //   这里存的是**钉钉侧的 resourceId**，取图走 dws 的下载命令；详情页拿不到时如实说）。
  const firstMedia = media[0]?.download?.arguments ?? null;
  return {
    channel: 'dingtalk',
    sender,
    senderType: 'user',
    conversationId: group.cid,
    conversationName: group.name,
    isDirect: false,
    atMe: false,
    raw,
    summary: raw.slice(0, 60),
    modality: hasImg ? 'image' : (hasFile ? 'file' : 'text'),
    source: 'im',
    ...(firstMedia ? { mediaId: String(firstMedia['resource-id'] ?? ''), fileRef: null } : {}),
  };
}

/**
 * 跑一轮：把两个群的**全量**消息拉进来（按水位线增量，幂等键 = `ddx-<messageId>`）。
 * @returns {{ok:boolean, inCount:number, added:number, updated:number, skipped:number, errors:string[], detail:Array}}
 */
export function ingestOnce({ since = '2026-10-12 00:00:00', maxPages = 40, groups = FULL_MESSAGE_GROUPS, run = defaultRun } = {}) {
  const seen = loadSeen();
  const detail = [];
  const errors = [];
  let inCount = 0; let added = 0; let updated = 0; let skipped = 0;

  for (const g of groups) {
    // ★★ 2026-10-13 修：**水位线的用法改对了**。
    //   原来写的是 `seen.groups?.[cid]?.cursor ?? since` —— 看起来对，实际有个坑：
    //   每轮跑完 `newest` 都会被推到**最新一条的时间**，于是下一轮从"最新"再读一遍窗口起点到最新；
    //   更要紧的是**窗口起点被当成每轮的起点**时，`--since` 传进来的 V1_START 会让每轮都重读一遍全窗口
    //   （靠幂等跳过，结果是"不错但白读"，且随消息量线性变慢）。
    //   ⇒ 现在的规矩：**有水位线就从水位线继续；没有才用窗口起点**（第一次跑）。
    const prev = seen.groups?.[g.cid];
    let from = prev?.cursor ? shiftBack(prev.cursor, 1) : since;   // 有水位线 ⇒ 从水位线**前 1 分钟**继续
    let newest = prev?.cursor ?? from;
    let gotTotal = 0;
    let pages = 0;
    let lastHasMore = false;
    // ★★ 翻页：实测一页 `--limit 50` 回 49 条且 `hasMore=true` —— **只读一页会漏掉剩下的**。
    //   判据用"本页有没有比 from 更新的时间"：新的一页若把 newest 往前推了，就继续读下一页。
    //   （`--direction newer` 从时间边界往后读，所以水位线就用 newest。）
    for (let page = 0; page < maxPages; page += 1) {
      const r = fetchGroupPage({ cid: g.cid, since: from, limit: 50, run });
      pages += 1;
      if (!r.ok) {
        errors.push(`${g.name}：${r.error}`);
        detail.push({ group: g.name, ok: false, error: r.error, crossOrg: r.crossOrg === true, pages });
        break;   // ★ 这个群到此为止；另一个群照常跑（各自独立记错）
      }
      gotTotal += r.messages.length;
      lastHasMore = r.hasMore;
      let advanced = false;
      for (const m of r.messages) {
        inCount += 1;
        const ct = String(m.createTime ?? '');
        if (ct > newest) { newest = ct; advanced = true }
        const mid = String(m.messageId ?? '');
        if (mid && seen.messages[mid]) { skipped += 1; continue }     // 幂等：同一条不重复进
        const made = makeEvent({
          type: 'message',
          payload: mapMessage(m, g),
          origin: { channel: 'dingtalk', sender: String(m.sender ?? '').trim() || '(未知)', messageId: `ddx-${mid}`, raw: null },
          _at: ct ? new Date(ct.replace(' ', 'T') + '+08:00').getTime() : Date.now(),
        });
        if (made.ok === false) { errors.push(`${g.name} 归一失败：${made.errors.join('；')}`); continue }
        const up = store.upsert(made.event);
        if (up.action === 'rejected') { errors.push(`${g.name} 落库被拒：${up.reason}`); continue }
        if (up.action === 'added') added += 1; else updated += 1;
        if (mid) seen.messages[mid] = ct;
      }
      if (!r.hasMore || !advanced || r.messages.length === 0) break;   // 读完了 / 不再前进 ⇒ 停
      from = newest;
    }
    seen.groups = seen.groups ?? {};
    seen.groups[g.cid] = { name: g.name, cursor: newest, at: new Date().toISOString() };
    if (!detail.some((d) => d.group === g.name && d.ok === false)) {
      detail.push({ group: g.name, ok: true, got: gotTotal, pages, hasMore: lastHasMore, cursor: newest });
    }
  }

  saveSeen(seen);
  // ★ 回执的键名要对齐调度器的约定（`collector/run.mjs` 读 `inCount` / `outCount`）。
  //   第一版只给了 `added` / `updated` ⇒ 调度器报 `出 undefined`（真机抓到的）。
  //   `inCount` = 本轮**读到**多少条；`outCount` = 其中**真正写进库**的（新增 + 刷新）。
  return { ok: errors.length === 0, inCount, outCount: added + updated, added, updated, skipped, errors, detail };
}

/** 健康读数：**分开报**"授权在不在"与"这两个群各有多少条"，别混成一个数。 */
export function health({ run = defaultRun } = {}) {
  const out = { groups: [] };
  for (const g of FULL_MESSAGE_GROUPS) {
    const r = fetchGroupPage({ cid: g.cid, since: '2026-10-13 00:00:00', limit: 1, run });
    out.groups.push({ name: g.name, cid: g.cid, readable: r.ok, crossOrgMissing: r.crossOrg === true, error: r.error ?? null, count: r.count ?? 0 });
  }
  out.authorized = out.groups.every((x) => x.readable);
  out.why = out.authorized ? '两个群都能读' : '跨组织读取权限不在或已过期 —— 跑 dws chat data-auth cross-org --all --grant-type timed --ttl 24h';
  return out;
}

export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail: String(detail) });

  // DX-1 名单：两个群必须与库内 im-scope.yml 一致（id 抄错就永远读不到）
  // ★ 套件里跑会**改知识库根**（测试用临时目录）⇒ 那时 `im-scope.yml` 读不到。
  //   读不到就**如实说"这次没验到"**，而不是判红 —— 判红会让人以为是名单错了，
  //   而实际是"这一轮没有可对照的库"。单跑（在真库里）时会真的对照。
  const scope = crossOrgGroups();
  const inScope = new Map((scope.groups ?? []).map((g) => [g.name, g.cid]));
  const comparable = scope.ok === true && inScope.size > 0;
  for (const g of FULL_MESSAGE_GROUPS) {
    chk(`DX-1${g.name === '智询工作室' ? 'a' : 'b'}`,
      comparable ? `名单「${g.name}」的会话 id 与库内 im-scope.yml 一致` : `名单「${g.name}」写进模块（本轮没有可对照的库，未逐字核对）`,
      comparable ? inScope.get(g.name) === g.cid : true,
      comparable ? `本模块=${g.cid} · 库内=${inScope.get(g.name) ?? '(没找到)'}` : `本模块=${g.cid} · ${scope.why ?? '库内名单读不到'}（在真库里单跑这条会逐字对照）`);
  }

  // DX-2 授权缺失必须**单独认出来**（不能与"没消息"混同）
  const fakeCrossOrg = () => ({ stdout: JSON.stringify({ error: { message: '[UNCLASSIFIED] 没有跨组织拉取权限，请先执行 dws chat data-auth cross-org --all' } }), stderr: '' });
  const r1 = fetchGroupPage({ cid: 'cidX', since: '2026-10-12 00:00:00', run: fakeCrossOrg });
  chk('DX-2', '★ 授权缺失被单独认出来（crossOrg=true，不与"没消息"混同）', r1.ok === false && r1.crossOrg === true, r1.error);

  // DX-3 正常一页能解析
  const fakeOk = () => ({ stdout: JSON.stringify({ complete: false, count: 1, hasMore: true, messages: [{ conversationId: 'cidX', createTime: '2026-10-12 10:00:00', messageId: 'msgA', senderNick: '某人', text: { content: '一句话' } }] }), stderr: '' });
  const r2 = fetchGroupPage({ cid: 'cidX', since: '2026-10-12 00:00:00', run: fakeOk });
  chk('DX-3', '正常一页能解析出消息与 hasMore', r2.ok === true && r2.messages.length === 1 && r2.hasMore === true, JSON.stringify(r2.messages[0] ?? null).slice(0, 120));

  // DX-4 映射出的载荷符合契约
  const m = mapMessage({ messageId: 'msgA', createTime: '2026-10-12 10:00:00', senderNick: '某人', text: { content: '一句话' } }, FULL_MESSAGE_GROUPS[0]);
  const made = makeEvent({ type: 'message', payload: m, origin: { channel: 'dingtalk', sender: '某人', messageId: 'ddx-msgA', raw: null }, _at: Date.now() });
  chk('DX-4', '映射出的载荷过契约校验（含群名与真实来源）', made.ok === true && m.conversationName === '智询工作室', made.ok ? JSON.stringify(m).slice(0, 130) : JSON.stringify(made.errors));

  // DX-5 幂等键带独立前缀，不与 Stream 那条通路撞键
  chk('DX-5', '★ 幂等键用 ddx- 前缀（不与 Stream 通路的键相撞）', String(made.event?.origin?.messageId ?? '').startsWith('ddx-'), String(made.event?.origin?.messageId ?? ''));

  // DX-6 一个群读不到，不影响另一个群
  let calls = 0;
  const halfBroken = (args) => {
    calls += 1;
    const cid = args[args.indexOf('--group') + 1];
    if (cid === FULL_MESSAGE_GROUPS[0].cid) return fakeCrossOrg();
    return fakeOk();
  };
  const ing = ingestOnce({ run: halfBroken });
  chk('DX-6', '★ 一个群读不到时另一个群照常采（各自独立记错，不互相拖累）',
    calls >= 2 && ing.errors.length === 1 && ing.detail.some((d) => d.ok === true), JSON.stringify(ing.detail).slice(0, 160));

  return { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const __isMain = (() => { try { const entry = process.argv[1]; return !!entry && import.meta.url === pathToFileURL(entry).href } catch { return false } })();
if (__isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--health')) {
    const h = health();
    console.log('############ 工作台 v1.0 · 跨组织白名单群 ############');
    console.log(`  授权：${h.authorized ? '在' : '不在'} —— ${h.why}`);
    for (const g of h.groups) {
      console.log(`  ${g.readable ? '✓' : '✗'} ${g.name}：${g.readable ? `可读（今日 ${g.count} 条）` : g.error}`);
    }
    process.exit(h.authorized ? 0 : 1);
  }
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : '2026-10-12 00:00:00';
  const r = ingestOnce({ since });
  console.log('############ 工作台 v1.0 · 跨组织白名单群（全量）############');
  console.log(`  起点 ${since} · 进 ${r.inCount} · 新采 ${r.added} · 刷新 ${r.updated} · 跳过 ${r.skipped}`);
  for (const d of r.detail) {
    console.log(d.ok ? `  ✓ ${d.group}：本页 ${d.got} 条 · hasMore=${d.hasMore} · 水位线 ${d.cursor}` : `  ✗ ${d.group}：${d.error}`);
  }
  for (const e of r.errors) console.log(`  ！${e}`);
  process.exit(r.ok ? 0 : 1);
}
