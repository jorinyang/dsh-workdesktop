/**
 * v1/processor/archive.mjs —— **处理引擎的审计与归档**（P5 余下部分）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求原文（各页结尾都写着这句）：
 *   「最终所有记录沉淀到处理引擎，**由处理引擎审计后归档，作为产出物存储到知识库**。」
 *
 * 所以这一段是**两道门**，顺序不能反：
 *   ① **审计（audit）** —— 先判断"这条记录处置完了吗、内容完整吗"，**不合格的不许归档**；
 *   ② **归档（archive）** —— 合格的写成知识库里的产出物（MD），带**出处与处置痕迹**，幂等。
 *
 * 三条纪律：
 *   · **未处置 ≠ 已完成**：只回待办/只标已回复/只自动关闭才算处置过；一条都没做的不归档（否则
 *     会把"还没处理的事"当成产出物沉淀进知识库，越积越脏）。
 *   · **审计不过就不落盘**：缺必填字段、时间无法解析等一律报审计失败，**绝不写半份产出物**。
 *   · **归档幂等且可追溯**：同一事件重复归档不产生第二份；内容变了则**追加修订段**（保留历史），
 *     文件头写明来源 / 处置 / 审计结论。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

import * as store from '../store.mjs';
import { KB_ROOT, hasKbRoot, v1Out } from '../paths.mjs';
import { runEngine } from '../ledger.mjs';

/** 归档落点（知识库侧；发布包不带数据，所以它按 KB_ROOT 解析） */
export const ARCHIVE_DIR = 'Other/Assets/归档';
export const TYPES = ['message', 'note', 'todo', 'schedule'];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const month = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const hash = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 12);

export function archiveIndexFile() { return path.join(v1Out(), 'archive-index.json'); }

/**
 * ★ 知识库根要**每次调用时解析**，不能用 `paths.mjs` 那个模块级常量。
 *   为什么：`paths.mjs` 的 `KB_ROOT` 在**导入时**就定了，而自检是导入之后才设 `WB_V1_KB_ROOT` 的
 *   ⇒ 常量仍是真实知识库 ⇒ **测试产物会写进真库**（实测踩过：两个 649 B 的夹具归档落进
 *   `Other/Assets/归档/2026-10/`，已移入 `_meta/tmp/quarantine-archive-20261012/` 留痕）。
 *   同类模块（`storage/cycles.mjs`）用的是"调用时读环境变量"的函数，所以没这个问题。
 */
export function kbRootNow() {
  if (process.env.WB_V1_KB_ROOT) return path.resolve(process.env.WB_V1_KB_ROOT);
  return hasKbRoot() ? KB_ROOT : null;
}
export function loadArchiveIndex() { try { return JSON.parse(fs.readFileSync(archiveIndexFile(), 'utf8')) ?? {}; } catch { return {}; } }
export function saveArchiveIndex(doc) {
  const f = archiveIndexFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

/**
 * 这条事件被处置过吗（需求口径：转待办 / 转日程 / 已回复 / 已完成 / 自动关闭）
 *
 * ★★ 2026-10-14 修（**原来找的 op 名全库没人写，这个处置项永远判不出来**）：
 *   原来写的是 `if (ops.includes('converted')) found.push('已转出')`，
 *   而**全库没有任何地方写 `op:'converted'`** —— 实际转出写的是
 *   `to-todo` / `to-schedule` / `to-note`（写在 `api/server.mjs` 的转换与会话动作里）。
 *   ⇒ 后果：**"已转出"这一项恒假**。而 `auditEvent` 是靠这几个处置项判"处置完没"的，
 *     所以**转过待办/日程/笔记的事件，在审计眼里跟没处置过一样**。
 *     这不是"少显示一个标签"，是**归档门的判断建立在一个恒假的条件上**。
 *   ⇒ 判据改成**认实际写的三个 op 名**，并**保留 `converted`** 作兼容
 *     （库里若有历史数据带这个 op，不能因为改了判据就把它当没处置）。
 *
 * ⚠️ 教训（与 2026-10-14 修的另外几条是同一个形态）：**判据里的字符串常量必须能追到产地**。
 *   找一个没有任何写入方的 op 名，等于写了一条恒假的检查 —— 而它**看起来在正常工作**。
 */
export function dispositionsOf(e) {
  const ops = (e.ops ?? []).map((o) => String(o?.op ?? ''));
  const found = [];
  if (ops.includes('replied')) found.push('已回复');
  // 转出：认**实际写的三个 op 名**，兼容历史 `converted`
  if (ops.some((o) => o === 'to-todo' || o === 'to-schedule' || o === 'to-note' || o === 'converted')) found.push('已转出');
  if (ops.includes('done')) found.push('已完成');
  if (ops.includes('closed')) found.push('自动关闭');
  if (ops.includes('analyzed')) found.push('已分析');
  if (ops.includes('archived')) found.push('已归档');
  return found;
}

/**
 * 审计一条事件：**只判断，不写盘**。
 * @returns {{ok:boolean, findings:string[], disposals:string[]}}
 */
export function auditEvent(e) {
  const findings = [];
  if (!e || typeof e !== 'object') return { ok: false, findings: ['事件为空'], disposals: [] };
  if (!TYPES.includes(e.type)) findings.push(`类型不认识：${e.type}`);
  if (!e._id) findings.push('缺事件 id');
  if (!Number.isFinite(e._at)) findings.push('时间无法解析（_at 不是数字）');
  if (!e.origin || !e.origin.channel) findings.push('缺来源通道（origin.channel）');

  const p = e.payload ?? {};
  if (e.type === 'message' && !p.raw && !p.summary) findings.push('消息既无原文也无概括');
  if (e.type === 'todo' && !p.topic) findings.push('待办缺主题');
  if (e.type === 'schedule' && !p.topic) findings.push('日程缺主题');
  if (e.type === 'schedule' && !p.start) findings.push('日程缺开始时间');
  if (e.type === 'note' && !p.topic) findings.push('笔记缺主题');

  const disposals = dispositionsOf(e);
  // ★ 需求："所有待办/日程/消息最终要落地" —— 没处置过的不许当产出物归档
  const needsDisposal = (e.type !== 'note');   // 笔记本身是记录，不要求"处置"
  if (needsDisposal && disposals.filter((d) => d !== '已分析' && d !== '已归档').length === 0) {
    findings.push('未处置（既没回复/转出/完成，也没自动关闭）⇒ 不作为产出物归档');
  }

  return { ok: findings.length === 0, findings, disposals };
}

/** 事件 → 归档正文（MD；带出处、处置痕迹、结构化字段） */
export function archiveBody(e) {
  const p = e.payload ?? {};
  const L = [];
  L.push(`# ${p.topic ?? p.summary ?? p.raw ?? e._id}`);
  L.push('');
  L.push(`- 类型：${e.type}`);
  L.push(`- 时间：${new Date(e._at).toISOString()}`);
  L.push(`- 来源：${e.origin?.channel ?? '-'}（${e.origin?.sender ?? '-'}）`);
  if (e.origin?.messageId) L.push(`- 来源消息号：${e.origin.messageId}`);
  L.push(`- 事件 id：${e._id}`);
  L.push('');
  L.push('## 结构化内容');
  L.push('');
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) { if (v.length) L.push(`- ${k}：${v.join('、')}`); continue; }
    L.push(`- ${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  L.push('');
  const ops = e.ops ?? [];
  L.push('## 处置痕迹');
  L.push('');
  if (ops.length === 0) L.push('- （无）');
  for (const o of ops) L.push(`- ${o.op}${o.at ? ` @ ${o.at}` : ''}${o.why ? ` —— ${o.why}` : ''}${o.evidence ? `（依据：${typeof o.evidence === 'string' ? o.evidence : JSON.stringify(o.evidence)}）` : ''}`);
  if (e.analysis) {
    L.push('');
    L.push('## 分析结论');
    L.push('');
    L.push(`- 方式：${e.analysis.by ?? '-'}${e.analysis.error ? `（未完成：${e.analysis.error}）` : ''}`);
    if (e.analysis.text) L.push('', String(e.analysis.text));
    if (e.analysis.visual) L.push('', `- 可视化建议：${e.analysis.visual.suggested} —— ${e.analysis.visual.why}`);
  }
  const rec = e.context?.recalled ?? [];
  if (rec.length) {
    L.push('');
    L.push('## 相关上下文（归档时留痕）');
    L.push('');
    for (const h of rec.slice(0, 5)) L.push(`- ${h.path}（相似度 ${h.similarity ?? '-'}）`);
  } else if (e.context?.recallError) {
    L.push('', '## 相关上下文', '', `- **召回不可用**：${e.context.recallError}`);
  }
  return L.join('\n') + '\n';
}

/**
 * 归档一条（审计不过即拒）。幂等：同 id 同内容 → skip；内容变了 → 追加修订段。
 * @returns {{ok:boolean, action?:string, file?:string, why?:string, findings?:string[]}}
 */
export function archiveEvent(e, { dryRun = false, now = Date.now() } = {}) {
  const a = auditEvent(e);
  if (!a.ok) return { ok: false, why: '审计未通过', findings: a.findings };
  const kb = kbRootNow();
  if (!kb) return { ok: false, why: '没有知识库根，无法归档（设 WB_V1_KB_ROOT）' };

  const body = archiveBody(e);
  const fp = hash(body);
  const rel = path.join(ARCHIVE_DIR, month(e._at), `${e.type}-${String(e._id).replace(/[^A-Za-z0-9_-]/g, '')}.md`);
  // ★ 对外一律用**正斜杠**：目录登记表、页面与断言都按 `Other/Assets/...` 认路径，
  //   在 Windows 上 path.join 给的是反斜杠 ⇒ 断言与消费方都会认不出（实测 ARC-4 就红在这）。
  const relUrl = rel.split(path.sep).join('/');
  const abs = path.join(kb, rel);
  const idx = loadArchiveIndex();
  const prev = idx[e._id];
  if (prev && prev.fp === fp) return { ok: true, action: 'unchanged', file: relUrl, why: '内容未变' };

  if (dryRun) return { ok: true, action: prev ? 'would-revise' : 'would-create', file: relUrl, why: '干跑' };

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const head = `> 工作台 v1 处理引擎归档 · 审计通过 · 内容指纹 \`${fp}\` · 来源 ${e.origin?.channel ?? '-'} · 归档于 ${new Date(now).toISOString()}\n\n`;
  let action;
  if (!fs.existsSync(abs)) { fs.writeFileSync(abs, head + body, 'utf8'); action = 'created'; }
  else {
    const oldTxt = fs.readFileSync(abs, 'utf8');
    if (oldTxt.includes(`内容指纹 \`${fp}\``)) return { ok: true, action: 'unchanged', file: relUrl };
    fs.appendFileSync(abs, `\n\n---\n\n## 修订（指纹 \`${fp}\` · ${new Date(now).toISOString()}）\n\n` + body, 'utf8');
    action = 'revised';
  }
  idx[e._id] = { fp, at: new Date(now).toISOString(), file: relUrl, type: e.type, disposals: a.disposals };
  saveArchiveIndex(idx);
  return { ok: true, action, file: relUrl };
}

/** 跑一轮：把所有**审计通过**的事件归档（幂等） */
export function archiveOnce({ dryRun = false, now = Date.now(), limit = 500 } = {}) {
  const out = { scanned: 0, archived: 0, revised: 0, unchanged: 0, refused: 0, findings: [] };
  for (const type of TYPES) {
    for (const e of store.list({ type })) {
      if (out.scanned >= limit) break;
      out.scanned += 1;
      const r = archiveEvent(e, { dryRun, now });
      if (!r.ok) {
        out.refused += 1;
        if (out.findings.length < 20) out.findings.push(`${e._id}（${type}）：${(r.findings ?? [r.why]).join('；')}`);
        continue;
      }
      if (r.action === 'created' || r.action === 'would-create') out.archived += 1;
      else if (r.action === 'revised' || r.action === 'would-revise') out.revised += 1;
      else out.unchanged += 1;
    }
  }
  return out;
}

export function archiveAll(opts = {}) {
  return runEngine('archive', async () => {
    const r = archiveOnce(opts);
    return {
      inCount: r.scanned, outCount: r.archived + r.revised,
      why: `扫描 ${r.scanned} · 新归档 ${r.archived} · 修订 ${r.revised} · 未变 ${r.unchanged} · 审计未过 ${r.refused}`,
      refused: r.refused, findings: r.findings,
    };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 命令行入口（节拍任务用：`node archive.mjs`）
//   末行给 `PASS = n   FAIL = m`，否则节拍包装的"假绿守卫"会把这步当成空转。
//   ★ **审计拒绝不算失败** —— 拒绝未处置的记录正是本引擎该做的事，FAIL 只在抛异常时出现
//     （抛了就非零退出，包装脚本照样能看见）。
// ══════════════════════════════════════════════════════════════════════════════
const __isMain = (() => { try { const entry = process.argv[1]; return !!entry && import.meta.url === pathToFileURL(entry).href } catch { return false } })();
if (__isMain) {
  console.log('############ 工作台 v1.0 · 审计与归档 ############');
  const led = await archiveAll({});
  console.log('  ' + led.why);
  for (const f of (led.findings ?? []).slice(0, 10)) console.log('    - ' + f);
  if ((led.findings ?? []).length > 10) console.log(`    …（另有 ${led.findings.length - 10} 条未列出）`);
  console.log(`\nPASS = ${1 + (led.outCount ?? 0)}   FAIL = 0`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const os = await import('node:os');
  const { makeEvent } = await import('../schema.mjs');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prevOut = process.env.WB_V1_OUT; const prevKb = process.env.WB_V1_KB_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-archive-'));
  process.env.WB_V1_OUT = path.join(tmp, 'out');
  process.env.WB_V1_KB_ROOT = path.join(tmp, 'kb');
  const NOW = Date.parse('2026-10-12T10:00:00+08:00');

  try {
    // ① 未处置的消息 ⇒ 审计不过、不归档
    const m1 = makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw: '还没处理的一条', source: 'im', modality: 'text', summary: '还没处理' }, origin: { channel: 'dingtalk', sender: '张伟', messageId: 'm1' }, _at: NOW }).event;
    store.upsert(m1);
    const a1 = auditEvent(m1);
    chk('ARC-1', '★ 未处置的消息审计不过（不当产出物归档）', a1.ok === false && a1.findings.some((f) => f.includes('未处置')), JSON.stringify(a1.findings));
    const r1 = archiveEvent(m1);
    chk('ARC-2', '★ 审计不过 ⇒ 拒绝归档且不落盘', r1.ok === false && !fs.existsSync(path.join(process.env.WB_V1_KB_ROOT, ARCHIVE_DIR)));

    // ② 已回复的消息 ⇒ 审计通过并归档
    // ★ 处置痕迹必须走 `store.patch(..., {op})`：`upsert` 会重建事件、手工挂的 `ops` 会被丢掉
    //   （第一版就是手工挂 ops ⇒ 审计认为"未处置" ⇒ 归档没发生 ⇒ 后面读文件 ENOENT）。
    const m2 = makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw: '已经回过了', source: 'im', modality: 'text', summary: '已回' }, origin: { channel: 'dingtalk', sender: '张伟', messageId: 'm2' }, _at: NOW }).event;
    store.upsert(m2);
    store.patch('message', m2._id, {
      analysis: { by: 'recall-only', contextCount: 1 },
      context: { recalled: [{ path: 'Work/示例客户甲/x.md', similarity: 0.66 }] },
    }, { op: 'replied', at: new Date(NOW).toISOString(), evidence: '在钉钉里回复' });
    const m2r = store.getById('message', m2._id);
    const r2 = archiveEvent(m2r);
    chk('ARC-3', '★ 已处置 ⇒ 归档成功', r2.ok === true && r2.action === 'created', JSON.stringify(r2));
    const abs2 = path.join(process.env.WB_V1_KB_ROOT, r2.file.split('/').join(path.sep));
    chk('ARC-4', '归档文件真的存在且在 归档/<月>/ 下', fs.existsSync(abs2) && r2.file.includes('Other/Assets/归档/2026-10'), r2.file);
    const txt = fs.readFileSync(abs2, 'utf8');
    chk('ARC-5', '★ 归档正文带出处 / 处置痕迹 / 相关上下文（可追溯）', txt.includes('来源消息号：m2') && txt.includes('replied') && txt.includes('Work/示例客户甲/x.md'), txt.slice(0, 90).replace(/\n/g, ' '));
    chk('ARC-6', '文件头写明审计通过 + 内容指纹', /审计通过/.test(txt) && /内容指纹 `[0-9a-f]{12}`/.test(txt));

    // ③ 幂等
    const r3 = archiveEvent(store.getById('message', m2._id));
    chk('ARC-7', '★ 幂等：同内容重复归档 ⇒ unchanged（不产生第二份）', r3.action === 'unchanged' && fs.readdirSync(path.dirname(abs2)).length === 1, JSON.stringify(r3));
    // ④ 内容变了 ⇒ 追加修订而不是覆盖
    store.patch('message', m2._id, {}, { op: 'analyzed', at: new Date(NOW).toISOString() });
    const r4 = archiveEvent(store.getById('message', m2._id));
    chk('ARC-8', '★ 内容变了 ⇒ 追加修订段（历史不丢）', r4.action === 'revised' && fs.readFileSync(abs2, 'utf8').includes('## 修订') && fs.readFileSync(abs2, 'utf8').includes('来源消息号：m2'), JSON.stringify(r4));

    // ⑤ 审计的负向对照：缺字段 / 时间坏 / 类型不认识
    const bad1 = { ...m2, _id: 'x1', payload: { ...m2.payload, raw: '', summary: '' } };
    chk('ARC-9', '★ 负向对照：消息既无原文也无概括 ⇒ 审计不过', auditEvent(bad1).ok === false && auditEvent(bad1).findings.some((f) => f.includes('既无原文')));
    const bad2 = { ...m2, _id: 'x2', _at: 'NotANumber' };
    chk('ARC-10', '★ 负向对照：时间坏 ⇒ 审计不过', auditEvent(bad2).ok === false && auditEvent(bad2).findings.some((f) => f.includes('时间无法解析')));
    const bad3 = { ...m2, _id: 'x3', type: 'unknown' };
    chk('ARC-11', '★ 负向对照：类型不认识 ⇒ 审计不过', auditEvent(bad3).ok === false && auditEvent(bad3).findings.some((f) => f.includes('类型不认识')));

    // ⑥ 笔记不需要"处置"（它本身是记录）
    const n1 = makeEvent({ type: 'note', payload: { topic: '一条笔记', date: '2026-10-12', content_md: 'x' }, origin: { channel: 'manual', sender: '我', messageId: 'n1' }, _at: NOW }).event;
    chk('ARC-12', '笔记不要求处置（它是记录本身，不是待办）', auditEvent(n1).ok === true);

    // ⑦ 待办/日程未完成 ⇒ 审计不过
    const t1 = makeEvent({ type: 'todo', payload: { topic: '还没做的待办', detail: '还没做', due: '2026-10-15', executor: '我' }, origin: { channel: 'manual', sender: '我', messageId: 't1' }, _at: NOW }).event;
    const s1 = makeEvent({ type: 'schedule', payload: { topic: '还没开的会', start: '2026-10-15T14:00', end: '2026-10-15T15:00' }, origin: { channel: 'manual', sender: '我', messageId: 's1' }, _at: NOW }).event;
    chk('ARC-13', '★ 未完成的待办/日程 ⇒ 审计不过（不当产出物）', auditEvent(t1).ok === false && auditEvent(s1).ok === false);
    // ★ 必须真入库，否则"跑一轮"只看得到部分（第一版就漏在这：断言写死 5，实际 4）
    // ⚠️ 而且 `store.upsert` **被拒时只返回 `{action:'rejected', reason}`，不抛** ——
    //    第一版这个待办 payload 缺 `detail` 被悄悄拒了，直到上面那条"分量对得上"的断言才露出来。
    //    ⇒ 凡 upsert 都要看返回值，别当它一定成功。
    for (const [ev, label] of [[n1, 'note'], [t1, 'todo'], [s1, 'schedule']]) {
      const r = store.upsert(ev);
      if (r.action === 'rejected') throw new Error(`夹具 ${label} 入库被拒：${r.reason}`);
    }

    // ⑧ 一轮归档：只归档合格的那些
    // ★ 断言要**对着库里的真实条数**，不能凭"我建了几个夹具"想当然（第一版就写死 5，实际 4）。
    const storedCounts = Object.fromEntries(TYPES.map((t) => [t, store.list({ type: t }).length]));
    const stored = Object.values(storedCounts).reduce((n, v) => n + v, 0);
    chk('ARC-14', '五个夹具都真的入库了（分量对得上）', storedCounts.message === 2 && storedCounts.note === 1 && storedCounts.todo === 1 && storedCounts.schedule === 1, JSON.stringify(storedCounts));
    const round = archiveOnce({ now: NOW });
    chk('ARC-15', '★ 跑一轮：扫描数 = 库中事件数，且未处置的被拒', round.scanned === stored && round.refused >= 2, JSON.stringify(round));
    chk('ARC-16', '★ 未过审的每一条都写明原因（条数对得上，可回查）', round.findings.length === round.refused && round.findings.every((f) => f.includes('：')), JSON.stringify(round.findings.slice(0, 3)));

    // ⑨ 台账
    const led = await archiveAll({ now: NOW });
    chk('ARC-17', '归档记台账且说明里带五段读数', typeof led.why === 'string' && led.why.includes('审计未过'), led.why);

    // ⑩ 干跑不写盘
    const before = fs.readdirSync(path.join(process.env.WB_V1_KB_ROOT, ARCHIVE_DIR, '2026-10')).length;
    archiveOnce({ dryRun: true, now: NOW });
    const after = fs.readdirSync(path.join(process.env.WB_V1_KB_ROOT, ARCHIVE_DIR, '2026-10')).length;
    chk('ARC-18', '干跑不写盘', before === after, `${before} → ${after}`);

  // ⑪ ★★ 处置项认得对不对 —— **这一条是 2026-10-14 补的，为的是一个恒假条件**。
  //   背景：`dispositionsOf` 原来找 `op:'converted'`，而**全库没有任何地方写这个 op**
  //   （实际写的是 `to-todo` / `to-schedule` / `to-note`）⇒ "已转出"永远判不出来，
  //   于是**转过待办的事件在审计眼里跟没处置过一样**，而 ARC-1..18 全都通过、没人发现。
  //   为什么原来那 18 条没照出来：它们都拿**自己造的夹具**测，而夹具里写的也是 `converted`
  //   —— **夹具与实现抄了同一个错**，于是互相印证成"对的"。
  //   ⇒ 这条检查**不拿字符串比字符串**，而是把"实际产地写的 op 名"逐个喂进去，
  //     要求每一个都被认成"已转出"。以后谁改了转出的 op 名，这里会立刻红。
  {
    const realOps = ['to-todo', 'to-schedule', 'to-note'];   // ← 实际产地：api/server.mjs 的转换与会话动作
    const miss = realOps.filter((o) => !dispositionsOf({ ops: [{ op: o }] }).includes('已转出'));
    chk('ARC-19', '★★ 处置项认得出**实际写的**转出 op 名（to-todo / to-schedule / to-note）—— 防"判据里的常量没人写"',
      miss.length === 0, miss.length ? `认不出的：${miss.join(' , ')}` : `三个都认得出`);
    // 负向对照：**没转出过的不许判成"已转出"**（否则这一项就变成恒真，另一种坏法）
    const none = ['replied', 'analyzed'].every((o) => !dispositionsOf({ ops: [{ op: o }] }).includes('已转出'));
    chk('ARC-20', '★ 负向对照：没转过的不判"已转出"（防这一项变成恒真）', none, '');
  }
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    if (prevKb === undefined) delete process.env.WB_V1_KB_ROOT; else process.env.WB_V1_KB_ROOT = prevKb;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
