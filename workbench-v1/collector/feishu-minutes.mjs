/**
 * v1/collector/feishu-minutes.mjs —— 飞书 · 妙记（登记表 `fs-minutes`）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 3.1.4：「笔记结构化拆解：主题 / 时间（YYYY-MM-DD）/ 内容（md）」—— 妙记按**笔记**入流
 *   （与钉钉听记同族：`collector/minutes.mjs` 是那条的样板）。
 * 需求 2.2：CLI 类功能走**每 5 分钟轮询**、**幂等**。
 *
 * **权限这道坎（本文件的前提）**：一度报 `missing required scope(s): minutes:minutes.search:read`，
 *   用户 2026-10-12 授权后实测可用。**注意 appId 有两套**：本通路走 `lark-cli`
 *   （appId `cli_aae5b0cbf3e1dbeb`）—— 不是面板侧集成那个 `cli_aa26a37ae638dcee`。
 *
 * 实测形状（2026-10-12，不是猜的）：
 *   · `lark-cli minutes +search --owner-ids <openId>`
 *     ⇒ `{ok:true, data:{has_more, items:[{token, display_info, meta_data:{app_link, description}}]}}`
 *     —— `display_info` 里第一行是标题、后面是 `<b>关键词:</b>…`；`description` 形如
 *     `所有者: 杨瑒 开始时间: 2026.09.19 18:01:07 时长: 1 分 58 秒`（**时间在这里**，不在顶层字段）。
 *   · `lark-cli minutes +detail --minute-tokens <token>`
 *     ⇒ **先打几行进度再打 JSON**（`[minutes +detail] querying …`）⇒ 取数层要能容忍（已在 `cli.mjs` 修掉）。
 *
 * 幂等键 = `fs-min-<token>`；起点按**开始时间**（用户裁定："消息/听记/邮件/笔记按发送/创建时间"）。
 * **正文（逐字稿/摘要）尚未抓**：`+detail` 的产出物要再带 artifact 参数，本轮只到"标题 + 关键词 + 链接"，
 *   不假装存了逐字稿。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';

import { makeEvent } from '../schema.mjs';
import * as store from '../store.mjs';
import { v1Out } from '../paths.mjs';
import { inScope } from './registry.mjs';
import { runCli } from './cli.mjs';

export const KEY = 'fs-minutes';
export const INTERVAL_SEC = 300;

export function stateFile() { return path.join(v1Out(), 'fs-minutes-seen.json'); }
export function loadSeen() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveSeen(doc) {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

/** 取数：整段交给公共件（拼装 + 经 PowerShell + 解析，且能容忍进度行） */
export function defaultRun(args) { return runCli('lark-cli', args); }

/** 我自己的 openId：优先环境变量，其次问 `auth status`（只问一次就够） */
export function resolveOwnerId({ run = defaultRun, env = process.env } = {}) {
  if (env.WB_V1_LARK_OWNER_ID) return { ok: true, id: String(env.WB_V1_LARK_OWNER_ID), from: 'env' };
  const r = run(['auth', 'status', '--json']);
  if (r.ok !== true) return { ok: false, why: `取 openId 失败：${r.why}` };
  const id = r.json?.identities?.user?.openId;
  if (!id) return { ok: false, why: 'auth status 里没有 identities.user.openId' };
  return { ok: true, id: String(id), from: 'auth status' };
}

/** 搜我的妙记 */
export function fetchMinutes({ ownerId, run = defaultRun, pageSize = 20 } = {}) {
  const args = ['minutes', '+search', '--owner-ids', String(ownerId)];
  if (Number.isFinite(Number(pageSize))) args.push('--page-size', String(pageSize));
  const r = run(args);
  if (r.ok !== true) return { ok: false, why: r.why };
  const items = r.json?.data?.items;
  if (!Array.isArray(items)) return { ok: false, why: '返回里没有 data.items 数组（形状变了？）' };
  return { ok: true, items, hasMore: r.json.data.has_more === true };
}

/** 从 `display_info` 抠标题与关键词 */
export function parseDisplay(s) {
  const lines = String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  const title = (lines[0] ?? '').replace(/<[^>]+>/g, '').trim();
  const kwLine = lines.find((x) => /关键词/.test(x)) ?? '';
  const tags = kwLine.replace(/<[^>]+>/g, '').replace(/^.*?关键词[:：]\s*/, '').split(/[，,、\s]+/).map((x) => x.trim()).filter(Boolean);
  return { title, tags };
}

/** 从 `description` 抠开始时间（`开始时间: 2026.09.19 18:01:07`）→ 本地毫秒 */
export function parseStartMs(desc) {
  const m = /开始时间[:：]\s*(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(String(desc ?? ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

const pad = (n) => String(n).padStart(2, '0');

/** 妙记 → v1 笔记事件（需求 3.1.4 三项：主题 / 时间 / 内容） */
export function mapMinute(item) {
  const errs = [];
  const token = String(item?.token ?? '').trim();
  if (!token) errs.push('缺 token（幂等键要用）');
  const { title, tags } = parseDisplay(item?.display_info);
  if (!title) errs.push('display_info 里抠不出标题');
  const at = parseStartMs(item?.meta_data?.description);
  if (at === null) errs.push(`description 里抠不出开始时间：${JSON.stringify(item?.meta_data?.description ?? null)}`);
  if (errs.length) return { ok: false, errors: errs };

  const d = new Date(at);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;   // 需求 3.1.4：YYYY-MM-DD
  const link = String(item?.meta_data?.app_link ?? '').trim();
  const content_md = [
    `# ${title}`,
    '',
    `- 开始时间：${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    tags.length ? `- 关键词：${tags.join('、')}` : null,
    link ? `- 原文链接：${link}` : null,
    '',
    '> 说明：**逐字稿与摘要尚未抓取**（`minutes +detail` 的产出物需再带 artifact 参数）—— 本笔记只到标题、关键词与链接这一层。',
  ].filter((x) => x !== null).join('\n');

  return {
    ok: true,
    payload: {
      topic: title,
      date,
      content_md,
      tags,
      source: 'minutes',
    },
    origin: { channel: 'feishu', sender: '飞书妙记', messageId: `fs-min-${token}`, raw: link || token },
    _at: at,
  };
}

/** 跑一轮 */
export function ingestOnce({ run = defaultRun, dryRun = false, ownerId = null, pageSize = 20, maxNew = 200, now = Date.now() } = {}) {
  const errors = [];
  let inCount = 0; let outCount = 0; let refreshed = 0; let skipped = 0; let outOfScope = 0; let quarantined = 0;

  const owner = ownerId ? { ok: true, id: ownerId, from: '参数' } : resolveOwnerId({ run });
  if (owner.ok !== true) return { inCount: 0, outCount: 0, refreshed: 0, skipped: 0, outOfScope: 0, quarantined: 0, errors: [owner.why], dataAsOf: null, why: `身份取不到：${owner.why}` };

  const got = fetchMinutes({ ownerId: owner.id, run, pageSize });
  if (got.ok !== true) return { inCount: 0, outCount: 0, refreshed: 0, skipped: 0, outOfScope: 0, quarantined: 0, errors: [got.why], dataAsOf: null, why: `妙记列表取不到：${got.why}` };

  const seen = loadSeen();
  for (const item of got.items) {
    inCount += 1;
    const mapped = mapMinute(item);
    if (mapped.ok !== true) { quarantined += 1; errors.push(`妙记 ${String(item?.token ?? '?').slice(0, 20)} 映射失败：${mapped.errors.join('；')}`); continue; }
    const scope = inScope('note', mapped.payload, mapped._at);
    if (!scope.inScope) { skipped += 1; outOfScope += 1; continue; }
    if (dryRun) { outCount += 1; continue; }
    if (outCount + refreshed >= maxNew) { errors.push(`达到上限 ${maxNew} 条，其余下一轮再来`); break; }

    const made = makeEvent({ type: 'note', payload: mapped.payload, origin: mapped.origin, _at: mapped._at });
    if (made.ok === false) { quarantined += 1; errors.push(`妙记归一失败：${made.errors.join('；')}`); continue; }
    const r = store.upsert(made.event);
    if (r.action === 'rejected') { quarantined += 1; errors.push(`妙记落库被拒：${r.reason}`); continue; }
    if (r.action === 'added') outCount += 1; else if (r.action === 'updated') refreshed += 1;
    seen[mapped.origin.messageId] = { at: new Date(now).toISOString() };
  }
  if (!dryRun) saveSeen(seen);

  return {
    inCount, outCount, refreshed, skipped, outOfScope, quarantined, errors,
    ownerId: owner.id, ownerFrom: owner.from, hasMore: got.hasMore,
    dataAsOf: new Date(now).toISOString(),
    why: `妙记 ${got.items.length} 条（身份取自 ${owner.from}）→ 新采 ${outCount} · 刷新 ${refreshed} · 跳过 ${skipped}（其中出界 ${outOfScope}） · 隔离 ${quarantined}`
      + (got.hasMore ? ' · 还有更多页（本轮只取第一页）' : ''),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（注入假 run：不碰真 CLI）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const os = await import('node:os');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-fsmin-'));
  process.env.WB_V1_OUT = tmp;

  const NOW = Date.parse('2026-10-12T12:00:00+08:00');
  const M = (token, title, when, extra = {}) => ({
    token,
    display_info: `${title}\n<b>关键词:</b> 老师，模板，卡片`,
    meta_data: { app_link: `https://x.feishu.cn/minutes/${token}`, description: `所有者: 示例用户 开始时间: ${when} 时长: 1 分 58 秒` },
    ...extra,
  });
  const runWith = (items, owner = 'ou_test') => (args) => {
    // ⚠️ 位置别搞错：命令是 `['auth','status','--json']` ⇒ 子命令在 **args[0]**（不是 args[1]）。
    //   第一版写成 args[1] ⇒ 身份那步永远走失败分支 ⇒ 一轮里一条都没进（FSM-9..12 全红）。
    if (args[0] === 'auth') return { ok: true, json: { ok: true, identities: { user: { openId: owner } } } };
    if (args[1] === '+search') return { ok: true, json: { ok: true, data: { has_more: false, items } } };
    return { ok: false, why: '未预期参数：' + args.join(' ') };
  };

  try {
    // ① 解析
    chk('FSM-1', '★ 从 display_info 抠出标题与关键词', (() => { const p = parseDisplay('PRD文档生成实践安排\n<b>关键词:</b> 老师，模板，卡片'); return p.title === 'PRD文档生成实践安排' && p.tags.length === 3 && p.tags[0] === '老师'; })());
    chk('FSM-2', '★ 从 description 抠出开始时间（点号格式）', (() => { const t = parseStartMs('所有者: 杨瑒 开始时间: 2026.09.19 18:01:07 时长: 1 分 58 秒'); return t === new Date(2026, 8, 19, 18, 1, 7).getTime(); })(), String(parseStartMs('所有者: x 开始时间: 2026.09.19 18:01:07')));
    chk('FSM-3', '抠不出时间 ⇒ null（不编）', parseStartMs('没有时间') === null && parseStartMs(null) === null);

    // ② 映射
    const m = mapMinute(M('t1', 'PRD文档生成实践安排', '2026.09.19 18:01:07'));
    chk('FSM-4', '★ 主题/时间(YYYY-MM-DD)/内容三项（需求 3.1.4）', m.ok === true && m.payload.topic === 'PRD文档生成实践安排' && m.payload.date === '2026-09-19' && /# PRD/.test(m.payload.content_md), JSON.stringify({ topic: m.payload.topic, date: m.payload.date }));
    chk('FSM-5', '幂等键 = fs-min-<token>', m.origin.messageId === 'fs-min-t1');
    chk('FSM-6', '★ 正文没抓 ⇒ 笔记里**写明**（不假装有逐字稿）', /逐字稿与摘要尚未抓取/.test(m.payload.content_md));
    chk('FSM-7', '链接与关键词都进了内容', /https:\/\/x\.feishu\.cn/.test(m.payload.content_md) && m.payload.tags.length > 0);
    chk('FSM-8', '★ 负向对照：缺 token / 抠不出标题 / 抠不出时间 ⇒ 映射失败',
      mapMinute(M('', 'x', '2026.09.19 18:01:07')).ok === false && mapMinute({ token: 't', display_info: '', meta_data: {} }).ok === false);

    // ③ 一轮：界内一条入流、九月那条出界
    const items = [M('a', '新妙记甲', '2026.10.12 10:00:00'), M('b', '九月的老妙记', '2026.09.19 18:01:07')];
    const r1 = ingestOnce({ run: runWith(items), now: NOW });
    chk('FSM-9', '★ 一轮：界内入流、九月那条出界', r1.inCount === 2 && r1.outCount === 1 && r1.outOfScope === 1, JSON.stringify({ in: r1.inCount, out: r1.outCount, oos: r1.outOfScope }));
    chk('FSM-10', '库里 1 条笔记（进的是笔记页）', store.list({ type: 'note' }).length === 1, String(store.list({ type: 'note' }).length));
    chk('FSM-11', '身份来源写进读数（env / auth status）', r1.ownerFrom === 'auth status' && r1.ownerId === 'ou_test', JSON.stringify({ from: r1.ownerFrom, id: r1.ownerId }));

    // ④ 幂等
    const r2 = ingestOnce({ run: runWith(items), now: NOW });
    chk('FSM-12', '★ 第二轮幂等：不新建', r2.outCount === 0 && store.list({ type: 'note' }).length === 1, JSON.stringify({ out: r2.outCount }));

    // ⑤ 失败路径分得清
    const r3 = ingestOnce({ run: () => ({ ok: false, why: 'lark-cli 报错：missing required scope(s): minutes:minutes.search:read' }), now: NOW });
    chk('FSM-13', '★ 身份取不到 ⇒ 写明原因（不写成"没有妙记"）', /身份取不到/.test(r3.why), r3.why);
    const run4 = (args) => (args[0] === 'auth' ? { ok: true, json: { identities: { user: { openId: 'ou_x' } } } } : { ok: false, why: 'lark-cli 报错：网络不可达' });
    const r4 = ingestOnce({ run: run4, now: NOW });
    chk('FSM-14', '★ 列表取不到 ⇒ 也写明原因', /妙记列表取不到/.test(r4.why) && /网络不可达/.test(r4.why), r4.why);

    // ⑥ 干跑不写盘
    const before = store.list({ type: 'note' }).length;
    ingestOnce({ run: runWith([M('c', '干跑不该写', '2026.10.12 11:00:00')]), dryRun: true, now: NOW });
    chk('FSM-15', '干跑不写盘', store.list({ type: 'note' }).length === before);
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
