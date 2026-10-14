/**
 * v1/storage/cycles.mjs —— **存储引擎的周期沉淀**（P6；需求 4.2）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求原文（照抄）
 *   "存储引擎需要周期性（**每天**）对存储到知识库中的内容进行向量化，同时需要幂等抽象出
 *    方法论/萃取知识和规律/构建模型（**每周**）。**每月**对知识库的所有资产做一次 review，
 *    同样需要以月度为单位沉淀资产（知识/方法论/模型），**月度 review 将作为知识库的时间切片存在，
 *    不覆盖周期性每周的知识沉淀**。所有沉淀的资产以 MD 文档的形式存储到知识库中。"
 *
 * 三条分工（不重合、不互相假装）
 *   ① **每天向量化**：本模块**不重写**索引器 —— 知识库自有 `DSH-RAG-Index-Update`（每日 03:00）。
 *      本模块只做**新鲜度核对**（`vectorizeStatus()`），把"索引落后了多少"如实报出来。
 *      理由：两处各写一遍索引 = 两份真相，且必然漂移（本项目吃过这个亏）。
 *   ② **每周**：把这一周的四类事件聚合成一份材料，交给模型萃取**方法论 / 知识规律 / 模型**，
 *      落成 MD 到 `Other/Assets/周/<年-W周>.md`。
 *   ③ **每月**：聚合当月的**周沉淀 + 事件切片**，交模型做 review，落成 `Other/Assets/月/<年-月>.md`。
 *      **月度是独立目录与独立文件** —— 结构上就不可能覆盖每周沉淀（不是靠自觉）。
 *
 * 幂等：每份沉淀都记 `输入指纹`（聚合文本的 sha256）。指纹没变 ⇒ 跳过，不重复调模型、不重复写文件。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath , pathToFileURL } from 'node:url';

import * as store from '../store.mjs';
import { runEngine } from '../ledger.mjs';
import { KB_ROOT as ROOT } from '../paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function kbRoot() { return process.env.WB_V1_KB_ROOT || ROOT; }
export function v1Out() { return process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1'); }
export const WEEK_DIR = 'Other/Assets/周';
export const MONTH_DIR = 'Other/Assets/月';
export function indexStateFile() { return path.join(v1Out(), 'assets-index.json'); }

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** ISO 周标签：YYYY-Www */
export function isoWeek(ms) {
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  const thu = new Date(d.getTime()); thu.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const firstThu = new Date(thu.getFullYear(), 0, 4);
  const week = 1 + Math.round(((thu - firstThu) / DAY - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${thu.getFullYear()}-W${pad(week)}`;
}
export const monthLabel = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

/** 取时间窗内的事件（四类） */
export function eventsIn(fromMs, toMs) {
  const all = [];
  for (const t of ['message', 'note', 'todo', 'schedule']) for (const e of store.list({ type: t })) if (e._at >= fromMs && e._at < toMs) all.push(e);
  return all.sort((a, b) => a._at - b._at);
}

/** 事件 → 聚合材料（给模型看的原料；控制体量） */
export function digestOf(events, { maxChars = 12000 } = {}) {
  const lines = [];
  for (const e of events) {
    const p = e.payload ?? {};
    const when = new Date(e._at).toISOString().slice(0, 16).replace('T', ' ');
    if (e.type === 'message') lines.push(`- [消息 ${when}] ${p.sender ?? ''}：${String(p.raw ?? '').slice(0, 160)}`);
    else if (e.type === 'note') lines.push(`- [笔记 ${p.date ?? when}] ${p.topic ?? ''}：${String(p.content_md ?? '').slice(0, 300)}`);
    else if (e.type === 'todo') lines.push(`- [待办 ${p.due ?? '无期限'}] ${p.topic ?? ''}（执行人 ${p.executor ?? '-'}）${(e.ops ?? []).some((o) => o.op === 'done') ? '【已完成】' : ''}`);
    else if (e.type === 'schedule') lines.push(`- [日程 ${p.start ?? ''}] ${p.topic ?? ''}${(e.ops ?? []).some((o) => o.op === 'done') ? '【已完成】' : ''}`);
    if (lines.join('\n').length > maxChars) { lines.push('…（材料过长，已截断）'); break; }
  }
  return lines.join('\n');
}

export const fingerprint = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);

export function loadIndex() { try { return JSON.parse(fs.readFileSync(indexStateFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveIndex(doc) {
  const f = indexStateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

/** 写资产 MD（绝不覆盖：同名且指纹不同 ⇒ 追加"修订"段，保留历史） */
export function writeAsset(relDir, name, body, fp) {
  const abs = path.join(kbRoot(), relDir, `${name}.md`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const head = `> 由工作台 v1 存储引擎生成 · 输入指纹 \`${fp}\` · 生成于 ${new Date().toISOString()}\n\n`;
  if (!fs.existsSync(abs)) { fs.writeFileSync(abs, head + body + '\n', 'utf8'); return { wrote: 'created', abs }; }
  const prev = fs.readFileSync(abs, 'utf8');
  if (prev.includes(`输入指纹 \`${fp}\``)) return { wrote: 'unchanged', abs };
  fs.appendFileSync(abs, `\n\n---\n\n## 修订（输入指纹 \`${fp}\` · ${new Date().toISOString()}）\n\n` + body + '\n', 'utf8');
  return { wrote: 'appended', abs };
}

/** 每周萃取（需求 4.2 的"幂等抽象出方法论/萃取知识和规律/构建模型"） */
export async function weeklySediment({ now = Date.now(), modelFn = null, dryRun = false } = {}) {
  const from = now - 7 * DAY;
  const events = eventsIn(from, now);
  const material = digestOf(events);
  const fp = fingerprint(material);
  const label = isoWeek(now);
  const key = `week:${label}`;
  const idx = loadIndex();
  if (idx[key]?.fp === fp) return { ok: true, skipped: true, why: '输入未变（指纹相同）', label, fp, events: events.length };
  if (events.length === 0) return { ok: true, skipped: true, why: '本周没有事件', label, fp, events: 0 };

  const prompt = [
    '你在把一周的业务流水萃取成可复用的资产。要求：只写能从材料里看出来的东西，不要编。',
    '输出三段（每段用「## 标题」开头）：',
    '## 方法论 —— 这一周实际用到的做法/步骤（可复用）',
    '## 知识与规律 —— 从材料里看出的规律、约束、经验',
    '## 模型 —— 能沉淀成结构的东西（分层、判据、流程骨架）',
    '每段不超过 300 字。材料里没有依据的，写"本周材料不足"。',
    '',
    `【本周材料】（${events.length} 条，${ymd(from)} ~ ${ymd(now)}）`,
    material || '（空）',
  ].join('\n');

  const m = modelFn ? await modelFn(prompt) : { ok: false, why: '未注入模型（dryRun 或离线）' };
  if (m.ok !== true) return { ok: false, why: `模型未产出：${m.why}`, label, fp, events: events.length };

  const body = `# 周沉淀 ${label}（${ymd(from)} ~ ${ymd(now)}）\n\n材料：${events.length} 条事件\n\n${m.text}\n`;
  if (dryRun) return { ok: true, dryRun: true, label, fp, events: events.length };
  const w = writeAsset(WEEK_DIR, label, body, fp);
  idx[key] = { fp, at: new Date().toISOString(), file: `${WEEK_DIR}/${label}.md`, events: events.length };
  saveIndex(idx);
  return { ok: true, skipped: false, label, fp, events: events.length, wrote: w.wrote };
}

/** 每月 review（**时间切片**，独立目录，结构上不可能覆盖每周） */
export async function monthlyReview({ now = Date.now(), modelFn = null, dryRun = false } = {}) {
  const label = monthLabel(now);
  const d = new Date(now); const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const events = eventsIn(first, now);
  // 复用当月已有的周沉淀作为"资产侧"输入（体现"不覆盖、只汇总"）
  const weekDirAbs = path.join(kbRoot(), WEEK_DIR);
  const weekFiles = fs.existsSync(weekDirAbs) ? fs.readdirSync(weekDirAbs).filter((f) => f.endsWith('.md')) : [];
  const weekText = weekFiles.map((f) => `\n### 来自周沉淀 ${f}\n` + fs.readFileSync(path.join(weekDirAbs, f), 'utf8').slice(0, 2000)).join('\n');
  const material = digestOf(events) + weekText;
  const fp = fingerprint(material);
  const key = `month:${label}`;
  const idx = loadIndex();
  if (idx[key]?.fp === fp) return { ok: true, skipped: true, why: '输入未变（指纹相同）', label, fp, events: events.length, weeks: weekFiles.length };

  const prompt = [
    '你在做一次月度知识资产 review。只依据材料，不要编。',
    '输出四段（每段用「## 标题」开头）：',
    '## 知识 —— 本月沉淀下来的知识点',
    '## 方法论 —— 本月成型的方法（与上周相比有何变化）',
    '## 模型 —— 本月构建/修订的模型',
    '## 缺口 —— 本月没做但该做的事（材料里能看出的）',
    '每段不超过 300 字。',
    '',
    `【本月材料】${label} · ${events.length} 条事件 · ${weekFiles.length} 份周沉淀`,
    material || '（空）',
  ].join('\n');

  const m = modelFn ? await modelFn(prompt) : { ok: false, why: '未注入模型（dryRun 或离线）' };
  if (m.ok !== true) return { ok: false, why: `模型未产出：${m.why}`, label, fp, events: events.length };

  const body = `# 月度 review ${label}（时间切片）\n\n本月事件 ${events.length} 条 · 汇总周沉淀 ${weekFiles.length} 份\n`
    + `> 本文件是**时间切片**：它汇总当月，但**不修改** \`${WEEK_DIR}/\` 下的任何周沉淀。\n\n${m.text}\n`;
  if (dryRun) return { ok: true, dryRun: true, label, fp, events: events.length };
  const w = writeAsset(MONTH_DIR, label, body, fp);
  idx[key] = { fp, at: new Date().toISOString(), file: `${MONTH_DIR}/${label}.md`, events: events.length };
  saveIndex(idx);
  return { ok: true, skipped: false, label, fp, events: events.length, weeks: weekFiles.length, wrote: w.wrote };
}

/** 每天的向量化：**只核对新鲜度**，不重写索引器（知识库自有 DSH-RAG-Index-Update） */
export function vectorizeStatus({ now = Date.now() } = {}) {
  const log = path.join(ROOT, 'D:/AI/rag/logs/scheduled-update.log');
  const candidates = ['D:/AI/rag/logs/scheduled-update.log', path.join(ROOT, '..', 'AI', 'rag', 'logs', 'scheduled-update.log')];
  let lastAt = null; let file = null;
  for (const c of candidates) { try { if (fs.existsSync(c)) { lastAt = fs.statSync(c).mtimeMs; file = c; break; } } catch { /* next */ } }
  if (!lastAt) return { ok: null, why: '找不到索引更新日志 ⇒ 探不到（不假装知道）', file: null };
  const hours = (now - lastAt) / 3600000;
  return { ok: hours <= 26, lastRunAt: new Date(lastAt).toISOString(), hoursAgo: Math.round(hours * 10) / 10, stale: hours > 26, file };
}

/** 一轮周期检查（供每日/每周/每月任务调用；自身幂等） */
export async function runCycles({ now = Date.now(), modelFn = null, dryRun = false } = {}) {
  return runEngine('store', async () => {
    const vec = vectorizeStatus({ now });
    const w = await weeklySediment({ now, modelFn, dryRun });
    const isMonthEnd = (() => { const d = new Date(now); const t = new Date(now + DAY); return t.getMonth() !== d.getMonth(); })();
    const m = isMonthEnd ? await monthlyReview({ now, modelFn, dryRun }) : { skipped: true, why: '非月末（月度 review 只在月末做）' };
    return {
      inCount: (w.events ?? 0) + (m.events ?? 0), outCount: (w.skipped ? 0 : 1) + (m.skipped ? 0 : 1),
      why: `向量化核对：${vec.ok === null ? '探不到' : vec.ok ? '新鲜' : `落后 ${vec.hoursAgo}h`}；周=${w.skipped ? '跳过' : w.wrote}；月=${m.skipped ? '跳过' : m.wrote}`,
      extra: { vectorize: vec, week: w, month: m },
    };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 命令行入口（计划任务用）：\`node cycles.mjs [--weekly|--monthly|--all] [--dry-run]\`
//   · 缺省 = --all（周 + 月都跑；两者各自幂等，指纹没变就跳过）
//   · 末行给 \`PASS = n   FAIL = m\` —— 节拍包装靠它 + 新台账行判"是不是空转"（假绿守卫）
//   · **写不出资产不算失败**（周期没到 / 指纹没变 ⇒ 本来就不该写）；FAIL 只在抛异常时出现
// ══════════════════════════════════════════════════════════════════════════════
const __isMain = (() => { try { const entry = process.argv[1]; return !!entry && import.meta.url === pathToFileURL(entry).href } catch { return false } })();
if (__isMain) {
  const DRY = process.argv.includes('--dry-run');
  const only = process.argv.includes('--weekly') ? 'weekly' : (process.argv.includes('--monthly') ? 'monthly' : 'all');
  console.log('############ 工作台 v1.0 · 存储周期（' + only + (DRY ? ' · 干跑' : '') + '）############');
  try {
    // ★ 必须注入模型：`weeklySediment`/`monthlyReview` 的 `modelFn` 缺省是 null，
    //   不注入就只打印「未注入模型」⇒ **定时任务 exit=0 却什么都不产出**（假绿那种形态，已实测踩到）。
    //   干跑**不注入**（不花 token）：干跑要看的只是"会不会写、写到哪"。
    let modelFn = null;
    if (!DRY) {
      const { runModel } = await import('../processor/analyze.mjs');
      modelFn = runModel;
    }
    const w = (only === 'monthly') ? { skipped: true, why: '本轮只跑月' } : await weeklySediment({ dryRun: DRY, modelFn });
    const m = (only === 'weekly') ? { skipped: true, why: '本轮只跑周' } : await monthlyReview({ dryRun: DRY, modelFn });
    console.log('  周：' + (w.skipped ? w.why : (w.why ?? JSON.stringify({ wrote: w.wrote, fp: w.fp }))));
    console.log('  月：' + (m.skipped ? m.why : (m.why ?? JSON.stringify({ wrote: m.wrote, fp: m.fp }))));
    const vs = vectorizeStatus({});
    console.log('  向量化状态：' + JSON.stringify(vs).slice(0, 220));
    console.log('\nPASS = 1   FAIL = 0');
  } catch (e) {
    console.log('  ✗ 周期执行异常：' + (e && e.message ? e.message : String(e)));
    console.log('\nPASS = 0   FAIL = 1');
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（临时知识库根 + 桩模型）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const os = await import('node:os');
  const { makeEvent } = await import('../schema.mjs');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT; const prevKb = process.env.WB_V1_KB_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-cycles-'));
  process.env.WB_V1_OUT = path.join(tmp, 'out');
  process.env.WB_V1_KB_ROOT = path.join(tmp, 'kb');
  const NOW = Date.parse('2026-10-31T20:00:00+08:00');   // 月末，便于触发月度
  const stub = async (p) => ({ ok: true, text: '## 方法论\n- 测试产出\n\n## 知识与规律\n- x\n\n## 模型\n- y' });

  try {
    chk('CYC-1', 'ISO 周标签与月标签正确', isoWeek(Date.parse('2026-10-12T10:00:00+08:00')) === '2026-W42' && monthLabel(NOW) === '2026-10', `${isoWeek(Date.parse('2026-10-12T10:00:00+08:00'))} / ${monthLabel(NOW)}`);

    store.upsert(makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw: '本周把验收单对齐了', source: 'im', modality: 'text' }, origin: { channel: 'dingtalk', sender: '张伟', messageId: 'm1' }, _at: NOW - 2 * DAY }).event);
    store.upsert(makeEvent({ type: 'note', payload: { topic: '采集器设计', date: '2026-10-29', content_md: '三个维度：通道/水位线/幂等', tags: ['设计'] }, origin: { channel: 'manual', sender: '我', messageId: 'n1' }, _at: NOW - 2 * DAY }).event);

    const w1 = await weeklySediment({ now: NOW, modelFn: stub });
    chk('CYC-2', '★ 周沉淀落成 MD（Other/Assets/周）', w1.ok === true && w1.skipped === false && fs.existsSync(path.join(process.env.WB_V1_KB_ROOT, WEEK_DIR, `${w1.label}.md`)), JSON.stringify(w1));
    chk('CYC-3', '周沉淀含输入指纹（可复算）', fs.readFileSync(path.join(process.env.WB_V1_KB_ROOT, WEEK_DIR, `${w1.label}.md`), 'utf8').includes(w1.fp));
    const w2 = await weeklySediment({ now: NOW, modelFn: stub });
    chk('CYC-4', '★ 幂等：输入未变 ⇒ 跳过（不重复调模型、不重复写）', w2.skipped === true && w2.why.includes('指纹相同'), JSON.stringify(w2));
    // ★ 指纹算的是**输入材料** ⇒ 要触发"修订"，得让输入真的变（新增一条事件），
    //   而不是只换个模型桩（第一版这里写错了：输入没变当然跳过，那是对的行为）
    store.upsert(makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '李强', raw: '又补了一条：验收单复印件也归档了', source: 'im', modality: 'text' }, origin: { channel: 'dingtalk', sender: '李强', messageId: 'm2' }, _at: NOW - DAY }).event);
    const w3 = await weeklySediment({ now: NOW, modelFn: async () => ({ ok: true, text: '## 方法论\n- 变了' }) });
    chk('CYC-5', '★ 输入变了 ⇒ 追加"修订"段而不是覆盖（历史不丢）', w3.skipped !== true && w3.wrote === 'appended', JSON.stringify(w3));
    chk('CYC-5b', '★ 修订后旧内容仍在（逐字保留）', fs.readFileSync(path.join(process.env.WB_V1_KB_ROOT, WEEK_DIR, `${w1.label}.md`), 'utf8').includes(w1.fp));

    const wkFile = path.join(process.env.WB_V1_KB_ROOT, WEEK_DIR, `${w1.label}.md`);
    const beforeWeekly = fs.readFileSync(wkFile, 'utf8');
    const m1 = await monthlyReview({ now: NOW, modelFn: stub });
    chk('CYC-6', '★ 月度 review 落成 MD（Other/Assets/月）', m1.ok === true && fs.existsSync(path.join(process.env.WB_V1_KB_ROOT, MONTH_DIR, `${m1.label}.md`)), JSON.stringify(m1));
    chk('CYC-7', '★ 月度不覆盖周沉淀：周文件内容逐字未变', fs.readFileSync(wkFile, 'utf8') === beforeWeekly);
    chk('CYC-8', '★ 月度文件里写明"这是时间切片、不修改周沉淀"', fs.readFileSync(path.join(process.env.WB_V1_KB_ROOT, MONTH_DIR, `${m1.label}.md`), 'utf8').includes('时间切片'));
    const m2 = await monthlyReview({ now: NOW, modelFn: stub });
    chk('CYC-9', '月度幂等（输入未变 ⇒ 跳过）', m2.skipped === true);

    const v = vectorizeStatus({ now: NOW });
    chk('CYC-10', '★ 向量化核对：探得到就报新鲜度，探不到就说探不到（不假装）', v.ok === null ? /探不到/.test(v.why) : typeof v.hoursAgo === 'number', JSON.stringify(v));

    const r = await runCycles({ now: NOW, modelFn: stub });
    chk('CYC-11', 'runCycles 记台账且说明里带三段读数', typeof r.why === 'string' && r.why.includes('向量化核对'), r.why);

    // ── CYC-13/14：守护"定时任务真的会产出"（2026-10-12 实测踩到的假绿形态）──────────
    //   现象：`node cycles.mjs` 曾经**没有命令行入口**（静默退出）；补了入口之后又发现
    //   `weeklySediment/monthlyReview` 的 `modelFn` 缺省是 null ⇒ 打印「未注入模型」
    //   然后 **exit=0 却什么都不产出**。计划任务看退出码只会判"成功"。
    //   所以这两条查的是源码事实：① 有入口；② 非干跑分支**真的注入了**模型。
    {
      const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
      // ★ 2026-10-14 改：这条原来断言的是**源文件里有一段特定写法的文本**
      //   （`process.argv[1] … cycles.mjs`）。那一轮把入口判据从"只判文件名后缀"
      //   改成"用 import.meta.url 精确比对"之后，**它当场就红了** —— 而入口本身是好好的。
      //   ⇒ 那是"**断言写法而不是断言行为**"的典型：检查应该问"有没有入口、入口严不严"，
      //     不该问"代码长得像不像我上次写的那段"。
      //   现在两条一起守：① 有入口；② 入口判据是**精确比对**（不许只判后缀）。
      chk('CYC-13', '★ 有命令行入口，且入口判据是精确比对（不靠文件名后缀）',
        /__isMain|isMain/.test(src) && /import\.meta\.url/.test(src)
        && !/^\s*if \(process\.argv\[1\][^\n]*\.endsWith\(/m.test(src));
      chk('CYC-14', '★ 非干跑分支注入了模型（否则 exit=0 但一个资产都不产出）',
        /if \(!DRY\)[\s\S]{0,200}runModel/.test(src) && /modelFn\s*=\s*runModel/.test(src));
    }

    chk('CYC-12', '★ 负向对照：模型失败 ⇒ 不写资产文件（不产出空壳）', (async () => true)() && await (async () => {
      const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-cyc2-'));
      process.env.WB_V1_OUT = path.join(t2, 'out'); process.env.WB_V1_KB_ROOT = path.join(t2, 'kb');
      store.upsert(makeEvent({ type: 'message', payload: { channel: 'manual', sender: '我', raw: 'x', source: 'manual', modality: 'text' }, origin: { channel: 'manual', sender: '我', messageId: 'm9' }, _at: NOW - DAY }).event);
      const bad = await weeklySediment({ now: NOW, modelFn: async () => ({ ok: false, why: '模型超时' }) });
      const dir = path.join(process.env.WB_V1_KB_ROOT, WEEK_DIR);
      return bad.ok === false && !fs.existsSync(dir);
    })());
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    if (prevKb === undefined) delete process.env.WB_V1_KB_ROOT; else process.env.WB_V1_KB_ROOT = prevKb;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
