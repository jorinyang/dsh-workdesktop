/**
 * `v1/collector/scope-gate.mjs` —— **消息进来之前的范围判定**（用户 2026-10-13 裁定）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户原话（两轮，逐字）
 *   「钉钉群消息，白名单群（智询工作室 / AI Engineering Club）这两个群组的**全量信息**。
 *     其他群组的**非@我**的信息不进入消息。」
 *   第二轮选择：「只这两个群全量，**其余 26 个白名单群也按「只收@我」处理**」
 *
 * ⇒ 三条规矩，顺序执行：
 *   一、**单聊**：照旧全收（本次只约束群消息）。
 *   二、**这两个群的群消息**：全量收。
 *   三、**其余任何群的群消息**：只有「@我」的才收。
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
 * 现在：非白名单群的消息，**正文里确实点了我的名字才收**。
 *   实测口径 = 留 2663 条（现判法 2637 + 被误挡的 26）· 挡掉 7226 条。
 * ⚠️ 仍然保留 `fromAtSubscription` 这个导出，只用于**观测**（对比两种口径差多少），不参与判定。
 */
import fs from 'node:fs';
import { kbPath } from '../paths.mjs';

/** 全量收的两个群（与 `collector/dingtalk-cross-org.mjs` 的 `FULL_MESSAGE_GROUPS` 同源，不各写一份）。 */
export const FULL_GROUPS = Object.freeze([
  { name: '智询工作室', cid: 'cidYfn8k+5mWU/YcUESFbS5hg==' },
  { name: 'AI Engineering Club', cid: 'cidVsqzvXfWKFV0GDaoDkUWVA==' },
]);
const FULL_CIDS = new Set(FULL_GROUPS.map((g) => g.cid));

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
  const cid = String(m.conversationId ?? '');
  // 一、单聊全收（本次只约束群消息）
  if (m.isDirect === true) return { keep: true, why: '单聊（本次只约束群消息）', rule: 'direct' };
  // 二、两个白名单群全量
  if (FULL_CIDS.has(cid)) {
    const name = FULL_GROUPS.find((g) => g.cid === cid)?.name ?? cid;
    return { keep: true, why: `白名单群「${name}」全量收`, rule: 'full-group' };
  }
  // 三、其余群：**正文里确实点了我的名字**才收
  if (textMentionsMe(m.text)) {
    return { keep: true, why: '非白名单群，但正文里确实 @我', rule: 'at-me' };
  }
  return { keep: false, why: '非白名单群，正文里没有 @我', rule: 'other-group-not-at-me' };
}

/** 生成本轮回执的汇总（每一类各挡了多少、放了多少）—— 便于在采集日志里一眼看出这道闸的效果。 */
export function emptyTally() { return { direct: 0, 'full-group': 0, 'at-me': 0, 'other-group-not-at-me': 0 }; }
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
