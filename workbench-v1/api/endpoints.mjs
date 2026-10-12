/**
 * `_meta/workbench/v1/api/endpoints.mjs` —— **直接对接口的检查**（2026-10-12 新建）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么要有这一套
 * ══════════════════════════════════════════════════════════════════════════════
 * 旧 13 卡面板退役后，真机那组里有 58 条检查失去了检查对象（它们验的是旧面板内部的卡片）。
 * 但那批里**相当一部分验的是"数据出口"**，而不是那块渲染面：
 *
 *   `/crosscheck`  验收卡的跨源校验（溯源严格/宽松 · 多源支撑率 · 承诺↔交付 · 矛盾条数）
 *   `/disposition` 决策卡（桶 / 通道 / 期限 / 逾期天数 / 负责人 / 出处 / 可用动作）
 *   `/feedback`    判断质量台账（裁决计数 · 阈值 · 待裁定 · 校准）
 *   `/snapshot`    听记与待办的分源数字
 *   `/state`       指标口径与健康度
 *
 * **2026-10-12 实测：这五个接口全部 HTTP 200、全部在产数据。**
 * ⇒ 所以"跳过"只表示**经由面板 DOM 的验法**失去了对象，
 *   **不等于**"它验的那件事没人管了"。这一套就是把那件事重新管起来：
 *   **不经过面板，直接查接口**。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 设计上的一条硬规矩：判定与取数分开
 * ══════════════════════════════════════════════════════════════════════════════
 * · `judge*` 全是**纯函数**：给一份数据，返回判定 + 说明。**不联网、不读文件**。
 *   ⇒ 这样它们能被 `selfTest()` 用**我造的样例**离线验证（包括负向对照：喂坏数据必须判不过）。
 * · `fetchLive()` 只管取数；取不到就**如实回报"取不到"**，由调用方决定是跳过还是判不过。
 *
 * 为什么必须这样分：这个项目反复踩过同一个坑 ——
 * 检查里混着"取数"和"判定"，于是**取数失败被当成判定失败**，或者反过来被静默吞掉。
 * 分开之后，"面板没开"和"数据不对"是两句不同的话，谁也不会冒充谁。
 */

// ══════════════════════════════════════════════════════════════════════════════
// ① 纯判定函数（可离线测）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 通用：这个字段**真的有用**。
 * ★ `undefined` 不算有 —— 这是测出来才补上的（EP-20 一开始没过）：
 *   `{...good, promiseVsDelivery: undefined}` 里那个**键还在**，只是值是 `undefined`；
 *   只判 `k in o` 就会把它当成"字段齐了"，于是负向对照形同虚设。
 *   ⇒ 键在、值是 undefined，跟"没有这个字段"对使用者是一回事，必须同等对待。
 */
const has = (o, k, t) => o !== null && typeof o === 'object' && k in o && o[k] !== undefined
  && (t === undefined || (t === 'array' ? Array.isArray(o[k]) : typeof o[k] === t));
const isArr = (v) => Array.isArray(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * `/crosscheck` —— 验收卡的跨源校验。
 * ★ 这份结构是**实测出来的，不是猜的**（2026-10-12）：
 *   `multiSource` 是**对象**（`objects / both / matterOnly / triggerOnly / supportRate / singleSourceOverdue`），
 *   不是数组 —— 我第一版按数组判，真机一跑就不过，**那是我的假设错，不是接口坏**。
 * 判的是"产物在场且形状对"，**不是**"数值好不好看"（后者是业务判断，不由检查替用户下结论）。
 */
export function judgeCrosscheck(d) {
  const why = [];
  if (d === null || typeof d !== 'object') return { ok: false, why: ['整份数据取不到或不是对象'] };
  for (const k of ['version', 'generatedAt']) if (!has(d, k)) why.push(`缺 ${k}`);
  for (const k of ['contradictions', 'duplicates']) if (!isArr(d[k])) why.push(`${k} 不是数组（应为矛盾/重复条目列表）`);
  if (!has(d, 'multiSource')) why.push('缺 multiSource（多源支撑率没处落）');
  else if (!num(d.multiSource.supportRate)) why.push('multiSource.supportRate 不是数字（多源支撑率读不出来）');
  if (!has(d, 'promiseVsDelivery')) why.push('缺 promiseVsDelivery（承诺↔交付没处落）');
  if (!has(d, 'attribution')) why.push('缺 attribution（溯源没处落）');
  const ok = why.length === 0;
  return {
    ok, why,
    note: ok
      ? `多源支撑率 ${d.multiSource.supportRate}（双源 ${d.multiSource.both} · 仅事务 ${d.multiSource.matterOnly} · 仅触发 ${d.multiSource.triggerOnly}）`
        + ` · 矛盾 ${d.contradictions.length} 条 · 重复 ${d.duplicates.length} 条`
      : why.join(' · '),
  };
}

/**
 * `/feedback` —— 判断质量台账。
 * ★ 这里有一条**从旧检查继承来的硬规矩**（原 SBT-41 的教训）：
 *   **"读失败"不许冒充"尚无记录"** —— 两者对用户是完全不同的意思，
 *   前者是"东西丢了/没接上"，后者是"确实还没有裁决"。混为一谈就是骗人。
 */
export function judgeFeedback(d) {
  const why = [];
  if (d === null || typeof d !== 'object') return { ok: false, why: ['整份数据取不到或不是对象'] };
  if (!has(d, 'version')) why.push('缺 version');
  if (!has(d, 'updatedAt')) why.push('缺 updatedAt（无法判断这份台账有多旧）');
  if (!isArr(d.entries)) why.push('entries 不是数组（裁决条数没处落）');
  if (!num(d.threshold)) why.push('threshold 不是数字（达阈值与否无从判断）');
  if (!has(d, 'calibrated')) why.push('缺 calibrated（校准状态没处落）');
  if (d.entries !== undefined && !isArr(d.entries)) why.push('entries 类型不对');
  const ok = why.length === 0;
  const n = isArr(d.entries) ? d.entries.length : null;
  return {
    ok, why,
    note: ok ? `裁决 ${n} 条 · 阈值 ${d.threshold} · 校准=${JSON.stringify(d.calibrated)}` : why.join(' · '),
  };
}

/**
 * `/state` —— 流入与处置的口径 + 待办核心（驾驶舱顶部那排数的一部分就是它的）。
 * ★ 实测订正（2026-10-12）：`counts` 是**流入口径**的计数
 *   （`inflow / disposed / pending / outOfScope / inScope`），
 *   **不是**消息/日程/待办/笔记四类数 —— 那四类在 `/snapshot`（见 `judgeSnapshot`）。
 *   我第一版按"四类数"判，真机一跑就不过：**又是我的假设错**。
 */
export function judgeState(d) {
  const why = [];
  if (d === null || typeof d !== 'object') return { ok: false, why: ['整份数据取不到或不是对象'] };
  if (d.ok !== true) why.push(`ok 不是 true（${JSON.stringify(d.ok)}）`);
  if (!has(d, 'counts')) why.push('缺 counts（流入与处置的计数没处落）');
  else for (const k of ['inflow', 'disposed', 'pending', 'inScope']) {
    if (!num(d.counts[k])) why.push(`counts.${k} 不是数字`);
  }
  if (!has(d, 'dataAsOf')) why.push('缺 dataAsOf（不知道这份数是什么时候的）');
  if (!has(d, 'core')) why.push('缺 core（待办核心：逾期/今日到期/无期限没处落）');
  const ok = why.length === 0;
  return {
    ok, why,
    note: ok
      ? `数据截至 ${d.dataAsOf} · 流入 ${d.counts.inflow} / 已处置 ${d.counts.disposed} / 待处置 ${d.counts.pending} / 在界内 ${d.counts.inScope}`
        + ` · 待办核心可用=${d.core.available}`
      : why.join(' · '),
  };
}

/** `/disposition` —— 决策卡的来路（条目数很大，只判在场与形状，不搬内容） */
export function judgeDisposition(d) {
  const why = [];
  if (d === null || typeof d !== 'object') return { ok: false, why: ['整份数据取不到或不是对象'] };
  if (!has(d, 'version')) why.push('缺 version');
  if (!has(d, 'generatedAt')) why.push('缺 generatedAt');
  const listKeys = ['items', 'entries', 'objects', 'rows'].filter((k) => isArr(d[k]));
  if (listKeys.length === 0) why.push('没有可用的条目列表（items/entries/objects/rows 都不是数组）');
  const ok = why.length === 0;
  const n = listKeys.map((k) => d[k].length).reduce((a, b) => a + b, 0);
  return { ok, why, note: ok ? `条目容器 ${listKeys.join('/')} · 共 ${n} 条 · 字段 ${Object.keys(d).length} 个` : why.join(' · ') };
}

/**
 * `/snapshot` —— **四类业务数的真正来路**（需求 4.3.6 驾驶舱顶部那排数）。
 * ★ 实测订正（2026-10-12）：`todos` / `minutes` / `calendar` / `knowledge` 都是**对象**，
 *   数组与计数在它们**里面**（`todos.items` / `todos.counts` / `calendar.counts` / `knowledge.counts`）。
 *   我第一版按数组判，真机一跑就不过 —— **是我的假设错，不是数据坏**。
 */
export function judgeSnapshot(d) {
  const why = [];
  if (d === null || typeof d !== 'object') return { ok: false, why: ['整份数据取不到或不是对象'] };
  if (d.ok !== true) why.push(`ok 不是 true（${JSON.stringify(d.ok)}）`);
  if (!has(d, 'at')) why.push('缺 at（不知道这份快照是什么时候的）');
  if (!has(d, 'knowledgePath')) why.push('缺 knowledgePath（不知道读的是哪个知识库）');

  // 四类里后两类：待办与听记（各自要有 items 数组与 counts）
  for (const k of ['todos', 'minutes']) {
    if (!has(d, k)) { why.push(`缺 ${k}`); continue; }
    if (!isArr(d[k].items)) why.push(`${k}.items 不是数组（条目没处落）`);
    if (!has(d[k], 'counts')) why.push(`${k}.counts 缺失（分源数字没处落）`);
  }
  // 前两类：日程（calendar）与知识库（knowledge）—— 它们在不在，决定"四类业务数"齐不齐
  for (const k of ['calendar', 'knowledge']) {
    if (!has(d, k)) why.push(`缺 ${k}（四类业务数会缺一格）`);
  }
  const ok = why.length === 0;
  return {
    ok, why,
    note: ok
      ? `待办 ${isArr(d.todos.items) ? d.todos.items.length : '?'} 条 · 听记 ${isArr(d.minutes.items) ? d.minutes.items.length : '?'} 条`
        + ` · 日程 ${JSON.stringify(d.calendar.counts ?? {}).slice(0, 60)} · 知识库 ${JSON.stringify(d.knowledge.counts ?? {}).slice(0, 60)}`
      : why.join(' · '),
  };
}

/** 四个判定的对照表（取数名 → 判定函数 → 人话说明） */
export const ENDPOINT_CHECKS = Object.freeze([
  { id: 'EP-1', name: '验收卡的跨源校验（`/crosscheck`）', path: '/workdesktop/api/crosscheck', judge: judgeCrosscheck },
  { id: 'EP-2', name: '判断质量台账（`/feedback`）', path: '/workdesktop/api/feedback', judge: judgeFeedback },
  { id: 'EP-3', name: '指标口径与四类业务数（`/state`）', path: '/workdesktop/api/state', judge: judgeState },
  { id: 'EP-4', name: '决策卡的来路（`/disposition`）', path: '/workdesktop/api/disposition', judge: judgeDisposition },
  { id: 'EP-5', name: '听记与待办的分源数字（`/snapshot`）', path: '/workdesktop/api/snapshot', judge: judgeSnapshot },
]);

// ══════════════════════════════════════════════════════════════════════════════
// ② 取数（只管取；取不到如实回报，不冒充判定结果）
// ══════════════════════════════════════════════════════════════════════════════

export const BASE = 'http://127.0.0.1:3080';

/**
 * 打一个接口。
 * ★ 三种结果要分清（这正是本项目反复强调的那条）：
 *   · `{ ok: true, data }`       —— 取到了
 *   · `{ ok: false, unreachable: true, error }` —— **面板没开/网络不通**（环境前置，不是产品缺陷）
 *   · `{ ok: false, unreachable: false, error }` —— 通了但不是 200，或返回的不是 JSON（**这是真的有问题**）
 */
export async function fetchOne(path, { base = BASE, timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
  const url = base + path;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) return { ok: false, unreachable: false, error: `HTTP ${r.status}`, text };
    try { return { ok: true, data: JSON.parse(text), bytes: text.length }; }
    catch (e) { return { ok: false, unreachable: false, error: '返回的不是 JSON：' + e.message, text: text.slice(0, 200) }; }
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (e && e.message ? e.message : String(e));
    // 连不上/被拒/超时 ⇒ 环境前置：面板没开
    return { ok: false, unreachable: true, error: msg };
  } finally { clearTimeout(timer); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ③ 跑一遍（真机）：需要一个在跑的面板
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 对五个接口各跑一次判定。
 * @returns {{ pass:number, fail:number, skip:number, details:Array }}
 */
export async function verifyEndpoints({ base = BASE, timeoutMs = 20000, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const details = [];
  let pass = 0, fail = 0, skip = 0;
  for (const c of ENDPOINT_CHECKS) {
    const r = await fetchOne(c.path, { base, timeoutMs, fetchImpl });
    let verdict;
    if (r.unreachable) {
      // ★ 面板没开 ⇒ **跳过**（带原因），不判不过。
      //   理由：这一套量的是"接口产出的数据对不对"，面板没开时我们根本没测到那件事；
      //   把它记成"不过"就是拿环境前置冒充产品缺陷 —— 本项目明令禁止。
      verdict = { ok: false, skip: true, note: `跳过：接口取不到（${r.error}）—— 面板可能没开，这不代表数据有问题` };
    } else if (!r.ok) {
      verdict = { ok: false, skip: false, note: `接口通了但不是可用的响应：${r.error}` };
    } else {
      const j = c.judge(r.data);
      verdict = { ok: j.ok, skip: false, note: (j.note || '') + ` · ${r.bytes} 字节` };
    }
    if (verdict.skip) skip += 1; else if (verdict.ok) pass += 1; else fail += 1;
    details.push({ id: c.id, name: c.name, ok: !!verdict.ok, skip: !!verdict.skip, note: verdict.note });
    log(`  [${verdict.skip ? 'SKIP' : verdict.ok ? 'PASS' : 'FAIL'}] ${c.id.padEnd(6)} ${c.name}`);
    log(`         ${verdict.note}`);
  }
  log('');
  log(`  PASS = ${pass}   FAIL = ${fail}   SKIP = ${skip}`);
  return { pass, fail, skip, details };
}

// ══════════════════════════════════════════════════════════════════════════════
// ④ 自检（纯离线：不联网，用我造的样例；含负向对照）
// ══════════════════════════════════════════════════════════════════════════════

export async function selfTest() {
  const details = [];
  const chk = (id, desc, ok, note = '') => details.push({ id, desc, ok: !!ok, note });

  // ── EP-10…：判定函数对**好样例**必须放行 ────────────────────────────────
  // ★ 样例一律按**真实结构**写（2026-10-12 实测那份）。
  //   为什么强调这点：我第一版的自检样例是**我凭空想的形状**，于是离线全过、真机全不过 ——
  //   那种"自己考自己"的样例没有价值，**样例必须是照着真实数据抄下来的**。
  const goodCross = {
    version: '1', generatedAt: '2026-10-12T00:00:00Z',
    contradictions: [{ a: 1 }], duplicates: [],
    multiSource: { objects: 18, both: 5, matterOnly: 9, triggerOnly: 4, supportRate: 0.278 },
    promiseVsDelivery: { n: 1 }, attribution: { strict: 3, loose: 4 },
  };
  chk('EP-10', '验收卡判定：形状齐全的好数据必须放行', judgeCrosscheck(goodCross).ok === true, judgeCrosscheck(goodCross).note);

  const goodFeed = { version: '1', updatedAt: '2026-10-12T00:00:00Z', entries: [{}, {}], threshold: 3, calibrated: false };
  chk('EP-11', '台账判定：形状齐全的好数据必须放行', judgeFeedback(goodFeed).ok === true, judgeFeedback(goodFeed).note);

  const goodState = {
    ok: true, dataAsOf: '2026-10-12',
    counts: { inflow: 96, disposed: 92, pending: 4, outOfScope: 0, inScope: 92 },
    core: { available: true },
  };
  chk('EP-12', '状态判定：流入与处置计数齐全的好数据必须放行', judgeState(goodState).ok === true, judgeState(goodState).note);

  const goodDisp = { version: '1', generatedAt: 'x', entries: [1, 2, 3] };
  chk('EP-13', '决策卡判定：有条目容器且元信息齐全必须放行', judgeDisposition(goodDisp).ok === true, judgeDisposition(goodDisp).note);

  const goodSnap = {
    ok: true, at: '2026-10-12T00:00:00Z', knowledgePath: 'C:/x',
    todos: { items: [1], counts: { dingtalk: 1 } },
    minutes: { items: [], counts: {} },
    calendar: { counts: { today: 1 } },
    knowledge: { counts: { total: 2 } },
  };
  chk('EP-14', '快照判定：四类业务数（日程/待办/听记/知识库）齐全必须放行', judgeSnapshot(goodSnap).ok === true, judgeSnapshot(goodSnap).note);

  // ── EP-20…：★ **负向对照**（缺一个字段就必须判不过；否则判定是恒真的）────
  chk('EP-20', '★ 负向对照：验收卡少了「承诺↔交付」必须判不过',
    judgeCrosscheck({ ...goodCross, promiseVsDelivery: undefined }).ok === false);
  chk('EP-21', '★ 负向对照：台账少了阈值必须判不过（否则"达阈值与否"无从判断）',
    judgeFeedback({ ...goodFeed, threshold: undefined }).ok === false);
  chk('EP-22', '★ 负向对照：状态里 ok 不是 true 必须判不过（接口自己说没成）',
    judgeState({ ...goodState, ok: false }).ok === false);
  chk('EP-23', '★ 负向对照：状态里 counts 少了「待处置」必须判不过（流入处置的口径会缺一格）',
    judgeState({ ok: true, dataAsOf: 'x', core: {}, counts: { inflow: 1, disposed: 1, inScope: 1 } }).ok === false);
  chk('EP-24', '★ 负向对照：决策卡没有任何条目容器必须判不过',
    judgeDisposition({ version: '1', generatedAt: 'x' }).ok === false);
  chk('EP-25', '★ 负向对照：快照里 todos.items 不是数组必须判不过',
    judgeSnapshot({ ...goodSnap, todos: { items: 'oops', counts: {} } }).ok === false);
  chk('EP-25b', '★ 负向对照：快照缺了「日程」那一格（四类业务数会缺一格）必须判不过',
    judgeSnapshot({ ...goodSnap, calendar: undefined }).ok === false);
  chk('EP-25c', '★ 负向对照：多源支撑率不是数字必须判不过（那是这一项的核心数）',
    judgeCrosscheck({ ...goodCross, multiSource: { both: 1 } }).ok === false);
  chk('EP-26', '★ 负向对照：喂 null / 非对象，五个判定都要判不过（不许崩、不许放行）',
    [judgeCrosscheck, judgeFeedback, judgeState, judgeDisposition, judgeSnapshot]
      .every((f) => { try { return f(null).ok === false && f('x').ok === false; } catch { return false; } }));

  // ── EP-30…：★ **取数失败不许冒充判定失败**（这是这一套存在的意义所在）────
  const boom = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }); };
  const r1 = await fetchOne('/workdesktop/api/state', { fetchImpl: boom });
  chk('EP-30', '★ 连不上 ⇒ 如实报「取不到」，且标为环境前置（不是数据有问题）',
    r1.ok === false && r1.unreachable === true, r1.error);

  const http500 = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const r2 = await fetchOne('/x', { fetchImpl: http500 });
  chk('EP-31', '★ 通了但 500 ⇒ **不算环境前置**（这是真有问题，不许被当成"面板没开"吞掉）',
    r2.ok === false && r2.unreachable === false, r2.error);

  const notJson = async () => ({ ok: true, status: 200, text: async () => '<html>login</html>' });
  const r3 = await fetchOne('/x', { fetchImpl: notJson });
  chk('EP-32', '★ 返回的不是 JSON ⇒ 判「不可用」并保留开头一段（便于看它到底回了什么）',
    r3.ok === false && r3.unreachable === false && /html/.test(r3.text || ''), r3.error);

  const slow = async (_u, o) => new Promise((_res, rej) => {
    o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const r4 = await fetchOne('/x', { fetchImpl: slow, timeoutMs: 60 });
  chk('EP-33', '★ 超时 ⇒ 报「超时」并归入环境前置（面板没开与面板卡住，对使用者是同一件事：现在量不到）',
    r4.ok === false && r4.unreachable === true && /超时/.test(r4.error), r4.error);

  // ── EP-40…：编排层（用假取数，离线跑）──────────────────────────────────
  const quiet = () => {};
  const all200 = async (u) => ({ ok: true, status: 200, text: async () => JSON.stringify(
    u.includes('crosscheck') ? goodCross
      : u.includes('feedback') ? goodFeed
        : u.includes('state') ? goodState
          : u.includes('disposition') ? goodDisp : goodSnap) });
  const runAll = await verifyEndpoints({ fetchImpl: all200, log: quiet });
  chk('EP-40', '五个接口全好 ⇒ 5 通过 / 0 没过 / 0 跳过', runAll.pass === 5 && runAll.fail === 0 && runAll.skip === 0,
    JSON.stringify({ pass: runAll.pass, fail: runAll.fail, skip: runAll.skip }));

  const runDown = await verifyEndpoints({ fetchImpl: boom, log: quiet });
  chk('EP-41', '★ 面板没开 ⇒ **5 跳过、0 没过**（绝不把环境前置记成产品缺陷）',
    runDown.skip === 5 && runDown.fail === 0, JSON.stringify({ pass: runDown.pass, fail: runDown.fail, skip: runDown.skip }));

  const oneBad = async (u) => (u.includes('feedback')
    ? { ok: true, status: 200, text: async () => JSON.stringify({ version: '1' }) }   // 缺一堆字段
    : all200(u));
  const runMixed = await verifyEndpoints({ fetchImpl: oneBad, log: quiet });
  chk('EP-42', '★ 一个接口数据不齐 ⇒ 那一个判不过、其余照常通过（一个坏不会带崩全部）',
    runMixed.fail === 1 && runMixed.pass === 4, JSON.stringify({ pass: runMixed.pass, fail: runMixed.fail }));

  const pass = details.filter((d) => d.ok).length;
  const fail = details.length - pass;
  return { pass, fail, details, total: details.length };
}

// ══════════════════════════════════════════════════════════════════════════════
// 直接跑（`node _meta/workbench/v1/api/endpoints.mjs`）＝ 真机那一遍
// ══════════════════════════════════════════════════════════════════════════════

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  console.log('############ 直接对接口的检查（不经过面板）############');
  console.log('');
  const r = await verifyEndpoints({});
  process.exit(r.fail === 0 ? 0 : 1);
}
