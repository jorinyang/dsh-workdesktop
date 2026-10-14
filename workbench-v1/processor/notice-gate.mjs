/**
 * `v1/processor/notice-gate.mjs` —— **该不该"提醒"我**（用户 2026-10-14 裁定）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户原话
 *   「我想修改一下规则，之前我 **28 个白名单的群的其他人发言信息还是收集**
 *     （方便我查询谁在什么时候讲了什么话），但是**在非@我的信息则不用提醒**。」
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么这条规矩要**单独一个文件**，而不是塞进 `scope-gate.mjs`
 *
 *   用户这句话把两件事分开了：
 *     · **收**（进不进库）—— 白名单群全收，为的是"能查谁在什么时候讲了什么"；
 *     · **提醒**（要不要扰我）—— 非 @我 的群消息**不提醒**。
 *   这两件事**判法不同、将来也会各自改**（比如"白名单群再扩"不影响"提醒只认 @我"）。
 *   塞在一个文件里，下次改其中一条就会连带动到另一条 —— 本项目的教训是：
 *   **一条规矩一个产地，别让两个关注点共用一处判定**。
 *
 *   所以：收的判定在 `collector/scope-gate.mjs`；提醒的判定在这里。
 *   两处都从 `_meta/im-scope.yml` 读同一份白名单（**名单只有一份**），但**规矩各自独立**。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 提醒的规矩（三条）
 *   一、**单聊**：提醒（对方在等我回，这是最该提醒的一类）。
 *   二、**群里点到我的名字**：提醒。
 *   三、**其余群消息（含 28 个白名单群里别人说的话）**：**只收不提醒**
 *      —— 它们照旧进库、照旧能查，只是**不占"长期未回复"那条提醒**。
 *
 * ⚠️ 为什么"白名单群里的 @我"要提醒、而"别人闲聊"不提醒：
 *   @我 是**冲我来的**（要我做点什么）；别人闲聊是**我在旁听**（我能查到就够了）。
 *   这条分界正是用户这句话的要点。
 */
import { textMentionsMe, whitelistStatus, scopeDecision } from '../collector/scope-gate.mjs';

/** 提醒与否的判定结果类型 */
export const NOTICE_RULES = Object.freeze(['direct', 'at-me', 'quiet-group']);

/**
 * 这条消息**要不要提醒我**。
 * @param {{conversationId?:string, isDirect?:boolean, text?:string, raw?:string}} m
 * @returns {{notice:boolean, rule:'direct'|'at-me'|'quiet-group', why:string}}
 */
export function noticeDecision(m = {}) {
  // ★ `?? {}` 是**必须的**：默认值只在"参数是 undefined"时生效，而 `null` 会照样传进来
  //   ⇒ 第一版 `noticeDecision(null)` 取 `m.text` 时当场崩（NG-7 抓到的）。
  //   这类"上层喂了个 null"的事真会上门（采集端字段缺失、老数据），所以不能只靠默认值。
  const src = m ?? {};
  const text = String(src.text ?? src.raw ?? '');
  // 一、单聊：提醒
  if (src.isDirect === true) return { notice: true, rule: 'direct', why: '单聊 —— 对方在等我回' };
  // 二、群里点到我的名字：提醒（**先判 @我，再判白名单** —— 顺序要紧：
  //    白名单群里的 @我 也应当提醒，不能被"白名单 = 安静"整条盖掉）
  if (textMentionsMe(text)) return { notice: true, rule: 'at-me', why: '群里点到了我的名字 —— 是冲我来的' };
  // ★★ 三、**判不出会话类型的**：照旧提醒。
  //   来由：自检夹具里那条消息**没带 conversationId、也没标 isDirect**，被这条闸当成"群消息且没 @我"
  //   滤掉了 —— PG-12 当场变红。查清之后确认这**不只是夹具的问题**：
  //   真数据里也可能有"会话信息缺失"的消息（采集端字段没给全、或老数据）。
  //   对这类**判不出来的**，规矩应当是**放行（提醒）**而不是静默滤掉 ——
  //   漏提醒比多提醒的代价大（多提醒顶多吵一下，漏提醒是真的错过）。
  //   这条与采集侧的判法同源：**判不出来时不假装知道**。
  const cid = String(src.conversationId ?? '');
  if (cid === '') {
    return { notice: true, rule: 'at-me', why: '会话信息缺失（判不出是单聊还是群）—— 按"提醒"处理，不静默滤掉' };
  }
  // 四、其余群消息：只收不提醒
  const wl = whitelistStatus();
  const dec = scopeDecision({ conversationId: cid, isDirect: false, text });
  return {
    notice: false,
    rule: 'quiet-group',
    why: dec.keep
      ? `白名单群（共 ${wl.count} 个）里别人的发言 —— 照旧收进库、能查到，但不提醒`
      : '非白名单群、且没 @我 —— 照旧按范围闸处理（本来就不进库）',
  };
}

/** 提醒清单里该保留哪些（给总览"长期未回复"用）：就地过滤，不改事件 */
export function noticeable(events = []) {
  return (events ?? []).filter((e) => noticeDecision({
    conversationId: String(e?.payload?.conversationId ?? ''),
    isDirect: e?.payload?.isDirect === true,
    text: String(e?.payload?.raw ?? e?.payload?.summary ?? ''),
  }).notice);
}

export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail: String(detail) });
  const WL = process.env.WB_TEST_WL_CID || 'cidnncSCEp7R0VHOqrrD2764w==';   // AI表格产品交流群 🥕（白名单里）

  chk('NG-1', '单聊 ⇒ 提醒', noticeDecision({ isDirect: true }).notice === true,
    JSON.stringify(noticeDecision({ isDirect: true })));
  chk('NG-2', '★ 白名单群里**别人闲聊**（没 @我）⇒ **不提醒**（用户这次改的就是它）',
    noticeDecision({ conversationId: WL, isDirect: false, text: '这个表格我改好了' }).notice === false,
    JSON.stringify(noticeDecision({ conversationId: WL, isDirect: false, text: '这个表格我改好了' })));
  chk('NG-3', '★★ 白名单群里**@我** ⇒ **要提醒**（顺序要紧：@我 优先于"白名单 = 安静"）',
    noticeDecision({ conversationId: WL, isDirect: false, text: '@杨瑒(月夜) 你看下这个' }).notice === true,
    JSON.stringify(noticeDecision({ conversationId: WL, isDirect: false, text: '@杨瑒(月夜) 你看下这个' })));
  chk('NG-4', '非白名单群、@我 ⇒ 提醒',
    noticeDecision({ conversationId: 'cidNotWhitelist', isDirect: false, text: '@杨瑒(月夜) 在吗' }).notice === true);
  chk('NG-5', '非白名单群、没 @我 ⇒ 不提醒',
    noticeDecision({ conversationId: 'cidNotWhitelist', isDirect: false, text: '大家早' }).notice === false);
  chk('NG-6', '正文里 @ 的是别人 ⇒ 不提醒（不能只看"正文有没有 @"）',
    noticeDecision({ conversationId: WL, isDirect: false, text: '@牧国涛 好的' }).notice === false);
  // ★★ NG-7 改（2026-10-14）：原来这条期望「空/缺字段 ⇒ 不提醒」。
  //   加了"判不出会话类型 ⇒ 按提醒处理"之后它变红 —— **它红得对，它守的是旧行为**。
  //   ⇒ 拆成两条：一条守"不炸"（本来的用意），一条守**新行为**（判不出 ⇒ 提醒，别静默滤掉）。
  chk('NG-7', '空/缺字段**不炸**（上层喂什么都得活着）', (() => {
    try { noticeDecision({}); noticeDecision(undefined); noticeDecision(null); return true } catch { return false }
  })());
  chk('NG-7b', '★★ 判不出会话类型（没有 conversationId）⇒ **按提醒处理**，不静默滤掉',
    noticeDecision({}).notice === true && noticeDecision({}).why.includes('会话信息缺失'),
    JSON.stringify(noticeDecision({})));
  chk('NG-7c', '与非白名单群、没 @我 区分开：那种**有** conversationId ⇒ 不提醒',
    noticeDecision({ conversationId: 'cidNotWhitelist', text: '大家早' }).notice === false);
  // noticeable() 就地过滤
  const evs = [
    { payload: { isDirect: true, raw: '在吗' } },
    { payload: { conversationId: WL, raw: '改好了' } },
    { payload: { conversationId: WL, raw: '@杨瑒(月夜) 看下' } },
  ];
  const kept = noticeable(evs);
  chk('NG-8', '★ 提醒清单过滤：3 条里留下 2 条（单聊 + 群里 @我），"别人闲聊"那条被滤掉',
    kept.length === 2, `留下 ${kept.length} 条`);
  chk('NG-9', '★ 过滤是**就地**的，不改事件本身（原始数组长度不变）',
    evs.length === 3 && evs[1].payload.raw === '改好了');

  return { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out };
}
