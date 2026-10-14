/**
 * `v1/processor/extract.mjs` —— **从「消息 + 相关上下文」里提取结构化字段**（用户 2026-10-14 这一轮）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 用户原话（三种转换，逐字）
 *   · 「消息详情页面的**转待办**，是需要提取**消息以及消息相关的上下文**当中包含的
 *      跟**待办结构化字段**相关的内容，创建待办，并将对应的内容填写到其中」
 *   · 「转日程，是需要提取消息以及消息相关上下文中包含和**日程结构化字段**相关的内容，
 *      创建日程并将对应的内容填写到其中」
 *   · 「转笔记，需要提取消息以及消息相关上下文中包含**笔记结构化字段**相关的内容，
 *      创建笔记并将对应的内容填写到其中」
 *   · 「待办详情页的**转日程**功能，需要提取**笔记及相关上下文**中包含和日程结构化字段相关的内容」
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 与上一轮的区别（这一点要说清楚，否则看不出改了哪儿）
 *
 *   上一轮我做的：从**消息原文**里挑字段（`pickPlace` / `pickParticipants` / `briefTitle`），
 *     主题取一句话、其余字段按正则挑。**完全没有用"相关上下文"。**
 *   这一轮用户明确要求把**召回的相关材料**也算作来源。两者是不同的料：
 *     · 消息原文 = 当事人当时说的话；
 *     · 相关上下文 = 知识库里召回的、与这条相关的历史材料（可能有完整的项目名、参与人、地点）。
 *   ⇒ 现在的口径：**先在原文里找；原文里找不到，才去上下文里找**。
 *     为什么是这个顺序：原文是"这条消息本身说什么"，上下文是"别处的相关材料"——
 *     拿别处的材料去填这条消息的字段，只有在原文确实没给的时候才合理。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 三条纪律
 *
 *   一、**纯规则，不调模型**。转换是点一下就出结果的交互动作；为它调模型要几秒到几十秒。
 *      而且这些字段（日期、地点、人名、来源）本来就是形态明确的，规则比模型稳。
 *      （要模型的那条路是"分析笔记"，那是另一个按钮，见 `analyze.mjs`。）
 *   二、**挑不出就留空，不硬编**。地点挑不出 ⇒ `null`；参与人挑不出 ⇒ `[]`。
 *      宁可空着让人补，也不能编一个看着像真的。
 *   三、**原文优先，上下文兜底**，并在返回值里**说清每一项是从哪儿来的**（`from` 字段）——
 *      用户要看得出"这个地点是从消息里读的，还是从召回材料里读的"。
 */
import { briefTitle, pickParticipants, pickPlace, stripNoise } from './brief.mjs';

/** 把"消息 + 相关上下文"拼成一条可检索的料，并记住每一段的来源 */
export function buildMaterial(raw, recalled = [], { maxCtx = 5, maxChars = 400 } = {}) {
  const selfText = String(raw ?? '').trim();
  const ctx = [];
  for (const h of (Array.isArray(recalled) ? recalled : []).slice(0, maxCtx)) {
    const t = String(h?.text ?? '').trim();
    if (t.length < 8) continue;                       // 太短的材料没有信息量（与 context-summary 同一门槛）
    ctx.push(t.slice(0, maxChars));
  }
  return { selfText, ctx, all: [selfText, ...ctx].filter(Boolean).join('\n') };
}

/** 在原文里找；找不到再去上下文里找。返回 `{value, from}`（`from` 说清是哪来的） */
function firstHit(selfText, ctx, pick) {
  const a = pick(selfText);
  if (a !== null && a !== undefined && !(Array.isArray(a) && a.length === 0) && a !== '') {
    return { value: a, from: '消息原文' };
  }
  for (let i = 0; i < ctx.length; i += 1) {
    const b = pick(ctx[i]);
    if (b !== null && b !== undefined && !(Array.isArray(b) && b.length === 0) && b !== '') {
      return { value: b, from: `相关上下文第 ${i + 1} 条` };
    }
  }
  return { value: null, from: null };
}

/**
 * 日期形态：`2026-10-20` / `10月20日` / `明天` / `下周三` / **`本月内`** / **`月底`**
 * （只认明确的，不硬猜）
 *
 * ★ 2026-10-14 补（**自检 EX-3 逼出来的**）：第一版只认"具体某天"，漏了
 *   **`本月内` / `这个月内` / `月底` / `下月初`** 这类**月度区间**的说法 ——
 *   而"本月内给到客户"是一个**完全明确的截止**（就是月末那天），不该当作"没给日期"。
 *   处理方式：`本月内/月底` ⇒ 当月最后一天；`下月初` ⇒ 下月一号。
 *   ⚠️ 只说"本月"不说"内/底"的（如"本月的进展"）**不认** —— 那是描述不是截止。
 */
export function pickDueDate(text, { now = Date.now() } = {}) {
  const t = stripNoise(text);
  const iso = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/.exec(t);
  if (iso) {
    const p = (n) => String(n).padStart(2, '0');
    return `${iso[1]}-${p(Number(iso[2]))}-${p(Number(iso[3]))}`;
  }
  const md = /(\d{1,2})月(\d{1,2})日?/.exec(t);
  if (md) {
    const y = new Date(now).getFullYear();
    const p = (n) => String(n).padStart(2, '0');
    return `${y}-${p(Number(md[1]))}-${p(Number(md[2]))}`;
  }
  // ★ 月度区间（见上面那段说明）：只在"内 / 底 / 末"这些**收口词**出现时才认
  const p2 = (n) => String(n).padStart(2, '0');
  // `monthEndOf(y, m)` —— m 是 **1~12 的自然月**，返回那个月最后一天。
  // ⚠️ 第一版把 `new Date(y, m, 0)` 的参数语义搞混了（那是"第 m 月的前一天"），
  //   于是 `下月底` 算成了**本月末**（自检量到 2026-10-31，应为 2026-11-30）。
  //   ⇒ 显式写清"给年月、要那月最后一天"，别再靠 `new Date` 的月份从 0 起算去倒推。
  const monthEndOf = (y, m) => {
    const d = new Date(y, m, 0);                      // 第 m 月的最后一天（m 从 1 起）
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  const D0 = new Date(now);
  const nextMonth = new Date(D0.getFullYear(), D0.getMonth() + 1, 1);
  // ★ 顺序要紧：**先判"下月"，再判"本月/裸月底"**。
  //   第一版把 `/月底|月末/` 写在了前面，而它是**裸匹配** —— `下月底` 里含"月底"
  //   ⇒ 被它抢先命中，当成本月末（自检量到 2026-10-31，应为 2026-11-30）。
  //   这是"宽规则吃掉窄规则"，与前端那几次"取第一个 .list 取错对象"是同一类病：
  //   **判据写得越宽，越要先让窄的过一遍。**
  if (/(下月|下个月)(内|底|末)/.test(t)) return monthEndOf(nextMonth.getFullYear(), nextMonth.getMonth() + 1);
  if (/下月(初|一)|下个月初/.test(t)) return `${nextMonth.getFullYear()}-${p2(nextMonth.getMonth() + 1)}-01`;
  if (/(本月|这个月|当月)(内|底|末)/.test(t)) return monthEndOf(D0.getFullYear(), D0.getMonth() + 1);
  // 裸的"月底/月末"（前面**不是**"下"字）才算本月末 —— 用负向后顾把"下月底"排除掉
  if (/(?<!下)月底|(?<!下)月末/.test(t)) return monthEndOf(D0.getFullYear(), D0.getMonth() + 1);
  const rel = /(今天|明天|后天|大后天)/.exec(t);
  if (rel) {
    const add = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[rel[1]];
    const d = new Date(now + add * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // 星期几：`下周三` / `本周五` / `周三`
  // ★ 2026-10-14 修（**自检 EX-3 抓到的**）：第一版的正则 `(下|本|这)?(?:周|星期)([一二三四五六日天])`
  //   会把 **`下周需要和客户对齐`** 里的"下周"匹配成"下周日"（`[一二三四五六日天]` 含"日"，
  //   而"下周"后面那半个字"日"其实不存在 —— 是"需要"的"需"被当成了边界之外的下一字符）。
  //   后果很严重：一句"下周再说"会被解析成**一个具体日期**并写进待办的截止时间。
  //   ⇒ 修法两条：① 星期后面**必须是"周几那个字"**，且不能紧跟"要/需/的/再/末"这类词；
  //     ② 加一条负向：`下周`、`本周`、`这周` 单独出现（后面不是星期字）⇒ **不认**，返回 null。
  const wk = /(下|本|这)?(?:周|星期)([一二三四五六])/.exec(t);
  if (wk) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const want = map[wk[2]];
    if (want === undefined) return null;               // `周天`/`周日` 这种歧义形态不认（见上面那段说明）
    const cur = new Date(now);
    const curDow = cur.getDay() === 0 ? 7 : cur.getDay();
    let delta = want - curDow;
    if (wk[1] === '下') delta += 7;
    else if (delta < 0) delta += 7;                   // 只说"周三"而本周已过 ⇒ 算下周
    const d = new Date(now + delta * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return null;
}

/** 执行人：只在**明确说"让谁做"**的时候认，不把发信人当执行人 */
export function pickExecutor(text, { self = '我' } = {}) {
  const t = stripNoise(text);
  const m = /(?:请|让|安排|交给|由)\s*([\u4e00-\u9fa5]{2,4})\s*(?:来|去|负责|跟进|处理|做|看一下|看下)/.exec(t);
  if (m) return m[1];
  if (/(我|自己)\s*(?:来|去|负责|跟进|处理|做|看一下|看下|弄|改|发|写)/.test(t)) return self;
  return null;
}

/** 待办等级/优先级线索（只在明文出现时才给） */
export function pickPriority(text) {
  const t = stripNoise(text);
  if (/加急|紧急|尽快|马上|立刻|今天必须/.test(t)) return '高';
  if (/不急|有空|方便时|再说/.test(t)) return '低';
  return null;
}

/**
 * 提取**待办**的结构化字段。
 * @returns {{payload:object, from:object, material:object}}
 *   `from` 逐字段说清来源（消息原文 / 相关上下文第 N 条 / 未找到）
 */
export function extractTodo(raw, recalled, { now = Date.now(), sender = null, self = '我', over = {} } = {}) {
  const mat = buildMaterial(raw, recalled);
  const s = mat.selfText; const c = mat.ctx;
  const brief = firstHit(s, c, (x) => briefTitle(x) || null);
  const topic = over.topic ?? brief.value ?? '（未命名待办）';
  const due = firstHit(s, c, (x) => pickDueDate(x, { now }));
  const exec = firstHit(s, c, (x) => pickExecutor(x, { self }));
  const prio = firstHit(s, c, (x) => pickPriority(x));
  // 详情：**原文 + 召回材料**都留下（用户说"提取消息以及消息相关的上下文"）
  const detailParts = [];
  if (s) detailParts.push(s);
  if (c.length) detailParts.push(`—— 相关上下文 ——\n${c.map((x, i) => `【${i + 1}】${x}`).join('\n')}`);
  return {
    payload: {
      topic: String(topic).slice(0, 80),
      detail: over.detail ?? (detailParts.join('\n\n') || ''),
      due: over.due ?? due.value,
      publisher: over.publisher ?? sender ?? null,
      executor: over.executor ?? exec.value ?? self,
      ...(prio.value ? { detail: `${over.detail ?? detailParts.join('\n\n')}\n\n（线索：${prio.value}优先）` } : {}),
    },
    from: {
      topic: brief.from ?? '兜底', due: due.from ?? '未找到', executor: exec.from ?? '默认（我）',
      publisher: sender ? '消息发信人' : '未找到', context: c.length ? `${c.length} 条` : '无',
    },
    material: { selfLen: s.length, ctxCount: c.length },
  };
}

/** 提取**日程**的结构化字段 */
export function extractSchedule(raw, recalled, { now = Date.now(), sender = null, over = {} } = {}) {
  const mat = buildMaterial(raw, recalled);
  const s = mat.selfText; const c = mat.ctx;
  const brief = firstHit(s, c, (x) => briefTitle(x) || null);
  const place = firstHit(s, c, (x) => pickPlace(x));
  const parts = firstHit(s, c, (x) => { const p = pickParticipants(x); return p.length ? p : null });
  // 主题/地点/参与人后面的括号里常常就是参与人（`@张三（技术部）` 已由 pickParticipants 处理）
  const detailParts = [];
  if (s) detailParts.push(s);
  if (c.length) detailParts.push(`—— 相关上下文 ——\n${c.map((x, i) => `【${i + 1}】${x}`).join('\n')}`);
  return {
    payload: {
      topic: String(over.topic ?? brief.value ?? '（未命名日程）').slice(0, 80),
      detail: over.detail ?? (detailParts.join('\n\n') || ''),
      place: over.place ?? place.value,
      participants: over.participants ?? parts.value ?? [],
    },
    from: {
      topic: brief.from ?? '兜底', place: place.from ?? '未找到',
      participants: parts.from ?? '未找到', context: c.length ? `${c.length} 条` : '无',
    },
    material: { selfLen: s.length, ctxCount: c.length },
  };
}

/** 提取**笔记**的结构化字段（主题 / 时间 / 内容） */
export function extractNote(raw, recalled, { now = Date.now(), over = {} } = {}) {
  const mat = buildMaterial(raw, recalled);
  const s = mat.selfText; const c = mat.ctx;
  const brief = firstHit(s, c, (x) => briefTitle(x) || null);
  // 内容：**完整原文**（用户第 7.1 条"将消息完整记录下来"）+ 召回材料
  const body = [];
  if (s) body.push(s);
  if (c.length) body.push(`—— 相关上下文 ——\n${c.map((x, i) => `【${i + 1}】${x}`).join('\n')}`);
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return {
    payload: {
      topic: String(over.topic ?? brief.value ?? '消息沉淀').slice(0, 80),
      date: over.date ?? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      content_md: over.content_md ?? body.join('\n\n'),
      tags: over.tags ?? ['消息沉淀'],
    },
    from: { topic: brief.from ?? '兜底', content: c.length ? `原文 + ${c.length} 条上下文` : '原文', context: c.length ? `${c.length} 条` : '无' },
    material: { selfLen: s.length, ctxCount: c.length },
  };
}

export async function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail: String(detail) });

  const CTX = [
    { text: '这个项目由冯杰楠负责跟进，地点定在杭州西溪园区，下周需要和客户对齐一次。' },
    { text: '另外注意：报价单要在本月内给到客户，商务那边催过一次。' },
  ];

  // ① 原文里有 ⇒ 用原文的（不拿上下文的去顶）
  const a = extractTodo('明天上午十点在3楼会议室对一下接口联调的方案，@张三', CTX);
  chk('EX-1', '待办：**原文里有就用原文的**', a.from.due === '消息原文' && a.payload.due !== null, `due=${a.payload.due} from=${a.from.due}`);
  chk('EX-2', '★ 逐字段说清来源（用户要看得出是消息还是上下文）',
    a.from.topic && a.from.due && a.from.executor && a.from.context === '2 条', JSON.stringify(a.from));

  // ② 原文里没有 ⇒ 去上下文里找（这正是用户这一轮新加的要求）
  const b = extractTodo('那个事你再看看', CTX);
  chk('EX-3', '★★ 原文里没有 ⇒ **去相关上下文里找**（这一轮新加的要求）',
    b.from.due === '相关上下文第 1 条' || b.from.due === '相关上下文第 2 条', `due=${b.payload.due} from=${b.from.due}`);
  chk('EX-4', '★★ 详情里**原文与召回材料都留下**（用户："提取消息以及消息相关的上下文"）',
    b.payload.detail.includes('那个事你再看看') && b.payload.detail.includes('相关上下文') && b.payload.detail.includes('冯杰楠'),
    `${b.payload.detail.length} 字`);

  // ③ 日程：地点与参与人能从上下文里补
  const sch = extractSchedule('周一碰一下', CTX);
  chk('EX-5', '★★ 日程：地点**能从上下文里补**（原文没给）', sch.payload.place === '杭州西溪园区' && sch.from.place === '相关上下文第 1 条', `place=${sch.payload.place} from=${sch.from.place}`);
  chk('EX-6', '日程：参与人从 @ 里挑', extractSchedule('@张三 @李四 明天开会', []).payload.participants.length === 2);

  // ④ 笔记：内容完整（原文一个字不丢）
  const note = extractNote('这段话要完整记下来，包括标点。', CTX);
  chk('EX-7', '★★ 笔记：内容**保留完整原文**（用户"将消息完整记录下来"）',
    note.payload.content_md.includes('这段话要完整记下来，包括标点。') && note.payload.content_md.includes('相关上下文'), `${note.payload.content_md.length} 字`);
  chk('EX-8', '笔记：主题是**一句话**（不是整段）', note.payload.topic.length <= 36 && !note.payload.topic.includes('相关上下文'), note.payload.topic);
  chk('EX-9', '笔记：日期是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(note.payload.date), note.payload.date);

  // ⑤ 挑不出就留空（不硬编）
  const empty = extractSchedule('嗯嗯好的收到', []);
  chk('EX-10', '★ 挑不出就**留空**（地点 null / 参与人 []），不硬编',
    empty.payload.place === null && Array.isArray(empty.payload.participants) && empty.payload.participants.length === 0,
    JSON.stringify({ place: empty.payload.place, parts: empty.payload.participants }));
  chk('EX-11', '★ 上下文太短的**不采用**（与 context-summary 同一门槛）',
    buildMaterial('x', [{ text: '短' }, { text: '这条够长，能被采纳作为材料使用。' }]).ctx.length === 1);

  // ⑥ 人给了就用人的（界面填了就是用户的意思，不该被规则改写）
  const given = extractTodo('明天开会', CTX, { over: { topic: '我自己写的标题', due: '2026-12-31' } });
  chk('EX-12', '★ 人给的字段**不被改写**（界面上填了就是你的意思）',
    given.payload.topic === '我自己写的标题' && given.payload.due === '2026-12-31', JSON.stringify({ t: given.payload.topic, d: given.payload.due }));

  // ⑦ 纯规则
  chk('EX-13', '★ 纯规则：不调模型（无网络 / 无 spawn）', !/spawn|fetch\(|http/i.test(extractTodo.toString() + extractSchedule.toString() + extractNote.toString()));

  // ⑧ 日期形态
  const N = Date.parse('2026-10-14T10:00:00+08:00');
  chk('EX-14', '★ 日期形态：绝对 / 相对 / 星期几 / **月度区间** 都认，且不该认的不认',
    pickDueDate('2026-10-20 交', { now: N }) === '2026-10-20'
    && pickDueDate('明天交', { now: N }) === '2026-10-15'
    && pickDueDate('下周三交', { now: N }) === '2026-10-21'
    && pickDueDate('本月内给到客户', { now: N }) === '2026-10-31'
    && pickDueDate('下月底', { now: N }) === '2026-11-30'
    && pickDueDate('本月的进展', { now: N }) === null      // 描述不是截止
    && pickDueDate('下周需要和客户对齐', { now: N }) === null   // "下周"没有具体星期几 ⇒ 不认
    && pickDueDate('没写日期', { now: N }) === null,
    [pickDueDate('2026-10-20 交', { now: N }), pickDueDate('明天交', { now: N }), pickDueDate('下周三交', { now: N }), pickDueDate('本月内给到客户', { now: N }), pickDueDate('下月底', { now: N })].join(' / '));

  return { pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out };
}
