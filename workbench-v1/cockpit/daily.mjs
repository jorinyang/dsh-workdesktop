/**
 * `v1/cockpit/daily.mjs` —— **驾驶舱每日生成**（用户第 8 节）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户原话
 *   「驾驶舱**每天幂等执行**：从处理引擎存储到知识库的内容中提取事件切片，分析业务发展趋势；
 *     结合知识库资产的知识点，洞察业务规律；结合知识库沉淀的方法论，进行业务全面分析；
 *     最终形成业务改进建议。**所有内容不断积累，从一开始到当前，无上限。**」
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 三条纪律
 *
 *   一、**幂等靠输入指纹**，不靠"记住今天跑过没有"。
 *      `narrative()` 自己按（提问 + 材料）算指纹，没变就直接返回缓存、**不调模型**。
 *      ⇒ 今天跑两次、明天材料没变再跑一次，都不会重复烧 token；
 *        而材料真的变了（进了新事件）⇒ 自动重算，不必有人记得"该重新生成了"。
 *      （这一点是本文件**不用自己的日期判断**的原因：日期判断会在"今天补了昨天的数据"时漏掉。）
 *
 *   二、**逐块跑，一块失败不影响其余**。
 *      模型偶发不答是常事（见 `cockpit.mjs#narrative` 的重试），
 *      但"趋势生成失败"不该把"建议"也一起拖住。
 *      ⇒ 每块各报各的结果，最后汇总。
 *
 *   三、**跑完把这一轮的账写下来**（`cockpit/daily-log.jsonl`）。
 *      用户说"内容不断积累、无上限"—— 那"哪一天生成了什么"本身也是要能回查的。
 *      账只追加、不覆盖（与 `engine-runs.jsonl` 同一个道理）。
 *
 * 用法：
 *   node _meta/workbench/v1/cockpit/daily.mjs              # 跑一遍
 *   node _meta/workbench/v1/cockpit/daily.mjs --dry        # 只报会做什么，不调模型
 *   node _meta/workbench/v1/cockpit/daily.mjs --force      # 无视指纹，全部重算
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { narrative, NARRATIVE_SPECS, narrativeDir, units } from '../api/cockpit.mjs';

/** 每一轮要生成的块（顺序＝页面上自上而下的顺序） */
export const DAILY_KINDS = Object.freeze(['trend', 'insight', 'analysis', 'state', 'advice']);

/** 这一轮的账：只追加，不覆盖 */
export function dailyLogFile() { return path.join(narrativeDir(), 'daily-log.jsonl'); }

export function appendDailyLog(entry) {
  try {
    fs.mkdirSync(narrativeDir(), { recursive: true });
    fs.appendFileSync(dailyLogFile(), JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/**
 * 跑一轮。
 * @param {{now?:number, dry?:boolean, force?:boolean, modelFn?:Function, log?:boolean}} o
 * @returns {{at:string, ran:Array, ok:number, failed:number, refused:number, cached:number}}
 */
export async function runDaily({ now = Date.now(), dry = false, force = false, modelFn = null, log = true } = {}) {
  const at = new Date(now).toISOString();
  const ran = [];
  for (const kind of DAILY_KINDS) {
    if (dry) { ran.push({ kind, action: 'dry' }); continue }
    let r;
    try {
      r = await narrative(kind, { now, force, ...(modelFn ? { modelFn } : {}) });
    } catch (e) {
      r = { ok: false, why: `抛异常：${String((e && e.message) || e).slice(0, 160)}` };
    }
    ran.push({
      kind,
      action: r.ok !== true ? (r.refused ? 'refused' : 'failed') : (r.cached ? 'cached' : 'generated'),
      label: r.label ?? NARRATIVE_SPECS[kind]?.label ?? kind,
      chars: r.text ? String(r.text).length : 0,
      retried: r.retried ?? null,
      why: r.ok === true ? null : String(r.why ?? '').slice(0, 200),
    });
  }
  const summary = {
    at,
    // ★ 单元清单也记一笔：复盘那一块是按单元走的，事后要看得出"当时有哪些单元可选"
    units: (() => { try { const u = units({ now }); return { count: u.counts.units, events: u.counts.events } } catch { return null } })(),
    ran,
    ok: ran.filter((x) => x.action === 'generated' || x.action === 'cached').length,
    cached: ran.filter((x) => x.action === 'cached').length,
    failed: ran.filter((x) => x.action === 'failed').length,
    refused: ran.filter((x) => x.action === 'refused').length,
  };
  if (log && dry !== true) appendDailyLog(summary);
  return summary;
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const force = argv.includes('--force');
  runDaily({ dry, force })
    .then((s) => {
      console.log(`驾驶舱每日生成 · ${s.at}${dry ? '（干跑，不调模型）' : ''}`);
      for (const x of s.ran) {
        const mark = x.action === 'generated' ? '生成' : x.action === 'cached' ? '用缓存' : x.action === 'refused' ? '拒绝' : x.action === 'failed' ? '失败' : '干跑';
        console.log(`  ${mark.padEnd(4)} ${String(x.label ?? x.kind)}${x.chars ? ` · ${x.chars} 字` : ''}${x.retried ? `（${x.retried === 'slim' ? '减料后成功' : '重试后成功'}）` : ''}${x.why ? `\n        ${x.why}` : ''}`);
      }
      console.log(`  小结：成功 ${s.ok}（其中用缓存 ${s.cached}）· 失败 ${s.failed} · 拒绝 ${s.refused}`);
      process.exit(0);
    })
    .catch((e) => { console.error('✗ 跑挂了：' + String((e && e.stack) || e)); process.exit(1) });
}

/**
 * 自检（2026-10-14 加）—— 钉住用户第 8 节那条要求：
 *   「驾驶舱**每天幂等执行**…**所有内容不断积累，从一开始到当前，无上限**。」
 *
 * 为什么这几条必须写成可判的：
 *   · **幂等**是这条要求的核心，而它的失效方式很安静 —— 不幂等不会报错，
 *     只会每天多烧五次模型调用，**没人会发现**（这正是本项目一贯栽的那类错）。
 *   · "一块失败拖累其余"同样安静：页面上那几块空着，看不出是模型的问题还是流程的问题。
 */
export async function selfTest() {
  const fs2 = await import('node:fs');
  const os = await import('node:os');
  const path2 = await import('node:path');
  const { makeEvent } = await import('../schema.mjs');
  const store = await import('../store.mjs');
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail: String(detail) });

  const prev = process.env.WB_V1_OUT;
  const tmp = fs2.mkdtempSync(path2.join(os.tmpdir(), 'wb-ckp-daily-'));
  process.env.WB_V1_OUT = tmp;
  const NOW = Date.parse('2026-10-12T10:00:00+08:00');
  try {
    store.upsert(makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw: '要处理', source: 'im', modality: 'text', summary: '要处理' }, origin: { channel: 'dingtalk', sender: '张伟', messageId: 'd1' }, _at: NOW - 86400000 }).event);
    store.upsert(makeEvent({ type: 'note', payload: { topic: 'A', date: '2026-10-10', content_md: 'x', tags: ['设计'] }, origin: { channel: 'manual', sender: '我', messageId: 'd2' }, _at: NOW - 86400000 }).event);

    let calls = 0;
    const stub = async () => { calls += 1; return { ok: true, text: '（桩）判断：在推进' } };
    const r1 = await runDaily({ now: NOW, modelFn: stub });
    chk('DL-1', '★ 一轮跑齐五块（趋势/复盘/全盘/状态/建议）', r1.ran.length === 5 && r1.ran.every((x) => x.action === 'generated'), r1.ran.map((x) => x.kind + ':' + x.action).join(' '));
    chk('DL-2', '★ 五块各调一次模型', calls === 5, String(calls));

    const before = calls;
    const r2 = await runDaily({ now: NOW, modelFn: stub });
    chk('DL-3', '★★ 材料没变 ⇒ 全部走缓存（**幂等**）', r2.ran.every((x) => x.action === 'cached'), r2.ran.map((x) => x.action).join(' '));
    chk('DL-4', '★★ 且**一次模型都没再调**（幂等＝不重复烧 token）', calls === before, `${before} → ${calls}`);

    const stubFailOne = async (p) => (p.includes('业务单元') ? { ok: false, why: '模型返回非 0' } : { ok: true, text: '（桩）好' });
    const r3 = await runDaily({ now: NOW, modelFn: stubFailOne, force: true });
    chk('DL-5', '★ 一块失败**不拖累**其余（失败 1、成功 4）',
      r3.ran.filter((x) => x.action === 'failed').length === 1 && r3.ran.filter((x) => x.action === 'generated').length === 4,
      r3.ran.map((x) => x.kind + ':' + x.action).join(' '));
    chk('DL-6', '★ 失败那块的**原因如实记下来**（不是一句"失败"）',
      String(r3.ran.find((x) => x.action === 'failed')?.why || '').length > 0,
      String(r3.ran.find((x) => x.action === 'failed')?.why || '').slice(0, 60));

    const lines = fs2.readFileSync(dailyLogFile(), 'utf8').trim().split('\n').filter(Boolean);
    chk('DL-7', '★ 跑一轮记一笔账（只追加、不覆盖）', lines.length === 3, `${lines.length} 笔`);
    const last = JSON.parse(lines[lines.length - 1]);
    chk('DL-8', '★ 账里有时间 / 每块处置 / 成败计数 / 单元数',
      !!last.at && Array.isArray(last.ran) && typeof last.ok === 'number' && last.units !== undefined,
      JSON.stringify({ at: last.at, ok: last.ok, failed: last.failed, units: last.units }));
    chk('DL-9', '★ 账里分得清"生成"与"用缓存"（否则事后看不出有没有白跑）',
      lines.some((l) => JSON.parse(l).ran.some((x) => x.action === 'cached')));

    const beforeLen = fs2.readFileSync(dailyLogFile(), 'utf8').length;
    const beforeCalls = calls;
    const r5 = await runDaily({ now: NOW, dry: true, modelFn: stub });
    chk('DL-10', '★ 干跑：不调模型、不记账', calls === beforeCalls
      && fs2.readFileSync(dailyLogFile(), 'utf8').length === beforeLen
      && r5.ran.every((x) => x.action === 'dry'),
      `模型 ${beforeCalls}→${calls} · 账长度不变=${fs2.readFileSync(dailyLogFile(), 'utf8').length === beforeLen}`);
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs2.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  return { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selftest')) {
    const r = await selfTest();
    for (const x of r.details) console.log(`  [${x.ok ? '过' : '没过'}] ${x.id} :: ${x.desc}${x.detail ? ' —— ' + x.detail : ''}`);
    console.log(`  PASS = ${r.pass}   FAIL = ${r.fail}`);
    process.exit(r.fail === 0 ? 0 : 1);
  }
  main();
}
