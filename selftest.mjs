#!/usr/bin/env node
/**
 * selftest — zero-dependency, offline, self-proving suite for dsh-workdesktop.
 *
 * Goal: **"clone it and it can prove itself."** No DSH runtime, no local knowledge base,
 * no network, no personal data — everything it needs ships in `selftest/fixtures/`.
 *
 * What it covers (and why these four groups):
 *   1. The host half actually mounts and answers. We feed it a stub `ctx` and call the
 *      read-only routes with fake `req`/`res`, then assert status + the fields the panel
 *      consumes. This is the only way to test a Cordis plugin host half without a runtime.
 *      Covers the workbench passthroughs (`/objects` `/disposition` `/crosscheck`
 *      `/domain-health` `/brief` `/insights`) plus three "must not be silent" surfaces:
 *      the feedback ledger's explicit 503, the retired `/focus` GET tombstone (410), and
 *      the disposition write exit's **source-level validation** (invalid input is rejected
 *      before any vault CLI is spawned — which is why it is assertable inside a clone).
 *      The same round-trip is proven for the card-order overlay (`/ui-prefs`
 *      GET/POST/DELETE): unknown keys are ignored *and reported*, an empty write is
 *      rejected rather than half-applied, and DELETE really removes the file.
 *   2. Missing configuration must fail loudly. The plugin resolves the knowledge base from
 *      `DSH_WORKBENCH_KNOWLEDGE`; a silent fallback to somebody's desktop would be worse than
 *      a crash, so we assert the import throws and that the message names the variable.
 *   3. Source contracts. The panel's card order is a product promise; it must be readable and
 *      assertable, not an accident of execution order. Both halves must also parse.
 *   4. Desensitization guard. This repo is public, so the repository scans **itself** for
 *      personal paths, e-mail addresses, phone numbers and credential shapes — with a
 *      negative control, because a scanner that cannot fail proves nothing.
 *
 * What it does NOT prove (stated plainly, so nobody over-reads a green run):
 *   · it does not exercise the real DSH runtime, the browser half's rendering, or slot UI;
 *   · it does not cover behaviour that depends on a real vault (calendar, todos, DSH tools);
 *   · it does not use or need any real business data — by construction.
 *
 * Usage: node selftest.mjs        (exit 0 = all green)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'selftest', 'fixtures');
const ROUTE = '/workbench/api';

let pass = 0;
let fail = 0;
function chk(id, desc, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  PASS  ${id}  ${desc}`); }
  else { fail += 1; console.log(`  FAIL  ${id}  ${desc}${detail ? '  —— ' + detail : ''}`); }
}
const read = (p) => fs.readFileSync(p, 'utf8');

// ── 1. host half: mount with a stub ctx, call the read-only routes ────────────────
console.log('\n[1] host half mounts and answers (stub ctx, fixture vault)');

/** Import a *fresh* module instance (ESM caches by URL) with the env var pointed at fixtures. */
async function mountPlugin(knowledgeDir) {
  process.env.DSH_WORKBENCH_KNOWLEDGE = knowledgeDir;
  const base = pathToFileURL(path.join(HERE, 'lib', 'index.js')).href;
  const mod = await import(`${base}?selftest=${Date.now()}${Math.random()}`);
  const noop = () => () => {};
  let spec = null;
  const ctx = new Proxy({
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    webServer: { register: (s) => { spec = s; return () => {} } },
    logger: { info: noop, warn: noop, error: noop },
    get: () => undefined,
  }, { get: (t, k) => (k in t ? t[k] : noop) });
  mod.apply(ctx);
  return { spec, mod };
}

/**
 * Minimal `req`/`res` doubles.
 * `sendJson` only uses writeHead + end; the host's `readBody` subscribes to
 * `req.on('data'|'end')`, so the request double is a tiny event emitter that can
 * also replay a JSON body (needed for the POST routes' source-level validation).
 */
function makeReq(url, method, body) {
  const handlers = {};
  return {
    url,
    method,
    on(name, cb) { (handlers[name] = handlers[name] || []).push(cb); return this; },
    destroy() {},
    /** Replay the body after the handler has subscribed. */
    replay() {
      if (body !== null && body !== undefined) {
        const chunk = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
        for (const cb of handlers.data || []) cb(chunk);
      }
      for (const cb of handlers.end || []) cb();
    },
  };
}

function call(spec, url, method = 'GET', body = null) {
  const out = { code: null, headers: null, body: null };
  const res = {
    writeHead(code, headers) { out.code = code; out.headers = headers || {}; },
    end(chunk) { out.body = chunk === undefined ? '' : String(chunk); },
    setHeader() {},
  };
  const req = makeReq(url, method, body);
  // `spec.handler` runs synchronously up to its first await, so readBody's
  // subscriptions exist by the time we replay the body.
  const promise = Promise.resolve(spec.handler(req, res)).then(() => out);
  req.replay();
  return { promise, out };
}

const { spec, mod } = await mountPlugin(FIXTURES);
chk('L1-1', 'ctx.webServer.register 被以 prefix 方式调用，路径为 /workbench/api',
  spec !== null && spec.kind === 'prefix' && spec.path === ROUTE,
  spec === null ? '未捕获到 register 调用' : `kind=${spec.kind} path=${spec.path}`);

const cases = [
  ['/objects', (d) => {
    const o = d.objects.find((x) => x.kind === 'session');
    return Array.isArray(d.objects) && d.objects.length === 3 && o !== undefined
      && typeof o.key === 'string' && typeof o.state === 'string'
      && o.next_step !== null && typeof o.next_step.id === 'string'
      && d.byRecord['MT-20250101-001'].key === o.key
      && d.rollup['客户:组织甲'].children.length === 1
      && d.coverage.unassigned === 1 && d.unassigned.length === 1;
  }, 'objects[] + byRecord + rollup + coverage/unassigned'],
  ['/disposition', (d) => d.summary.landed === 3 && d.summary.noLanding === 1
    && Math.abs(d.summary.landingRate - 0.75) < 1e-9
    && d.calibrated === false && d.noLanding.length === 1
    && d.joinHazard.idCollisionCount === 1, 'summary{landed,noLanding,landingRate} + calibrated(false) + noLanding[] + joinHazard'],
  ['/crosscheck', (d) => d.trace.strictRate === 0.75 && d.trace.bySide.trigger.sourceRefRate === 0
    && d.multiSource.both === 1 && d.promiseVsDelivery.executed === 1
    && d.contradictions.length === 1 && d.planVsActual.late === 1, 'trace + multiSource + promiseVsDelivery + contradictions'],
  ['/domain-health', (d) => d.summary.domains === 3 && d.domains.length === 3
    && d.domains[0].id === 'example-client', 'summary + domains[]'],
];
for (const [route, verify, what] of cases) {
  try {
    const { promise } = call(spec, ROUTE + route);
    const out = await promise;
    const doc = out.body ? JSON.parse(out.body) : null;
    chk(`L1-2${route}`, `${route} → 200 + ${what}`,
      out.code === 200 && doc !== null && verify(doc),
      `code=${out.code} body=${String(out.body).slice(0, 120)}`);
  } catch (e) {
    chk(`L1-2${route}`, `${route} → 200`, false, e.message);
  }
}

// ── 1b. T31 routes: today's decision surface + cross-source insights ─────────────
// Both are read-only passthroughs of vault products. The fixtures carry only neutral
// example data, so these asserts describe the *contract*, not any real business fact.
{
  const out = await call(spec, ROUTE + '/brief').promise;
  const d = out.body ? JSON.parse(out.body) : null;
  chk('L1-3/brief', '/brief → 200 + 今日必办/待定/昨夜动向三块 + 校准标记与口径一致性',
    out.code === 200 && d !== null && d.calibrated === false
    && d.todayMustDo.total === 2 && d.todayMustDo.by_kind.trigger === 1 && d.todayMustDo.by_kind.matter === 1
    && d.waiting.total === 1 && d.waiting.by_group.onMeReply === 1
    && Array.isArray(d.overnight.items) && d.overnight.items.length === 1 && d.overnight.items[0].plane === 'inbound'
    && d.consistency.agree === true && Array.isArray(d.rules) && d.rules.length === 3,
    `code=${out.code} body=${String(out.body).slice(0, 140)}`);
}
{
  const out = await call(spec, ROUTE + '/insights').promise;
  const d = out.body ? JSON.parse(out.body) : null;
  const one = d !== null && Array.isArray(d.insights) ? d.insights[0] : null;
  chk('L1-4/insights', '/insights → 200 + 证据链/支撑强度/可反驳入口齐全（无证据不入面板）',
    out.code === 200 && one !== null
    && Array.isArray(one.evidence) && one.evidence.length === 4 && one.evidence_lines === 4
    && ['multi', 'single'].includes(one.support)
    && typeof one.confidence === 'number'
    && typeof (one.rebuttal || {}).entry === 'string' && typeof (one.rebuttal || {}).ledger === 'string'
    && d.summary.dropped === 1 && Array.isArray(d.dropped) && d.dropped.length === 1,
    `code=${out.code} body=${String(out.body).slice(0, 140)}`);
}
{
  // A fresh clone has no vault pipeline, so "ledger not generated" is the normal state.
  // It must be an explicit 503 with a message — never a silent 200 with empty data.
  const out = await call(spec, ROUTE + '/feedback').promise;
  const d = out.body ? JSON.parse(out.body) : null;
  chk('L1-5/feedback', '/feedback（台账未生成）→ 503 + 明确文案，不当成空数据',
    out.code === 503 && d !== null && /尚未生成/.test(String(d.error || '')),
    `code=${out.code} body=${String(out.body).slice(0, 140)}`);
}
{
  // GET /focus was retired: focus state has exactly one source of truth (/state.focus).
  // The tombstone must say so, rather than degrading into a silent 404.
  const out = await call(spec, ROUTE + '/focus').promise;
  const d = out.body ? JSON.parse(out.body) : null;
  chk('L1-6/focus-get', '/focus GET → 410 墓碑并指向 /state.focus（单一真相源）',
    out.code === 410 && d !== null && /state\.focus/.test(String(d.error || '')),
    `code=${out.code} body=${String(out.body).slice(0, 140)}`);
}
{
  // The disposition write exit must reject invalid input **before** shelling out to the
  // vault CLI — which is exactly why these three can be asserted inside a clone.
  const acts = [
    [{ action: 'reject', reason: '示例理由' }, '缺 id'],
    [{ id: 'IN-20250101-001', action: 'nope', reason: '示例理由' }, 'action 只能是'],
    [{ id: 'IN-20250101-001', action: 'reject', reason: '   ' }, '必须填写理由'],
  ];
  for (let i = 0; i < acts.length; i += 1) {
    const [payload, expect] = acts[i];
    const out = await call(spec, ROUTE + '/disposition/act', 'POST', payload).promise;
    const d = out.body ? JSON.parse(out.body) : null;
    chk(`L1-7/act-${i + 1}`, `/disposition/act 源头拦截：${expect}`,
      out.code === 200 && d !== null && d.ok === false && String(d.error || '').includes(expect),
      `code=${out.code} body=${String(out.body).slice(0, 140)}`);
  }
}

// ── 1c. /ui-prefs: the card-order overlay (read-back + rejection + reset) ────────
// The panel's drag-to-reorder writes an overlay **file in the vault**, not localStorage —
// which is exactly why a clone can prove the contract: unknown card keys / unknown fields
// are ignored *and reported* (never silently written into the file), the overlay is
// readable back after a restart-shaped reload, an empty write is rejected outright, and
// DELETE really removes the file so the compiled-in default order takes over again.
{
  const OVERLAY = path.join(FIXTURES, '_meta', 'out', 'ui-prefs.json');
  const getPrefs = async () => {
    const o = await call(spec, ROUTE + '/ui-prefs').promise;
    return { code: o.code, raw: String(o.body), d: o.body ? JSON.parse(o.body) : null };
  };
  const order = (x) => JSON.stringify(x === null || x === undefined ? null : x);

  const g0 = await getPrefs();
  chk('L1-8/uiprefs-get', '/ui-prefs GET → 200 + 15 个已知卡片键 + 无覆盖层时 exists=false（不当成空数据）',
    g0.code === 200 && g0.d !== null && Array.isArray(g0.d.known) && g0.d.known.length === 15
    && g0.d.exists === false && g0.d.prefs === null
    && Array.isArray(g0.d.fields)
    && ['cardOrder', 'briefSeenAt', 'briefRead'].every((f) => g0.d.fields.includes(f)),
    `code=${g0.code} body=${g0.raw.slice(0, 160)}`);

  const p1 = await call(spec, ROUTE + '/ui-prefs', 'POST',
    { cardOrder: ['metrics', 'brief', 'no-such-card', 'metrics'], rogue: 1 }).promise;
  const d1 = p1.body ? JSON.parse(p1.body) : null;
  chk('L1-9/uiprefs-post', '/ui-prefs POST → 未知卡片键与未知字段被忽略并回报，重复只取首次',
    p1.code === 200 && d1 !== null && d1.ok === true
    && Array.isArray(d1.ignored) && d1.ignored.length === 1 && d1.ignored[0] === 'no-such-card'
    && Array.isArray(d1.duplicated) && d1.duplicated.length === 1 && d1.duplicated[0] === 'metrics'
    && Array.isArray(d1.ignoredKeys) && d1.ignoredKeys.length === 1 && d1.ignoredKeys[0] === 'rogue'
    && order(d1.prefs?.cardOrder) === order(['metrics', 'brief']),
    `code=${p1.code} body=${String(p1.body).slice(0, 160)}`);

  const g1 = await getPrefs();
  chk('L1-10/uiprefs-persist', '/ui-prefs 覆盖层落盘后可读回（exists=true · 顺序一致 · 带 updatedAt）',
    g1.code === 200 && g1.d !== null && g1.d.exists === true
    && order(g1.d.prefs?.cardOrder) === order(['metrics', 'brief'])
    && typeof g1.d.prefs?.updatedAt === 'string' && String(g1.d.prefs.updatedAt).length > 0,
    `code=${g1.code} body=${String(g1.raw).slice(0, 160)}`);

  const p2 = await call(spec, ROUTE + '/ui-prefs', 'POST', { rogue: 1 }).promise;
  const d2 = p2.body ? JSON.parse(p2.body) : null;
  const g2 = await getPrefs();
  chk('L1-11/uiprefs-reject', '/ui-prefs POST 无任何已知字段 → ok=false + 明确文案，且不写坏既有覆盖层',
    p2.code === 200 && d2 !== null && d2.ok === false && /至少给一个字段/.test(String(d2.error || ''))
    && g2.d !== null && g2.d.exists === true && order(g2.d.prefs?.cardOrder) === order(['metrics', 'brief']),
    `code=${p2.code} body=${String(p2.body).slice(0, 160)}`);

  const del = await call(spec, ROUTE + '/ui-prefs', 'DELETE').promise;
  const dd = del.body ? JSON.parse(del.body) : null;
  const g3 = await getPrefs();
  const left = fs.existsSync(OVERLAY);
  if (left) fs.rmSync(OVERLAY, { force: true });   // 断言失败也不给仓库留脏文件
  chk('L1-12/uiprefs-reset', '/ui-prefs DELETE → 覆盖层文件被删除，GET 回到 exists=false（默认顺序不受影响）',
    del.code === 200 && dd !== null && dd.ok === true && dd.prefs === null
    && g3.d !== null && g3.d.exists === false && g3.d.prefs === null && left === false,
    `code=${del.code} 断言时残留=${left} 清后残留=${fs.existsSync(OVERLAY)}`);
}

// ── 2. missing configuration must fail loudly ────────────────────────────────────
console.log('\n[2] missing DSH_WORKBENCH_KNOWLEDGE fails loudly (no silent fallback)');
{
  const env = { ...process.env };
  delete env.DSH_WORKBENCH_KNOWLEDGE;
  const script = "import('./lib/index.js').then(()=>console.log('IMPORT_OK')).catch((e)=>{console.log('IMPORT_ERR:'+e.message);})";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: HERE, env, encoding: 'utf8' });
  const text = String(r.stdout || '') + String(r.stderr || '');
  chk('L2-1', 'import 失败并指出缺哪个环境变量', !/IMPORT_OK/.test(text) && /DSH_WORKBENCH_KNOWLEDGE/.test(text),
    text.slice(0, 160));
  chk('L2-2', '错误信息里没有硬编码的个人路径（不静默回落桌面）',
    !/[A-Za-z]:\\Users\\/i.test(text) && !/\/(Users|home)\//.test(text),
    text.slice(0, 160));
}

// ── 3. source contracts ─────────────────────────────────────────────────────────
console.log('\n[3] source contracts');
for (const f of ['lib/index.js', 'lib/client.js']) {
  const r = spawnSync(process.execPath, ['--check', path.join(HERE, f)], { encoding: 'utf8' });
  chk(`L3-${f}`, `${f} 语法通过`, r.status === 0, String(r.stderr || '').slice(0, 160));
}
{
  const src = read(path.join(HERE, 'lib', 'client.js'));
  const m = src.match(/const CARD_ORDER\s*=\s*\[([\s\S]*?)\]/);
  const keys = m === null ? [] : [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  const EXPECT = ['brief', 'triggers', 'matters', 'schedule', 'todos', 'focus', 'objects',
    'inflow', 'insights', 'recall', 'domains', 'metrics', 'kb', 'minutes', 'system'];
  chk('L3-CARD_ORDER', `CARD_ORDER 存在且 ${EXPECT.length} 张卡顺序可断言`,
    m !== null && keys.length === EXPECT.length && keys.every((k, i) => k === EXPECT[i]),
    m === null ? '未找到 CARD_ORDER' : keys.join(','));
  // The host keeps a second copy of the key list only to filter the overlay. If the two
  // ever drift, the failure mode is **silent card loss** (a dragged card is treated as an
  // unknown key and dropped), so the parity itself has to be asserted — in the same order,
  // item by item, not just "same length".
  const host = mod.__test?.KNOWN_CARD_KEYS;
  chk('L3-KNOWN_CARD_KEYS', 'host 的 KNOWN_CARD_KEYS 与 client 的 CARD_ORDER 逐项一致（防静默丢卡）',
    Array.isArray(host) && host.length === keys.length && host.every((k, i) => k === keys[i]),
    `host=${Array.isArray(host) ? host.join(',') : String(host)}`);
}
{
  const pkg = JSON.parse(read(path.join(HERE, 'package.json')));
  chk('L3-package', 'package.json 元数据正确（name/license/repository/中性作者）',
    pkg.name === 'dsh-workdesktop' && pkg.license === 'MIT'
    && typeof pkg.repository?.url === 'string' && /dsh-workdesktop/.test(pkg.repository.url)
    && !/@/.test(String(pkg.author || '')),
    `${pkg.name} / ${pkg.license} / ${pkg.author}`);
}

// ── 4. desensitization guard (this repo is public) ──────────────────────────────
console.log('\n[4] desensitization guard (scans this repository, with a negative control)');

// Patterns are assembled from fragments so the scanner file does not match itself.
const RULES = [
  { id: 'win-personal-path', why: '个人绝对路径', re: new RegExp('[A-Za-z]:\\\\' + 'Us' + 'ers\\\\') },
  { id: 'posix-personal-path', why: '个人绝对路径', re: /\/(?:Us|ho)[a-z]*\/[^/\s"']+\// },
  { id: 'email', why: '邮箱', re: /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org))[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: 'cn-mobile', why: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { id: 'credential', why: '凭据形态', re: new RegExp('(?:g' + 'hp_|github_' + 'pat_|xo' + 'xb-|s' + 'k-[A-Za-z0-9]{16,})') },
  { id: 'bearer', why: '明文令牌', re: /[Bb]earer\s+[A-Za-z0-9._-]{16,}/ },
  { id: 'token-query', why: 'URL 里的令牌', re: /[?&](?:token|access_token)=[A-Za-z0-9._-]{16,}/i },
];
const SCAN_EXT = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt', '.editorconfig', '']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'fixtures']);
const SKIP_FILES = new Set(['selftest.mjs', 'LICENSE', '.gitignore']);

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, acc); }
    else if (!SKIP_FILES.has(e.name)) acc.push(p);
  }
  return acc;
}
function scanText(text) {
  const hits = [];
  for (const r of RULES) {
    const m = text.match(new RegExp(r.re.source, 'g'));
    if (m !== null && m.length > 0) hits.push({ id: r.id, why: r.why, n: m.length, sample: m[0].slice(0, 40) });
  }
  return hits;
}

// 4a. negative control: the guard MUST fire on synthetic sensitive strings
{
  const control = [
    'const vault = "' + 'C:' + '\\\\' + 'Us' + 'ers\\\\someone\\\\vault"',
    'mail: someone@' + 'real-company' + '.cn',
    'phone: 138' + '00138000',
    'key: ' + 'g' + 'hp_' + 'a'.repeat(36),
    'Authorization: ' + 'Bea' + 'rer ' + 'x'.repeat(24),
    'http://host/api?to' + 'ken=' + 'y'.repeat(24),
  ].join('\n');
  const hits = scanText(control);
  chk('L4-0', '★ 负向对照：人造敏感串必须被抓到（判据非恒真）', hits.length >= 4,
    `命中 ${hits.length}/${RULES.length} 条规则：${hits.map((h) => h.id).join(',')}`);
}

// 4b. the repository itself must be clean
{
  const files = walk(HERE).filter((f) => SCAN_EXT.has(path.extname(f)) && !/package-lock\.json$/.test(f));
  const bad = [];
  for (const f of files) {
    for (const h of scanText(read(f))) bad.push(`${path.relative(HERE, f)} [${h.id}] ×${h.n}`);
  }
  chk('L4-1', `仓库自身零命中（扫了 ${files.length} 个文件）`, bad.length === 0, bad.slice(0, 5).join(' | '));
}

// 4c. fixtures must stay neutral: every `Work/<segment>/` must come from a generic example
{
  const ALLOW = new Set(['示例客户', '组织甲', '组织乙']);
  const fixtureFiles = walk(path.join(HERE, 'selftest', 'fixtures'));
  const seen = new Set();
  const bad = [];
  for (const f of fixtureFiles) {
    for (const m of read(f).matchAll(/Work\/([^/\s"'\\]+)\//g)) {
      seen.add(m[1]);
      if (!ALLOW.has(m[1])) bad.push(`${path.basename(f)}: Work/${m[1]}/`);
    }
  }
  chk('L4-2', `fixture 里的目录名全部是中性示例（${[...seen].join(' · ') || '无'}）`, bad.length === 0, bad.join(', '));
}

// ── summary ────────────────────────────────────────────────────────────────────
console.log('');
console.log('  ── 说明 / notes ──');
console.log('   · 本套件不依赖 DSH 运行时、本机知识库或网络；fixtures 自带全部输入。');
console.log('   · 它**不能**证明：真机槽位渲染、真实 vault 数据链路、浏览器半体交互。');
console.log('   · 脱敏权威扫描（真实业务词表）在仓库外留存，本文件只做结构性规则 + fixture 中性性。');
console.log('');
console.log(`  PASS = ${pass}`);
console.log(`  FAIL = ${fail}`);
console.log('');
console.log(fail === 0 ? '  结论：selftest 全绿' : '  结论：存在 FAIL，请修复');
process.exit(fail === 0 ? 0 : 1);
