/**
 * `v1/processor/context-gate.mjs` —— **"这条还需不需要取相关上下文"的唯一判据**。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户原话（2026-10-14，这一条是它落地的判据）
 *   「所有信息/待办/日程/笔记**在流入到工作台的时候做一次相关上下文的获取和分析**，
 *     在转日程/转笔记/转待办相互转换的时候**按照之前已经有的上下文**。
 *     消息列表的消息/待办列表的待办/日程列表的日程和笔记列表的笔记在执行操作转换/完成标记的时候
 *     **也不再重复获取上下文**。」
 *   ⇒ 三句话落到代码上是三件事：
 *     ① **流入时取一次** —— 接口新建时当场取（`api/server.mjs` 的 `recallIntoEvent`）；
 *     ② **转换时用已有的** —— 三种转换只读 `evt.context.recalled`，**不调召回**；
 *     ③ **动作时不取** —— 已完成/已搁置这些标记根本不碰上下文。
 *   而"**别重复取**"要落地，就必须有一个**统一的判据**回答"这条还需要取吗"。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件（不放在 `api/server.mjs` 里）
 *
 *   第一版我把它写在 `server.mjs` 并导出 —— 结果分析引擎要引它，
 *   而 `server.mjs` 又动态 import 分析引擎 ⇒ **两边互相引用**。
 *   动态 import 是懒的，当时不会立刻炸，但那是**埋在里面的隐患**（谁先把谁加载完说不准）。
 *   ⇒ 判据是**纯函数、没有任何依赖**，就该待在一个**谁都能引、它谁也不引**的地方。
 *     这类"两处都要用的判据"以后照这个办：**提到中立的小模块**，别塞在某一方里面。
 */

/**
 * 这条事件还需不需要取相关上下文。
 * @param {object} evt 事件
 * @returns {boolean}
 */
export function needsContext(evt) {
  if (!evt) return false;
  if (Array.isArray(evt.context?.recalled) && evt.context.recalled.length > 0) return false;   // 已经有材料
  if (evt.context?.recallError) return false;                                                  // 上次取过但桥断了（别反复打）
  return true;
}

/** 从事件里挑"拿去检索的那句话"（四类的字段名不同，产地只留这一处） */
export function queryOf(evt, { max = 200 } = {}) {
  const p = evt?.payload ?? {};
  return String(p.topic ?? p.summary ?? p.raw ?? '').slice(0, max);
}

export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail: String(detail) });

  chk('CG-1', '★ 没有上下文 ⇒ 需要取', needsContext({ payload: { raw: 'x' } }) === true);
  chk('CG-2', '★ 已经有材料 ⇒ **不需要再取**（用户："不再重复获取上下文"）',
    needsContext({ context: { recalled: [{ text: 'a' }] } }) === false);
  chk('CG-3', '★ 取过但一条没命中 ⇒ 仍需取（"空"不等于"不用取"）',
    needsContext({ context: { recalled: [] } }) === true);
  chk('CG-4', '★ 上次桥断了 ⇒ 不反复打（重试一个已知不可用的东西没意义）',
    needsContext({ context: { recalled: [], recallError: '桥断了' } }) === false);
  chk('CG-5', '★ 空事件 ⇒ 不取（不猜）', needsContext(null) === false && needsContext(undefined) === false);

  chk('CG-6', '★ 检索文本按四类的字段名依次取（topic → summary → raw）',
    queryOf({ payload: { topic: 'T' } }) === 'T'
    && queryOf({ payload: { summary: 'S' } }) === 'S'
    && queryOf({ payload: { raw: 'R' } }) === 'R'
    && queryOf({ payload: { topic: 'T', raw: 'R' } }) === 'T',
    [queryOf({ payload: { topic: 'T' } }), queryOf({ payload: { summary: 'S' } }), queryOf({ payload: { raw: 'R' } })].join('/'));
  chk('CG-7', '★ 超长截断（不把整篇塞给检索服务）', queryOf({ payload: { raw: 'x'.repeat(500) } }).length === 200);

  return { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out };
}
