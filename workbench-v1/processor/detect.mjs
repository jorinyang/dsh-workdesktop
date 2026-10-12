/**
 * v1/processor/detect.mjs —— **消息意图判定与置信度**（P2-2；用户 Q2 裁定）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 用户裁定原文（2026-10-12）：
 *   「**优先自动创建**，信息完整且置信度足够高的请直接进行创建，出现少许误判我会手动修改
 *    （日程转待办/待办转日程/信息转笔记/信息转待办/信息转日程），**置信度不高则判定+给建议
 *    （标注待处置），我在浮层点确认**。」
 *
 * 需求 3.3.3 原文的判据：
 *   · "有明确的主题/时间/地点/人员/内容 ⇒ 可视为**日程**，创建日程"；
 *   · "有明确的具体事务/截止时间/发布人/执行人 ⇒ 可视为**待办**，创建待办"；
 *   · "有成体系的知识/结构/方法 ⇒ 总结概括并记录为**笔记**"。
 *
 * 本文件只做**判定**（纯函数，无副作用、不调模型）—— 执行在 `filter.mjs`（自动建）与
 *   `api/server.mjs`（人工确认）。判定与执行分开，才能单测、才能复核。
 *
 * 置信度怎么算（**把它写清楚，别让它成为一句玄学**）：
 *   `high`   = 该类判据的**必需要素齐**（日程：主题 + 明确时间表达；待办：具体事务 + 时间/@人；
 *              笔记：成体系信号 + 有实质长度），且**不与其他类同时高分**（歧义 ⇒ 降级）；
 *   `medium` = 差一项，或有第二类候选（歧义）⇒ **不自动建**，标注"待处置"交人点；
 *   `low`    = 只剩弱信号 ⇒ 只提示，不建。
 *
 * 为什么歧义要降级而不是"挑一个最高的"：两类都像的时候，**挑错比不挑更贵**
 *   —— 建错一条日程要人工去删，而标"待处置"只占你一眼。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/* ── 词表（都是可复核的显式清单，不许散在正则里）────────────────────────── */

/** 时间表达：**有实义**的时间词。单字（点/时/分/号/日/月）故意不收 ——
 *  它们会把"今天天气不错，晚上吃啥"这种闲聊也判成"有时间"（实测踩到）。 */
export const TIME_HINTS = Object.freeze([
  '今天', '明天', '后天', '大后天', '本周', '这周', '下周', '上周',
  '周一', '周二', '周三', '周四', '周五', '周六', '周日', '周天',
  '上午', '下午', '中午', '晚上', '早上', '凌晨', '点半', '点钟', '月', '日',
]);

/** 事件信号：日程要"有事由"，不是只有时间（开会/评审/沟通/约见…） */
export const EVENT_HINTS = Object.freeze([
  '会', '开会', '评审', '例会', '沟通', '对齐', '讨论', '汇报', '面谈', '拜访', '约', '约见', '上门', '出差',
  '培训', '讲课', '演示', 'demo', '分享', '面试', '答辩', '验收', '上线', '启动会', '复盘',
]);

/** 截止/交付类：待办的时间侧信号（比"日程时间"更强调 deadline） */
export const DUE_HINTS = Object.freeze([
  '截止', 'deadline', '之前', '以前', '前完成', '前给', '前发', '前交', '前提交', '前回复', '内完成', '内给',
  '今天内', '明天内', '本周内', '下周内', '月底', '月底前', '尽快', '下班前', '前搞定', '前发我', '前给我',
]);

/** 指派/事务类：待办的"具体事务"信号 */
export const TASK_HINTS = Object.freeze([
  '请', '帮我', '麻烦', '需要你', '需要我', '记得', '别忘了', '安排', '落实', '跟进', '对接', '确认一下',
  '发我', '给我', '提交', '整理', '出一版', '出一份', '准备', '约一下', '回一下', '处理一下', '看下',
]);

/** @人 / 执行人信号 */
export const ASSIGN_HINTS = Object.freeze(['@', '负责', '由你', '由我', '你来', '我来', '执行人', '发布人']);

/** 地点信号（日程用） */
export const PLACE_HINTS = Object.freeze(['会议室', '线上', '腾讯会议', '飞书会议', '钉钉会议', 'zoom', 'zoom会议', '地点', '现场', '在', '地址']);

/** 成体系知识信号（需求 3.3.3 后半句：成体系的知识/结构/方法 ⇒ 笔记） */
export const KNOWLEDGE_HINTS = Object.freeze([
  '方法论', '原则', '规律', '框架', '模型', '结构', '分层', '步骤', '流程', '方法', '要点', '总结', '归纳',
  '一是', '二是', '三是', '第一', '第二', '第三',
]);

/** 完成类词（与 close.mjs 的 DONE_HINTS 同源口径：用于"这条消息是不是在说某件事办完了"） */
export const DONE_MARKS = Object.freeze(['已完成', '完成了', '已发', '发了', '已交付', '交付了', '上传了', '已上传', '已提交', '提交了', '搞定了', '已处理', '已回复', 'done', '发你了', '发给我了', '已经发', '已给', '给你了', '办完了', '做完了']);

/**
 * **系统通知的识别**（2026-10-12 补；这一条是看了自动建出来的东西之后才加的）
 *
 * 为什么必须挡住：判定上线跑了半天，自动建了 8 条 —— 其中**三条是钉钉自己的系统通知**
 *   （额度不足提醒、"上周学习情况总结"、卡片渲染的原始结构）。
 *   这些不是"我说的话"，是平台自动发的；把它们建成笔记/待办，等于往知识库里灌噪声，
 *   而且**每一条都会重复出现**（额度提醒会反复发）。
 *   ⇒ 规矩：**系统通知整条不判**（连候选都不给），而不是"判出来再降级"。
 *
 * 辨认方式（两类，都要，缺一类会漏）：
 *   ① **固定话术**：平台通知有稳定的开头/句式，列成显式清单；
 *   ② **卡片结构**：钉钉的互动卡片会把渲染数据一起发过来 —— 正文里出现
 *      `"minSupportVersion"` / 大段 `[{"text":{…}}]` 这种，**不是人说的话**。
 */
export const SYSTEM_NOISE = Object.freeze([
  '额度不足', '额度已使用', '额度即将用完', '剩余', 'DING额度',
  '上周学习情况总结', '上周使用人数', '上周新分配', '上周新安排',
  '仅你和对方可见',
  '你的账号', '系统消息', '自动回复', '本条消息由系统',
]);

/** 这条是不是系统/卡片产生的（是 ⇒ **整条不判**） */
export function looksLikeSystemMessage(raw) {
  const t = String(raw ?? '');
  if (t.trim() === '') return true;
  if (SYSTEM_NOISE.some((h) => t.includes(h))) return true;
  // 卡片结构：正文里塞着渲染数据（JSON 片段 + 卡片的固定键名）
  if (/"minSupportVersion"|"translateMap"|"items"\s*:\s*\[\s*\{/.test(t)) return true;
  // 大段 JSON 当作"内容"：整条里 `{` 与 `"` 密度过高 ⇒ 那不是人写的句子
  const jsonish = (t.match(/[{}"]/g) ?? []).length;
  if (t.length > 0 && jsonish / t.length > 0.06) return true;
  return false;
}

/* ── 取值工具 ────────────────────────────────────────────────────────────── */

const T = (v) => String(v ?? '').trim();
const hit = (text, list) => list.filter((h) => text.includes(h));
const hasAny = (text, list) => hit(text, list).length > 0;

/** 时间片段的模式表（顺序即优先级；`g` 重编译用于扫全部） */
const TIME_PATS = Object.freeze([
  /(截止|deadline)[^\s，。；;]{0,10}/i,
  /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/,
  /(今|明|后|大后)天/,
  /(本|这|下|上)周[一二三四五六日天]?(前|之前)?/,
  /周[一二三四五六日天](前|之前)?/,
  // 时段 +（数字**或中文数字**）小时 + 点 —— 实测"下午三点"没被认出来（原来只写了 \d）
  /(上午|下午|中午|晚上|早上|凌晨)\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[点时]/,
  // 裸"三点/12点半"（必须带[点时]，否则单字"点"会误伤）
  /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[点时](半|\d{1,2}\s*分?)?/,
  /\d{1,2}\s*月\s*\d{1,2}\s*[日号]/,
]);

/**
 * 抓**全部**时间片段（只用于**证据展示**，精确解析归各采集器）。
 * ★ 为什么要"全部"：日程时间与截止可能**同时**出现在一句里
 *   （"明天下午三点开会，麻烦你周五前把单子发我"）——只取第一处会把截止漏掉，
 *   于是待办判不出来（实测踩到）。
 */
export function extractAllTimePhrases(text) {
  const t = T(text);
  const found = [];
  for (const p of TIME_PATS) {
    const g = new RegExp(p.source, 'g');
    let m;
    while ((m = g.exec(t)) !== null) { if (!found.includes(m[0])) found.push(m[0]); }
  }
  return found;
}

/** 抓一个"最像"的时间片段（第一条命中的） */
export function extractTimePhrase(text) {
  const all = extractAllTimePhrases(text);
  return all.length ? all[0] : null;
}

/** 这个时间片段是**截止式**的吗（"周五前/月底前/之前"）—— 截止式 ⇒ 待办信号，不是日程时间 */
export function isDuePhrase(phrase) {
  return phrase !== null && phrase !== undefined && /前\s*$/.test(String(phrase).trim());
}

/* ── 把"时间表达"落成具体日期 ──────────────────────────────────────────────
 * ★ 为什么必须有这一步（实测踩到的真错）：
 *   日程的契约**要求 `start`/`end` 是具体时间**（`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`），
 *   第一版自动建时传了 `null` ⇒ `makeEvent` 直接判非法、**建了个空**，而外层还以为"建过了"。
 *   这是最坏的形态：看起来自动建了，库里什么都没有。
 *   ⇒ 规矩：**能定出具体日期才自动建；定不出 ⇒ 不建，标"待处置"交人点**（猜日期比不建更糟）。
 * 说明：这里只处理**相对日期**（今天/明天/后天/大后天）与大写时刻（"下午三点"），
 *   因为它们是"相对创建那一刻"唯一能算准的；"下周三/月底"这类**故意不算**（不确定就交人）。
 * ───────────────────────────────────────────────────────────────────────── */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const num = (s) => { const t = String(s); if (/^\d+$/.test(t)) return Number(t); return CN_NUM[t] ?? null; };
const ymdOf = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

/** 从一条消息里解出日程的 start/end（解不出返回 null —— **不猜**） */
export function deriveScheduleWindow(raw, { now = Date.now() } = {}) {
  const t = T(raw);
  const phrases = extractAllTimePhrases(t);
  let dayMs = null;
  if (/(大后天)/.test(t)) dayMs = now + 3 * 86400000;
  else if (/后天/.test(t)) dayMs = now + 2 * 86400000;
  else if (/明天/.test(t)) dayMs = now + 86400000;
  else if (/今天|今晚/.test(t)) dayMs = now;
  const explicit = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/.exec(t);
  if (explicit) {
    const m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(explicit[0]);
    if (m) dayMs = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
  }
  if (dayMs === null) return { ok: false, why: `没有能算成具体日期的相对日期（片段：${phrases.join('/') || '无'}）⇒ 不猜，交人点`, phrases };

  // 时刻（可选）：优先"时段 + 数字/中文数字 + 点时"
  let hh = null; let mm = 0;
  const tp = /(上午|下午|中午|晚上|早上|凌晨)\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[点时](半|\d{1,2}\s*分?)?/.exec(t);
  const tp2 = tp ?? /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[点时](半|\d{1,2}\s*分?)?/.exec(t);
  if (tp2) {
    hh = num(tp2[2]);
    if (hh !== null) {
      const seg = tp ? tp[1] : '';
      if ((seg === '下午' || seg === '晚上') && hh < 12) hh += 12;
      if (seg === '中午' && hh < 12) hh += 12;
      if (hh >= 24) hh = null;
    }
    if (tp2[3] === '半') mm = 30;
    else if (tp2[3]) { const g = /(\d{1,2})/.exec(tp2[3]); if (g) mm = Number(g[1]); }
  }
  const d = new Date(dayMs);
  if (hh !== null) d.setHours(hh, mm, 0, 0); else d.setHours(9, 0, 0, 0);
  const start = `${ymdOf(dayMs)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const e = new Date(d.getTime() + 3600000);                       // 默认一小时
  const end = `${ymdOf(e.getTime())}T${String(e.getHours()).padStart(2, '0')}:${String(e.getMinutes()).padStart(2, '0')}`;
  return { ok: true, start, end, day: ymdOf(dayMs), hh, mm, phrases, guessedEnd: true };
}

/**
 * 判定一条消息可以变成什么。
 * @returns {{candidates:Array<{kind:'schedule'|'todo'|'note', confidence:'high'|'medium'|'low', why:string, evidence:object}>,
 *            auto:Array, pending:Array, summary:string}}
 */
export function detectFromMessage(evt) {
  const raw = T(evt?.payload?.raw ?? evt?.payload?.summary ?? '');
  const out = [];
  if (raw === '') return { candidates: [], auto: [], pending: [], summary: '空消息，无从判定' };
  // ★ 系统通知/卡片结构 ⇒ **整条不判**（连候选项都不给）。
  //   理由见 `SYSTEM_NOISE` 上面的注释：这类东西不是"我说的话"，建成事件只会灌噪声，且会反复出现。
  if (looksLikeSystemMessage(raw)) {
    return { candidates: [], auto: [], pending: [], summary: `系统通知/卡片结构 ⇒ 不判定（${SYSTEM_NOISE.find((h) => raw.includes(h)) ?? '含大量卡片字段'}）`, system: true };
  }

  const timeHit = hit(raw, TIME_HINTS);
  const timePhrases = extractAllTimePhrases(raw);
  const timePhrase = timePhrases.length ? timePhrases[0] : null;
  const duePhrases = timePhrases.filter(isDuePhrase);          // ★ 全部截止式子句（不止第一处）
  const dueHit = hit(raw, DUE_HINTS);
  // ★ 截止式时间表达（"周五前""月底前"）本身**就是**待办的截止信号 ——
  //   词表里没有裸"周五"，实测导致"麻烦你周五前把验收单发我"的 dueHit 为空、待办掉成 medium。
  //   **要扫全部时间片段**：一句里可能先出现日程时间（"明天下午三点开会"）、后出现截止（"周五前发我"），
  //   只取第一处会把截止漏掉（实测：歧义用例因此判不出两类都强）。
  for (const p of duePhrases) if (!dueHit.includes(p)) dueHit.push(p);
  const taskHit = hit(raw, TASK_HINTS);
  const assignHit = hit(raw, ASSIGN_HINTS);
  const placeHit = hit(raw, PLACE_HINTS);
  const knowHit = hit(raw, KNOWLEDGE_HINTS);

  /* ── ① 日程：明确主题 + 时间（地点/人员是加分项，不是必需）──────────────
      ★ 截止式时间（"周五前/月底前"）**不算日程的时间** —— 它说的是"在那之前做完"，
        不是"那个时刻要碰面"。实测踩到：不加这条，`麻烦你周五前把验收单发我` 会同时被判成
        日程与待办 ⇒ 白触发歧义降级（两条都掉 medium，人多点一次）。 */
  {
    const scheduleTime = isDuePhrase(timePhrase) ? null : (timePhrase ?? (timeHit.length > 0 ? timeHit[0] : null));
    const sigCount0 = (hit(raw, EVENT_HINTS).length > 0 ? 1 : 0) + (placeHit.length > 0 ? 1 : 0) + (assignHit.length > 0 ? 1 : 0);
    // 只有时间、连一点事由都没有（无事件/地点/人员）⇒ 不给候选。
    //   实测："今天天气不错，**晚上**吃啥"里的"晚上"会命中时间词 ⇒ 必须靠"无事由"这一条挡住。
    if (scheduleTime !== null && sigCount0 > 0) {
        const eventSig = hit(raw, EVENT_HINTS).length;
        const placeSig = placeHit.length > 0;
        const personSig = assignHit.length > 0;
        // ★ 日程要"有事由"：只有时间没有事件/地点/人 ⇒ 不给 high。
        //   实测踩到：单字时间词会让"今天天气不错""这周五"这种也被判成高置信日程 —— 那就是乱建。
        const sigCount = (eventSig > 0 ? 1 : 0) + (placeSig ? 1 : 0) + (personSig ? 1 : 0);
        const conf = sigCount >= 2 ? 'high' : (sigCount === 1 ? 'medium' : 'low');
        const sigWhy = [eventSig ? '事件「' + hit(raw, EVENT_HINTS)[0] + '」' : '', placeSig ? '地点「' + placeHit[0] + '」' : '', personSig ? '人员「' + assignHit[0] + '」' : ''].filter(Boolean).join(' + ');
        out.push({
          kind: 'schedule', confidence: conf,
          why: `含时间表达「${scheduleTime}」${sigWhy ? ' + ' + sigWhy : ''} ⇒ ${conf === 'high' ? '像日程' : conf === 'medium' ? '可能是日程，交你判' : '只有时间、没有事由，不建'}（需求 3.3.3）`,
          evidence: { timePhrase: scheduleTime, timeHit, placeHit, eventSig, sigCount },
        });
      }
  }

  /* ── ② 待办：**具体事务**（必须命中任务词，不是"@人"就算）+ 截止/指派 ⇒ 高置信 ──
     实测修正：原来把"assignHit 也算事务"，于是"明天下午…你也来"里的"你来"被当成待办事务，
     与日程同时高分 ⇒ 白白触发歧义降级。人员信号是**加分项**，不能单独充当"具体事务"。 */
  {
    const hasTask = taskHit.length > 0;
    const hasDue = dueHit.length > 0;
    if (hasTask && (hasDue || assignHit.length > 0)) {
      const conf = (taskHit.length > 0 && hasDue) ? 'high' : 'medium';
      out.push({
        kind: 'todo', confidence: conf,
        why: `含事务信号「${(taskHit[0] ?? assignHit[0])}」${hasDue ? ' + 截止信号「' + dueHit[0] + '」' : ' + 指派'} ⇒ 像待办（需求 3.3.3）`,
        evidence: { taskHit, dueHit, assignHit },
      });
    } else if (hasDue && raw.length >= 10) {
      out.push({
        kind: 'todo', confidence: 'medium',
        why: `含截止信号「${dueHit[0]}」但没抓到明确事务词 ⇒ 可能是待办，交你判`,
        evidence: { dueHit, taskHit },
      });
    }
  }

  /* ── ③ 笔记：成体系的知识/结构/方法（需求 3.3.3 后半句）─────────────── */
  {
    if (knowHit.length >= 2 || (knowHit.length >= 1 && raw.length >= 60)) {
      out.push({
        kind: 'note', confidence: raw.length >= 80 ? 'high' : 'medium',
        why: `含成体系信号「${knowHit.slice(0, 3).join('、')}」且长度 ${raw.length} 字 ⇒ 像可沉淀的笔记`,
        evidence: { knowHit, length: raw.length },
      });
    }
  }

  // 已处理信号：这条是在说"某件事办完了" ⇒ 更像证据，不像新任务（降级全部候选）
  const done = hasAny(raw, DONE_MARKS);
  if (done) for (const c of out) { c.confidence = c.confidence === 'high' ? 'medium' : 'low'; c.why += '（含完成类词，可能是**办完的证据**而不是新任务 ⇒ 降级）'; }

  // ★ 歧义降级：两类都到 high ⇒ 都降为 medium（挑错比不挑更贵）
  const highs = out.filter((c) => c.confidence === 'high');
  if (highs.length > 1) for (const c of highs) { c.confidence = 'medium'; c.why += '（同时有两类高分 ⇒ 歧义降级，交你点）'; }

  const auto = out.filter((c) => c.confidence === 'high');
  const pending = out.filter((c) => c.confidence === 'medium');
  const summary = out.length === 0 ? '没有可转换的判据命中' : out.map((c) => `${c.kind}:${c.confidence}`).join(' · ');
  return { candidates: out, auto, pending, summary, marks: { timeHit, dueHit, taskHit, assignHit, placeHit, knowHit, done } };
}

/* ── 执行侧：把判定结果落成事件（幂等；用 `_detect` 记账，不另建真相源）────── */

/**
 * 对**一条消息**执行判定与自动创建（用户 Q2：高置信直接建、低置信标待处置）。
 *
 * 幂等怎么做（这一条最要紧，否则每 5 分钟一轮会建一堆重复事件）：
 *   · 判定结果写在消息事件的 **`_detect`** 字段上（`{at, candidates, auto, pending, created}`）；
 *   · **已经判过**（`_detect.created` 是数组）⇒ 直接返回 `skipped`，**不再判、不再建**；
 *   · 于是"同一句被反复判"这条最贵的错（库里长出一堆重复日程）在入口就被挡住。
 *
 * @returns {{id,action:'auto'|'pending'|'none'|'skipped',created:Array,pending:Array}}
 */
export function autoCreateFromMessage(evt, { store, schema, dryRun = false, now = Date.now() } = {}) {
  if (!evt || evt.type !== 'message') return { id: evt?._id ?? null, action: 'none', created: [], pending: [] };
  if (evt._detect && Array.isArray(evt._detect.created)) {
    return { id: evt._id, action: 'skipped', created: evt._detect.created, pending: evt._detect.pending ?? [] };
  }
  const r = detectFromMessage(evt);
  const created = [];
  const unbuildable = [];                    // 判出来了但"定不出必要字段"⇒ 转成待处置（不假装建过）
  if (!dryRun) {
    for (const c of r.auto) {
      let payload = null;
      if (c.kind === 'schedule') {
        const w = deriveScheduleWindow(String(evt.payload.raw ?? ''), { now });
        if (w.ok !== true) { unbuildable.push({ ...c, why: c.why + '｜' + w.why }); continue; }
        payload = { topic: String(evt.payload.raw).slice(0, 80), detail: String(evt.payload.raw), start: w.start, end: w.end, place: null, participants: [] };
      } else if (c.kind === 'todo') {
        payload = { topic: String(evt.payload.raw).slice(0, 80), detail: String(evt.payload.raw), due: null, publisher: evt.payload.sender ?? null, executor: '我' };
      } else {
        // ★ 笔记的**最低内容门槛**（2026-10-12 补，实测）：判定上线后自动建了 5 条笔记，
        //   翻出来看有几条是"一周学习情况总结""额度提醒"这类**短的系统播报** ——
        //   它们不是知识。规矩：**太短的不自动建成笔记**，改标"待处置"交人看。
        const body = String(evt.payload.raw ?? '').trim();
        if (body.length < 40) { unbuildable.push({ ...c, why: c.why + `｜内容只有 ${body.length} 字，太短，不自动建笔记（交你判）` }); continue; }
        payload = { topic: body.slice(0, 80), date: ymdOf(now), content_md: `来源：${evt.payload?.channel ?? evt.origin?.channel ?? '-'} · ${evt.payload?.sender ?? '-'}\n\n${body}`, tags: ['消息沉淀'] };
      }
      const made = schema.makeEvent({
        type: c.kind, payload,
        origin: { channel: evt.origin?.channel ?? 'manual', sender: evt.payload?.sender ?? null, messageId: `auto-${evt._id}-${c.kind}`, raw: evt.payload?.raw ?? null },
        _at: evt._at ?? now,
      });
      // ★ 契约拒了必须**报出来**，不能静默（第一版就是把非法载荷静默丢掉，看起来像"建过了"）
      if (made.ok === false) { unbuildable.push({ ...c, why: c.why + '｜契约拒绝：' + (made.errors ?? []).join('；') }); continue; }
      const up = store.upsert(made.event);
      if (up.action === 'rejected') { unbuildable.push({ ...c, why: c.why + '｜落库被拒：' + (up.reason ?? '') }); continue; }
      created.push({ kind: c.kind, id: made.event._id, action: up.action, why: c.why });
    }
    const pending = [...r.pending, ...unbuildable];
    // ★ 补丁结果**必须收**：`_detect` 是幂等的唯一依据，写不进去就会"每轮重复自动建"。
    //   实测踩到过：`store.patch` 有字段白名单，`_detect` 当时不在名单里 ⇒ 静默被拒 ⇒ 重复建。
    const pr = store.patch('message', evt._id, {
      _detect: { at: new Date(now).toISOString(), candidates: r.candidates, auto: r.auto, pending, created, summary: r.summary },
    }, { op: created.length ? 'auto-created' : 'detected', by: 'detect', evidence: { created: created.map((x) => x.id), pending: pending.map((x) => x.kind) } });
    if (pr && pr.ok === false) {
      // 写不进账 ⇒ **不让调用方以为已经判过**（否则下一轮还会重复建）
      return { id: evt._id, action: 'error', created, pending, candidates: r.candidates, summary: r.summary, why: `判定记账写入被拒：${pr.why}` };
    }
    return {
      id: evt._id,
      action: created.length > 0 ? 'auto' : (pending.length > 0 ? 'pending' : 'none'),
      created, pending, candidates: r.candidates, summary: r.summary,
    };
  }
  return {
    id: evt._id,
    action: r.auto.length > 0 ? 'auto' : (r.pending.length > 0 ? 'pending' : 'none'),
    created, pending: r.pending, candidates: r.candidates, summary: r.summary,
  };
}

/** 跑一轮：对所有"还没判过"的消息执行判定与自动创建（幂等） */
export function detectOnce({ store, schema, dryRun = false, limit = 100, now = Date.now() } = {}) {
  const rows = store.list({ type: 'message' }).filter((e) => !(e._detect && Array.isArray(e._detect.created))).slice(0, limit);
  const results = rows.map((e) => autoCreateFromMessage(e, { store, schema, dryRun, now }));
  return {
    inCount: rows.length,
    auto: results.filter((r) => r.action === 'auto').length,
    pending: results.filter((r) => r.action === 'pending').length,
    none: results.filter((r) => r.action === 'none').length,
    created: results.reduce((n, r) => n + r.created.length, 0),
    results,
  };
}

/* ── 自检（用真实 store/schema，但落在临时运行态；不出网、不调模型）────────── */

/** 自检里需要 store/schema/fs/os/path —— 与 run.mjs 的调用方**同源**，不另造一份假 store */
let fsx = null; let osx = null; let pathx = null; let store = null; let schema = null;
export async function _loadDeps() {
  if (store) return;
  fsx = await import('node:fs'); osx = await import('node:os'); pathx = await import('node:path');
  store = await import('../store.mjs'); schema = await import('../schema.mjs');
}

export async function selfTest() {
  await _loadDeps();
  const fs = fsx; const os = osx; const path = pathx;
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const msg = (raw) => ({ type: 'message', _id: 'msg_x', payload: { raw, sender: '张伟', channel: 'dingtalk', source: 'im' }, origin: { channel: 'dingtalk', sender: '张伟' } });
  const kinds = (r) => r.candidates.map((c) => `${c.kind}:${c.confidence}`).join(',');

  // ① 日程：主题 + 明确时间 + 地点 ⇒ 高置信自动建
  const r1 = detectFromMessage(msg('明天下午 3 点在会议室开项目评审会，你也来'));
  chk('DET-1', '★ 日程：明确时间 + 地点 ⇒ high（可直接自动建）', r1.auto.some((c) => c.kind === 'schedule') && r1.auto.length === 1, kinds(r1));
  chk('DET-2', '判据写清了抓到的那个时间片段（可复核）', String(r1.candidates[0].why).includes('明天'), r1.candidates[0].why);

  // ② 待办：具体事务 + 截止 ⇒ 高置信
  const r2 = detectFromMessage(msg('麻烦你周五前把验收单发我，我来提交'));
  chk('DET-3', '★ 待办：事务 + 截止 ⇒ high', r2.auto.some((c) => c.kind === 'todo'), kinds(r2));
  chk('DET-4', '待办判据里有明确的截止信号', r2.candidates.find((c) => c.kind === 'todo')?.evidence.dueHit.length > 0, JSON.stringify(r2.candidates.find((c) => c.kind === 'todo')?.evidence));

  // ③ 笔记：成体系信号 + 长度 ⇒ 可沉淀
  const r3 = detectFromMessage(msg('我把采集器的设计原则归纳了一下：第一是多通道，第二是幂等，第三是模态不变。这个方法论后面可以复用到别的系统上，结构上分三层，每层各管一段。'));
  chk('DET-5', '★ 笔记：成体系信号 + 有实质长度 ⇒ 候选', r3.candidates.some((c) => c.kind === 'note'), kinds(r3));

  // ④ ★ 歧义降级：同一句里两类都高分 ⇒ 都降 medium（不许自作主张挑一个）
  const r4 = detectFromMessage(msg('明天下午三点在会议室开评审会，麻烦你周五前把验收单发我'));
  chk('DET-6', '★ 两类同时高分 ⇒ 都降为 medium（歧义交人点，不自动建）', r4.auto.length === 0 && r4.pending.length >= 2, kinds(r4));
  chk('DET-7', '降级理由写明"歧义降级"（不是静默降级）', r4.pending.some((c) => String(c.why).includes('歧义降级')), JSON.stringify(r4.pending.map((c) => c.why)));

  // ⑤ ★ 完成类词降级：这条在说"办完了" ⇒ 更像证据，不当新任务
  const r5 = detectFromMessage(msg('验收单已经发你了，明天下午的会照常'));
  chk('DET-8', '★ 含完成类词 ⇒ 候选降级（它更像完成证据，不是新任务）', r5.auto.length === 0, kinds(r5));
  chk('DET-9', '降级理由写明是"完成类词"', r5.candidates.some((c) => String(c.why).includes('办完的证据')), JSON.stringify(r5.candidates.map((c) => c.why)));

  // ⑥ 负向：普通闲聊 ⇒ 什么都不建（这是最容易犯的错：什么都想建）
  const r6 = detectFromMessage(msg('今天天气不错，晚上吃啥'));
  chk('DET-10', '★ 负向对照：普通闲聊 ⇒ 一个候选都没有（不硬套）', r6.candidates.length === 0 && r6.auto.length === 0, kinds(r6) + ' :: ' + r6.summary);
  const r7 = detectFromMessage(msg('收到'));
  chk('DET-11', '★ 负向对照：短确认语 ⇒ 不建', r7.candidates.length === 0, kinds(r7));
  const r8 = detectFromMessage({ type: 'message', payload: { raw: '   ' } });
  chk('DET-12', '空消息 ⇒ 不判定且不炸', r8.candidates.length === 0 && r8.summary.includes('空消息'));

  // ⑦ 只有时间、没有别的 ⇒ 不当高置信日程（宁可问一句）
  const r9 = detectFromMessage(msg('这周五'));
  chk('DET-13', '★ 只有时间、没有事由 ⇒ **不**给 high（宁可问一句也不乱建）', !r9.auto.some((c) => c.kind === 'schedule'), kinds(r9));

  // ⑧ 时间片段抽取（用于证据展示）
  chk('DET-14', '时间片段抽取：日期/时刻/周几都认', extractTimePhrase('2026-10-20 交') === '2026-10-20' && extractTimePhrase('周三给你') === '周三' && extractTimePhrase('下午三点') !== null, [extractTimePhrase('2026-10-20 交'), extractTimePhrase('周三给你'), extractTimePhrase('下午三点')].join(' | '));
  chk('DET-15', '负向：没有时间表达 ⇒ 抽不出来（不编）', extractTimePhrase('这事你看着办') === null, String(extractTimePhrase('这事你看着办')));

  // ⑨ ★ 执行侧：高置信自动建 + **幂等**（这一条最贵：判重了库里会长出一堆重复日程）
  {
    const prev = process.env.WB_V1_OUT;
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-detect-'));
    process.env.WB_V1_OUT = tmp2;
    try {
      const st = store; const sc = schema;
      st.upsert(sc.makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw: '明天下午三点在会议室开项目评审会，你也来', source: 'im', modality: 'text', summary: '开项目评审会' }, origin: { channel: 'dingtalk', sender: '张伟', messageId: 'm-auto-1' }, _at: Date.now() }).event);
      const m1 = st.list({ type: 'message' })[0];
      const a1 = autoCreateFromMessage(m1, { store: st, schema: sc });
      chk('DET-16', '★ 高置信 ⇒ 真的自动建了日程（用户 Q2：优先自动创建）', a1.action === 'auto' && a1.created.some((c) => c.kind === 'schedule') && st.list({ type: 'schedule' }).length === 1, JSON.stringify(a1.created));
      const a2 = autoCreateFromMessage(st.getById('message', m1._id), { store: st, schema: sc });
      chk('DET-17', '★★ 幂等：再判一次不重复建（否则每 5 分钟轮一次就长一堆重复）', a2.action === 'skipped' && st.list({ type: 'schedule' }).length === 1, JSON.stringify({ action: a2.action, schedules: st.list({ type: 'schedule' }).length }));
      chk('DET-18', '自动建留下留痕（auto-created + 目标 id）', (st.getById('message', m1._id).ops ?? []).some((o) => o.op === 'auto-created' && Array.isArray(o.evidence?.created)), JSON.stringify(st.getById('message', m1._id).ops));
      chk('DET-19', '判定结果落在消息上（_detect 含 candidates/auto/pending，可复核）', (() => { const e = st.getById('message', m1._id); return e._detect && Array.isArray(e._detect.candidates) && Array.isArray(e._detect.created); })());

      // 低置信 ⇒ 不建，只标"待处置"
      st.upsert(sc.makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw: '这周五', source: 'im', modality: 'text', summary: '这周五' }, origin: { channel: 'dingtalk', sender: '张伟', messageId: 'm-pend-1' }, _at: Date.now() }).event);
      const m2 = st.list({ type: 'message' }).find((e) => e.origin.messageId === 'm-pend-1');
      const b1 = autoCreateFromMessage(m2, { store: st, schema: sc });
      chk('DET-20', '★ 判据不足 ⇒ **不建**（宁可问一句），且不报成 auto', b1.action === 'none' && b1.created.length === 0 && st.list({ type: 'schedule' }).length === 1, JSON.stringify({ action: b1.action, summary: b1.summary }));
      const b2 = autoCreateFromMessage(st.getById('message', m2._id), { store: st, schema: sc });
      chk('DET-21', '判定过的消息会被跳过（幂等对"没建"的也一样）', b2.action === 'skipped');

      // ⑩ ★ 系统通知与短播报**不许**被建成事件（2026-10-12 看了自动建出来的东西之后加的）
      const sysCases = [
        ['短信/电话DING额度不足 截止2026-10-12，[某学院]的短信DING额度已使用892条，剩余108条', '额度提醒'],
        ['* 仅你和对方可见 [{"text":{"minSupportVersion":"1.1","translateMap":{},"version":"1.2","items":[{"text":"x"}]}}]', '卡片结构'],
        ['[金牌团队]:上周学习情况总结 企业名称：某某科技 上周使用人数：0人，比上一周持平', '周报播报'],
      ];
      let sysOk = true; const sysDetail = [];
      for (const [raw, label] of sysCases) {
        const d = detectFromMessage({ type: 'message', payload: { raw }, origin: {} });
        if (d.candidates.length !== 0) { sysOk = false; sysDetail.push(label + ' 仍判出 ' + d.candidates.length + ' 项'); }
      }
      chk('DET-22', '★★ 系统通知/卡片结构 ⇒ 整条不判（额度提醒、卡片 JSON、周报播报）', sysOk, sysDetail.join('；') || '三类都不判');

      // 短播报：即使被当成"笔记候选"，也**不自动建**（内容太短）
      const shortRaw = '上周学习情况总结：使用人数 0 人，新分配学习计划 0 个，新安排考试 0 个，新上传课程 0 门。';
      const madeShort = sc.makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '系统', raw: shortRaw, source: 'im', modality: 'text', summary: shortRaw.slice(0, 40) }, origin: { channel: 'dingtalk', sender: '系统', messageId: 'm-short-1' }, _at: Date.now() });
      st.upsert(madeShort.event);
      const mShort = st.list({ type: 'message' }).find((e) => e.origin.messageId === 'm-short-1');
      const rShort = autoCreateFromMessage(mShort, { store: st, schema: sc });
      chk('DET-23', '★ 太短的播报不自动建成笔记（改标"待处置"交人看）', rShort.created.length === 0, JSON.stringify({ action: rShort.action, created: rShort.created.length, summary: rShort.summary }));

      // ★ 负向对照的另一半：**不能因为加了闸就把正常内容也挡了**
      //   ① 只是"长"不够 —— 需求原文要的是"成体系的知识/结构/方法"，
      //      一段抒发想法的长消息**不该**被自动建成笔记（这半条是我先写错预期、后来按需求原文改回来的）；
      const longTalk = '呃我刚才有的一个疑问是这样的，就现在我给这些场景去做辅导的时候，我统一告诉他们需要提交的内容就是有一个是他场景的一个说明文档，然后需要做一个海报，呃需要有一个视频去讲解他的这个产品';
      const madeTalk = sc.makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '某人', raw: longTalk, source: 'im', modality: 'text', summary: longTalk.slice(0, 40) }, origin: { channel: 'dingtalk', sender: '某人', messageId: 'm-talk-1' }, _at: Date.now() });
      st.upsert(madeTalk.event);
      const mTalk = st.list({ type: 'message' }).find((e) => e.origin.messageId === 'm-talk-1');
      const rTalk = autoCreateFromMessage(mTalk, { store: st, schema: sc });
      chk('DET-24', '★ 只是"长"不够：抒发想法的长消息不自动建笔记（需求要的是"成体系的知识/结构/方法"）', rTalk.created.length === 0, JSON.stringify({ action: rTalk.action, summary: rTalk.summary }));
      //   ② 但**真的成体系的**内容必须照常建（闸门不能把正事挡了）
      const realKnow = '我把采集器的设计原则归纳了一下：第一是多通道，第二是幂等，第三是模态不变。这个方法论的要点是：结构上分三层，每层各管一段，步骤上先探形状再认种类最后翻页。后面可以复用到别的系统上。';
      const madeReal = sc.makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '某人', raw: realKnow, source: 'im', modality: 'text', summary: realKnow.slice(0, 40) }, origin: { channel: 'dingtalk', sender: '某人', messageId: 'm-real-1' }, _at: Date.now() });
      st.upsert(madeReal.event);
      const mReal = st.list({ type: 'message' }).find((e) => e.origin.messageId === 'm-real-1');
      const rReal = autoCreateFromMessage(mReal, { store: st, schema: sc });
      chk('DET-25', '★ 成体系的内容仍然照常建（闸门只挡噪声，不挡正事）', rReal.created.length >= 1 && rReal.created.some((x) => x.kind === 'note'), JSON.stringify({ action: rReal.action, created: rReal.created }));
    } finally {
      if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
      try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}

