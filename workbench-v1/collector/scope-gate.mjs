/**
 * `v1/collector/scope-gate.mjs` —— **消息进来之前的范围判定**（用户 2026-10-13 首裁 · 2026-10-14 改判）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户原话（第二轮，**当前口径**）
 *   「我想修改一下规则，之前我 **28 个白名单的群的其他人发言信息还是收集**
 *     （方便我查询谁在什么时候讲了什么话），但是**在非@我的信息则不用提醒**。」
 *
 * ⇒ 用户把**收**与**提醒**分成了两件事：
 *   · **收**：那 28 个白名单群（`_meta/im-scope.yml#full_message_groups`）**全量收**，
 *     目的是"能查谁在什么时候讲了什么" ⇒ 判"该不该收"时**不能只看 @我**。
 *   · **提醒**：非 @我 的**不进提醒**（今日总览的"长期未回复"那一条）。
 *     提醒的判定**不在本文件**，在 `processor/notice-gate.mjs`（那条规矩的产地）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 收的三条规矩（按顺序）
 *   一、**单聊**：全收。
 *   二、**白名单群（28 个）**：全量收。
 *   三、**其余任何群**：只有「@我」的才收。
 *
 * 白名单从 `_meta/im-scope.yml` 读（**不在这里再抄一份名单** —— 两份必然漂）。
 *   读不到时退回**只认那两个跨组织群**（保守：宁可少收，不可把无关群灌进来），
 *   并把原因放进 `whitelistStatus()`，由采集器如实报出来。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 判"@我"**只看正文** —— 这是实测改出来的，不是一开始就这么写
 *
 * 第一版我用了**两道**（订阅级 + 正文级），以为"两道互补更稳"。**实测把第一版否掉了**：
 *   拿 `_meta/out/.runtime/im-events.ndjson` 的 **9889 条真实事件**逐条过：
 *     · 订阅级那道：**没有多留下任何一条**（"只有订阅说@我、正文没@我"的 = **0 条**）；
 *     · 它却**漏掉了 26 条真的 @我** —— 那些消息正文明明是 `@杨瑒(月夜) …`，
 *       但因为不是从 `@我` 那条订阅投来的，被第一版挡掉了。
 *     · 还有 28 条相反的情况：从 `@我` 订阅投来，正文里 @ 的是别人（`@牧国涛` 这类）。
 *   ⇒ 订阅级这个标记**既不多收、又漏收**，两道并起来只会更糟。
 *     **正文里 @ 的是谁，是这条消息自己的属性，比"它从哪条通道来"可靠。**
 *
 * ⚠️ 仍然保留 `fromAtSubscription` 这个导出，只用于**观测**（对比两种口径差多少），不参与判定。
 */
import fs from 'node:fs';
import { kbPath } from '../paths.mjs';

/** 跨组织那两个群：**白名单读不到时的保守兜底**（它们走 API 拉取，必须有确切 cid）。 */
export const FULL_GROUPS = Object.freeze([
  { name: '智询工作室', cid: 'cidYfn8k+5mWU/YcUESFbS5hg==' },
  { name: 'AI Engineering Club', cid: 'cidVsqzvXfWKFV0GDaoDkUWVA==' },
]);

/**
 * 读 `_meta/im-scope.yml` 的白名单群（name + cid）。
 * 每次调用都重读（文件很小）—— **改了名单不必等重启**。
 */
export function whitelistGroups({ file = null } = {}) {
  const f = file ?? kbPath('_meta', 'im-scope.yml');
  let t = '';
  try { t = fs.readFileSync(f, 'utf8') } catch { return { ok: false, why: `读不到 ${f}`, groups: [] } }
  const sec = t.split('full_message_groups:')[1] ?? '';
  if (sec === '') return { ok: false, why: 'im-scope.yml 里没有 full_message_groups 段', groups: [] };
  const groups = [];
  let cur = null;
  for (const line of sec.split('\n')) {
    const mn = /^\s*-\s*name:\s*(.+?)\s*$/.exec(line);
    if (mn) { if (cur && cur.cid) groups.push(cur); cur = { name: mn[1].replace(/^["']|["']$/g, ''), cid: null }; continue }
    const mc = /^\s*cid:\s*"([^"]+)"/.exec(line);
    if (mc && cur) cur.cid = mc[1];
  }
  if (cur && cur.cid) groups.push(cur);
  return { ok: groups.length > 0, why: groups.length ? null : '名单里一条带 cid 的都没有', file: f, groups };
}

/** 白名单的 cid 集合（按"条数 + 文件路径 + 失败原因"做缓存键 —— 便宜且够用） */
let _wlCache = { key: '__init__', set: null, groups: [], ok: false, why: null };
function whitelistSet() {
  const r = whitelistGroups();
  const key = `${r.groups.length}:${r.file ?? ''}:${r.why ?? ''}`;
  if (_wlCache.key !== key) {
    // ★ 读不到 ⇒ 退回"只认那两个跨组织群"（保守：宁可少收，不可把无关群灌进来）
    const use = r.ok ? r.groups : [...FULL_GROUPS];
    _wlCache = { key, set: new Set(use.map((g) => g.cid)), groups: use, ok: r.ok, why: r.why };
  }
  return _wlCache;
}
/** 名单读得到吗、有几条（采集器把它如实报出来 —— 读不到等于退回保守口径，必须看得见） */
export function whitelistStatus() { const w = whitelistSet(); return { ok: w.ok, why: w.why, count: w.groups.length, names: w.groups.map((g) => g.name) }; }
/** 自检用：把白名单换成一份给定的集合 / 复位 */
export function _setWhitelistForTest(groups) {
  _wlCache = { key: `test:${groups.length}`, set: new Set(groups.map((g) => g.cid)), groups, ok: true, why: null };
}
export function _resetWhitelistCache() { _wlCache = { key: '__init__', set: null, groups: [], ok: false, why: null }; }

/** 我自己的名字（钉钉里的显示名）。取不到就退回这份内置的 —— 判定不能因为取不到而全放行。 */
export const SELF_MENTION_NAMES = Object.freeze(['杨瑒(月夜)', '杨瑒', '月夜']);

/**
 * 正文里有没有点我。
 * ★ 只认**行首或空白之后的 `@` + 我的名字**，且名字后面必须跟**分隔**，
 *   不认"别人名字里恰好含我的名字"（例：`@杨瑒的助理`）。
 * ★★ 分隔符里**必须包含左括号**（`(` / `（`）—— 真机实测的形态里就有：
 *     `@杨瑒(月夜)(杨瑒(月夜)) OK`（钉钉把名字和括号重复了一遍），
 *     第一版没有括号 ⇒ 这类 **50 条**被误判成"没 @我"。这是量出来的，不是猜的。
 */
export function textMentionsMe(text, names = SELF_MENTION_NAMES) {
  const t = String(text ?? '');
  if (t === '') return false;
  for (const n of names) {
    if (n === '') continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // @名字 后面是：行尾 / 空白 / 标点 / 左括号
    if (new RegExp(`(^|\\s)@${esc}(?=$|[\\s，。！？,.:：、()（）])`).test(t)) return true;
  }
  return false;
}

/**
 * 范围判定。
 * @param {{conversationId?:string, isDirect?:boolean, text?:string, fromAtSubscription?:boolean}} m
 *   `fromAtSubscription` 只用于观测对比，**不参与判定**（实测它既不多收、又漏收）。
 * @returns {{keep:boolean, why:string, rule:'direct'|'full-group'|'at-me'|'other-group-not-at-me'}}
 */
export function scopeDecision(m = {}) {
  // （原来这里先取了 `const cid = …`；加了"判不出会话类型就放行"之后改成在需要处再取，
  //   免得留下一个在早返回路径上用不到的变量。）
  // 一、单聊全收（本次只约束群消息）
  if (m.isDirect === true) return { keep: true, why: '单聊（本次只约束群消息）', rule: 'direct' };
  // ★★ 一-b、**判不出会话类型的**（没有 conversationId、也没标 isDirect）：**收**。
  //   来由（真机抓到的）：飞书单聊、短信/通知类消息**没有 conversationId**
  //   ⇒ 第一版把它们当成"没 @我 的群消息"**丢掉了**。
  //   实测那批里有：飞书单聊的"测试信息"、Trae 的推广短信、抖音钱包的通知、消费提醒……
  //   **这些根本不是群消息**，只是"没有群会话 id"而已。
  //   ⇒ 规矩：**一律先判它是不是单聊、是不是白名单群；判不出来就放行** ——
  //     本闸的用途是"挡住无关**群**消息"，不是"挡住我认不出来的东西"。
  //     这与 `processor/notice-gate.mjs` 对"判不出会话类型"的处理同源：**判不出来时不假装知道**。
  const cidIn = String(m.conversationId ?? '');
  if (cidIn === '') {
    return { keep: true, why: '没有会话 id（判不出是不是群消息）—— 放行，本闸只管群', rule: 'unclassified' };
  }
  // 二、**白名单群（28 个）全量收** —— 用户 2026-10-14 改判：
  //   「28 个白名单的群的其他人发言信息还是收集（方便我查询谁在什么时候讲了什么话）」
  //   ⇒ 收的口径**不能只看 @我**；"非 @我 不提醒"是**另一件事**，在 `processor/notice-gate.mjs`。
  const wl = whitelistSet();
  if (wl.set && wl.set.has(cidIn)) {
    const name = wl.groups.find((g) => g.cid === cidIn)?.name ?? cidIn;
    return { keep: true, why: `白名单群「${name}」全量收`, rule: 'full-group' };
  }
  // 三、其余群：**正文里确实点了我的名字**才收
  if (textMentionsMe(m.text)) {
    return { keep: true, why: '非白名单群，但正文里确实 @我', rule: 'at-me' };
  }
  return { keep: false, why: '非白名单群，正文里没有 @我', rule: 'other-group-not-at-me' };
}

/** 生成本轮回执的汇总（每一类各挡了多少、放了多少）—— 便于在采集日志里一眼看出这道闸的效果。 */
export function emptyTally() { return { direct: 0, unclassified: 0, 'full-group': 0, 'at-me': 0, 'other-group-not-at-me': 0 }; }
export function tallyOf(t, rule) { t[rule] = (t[rule] ?? 0) + 1; return t; }

/** 从事件里取"这条是不是从 @我 那条订阅来的"（与 dingtalk-im.mjs#scopeOf 同一口径：事件类型 `_at` 结尾）。 */
export function fromAtSubscription(ev) { return /_at$/.test(String(ev?.type ?? '')); }

export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail: String(detail) });
  const G = FULL_GROUPS[0].cid;

  chk('SG-1', '单聊照旧全收（本次只约束群消息）',
    scopeDecision({ isDirect: true, conversationId: 'cidOther' }).keep === true);
  chk('SG-2', '★ 白名单群「智询工作室」全量收（哪怕不是 @我、哪怕没有 atMe）',
    scopeDecision({ conversationId: G, isDirect: false, fromAtSubscription: false, text: '随便一句话' }).keep === true,
    JSON.stringify(scopeDecision({ conversationId: G, isDirect: false })));
  chk('SG-3', '★ 白名单群「AI Engineering Club」同样全量收',
    scopeDecision({ conversationId: FULL_GROUPS[1].cid, isDirect: false }).keep === true);
  chk('SG-4', '★ 非白名单群、非 @我 ⇒ **挡掉**',
    scopeDecision({ conversationId: 'cidOtherGroup', isDirect: false, fromAtSubscription: false, text: '闲聊' }).keep === false,
    JSON.stringify(scopeDecision({ conversationId: 'cidOtherGroup', isDirect: false, text: '闲聊' })));
  chk('SG-5', '★ 非白名单群、正文确实 @我 ⇒ 收',
    scopeDecision({ conversationId: 'cidOtherGroup', isDirect: false, text: '@杨瑒(月夜) 看一下这个' }).keep === true);
  // ★★ 这两条是**实测抓出来后改写**的：订阅级标记既不多收、又漏收（见文件顶部那段）
  chk('SG-6', '★★ 判 @我 **只看正文**：从「@我」订阅投来但正文 @ 的是别人 ⇒ 挡掉',
    scopeDecision({ conversationId: 'cidOtherGroup', isDirect: false, fromAtSubscription: true, text: '@牧国涛 好的，我这里联系一下陈主任' }).keep === false,
    JSON.stringify(scopeDecision({ conversationId: 'cidOtherGroup', isDirect: false, fromAtSubscription: true, text: '@牧国涛 好的' })));
  chk('SG-6b', '★★ 反过来也一样：**没走**「@我」订阅、但正文确实 @我 ⇒ **收**（实测被第一版误挡了 26 条）',
    scopeDecision({ conversationId: 'cidOtherGroup', isDirect: false, fromAtSubscription: false, text: '@杨瑒(月夜) 今天跟客户确认了需求边界' }).keep === true,
    '实测：`@杨瑒(月夜) …` 这样的消息有 26 条不在 `_at` 订阅里，第一版把它们全挡了');
  chk('SG-7', '非白名单群、正文里有 @ 但不是 @我 ⇒ 挡掉（不能只看"正文有没有 @"）',
    scopeDecision({ conversationId: 'cidOtherGroup', isDirect: false, text: '@周勇（三闻） 好的' }).keep === false);
  // ★★ 2026-10-14 加：**判不出会话类型的必须放行**（真机抓到的缺陷）。
  //   来由：飞书单聊、短信/通知类消息**没有 `conversationId`**，
  //   第一版把它们当成"没 @我 的群消息"**丢掉了** —— 实测丢的有飞书单聊的"测试信息"、
  //   Trae 的推广短信、抖音钱包的通知、消费提醒……**这些根本不是群消息**。
  chk('SG-7b', '★★ 没有会话 id（判不出是不是群消息）⇒ **放行** —— 本闸只管群，不管"我认不出来的"',
    scopeDecision({ text: '【抖音钱包放心借】通知：抖音里可以借钱了…拒收请回复R' }).keep === true,
    JSON.stringify(scopeDecision({ text: '【抖音钱包放心借】通知…' })));
  chk('SG-7c', '与"非白名单群且没 @我"区分开：那种**有** conversationId ⇒ 挡掉',
    scopeDecision({ conversationId: 'cidOtherGroup', text: '大家早' }).keep === false
    && scopeDecision({ text: '大家早' }).keep === true);
  // 正文匹配的边界
  chk('SG-8', '正文匹配不误判：`@杨瑒的助理` 不算 @我（名字后面要有分隔）',
    textMentionsMe('@杨瑒的助理 你好') === false && textMentionsMe('@杨瑒(月夜) 你好') === true);
  chk('SG-9', '我自己那几种写法都能认出来',
    ['@杨瑒(月夜)', '@杨瑒', '@月夜'].every((n) => textMentionsMe(`${n} 看一下`)));
  chk('SG-10', '空正文不炸、也不算 @我', textMentionsMe('') === false && textMentionsMe(undefined) === false);
  // fromAtSubscription 的口径
  chk('SG-11', '「@我订阅」的判法：事件类型 _at 结尾（与采集器同一口径）',
    fromAtSubscription({ type: 'user_im_message_receive_at' }) === true
    && fromAtSubscription({ type: 'user_im_message_receive_group_all' }) === false,
    String(fromAtSubscription({ type: 'user_im_message_receive_at' })));
  // 计分
  const t = emptyTally();
  tallyOf(t, 'at-me'); tallyOf(t, 'other-group-not-at-me'); tallyOf(t, 'other-group-not-at-me');
  chk('SG-12', '回执计分能逐类累加（便于在采集日志里看这道闸的效果）',
    t['at-me'] === 1 && t['other-group-not-at-me'] === 2, JSON.stringify(t));

  return { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out };
}
