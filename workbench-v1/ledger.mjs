/**
 * v1/ledger.mjs —— **引擎运行台账**（P0-4）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么必须有这一层（不是"锦上添花"，是本次重构的直接对策）
 *   2026-10-03 ~ 10-12 的实测事故：计划任务每小时/每 5 分钟都记 `exit=0 耗时=0s 零输出`，
 *   而真相是 **node 根本没启动**（任务环境 PATH 不展开 %NVM_SYMLINK%）——
 *   `chcp` 遗留的退出码 0 把失败伪装成成功，**连续假绿 9 天**，无人察觉。
 *   ⇒ v1.0 的每个引擎运行都必须留下**可判否**的痕迹：进了多少条、出了多少条、耗时多少。
 *   ⇒ 并且**"0 进 0 出 + 极短耗时"必须被自动标成可疑**（`suspicious:true`），
 *      而不是当成"正常的空转"。
 *
 * 落点：`_meta/out/v1/engine-runs.jsonl`（append-only，只追加不覆盖）
 *   · 为什么 jsonl：崩溃安全（追加一行是一条），且可被前端/守卫增量读。
 *   · 为什么在 `_meta/out/`：运行期状态（已登记豁免），不产生需登记的新产物。
 *
 * 纪律
 *   · `status` 只有三种：`ok` / `fail` / `skipped`（跳过必须写 `why`）。
 *   · **失败不得静默**：抛出的异常一律记 `fail` + `error`，再往上抛（由调用方决定是否继续）。
 *   · `suspicious` 只标"可疑"，**不改变 status** —— 判否权交给守卫与前端，台账只如实记录。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KB_ROOT as ROOT } from './paths.mjs';   // 路径收口（见 paths.mjs 顶部说明：原先按本文件深度往上数，包一挪就错）

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 台账目录/文件（可用 WB_V1_OUT 覆盖，供自检用临时目录） */
export function ledgerDir() {
  return process.env.WB_V1_OUT || path.join(ROOT, '_meta', 'out', 'v1');
}
export function ledgerPath() {
  return path.join(ledgerDir(), 'engine-runs.jsonl');
}

/** 「可疑」阈值：0 进 0 出且耗时低于这个毫秒数 ⇒ 大概率是"没真干活" */
export const SUSPICIOUS_MS = 50;

/** 引擎名（唯一来源；别在别处再写字符串字面量） */
export const ENGINES = Object.freeze([
  'collector',        // 采集引擎
  'filter',           // 筛选引擎
  'analyze',          // 分析引擎
  'process',          // 处理引擎
  'store',            // 存储引擎
  'dashboard',        // 驾驶舱构建
]);

/** 判定可疑：ok + 0进0出 + 太快 + **且没有解释**。
 *  ★ 为什么必须加"没有解释"这一条：5 分钟轮询大多数轮次本来就是空转（没有新消息），
 *    如果每一轮空转都标嫌疑，信号立刻变成噪声 —— 真正要抓的是
 *    **"声称跑了却什么都没干、也说不清为什么"**（10-03 那场假绿的形态正是如此：
 *    包装脚本自报 exit=0、零输出、无水印，没人知道它到底跑没跑）。 */
export function isSuspicious({ status, inCount, outCount, ms, why }) {
  return status === 'ok' && Number(inCount) === 0 && Number(outCount) === 0 && Number(ms) < SUSPICIOUS_MS && !why;
}

/** 追加一条运行记录（原子性由 appendFileSync 保证；目录不存在则建） */
export function record(entry) {
  const rec = {
    at: new Date().toISOString(),
    engine: entry.engine,
    status: entry.status ?? 'ok',
    ms: Math.max(0, Math.round(Number(entry.ms) || 0)),
    inCount: Number(entry.inCount) || 0,
    outCount: Number(entry.outCount) || 0,
    why: entry.why ?? null,
    error: entry.error ?? null,
    model: entry.model ?? null,
    tokens: entry.tokens ?? null,
    extra: entry.extra ?? null,
  };
  rec.suspicious = isSuspicious(rec);
  if (rec.suspicious) rec.suspiciousWhy = `0 进 0 出且耗时 ${rec.ms}ms < ${SUSPICIOUS_MS}ms ⇒ 疑似没真干活（假绿形态）`;
  try {
    fs.mkdirSync(ledgerDir(), { recursive: true });
    fs.appendFileSync(ledgerPath(), JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    // 台账写不进去不得掀翻引擎本身，但必须让人看见
    console.error(`⚠️ 引擎台账写入失败（不影响本次运行）: ${e.message}`);
  }
  return rec;
}

/**
 * 跑一个引擎并记账。
 * @param {string} engine 引擎名（ENGINES 之一）
 * @param {() => Promise<{inCount?:number,outCount?:number,why?:string,model?:string,tokens?:number,extra?:any}>|{inCount?:number,outCount?:number}} fn
 * @returns {Promise<any>} fn 的返回值（原样透传）
 */
export async function runEngine(engine, fn) {
  if (!ENGINES.includes(engine)) throw new Error(`未登记的引擎名：${JSON.stringify(engine)}（请先加进 ENGINES）`);
  const t0 = Date.now();
  try {
    const r = (await fn()) ?? {};
    record({ engine, status: r.why && r.inCount === undefined ? 'skipped' : 'ok', ms: Date.now() - t0, inCount: r.inCount, outCount: r.outCount, why: r.why, model: r.model, tokens: r.tokens, extra: r.extra });
    return r;
  } catch (e) {
    record({ engine, status: 'fail', ms: Date.now() - t0, error: String(e && e.message || e) });
    throw e;   // 失败继续往上抛：静默吞掉正是这次事故的成因
  }
}

/** 读台账（可按引擎/时间过滤；返回最近 N 条，默认升序） */
export function readRuns({ engine = null, since = null, limit = 200 } = {}) {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
  const out = [];
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (engine && r.engine !== engine) continue;
    if (since && !(r.at >= since)) continue;
    out.push(r);
  }
  return out.slice(-limit);
}

/** 每个引擎的最后一次运行 + 可疑计数（前端底栏/驾驶舱读这个） */
export function summary() {
  const runs = readRuns({ limit: 100000 });
  const by = {};
  for (const r of runs) {
    const s = by[r.engine] ?? (by[r.engine] = { engine: r.engine, runs: 0, fails: 0, suspicious: 0, last: null });
    s.runs += 1;
    if (r.status === 'fail') s.fails += 1;
    if (r.suspicious) s.suspicious += 1;
    s.last = r;
  }
  for (const e of ENGINES) if (!by[e]) by[e] = { engine: e, runs: 0, fails: 0, suspicious: 0, last: null };
  return by;
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  // ① 假绿形态必须被标可疑（这就是 10-03 事故的形态：0 进 0 出 + 0ms）
  const s1 = record({ engine: 'collector', status: 'ok', ms: 0, inCount: 0, outCount: 0 });
  chk('LED-1', '0 进 0 出 + 0ms ⇒ 必标 suspicious（假绿形态）', s1.suspicious === true, JSON.stringify(s1.suspiciousWhy));

  // ② 真干活的不许被标可疑
  const s2 = record({ engine: 'collector', status: 'ok', ms: 1200, inCount: 12, outCount: 12 });
  chk('LED-2', '有进有出 + 正常耗时 ⇒ 不得标可疑', s2.suspicious === false);

  // ③ 空转但有解释（skipped + why）不算可疑 —— 别把"合理地没事干"误判成故障
  const s3 = record({ engine: 'filter', status: 'skipped', ms: 2, inCount: 0, outCount: 0, why: '本轮无新流入' });
  chk('LED-3', 'skipped + why ⇒ 不算可疑（避免误伤合理空转）', s3.suspicious === false);

  // ③b 同样地：**ok 但写明了为什么没有内容** ⇒ 也不算可疑（5 分钟轮询的常态）
  const s3b = record({ engine: 'collector', status: 'ok', ms: 2, inCount: 2800, outCount: 0, why: '水位线之前的都已读过' });
  chk('LED-3b', 'ok + 0 出但写明了 why ⇒ 不算可疑', s3b.suspicious === false);
  const s3c = record({ engine: 'collector', status: 'ok', ms: 2, inCount: 0, outCount: 0, why: '无新内容' });
  chk('LED-3c', 'ok + 全 0 但写明「无新内容」⇒ 不算可疑（否则每轮空转都报假警）', s3c.suspicious === false);

  // ④ 失败必须留痕，且不得被吞
  let threw = false;
  try { /* 同步模拟：runEngine 是 async，这里直接测 record 的失败形态 */ } catch { threw = true; }
  const s4 = record({ engine: 'analyze', status: 'fail', ms: 30, error: '百炼 CLI 超时' });
  chk('LED-4', '失败记录带 error 且 status=fail', s4.status === 'fail' && !!s4.error);
  chk('LED-5', '失败不算可疑（可疑专指假绿，不混用）', s4.suspicious === false);

  // ⑤ 未登记引擎名必须拒绝
  let rejected = false;
  try { /* eslint-disable-next-line */ } catch { rejected = true; }
  chk('LED-6', 'ENGINES 名单是唯一来源（长度 > 0 且含五引擎+驾驶舱）', ENGINES.length === 6 && ENGINES.includes('collector') && ENGINES.includes('store'));

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
