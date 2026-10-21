/**
 * v1/processor/analyze.mjs —— **分析引擎**（P3；需求 3.2 逐条落地）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求原文的四条口径（照抄，别改）
 *   3.2.1 消息：检索 + 召回相关向量 → 结构化内容 + 原始信息 + 相关上下文 → 交给前端（**不调模型**）
 *   3.2.2 笔记：检索 + 召回 → **综合分析、给出分析与建议** → 若适合可视化则调工具构建 → 整合给前端
 *   3.2.3 待办：**只把结构化内容交给前端**，交人工执行（**不调模型**）
 *   3.2.4 日程：检索 + 召回 → 结构化内容 + 相关上下文 → 交给前端
 *   ⇒ 成本口径（Q9）：四类里只有**笔记**在创建时调模型；消息/日程只召回，待办直通。
 *
 * ★★ 2026-10-14 用户补一条（**覆盖 3.2.3 里"待办不召回"那半句**）：
 *   原话：「所有信息/待办/日程/笔记**在流入到工作台的时候做一次相关上下文的获取和分析**，
 *          在转日程/转笔记/转待办相互转换的时候**按照之前已经有的上下文**。
 *          消息列表的消息/待办列表的待办/日程列表的日程和笔记列表的笔记在执行操作转换/完成标记的时候
 *          **也不再重复获取上下文**。」
 *   ⇒ 待办**也要取一次上下文**（四类一致）。为什么这次可以改：
 *     · 3.2.3 那半句的本意是"**别为待办花模型钱**"（成本口径 Q9）—— 这一条**仍然守**：
 *       待办照旧**不调模型**，只召回；
 *     · 而"待办不召回"这半句与用户这一轮的要求直接冲突 —— 待办详情要显示相关上下文、
 *       待办转日程/转笔记要用上下文里的字段，没有材料就都做不成。
 *   ⇒ 结论：**待办 = 与消息/日程同一档（只召回、不调模型）**；"直通人工执行"的语义不变。
 *
 * 三条纪律
 *   ① **召回失败 ≠ 没有上下文**：召回层返回 `ok:false` 时，`context.recallError` 写明原因，
 *      绝不写成"知识库里没有相关材料"（那会让人以为检索过了）。
 *   ② **模型失败就不产出分析**：`analysis` 留空 + 记 `error`，下轮重试；**不编一段看起来像分析的文本**。
 *   ③ **可视化只给"建议"不给结论**：判断由规则给出 `suggested` + `why`，真正构建由前端按钮触发
 *      （需求 3.2.2 说"如果适合则调用工具构建" —— 调用动作归 P4/P5，引擎只负责判断与建议）。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from 'node:child_process';
// ★ 2026-10-14 加：`runModelViaFile` 要写临时文件（提示词不进命令行）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';   // pathToFileURL：入口判据要比对（不能只判文件名后缀）；fileURLToPath：自检要读自己
import { Worker } from 'node:worker_threads';   // ★ 2026-10-14：请求路径上不再同步调模型（见 runModelInWorker）
import { runEngine } from '../ledger.mjs';
import * as store from '../store.mjs';

const PS = 'powershell.exe';

/**
 * 推理通道：百炼 CLI（本机既有通道，已验证可用）。
 *
 * ★★ 2026-10-15 换模型（用户原话：「驾驶舱每日生成任务使用 deepseek-flash」）。
 *
 *   原来是 `bl text chat --message`，**不带 `--model`** ⇒ 走 `bl` 的默认（`qwen3.8-max`）。
 *
 *   为什么要换：驾驶舱的每块叙述提示词**约 3625 字**，而实测（见 `api/cockpit.mjs` 那段注释）
 *   **300 秒都拿不回来**（`spawnSync powershell.exe ETIMEDOUT`）⇒ 每日任务以非零退出。
 *   现在把模型**显式钉下来**、并选一个快的。
 *
 *   ⚠️ 模型 id 是**核实过的**，不是按名字猜的：
 *     实测 `bl text chat --model deepseek-flash` 回
 *       `The model deepseek-flash does not exist or you do not have access to it`（HTTP 404）
 *     —— 正确的 id 是 **`deepseek-v4.1-flash`**（`bl model search --keyword deepseek` 查到，
 *     provider=deepseek · 上下文 1,000,000 · 输出上限 393,216 · 支持 function-calling 与结构化输出）。
 *     实测能调通。
 *
 *   ⚠️ 为什么做成**环境变量可覆盖**而不是写死：
 *     模型是**会过时**的东西（这里的默认模型已经换过几轮），而写死意味着"哪天它下线了，
 *     要改代码才能换"。`WB_V1_MODEL` 让换模型是改配置，不是改代码。
 *     默认值取 deepseek-flash —— 用户这一轮指定的那个。
 */
export const DEFAULT_MODEL_ID = process.env.WB_V1_MODEL || 'deepseek-v4.1-flash';
/**
 * ⚠️ **这是模型选择的唯一一处** —— 两个调用点（`runModel` 的 `--message` 与
 *   `runModelViaFile` 的 `--messages-file`）都从它取，**不许各自再写一遍 `bl text chat`**。
 *
 *   为什么单独记这一笔：原来两条路各自写死了 `bl text chat`，而 `DEFAULT_MODEL_CMD`
 *   虽然导出了却**没有任何调用点用它** ⇒ 改这个常量等于没改（我第一版就踩了：
 *   改完常量、驾驶舱那条路仍走默认模型，因为它读的是自己那一行）。
 *   ⇒ 拆成"模型段 + 基命令"，两个调用点拼 `MODEL_FLAG`，**只此一处**。
 */
export const MODEL_FLAG = `bl text chat --model ${DEFAULT_MODEL_ID}`;
export const DEFAULT_MODEL_CMD = `${MODEL_FLAG} --message`;

/** 真跑模型（经 powershell 调 bl；失败如实返回，不编内容） */
/**
 * 调模型。
 *
 * ⚠️ **多行提示词不要走这条路**（2026-10-14 真机实测抓到的）：
 *   这里是 `bl text chat --message '<整段提示词>'` —— 整段提示词**塞在命令行里**。
 *   短提示词没事（恰恰是单行），但**多行提示词会被拆成多个参数**，`bl` 当场报错：
 *     `Error: Unexpected argument: +` / `Unexpected argument: /`
 *   表现是"模型没产出"，**看不出是命令行拆参数**，很容易被当成模型的问题。
 *   ⇒ 多行提示词用 `runModelViaFile()`（走 `--messages-file`，不经过命令行）。
 */
export function runModel(prompt, { timeoutMs = 180000 } = {}) {
  const q = String(prompt).replace(/'/g, "''");
  const cmd = `${MODEL_FLAG} --message '${q}'`;   // ★ 2026-10-15：模型从这一处取，别在这里另写
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `模型返回非 0（exit=${r.status}）：${(err || out).slice(0, 200)}` };
  if (out === '') return { ok: false, why: '模型无输出' };
  return { ok: true, text: out };
}

/**
 * 调模型 —— **提示词写文件，走 `--messages-file`**（2026-10-14 加）。
 *
 * 为什么不复用 `runModel`：那条把整段提示词塞进命令行，而 `bl text chat` 官方支持
 *   `--messages-file <path>`。多行提示词在命令行里会被拆成多个参数，
 *   `bl` 直接报 `Unexpected argument: +` / `Unexpected argument: /`，
 *   而**报出来的样子像模型故障**（真机实测：驾驶舱五块全部"失败"，
 *   实际是提示词里的加号、斜杠、星号被当成了独立参数）。
 *
 * 做法：
 *   一、把提示词写成临时 JSON（**用 `node:fs` 写，不经 shell**）；
 *   二、命令就一句 `bl text chat --messages-file '<路径>'` —— 命令行里只有路径，没有正文；
 *   三、跑完把临时文件删掉（`finally`，成功失败都删）。
 *
 * ⚠️ **文件内容必须是一个数组** `[{role,content}]`，不是 `{messages:[…]}`。
 *   第一版写成了后者，`bl` 报 `Error: i is not iterable`（它在迭代那个数组）
 *   —— 报错同样看不出是格式问题。**实测出来的格式，不是照文档猜的。**
 *
 * ⚠️ 临时文件写在 `os.tmpdir()`，**不写知识库**（那是一次性输入，不是产物）。
 */
/**
 * 调模型 —— 提示词写文件，走 `--messages-file`。
 *
 * ★★ 2026-10-21 加 `maxTokens`：**这一条是"模型明明在跑却返回空"的根因**。
 *
 *   实测（用 `--output json` 照出来的原始回执，2026-10-12 那天 28 个会话、提示词 2027 字）：
 *     `"finish_reason": "length", "content": "", "reasoning_content": "我们需要回答用户。需要整理…"`
 *   —— 模型把输出额度**全花在推理上**，正文一个字都没轮到 ⇒ `content` 是空串 ⇒ 上层判定"模型无输出"。
 *   而 `bl` 的默认 `--max-tokens` 是 4096，推理一长就没正文了。
 *
 *   同一段提示词对照：默认额度 ⇒ 输出 0 字（50~90 秒）；`--max-tokens 32768` ⇒ **2501 字合法 JSON**。
 *
 *   ⚠️ 为什么以前没暴露：短提示词推理也短，4096 够用；**一长就不够**，
 *     而表现是"exit=0 但没输出"，看着像模型或网络故障，实际是额度分配。
 *   ⇒ 调用方按需给 `maxTokens`；不给就维持原行为（不改变已有调用方）。
 */
export function runModelViaFile(prompt, { timeoutMs = 180000, role = 'user', maxTokens = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-model-'));
  const file = path.join(dir, 'messages.json');
  try {
    // ★ 数组，不是 {messages:[…]}（见上面那条说明）
    fs.writeFileSync(file, JSON.stringify([{ role, content: String(prompt) }]), 'utf8');
    // ★ 模型同上，一处取；额度由调用方决定（推理型模型要留足，否则正文被挤成空串）
    const cmd = `${MODEL_FLAG} --messages-file '${file.replace(/'/g, "''")}'`
      + (Number.isFinite(maxTokens) && maxTokens > 0 ? ` --max-tokens ${Math.floor(maxTokens)}` : '');
    const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    const out = String(r.stdout ?? '').trim();
    const err = String(r.stderr ?? '').trim();
    if (r.error) return { ok: false, why: `调用失败：${r.error.message}` };
    if (r.status !== 0) return { ok: false, why: `模型返回非 0（exit=${r.status}）：${(err || out).slice(0, 300)}` };
    if (out === '') return { ok: false, why: '模型无输出' };
    return { ok: true, text: out };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉不该影响结果 */ }
  }
}

/**
 * 调模型，**失败重试一次**（2026-10-14 加）。
 *
 * 来由：真机实测里，同一段提示词有时**第一次拿不回来**（`spawnSync powershell.exe ETIMEDOUT`），
 *   重发一次就正常。这类"偶发不答"如果直接判失败，驾驶舱那一块会莫名其妙一直生成不出来，
 *   而重发一次的代价只是一次调用。
 *
 * ⚠️ 只重试**一次**：真不通时不该无限重试（那会把一次点击变成几分钟的等待）。
 * ⚠️ 重试的是**同一段提示词**；"减料重试"是调用方的事（见 `cockpit.mjs#narrative`）——
 *   两者治的不是同一个病：这里治"偶发"，那里治"内容让它想太久"。
 */
export function runModelWithRetry(prompt, { timeoutMs = 180000, retries = 1, viaFile = false, maxTokens = null } = {}) {
  // ★ 2026-10-14：`viaFile` 让**多行提示词**走文件那条路（见 `runModelViaFile` 的说明）。
  //   驾驶舱的提示词是多行的，必须开它；单行短提示词的调用方走原来那条就行。
  const call = viaFile ? runModelViaFile : runModel;
  let last = call(prompt, maxTokens ? { timeoutMs, maxTokens } : { timeoutMs });
  for (let i = 0; i < retries && last.ok !== true; i += 1) {
    last = call(prompt, maxTokens ? { timeoutMs, maxTokens } : { timeoutMs });
    if (last.ok === true) return { ...last, retried: i + 1 };
  }
  return last;
}

/** worker 兜底超时：比模型自己的 timeoutMs 留余量（含一次重试与线程启停） */
const MODEL_WORKER_TIMEOUT_MS = Number(process.env.WB_V1_MODEL_TIMEOUT_MS ?? 600000);

/**
 * 调模型 —— **在独立线程里**，供 HTTP 请求路径使用。
 *
 * ★★ 2026-10-14：`runModel` / `runModelViaFile` / `runModelWithRetry` 都是 `spawnSync`
 *   （同步）。在请求路径上直接调 = 面板事件循环被按住**整段模型时间** —— 超时给到
 *   180–240 秒，而本包自己的注释里就记过一次实测：一段 3625 字的提示词
 *   **300 秒拿不回来**（`spawnSync powershell.exe ETIMEDOUT`，见 api/cockpit.mjs）。
 *   看门狗 guard 的 HTTP 探针是 4s 超时 × 连续 4 次 ⇒ 判定「假死（事件循环阻塞）」
 *   并强制重启面板（2026-10-12 ~ 14 实测 5 次，每次都留下一条 TOOL_OUTCOME_UNKNOWN）。
 *   ⇒ 请求路径一律用这个异步版本；离线脚本 / CLI 继续用同步版本，语义不变。
 *
 * ★ 失败**不抛异常**，而是照同步版本的样子返回 `{ok:false, why}`：
 *   调用方（analyzeOnce / reanalyzeNote / context-summary / cockpit）都是按"读 .ok"写的，
 *   把 worker 的错抛出去会绕过它们既有的失败处理。
 */
export function runModelInWorker(prompt, opts = {}) {
  return new Promise((resolve) => {
    let worker;
    const fail = (why) => resolve({ ok: false, why });
    try {
      worker = new Worker(new URL('./model-worker.mjs', import.meta.url), { workerData: { prompt, opts } });
    } catch (e) {
      fail(`模型 worker 启动失败：${e.message}`);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ ok: false, why: `模型 worker 超时（${Math.round(MODEL_WORKER_TIMEOUT_MS / 1000)}s）` }),
      MODEL_WORKER_TIMEOUT_MS,
    );
    worker.once('message', (msg) => {
      if (msg && msg.ok) finish(msg.result);
      else finish({ ok: false, why: (msg && msg.why) || '模型 worker 未给出原因' });
    });
    worker.once('error', (e) => finish({ ok: false, why: `模型 worker 出错：${e.message}` }));
    worker.once('exit', (code) => { if (code !== 0) finish({ ok: false, why: `模型 worker 退出码 ${code}` }); });
  });
}

/** 可视化判断（规则；只给建议） */
export const VISUAL_RULES = Object.freeze([
  { tool: 'coordinates', why: '内容含维度/排序/分布/对比 ⇒ 适合用坐标系落成一张定位图', re: /维度|排序|优先级|分布|对比|占比|矩阵|象限/ },
  { tool: 'project_graph', why: '内容含关系/流程/结构/依赖 ⇒ 适合用工程图落成结构图', re: /关系|流程|结构|依赖|链路|路径|上下游|闭环/ },
  { tool: 'modeling', why: '内容含方法论/从边界到验收/能力分层 ⇒ 适合在建模中心落成模型', re: /方法论|从边界|验收|分层|架构|L0|L1|L2|L3|L4|体检/ },
]);
export function suggestVisual(noteText) {
  const t = String(noteText ?? '');
  for (const r of VISUAL_RULES) if (r.re.test(t)) return { suggested: r.tool, why: r.why };
  return null;
}

/** 组装笔记的分析提示（把召回材料一起给它，要求给"分析与建议"） */
export function buildNotePrompt(note, hits) {
  const ctx = (hits ?? []).slice(0, 5).map((h, i) => `【材料${i + 1}】${h.path}（相似度 ${h.similarity ?? '-'}）\n${String(h.text ?? '').slice(0, 400)}`).join('\n\n');
  return [
    '你在给一条工作笔记做综合分析。要求：先给判断，再给理由，最后给下一步；不要客套，不要复述原文。',
    '输出格式（严格三段，每段不超过 120 字）：',
    '判断：…',
    '理由：…',
    '下一步：…',
    '',
    `【笔记主题】${note.payload?.topic ?? ''}`,
    `【笔记内容】\n${String(note.payload?.content_md ?? '').slice(0, 1500)}`,
    ctx ? `\n【知识库相关材料】\n${ctx}` : '\n【知识库相关材料】无',
  ].join('\n');
}

/**
 * **带台账的入口**（不管谁调都留痕）。
 *
 * ★★ 2026-10-15 修（**台账里从来没有 analyze** —— 这是"数据链路没对齐"最实的一处）。
 *
 *   改之前的结构：
 *     · `analyzeOnce()` —— 干活，**不记台账**；
 *     · `analyze()`     —— `runEngine('analyze', …analyzeOnce…)`，**记台账**。
 *   而**筛选引擎就地触发分析时调的是 `analyzeOnce`**（`filter.mjs` 里 `await analyzeOnce({ limit: 400 })`）
 *   ⇒ 分析**每 5 分钟都在跑**（台账里 filter 有 225 条），**却一条 analyze 都没有**。
 *   实测（2026-10-15 01:33）台账 15073 行里：
 *     collector 3333 · filter 225 · process 221 · archive 221 · **analyze 0**。
 *
 *   ⇒ 后果不是"少一行日志"：**台账是唯一能照出"某引擎没在干活"的东西** ——
 *     分析引擎曾经完全没被触发、而套件全绿，就是台账照出来的。它对这个引擎失效之后，
 *     "分析到底跑没跑"就只能靠翻 filter 那行控制台输出，而那**不留档**。
 *
 *   ⇒ 改法：把记账**挪进 `analyzeOnce`**（唯一干活的那个）⇒ 无论谁调都留痕。
 *     `analyze()` 保留为兼容入口（面板/CLI 有用到），它现在只是转调，**不再自己包一层** ——
 *     否则会把同一轮记两次账（`runEngine` 里再包一次 `analyzeOnce` 就是两层）。
 */
export async function analyzeOnce(o = {}) {
  const { limit = 50, dryRun = false, recallFn = null, modelFn = runModelInWorker } = o;
  return runEngine('analyze', async () => analyzeOnceInner({ limit, dryRun, recallFn, modelFn }));
}

/** 真正干活的那个（**不记台账** —— 记账统一在 `analyzeOnce` 那一层做，避免两处） */
async function analyzeOnceInner({ limit = 50, dryRun = false, recallFn = null, modelFn = runModelInWorker } = {}) {
  const recall = recallFn ?? (await import('./recall.mjs')).recall;
  const errors = [];
  // ★★ 2026-10-13 修（**笔记永远拿不到分析结论的根因** —— 用户第 11 条报的正是这个）：
  //   原来是把四种类型**顺序拼成一条长队**（message → note → schedule → todo），
  //   再 `todo.slice(0, limit)` 截断。而消息有几百条 ⇒ **额度永远被消息吃光，
  //   笔记/日程/待办一条都轮不到**。实测：`limit:200` 跑完 `message=200, note=0`，
  //   库里三条笔记的 `analysis` 一直是空的 —— 而详情页"分析与建议"就是读它，
  //   所以那一栏永远是空的。**这不是显示问题，是分析引擎根本没轮到笔记。**
  //   ⇒ 改成**轮流取**（每种类型一轮拿一条，拿完再进下一轮）：任何类型都不会被前面的饿死；
  //     条数少的类型自然先取完，剩余额度继续给条数多的，不浪费。
  const queues = {};
  for (const type of ['message', 'note', 'schedule', 'todo']) {
    queues[type] = store.list({ type }).filter((e) => {
      // ★ 2026-10-14：分析引擎是**兜底清扫**（采集器进来的那一路不经过接口，只能靠它按批补）。
      //   判断"要不要处理"还是老规矩（没分析过 + ops 里没有 analyzed）——
      //   **不要**在这里再加"有没有上下文"的条件：引擎的职责就是"把该分析的都分析掉"。
      //   "别重复取上下文"那件事由**取的时候**的判据管（见下面循环里对 `needsContext` 的使用）。
      if (e.analysis !== null && e.analysis !== undefined) return false;      // 已分析
      if ((e.ops ?? []).some((o) => String(o.op ?? '') === 'analyzed')) return false;
      return true;
    });
  }
  const todo = [];
  {
    const keys = ['message', 'note', 'schedule', 'todo'];
    let added = true;
    while (todo.length < limit && added) {
      added = false;
      for (const k of keys) {
        if (todo.length >= limit) break;
        const next = queues[k].shift();
        if (next !== undefined) { todo.push(next); added = true; }
      }
    }
  }
  const batch = todo;
  let out = { message: 0, note: 0, schedule: 0, todo: 0, withContext: 0, modelCalls: 0, failed: 0 };

  for (const evt of batch) {
    const t = evt.type;
    const q = String(evt.payload?.topic ?? evt.payload?.summary ?? evt.payload?.raw ?? '').slice(0, 200);

    // ★★ 2026-10-14 改（用户原话，见文件头那段）：**待办也要取一次上下文**。
    //   原来这里是「待办：直通人工，不召回不调模型 ⇒ `continue`」——
    //   于是 17 条待办的 `context.recalled` **全是空的**，详情页那一栏没材料、
    //   待办转日程/转笔记也提取不出字段（实测那两条转换只能拿标题硬填）。
    //   ⚠️ **仍然不调模型**（成本口径 Q9 那半句照旧）：只走下面的召回，不走笔记那段模型调用。
    //
    // ★★ 2026-10-14 再加：**先判"还需不需要取"**（用户原话：「在执行操作转换/完成标记的时候
    //   **也不再重复获取上下文**」）。接口新建时已经当场取过的，这里就**不要再取一遍** ——
    //   不然同一个东西会被召回两次（一次在流入、一次在清扫），白打一次检索服务。
    //   ⚠️ 判据与接口那边**共用同一个 `needsContext`**（`api/server.mjs` 导出）——
    //     两处各写一份必然漂。
    let hits = []; let recallErr = null;
    // ★ 判据来自**中立小模块** `context-gate.mjs`（不是从 server 引 —— 那会互相引用）
    const { needsContext } = await import('./context-gate.mjs');
    const needRecall = needsContext(evt);
    if (q !== '' && needRecall) {
      const r = await recall(q);
      if (r.ok === true) {
        hits = r.hits;
        if (hits.length) out.withContext += 1;
        if (!dryRun) store.patch(t, evt._id, { context: { recalled: hits, floor: r.floor, raw_count: r.raw_count, at: new Date().toISOString() } });
      } else {
        recallErr = r.why;
        errors.push(`${evt._id} 召回不可用：${r.why}`);
      }
    } else if (!needRecall) {
      // 已经有材料（或上次桥断了）⇒ 直接用已有的，**不再打一次检索**
      hits = evt.context?.recalled ?? [];
      out.recallReused = (out.recallReused ?? 0) + 1;
    }

    if (t === 'note') {
      const v = suggestVisual(String(evt.payload?.content_md ?? ''));
      const prompt = buildNotePrompt(evt, hits);
      const m = await modelFn(prompt);
      if (m.ok !== true) {
        errors.push(`${evt._id} 模型未产出：${m.why}`);
        out.failed += 1;
        if (!dryRun) store.patch('note', evt._id, { analysis: { by: 'model', error: m.why, at: new Date().toISOString(), visual: v } }, { op: 'analyzed', partial: true, recallError: recallErr });
      } else {
        out.modelCalls += 1;
        if (!dryRun) store.patch('note', evt._id, { analysis: { by: 'model', text: m.text, visual: v, at: new Date().toISOString(), contextCount: hits.length } }, { op: 'analyzed' });
      }
      out.note += 1;
      continue;
    }

    // 消息 / 日程 / **待办**：召回即完成（需求 3.2.1 / 3.2.4；待办见文件头 2026-10-14 那条），不调模型
    if (!dryRun) store.patch(t, evt._id, { analysis: { by: 'recall-only', contextCount: hits.length, at: new Date().toISOString(), recallError: recallErr } }, { op: 'analyzed' });
    out[t] += 1;
  }

  return { inCount: batch.length, ...out, errors, why: batch.length === 0 ? '没有待分析的事件' : null };
}

/** 兼容入口：面板与 CLI 用这个名字调。
 *  ★ 2026-10-15：它现在**只是转调 `analyzeOnce`**（记账已挪进那一层）。
 *    原来它自己包 `runEngine` ⇒ 若照旧保留，`analyzeOnce` 再包一层就会**同一轮记两次账**。 */
export async function analyze({ limit = 50 } = {}) {
  return analyzeOnce({ limit });
}

/**
 * **重跑一条笔记**（供「分析笔记」动作与"工作台新建笔记后立即分析"调用，需求 3.3.6 + 用户 Q3）。
 *
 * 为什么要单独一个入口，而不是复用 `analyzeOnce`：
 *   `analyzeOnce` 按"没有 analysis 的才算待分析"取件 —— 重跑时这条**已经有 analysis**，
 *   会被它自己跳过。重跑的语义是"**覆盖**上一次的结论"，所以这里显式地重新召回 + 重新调模型，
 *   再整块写回（`visual.built` 这类落点**保留**，因为那是"建过"的事实，不是分析的结论）。
 *
 * 三条纪律照旧：召回失败 ≠ 没有上下文（写 `recallError`）；模型失败 ⇒ **不编分析**、只记 error；
 * 模型/召回全部**注入**，自检不出网。
 */
export async function reanalyzeNote(evt, { recallFn = null, modelFn = runModelInWorker, dryRun = false } = {}) {
  if (!evt || evt.type !== 'note') return { ok: false, why: '只对笔记做分析' };
  const recall = recallFn ?? (await import('./recall.mjs')).recall;
  const q = String(evt.payload?.topic ?? evt.payload?.content_md ?? '').slice(0, 200);
  let hits = []; let recallErr = null;
  if (q !== '') {
    const r = await recall(q);
    if (r.ok === true) hits = r.hits;
    else recallErr = r.why;
  }
  const prevVisual = evt.analysis?.visual ?? null;
  // 可视化建议**重新判定**，但**已建成的落点保留**（built/ref/name/tool 是事实，不是结论）
  const fresh = suggestVisual(String(evt.payload?.content_md ?? ''));
  const visual = fresh
    ? { ...fresh, built: prevVisual?.built === true, ref: prevVisual?.ref ?? null, name: prevVisual?.name ?? null, tool: prevVisual?.tool ?? null, at: prevVisual?.at ?? null }
    : (prevVisual?.built === true ? prevVisual : null);
  const m = await modelFn(buildNotePrompt(evt, hits));
  const at = new Date().toISOString();
  const analysis = m.ok === true
    ? { by: 'model', text: m.text, visual, at, contextCount: hits.length, recallError: recallErr, rerun: true }
    : { by: 'model', error: m.why, visual, at, contextCount: hits.length, recallError: recallErr, rerun: true };
  if (!dryRun) {
    store.patch('note', evt._id, { context: { recalled: hits, at }, analysis }, { op: 'analyzed', rerun: true, recallError: recallErr });
  }
  return { ok: m.ok === true, why: m.ok === true ? null : m.why, text: m.text ?? null, visual, contextCount: hits.length, recallError: recallErr };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（注入桩：召回与模型都不出网）
// ══════════════════════════════════════════════════════════════════════════════
export async function selfTest() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeEvent } = await import('../schema.mjs');

  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });
  const prev = process.env.WB_V1_OUT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v1-analyze-'));
  process.env.WB_V1_OUT = tmp;
  const NOW = Date.now();

  const stubRecall = async (q) => ({ ok: true, hits: [{ path: 'Work/示例客户甲/x.md', text: `与「${q}」相关的材料`, similarity: 0.66 }], floor: 0.55, raw_count: 1, dropped: 0, why: null });
  const stubModel = async () => ({ ok: true, text: '判断：值得做\n理由：有历史材料支撑\n下一步：先做小样' });

  try {
    store.upsert(makeEvent({ type: 'message', payload: { channel: 'dingtalk', sender: '张伟', raw: '明天把验收单发我', source: 'im', modality: 'text', summary: '明天把验收单发我' }, origin: { channel: 'dingtalk', sender: '张伟', messageId: 'm1' }, _at: NOW }).event);
    store.upsert(makeEvent({ type: 'note', payload: { topic: '采集器设计的几个维度', date: '2026-10-12', content_md: '从维度上看，排序与对比是关键', tags: ['设计'] }, origin: { channel: 'manual', sender: '我', messageId: 'n1' }, _at: NOW }).event);
    store.upsert(makeEvent({ type: 'todo', payload: { topic: '把验收单发给张伟', detail: 'x', due: '2026-10-12' }, origin: { channel: 'manual', sender: '我', messageId: 't1' }, _at: NOW }).event);
    store.upsert(makeEvent({ type: 'schedule', payload: { topic: '项目评审会', start: '2026-10-12T14:00', end: '2026-10-12T15:00' }, origin: { channel: 'manual', sender: '我', messageId: 's1' }, _at: NOW }).event);

    const r1 = await analyzeOnce({ recallFn: stubRecall, modelFn: stubModel });
    chk('ANZ-1', '四类各处理一条', r1.message === 1 && r1.note === 1 && r1.todo === 1 && r1.schedule === 1, JSON.stringify(r1));
    chk('ANZ-2', '★ 消息/日程只召回不调模型（成本口径）', r1.modelCalls === 1, `modelCalls=${r1.modelCalls}`);

    const msg = store.list({ type: 'message' })[0];
    chk('ANZ-3', '★ 消息写入相关上下文（需求 3.2.1）', (msg.context?.recalled ?? []).length === 1 && msg.context.recalled[0].path === 'Work/示例客户甲/x.md', JSON.stringify(msg.context).slice(0, 120));
    chk('ANZ-4', '消息的分析标记为仅召回', msg.analysis?.by === 'recall-only');

    const note = store.list({ type: 'note' })[0];
    chk('ANZ-5', '★ 笔记有分析与建议（需求 3.2.2）', typeof note.analysis?.text === 'string' && note.analysis.text.includes('判断：'), JSON.stringify(note.analysis).slice(0, 140));
    chk('ANZ-6', '★ 笔记给出可视化建议（维度/排序 ⇒ 坐标系）', note.analysis?.visual?.suggested === 'coordinates', JSON.stringify(note.analysis?.visual));

    const td = store.list({ type: 'todo' })[0];
    // ★★ 2026-10-14 改（用户原话，见文件头那段）：
    //   这条原来守的是「待办**不召回**也不调模型（需求 3.2.3）」。
    //   用户这一轮明确要求「**所有**信息/待办/日程/笔记在流入时做一次相关上下文的获取和分析」
    //   ⇒ "不召回"那半句被覆盖；**"不调模型"那半句照旧守**（成本口径 Q9）。
    //   ⇒ 改成同时守两件事：**取到了上下文** + **没花模型钱**。
    chk('ANZ-7', '★★ 待办也取一次上下文，但**仍然不调模型**（用户 2026-10-14 覆盖"不召回"那半句）',
      (td.context?.recalled ?? []).length === 1 && td.analysis?.by === 'recall-only' && r1.modelCalls === 1,
      JSON.stringify({ recalled: (td.context?.recalled ?? []).length, by: td.analysis?.by, modelCalls: r1.modelCalls }));

    const r2 = await analyzeOnce({ recallFn: stubRecall, modelFn: stubModel });
    chk('ANZ-8', '★ 幂等：再跑一轮不重复分析', r2.inCount === 0, JSON.stringify({ in: r2.inCount, why: r2.why }));

    // 召回失败 ≠ 没有上下文
    process.env.WB_V1_OUT = path.join(tmp, 'out2');
    store.upsert(makeEvent({ type: 'message', payload: { channel: 'manual', sender: '我', raw: '召不回的一条', source: 'manual', modality: 'text' }, origin: { channel: 'manual', sender: '我', messageId: 'm2' }, _at: NOW }).event);
    const r3 = await analyzeOnce({ recallFn: async () => ({ ok: false, hits: [], why: '桥断了', floor: 0.55, raw_count: 0, dropped: 0 }) });
    const m2 = store.list({ type: 'message' })[0];
    chk('ANZ-9', '★ 召回不可用 ⇒ 写明 recallError（不写成"没有相关材料"）', r3.errors.length === 1 && m2.analysis?.recallError === '桥断了' && (m2.context?.recalled ?? []).length === 0, JSON.stringify(m2.analysis));

    // 模型失败 ⇒ 不产出分析
    process.env.WB_V1_OUT = path.join(tmp, 'out3');
    store.upsert(makeEvent({ type: 'note', payload: { topic: '会失败的笔记', date: '2026-10-12', content_md: 'x' }, origin: { channel: 'manual', sender: '我', messageId: 'n2' }, _at: NOW }).event);
    const r4 = await analyzeOnce({ recallFn: stubRecall, modelFn: async () => ({ ok: false, why: '模型超时' }) });
    const n2 = store.list({ type: 'note' })[0];
    chk('ANZ-10', '★ 模型失败 ⇒ 不编分析文本，只记错误（下轮可重试）', n2.analysis?.text === undefined && n2.analysis?.error === '模型超时' && r4.failed === 1, JSON.stringify(n2.analysis));

    chk('ANZ-11', '可视化规则：关系/流程 ⇒ 工程图', suggestVisual('这里的流程与依赖关系需要理清')?.suggested === 'project_graph');
    chk('ANZ-12', '★ 负向对照：普通笔记不硬套可视化建议', suggestVisual('今天下午开了个会，聊了聊进度') === null);
    chk('ANZ-13', '提示词含笔记内容与材料（供模型用）', buildNotePrompt({ payload: { topic: 'T', content_md: 'C' } }, [{ path: 'P', text: 'S', similarity: 0.6 }]).includes('【材料1】P'));

    // ★★ 2026-10-15 加（**守"分析有没有记账"** —— 用户这一轮要"对齐数据链路"，这是最实的一处）。
    //   起因：`analyzeOnce`（干活的那个）**不记账**，只有 `analyze()` 记。
    //   而筛选引擎就地触发分析时调的是 `analyzeOnce` ⇒ 分析**每 5 分钟都在跑，台账里却一条都没有**
    //   （实测 2026-10-15 台账 15073 行：collector 3333 · filter 225 · process 221 · archive 221 · **analyze 0**）。
    //   后果不是"少一行日志"：**台账是唯一能照出"某引擎没在干活"的东西** ——
    //   分析引擎曾经完全没被触发而套件全绿，就是台账照出来的。它对这个引擎失效之后，
    //   "分析到底跑没跑"就只能靠翻控制台输出，而那不留档。
    //
    //   判据：直接把 `analyzeOnce` 跑一轮（**不是跑 `analyze()`** —— 那正是绕过去的那条路），
    //   然后看台账里有没有多出一条 `engine: 'analyze'`。
    {
      const led = await import('../ledger.mjs');
      const before = led.readRuns({ engine: 'analyze' }).length;
      await analyzeOnce({ limit: 1 });
      const after = led.readRuns({ engine: 'analyze' }).length;
      chk('ANZ-14', '★★ 直接调 analyzeOnce 也**必须**记台账（调度入口绕过去的那条路 —— 记账已挪进它这一层）',
        after > before, `台账里 analyze：跑前 ${before} 条 → 跑后 ${after} 条`);
      // ★ 负向对照：**一轮只许记一条** —— 两层各包一次 `runEngine` 会把同一轮记两遍。
      //   ⚠️ 这条**必须走 `analyze()`**（不是 `analyzeOnce()`）：
      //     重复记账发生在**外层**（`analyze` 与 `analyzeOnce` 各包一次），
      //     而只调 `analyzeOnce` 永远只碰到一层 —— **测不出两层**。
      //     （第一版调的就是 `analyzeOnce`；负向验证时把外层改成"两层重复记账"，
      //       它照样判过 ⇒ 那是个摆设。）
      const before2 = led.readRuns({ engine: 'analyze' }).length;
      await analyze({ limit: 1 });
      const after2 = led.readRuns({ engine: 'analyze' }).length;
      chk('ANZ-15', '★ 走 analyze() 一轮也只记一条（防两层各包一次 runEngine ⇒ 同一轮记两遍）',
        after2 - before2 === 1, `analyze() 这一轮新增 ${after2 - before2} 条`);
    }

    // ★★ 2026-10-15 加：**模型选择只能有一处**（守用户这一轮换 deepseek-flash 的那件事）。
    //   起因：`DEFAULT_MODEL_CMD` 早就导出了，而两个调用点（`runModel` / `runModelViaFile`）
    //   **各自写死了 `bl text chat`、都不用那个常量** ⇒ 改常量等于没改。
    //   我第一版就踩了：改完常量，驾驶舱那条路仍走默认模型，因为它读的是自己那一行 ——
    //   而驾驶舱正是这次要改快的那条路，等于白改。
    //
    //   判据：**源码里 `bl text chat` 只许出现在 `MODEL_FLAG` 那一行**。
    //     多出一处，就说明又有人绕过常量另写了一份模型命令。
    {
      // ⚠️ 读自己：`fileURLToPath(import.meta.url)`（不是手拼字符串 —— 盘符那条 `/C:/` 要处理）。
      const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
      const codeLines = self.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

      // ⚠️ 判据取的是**起手命令段**，不是"提到这个名字"。
      //   这条检查我改了**四版**，四版都栽在**自指**上（检查必须写出那个串才能去数它）：
      //     · 一：数"含不含那条命令" ⇒ 注释行入账；
      //     · 二：加去注释 ⇒ 本段自检仍是普通语句，入账；
      //     · 三：改数"命令 + --model" ⇒ **正则字面量本身就含这个串**，入账；
      //     · 四：把待查串**拼出来** ⇒ 代码里不再有连续完整串，但**断言文字里又写了一遍** ⇒ 还是入账。
      //   ⇒ 第五版：拼接 + **描述里也不再写那条命令**（说"那条命令"即可）。
      //     这是这类"数某串出现几次"的检查的固有难点：**检查自身不许含那个串**，
      //     包括代码、正则、以及给人看的描述文字 —— 三处都算。
      const NEEDLE = 'bl text' + ' chat --model';        // 拼出来，避免自指
      const starter = codeLines.filter((l) => l.includes(NEEDLE));
      chk('ANZ-16', '★★ 模型命令是一处真相（起手命令段只许出现在 MODEL_FLAG 那一行）',
        starter.length === 1 && /MODEL_FLAG\s*=/.test(starter[0] ?? ''),
        `代码里出现 ${starter.length} 处：${starter.map((l) => l.trim().slice(0, 56)).join(' | ')}`);

      // 调用点：`${MODEL_FLAG} --message` / `--messages-file` 各一处。
      //   判据用 `${MODEL_FLAG}`（带模板插值）—— 自检里写的是 `\$\{MODEL_FLAG\}` 转义形态，不入账。
      const nMsg = codeLines.filter((l) => /\$\{MODEL_FLAG\} --message '?/.test(l) && !/\\\$\\\{/.test(l)).length;
      const nFile = codeLines.filter((l) => /\$\{MODEL_FLAG\} --messages-file '?/.test(l) && !/\\\$\\\{/.test(l)).length;
      chk('ANZ-17', '★ 两个调用点都从 MODEL_FLAG 取（`--message` 与 `--messages-file` 各一）',
        nMsg === 1 && nFile === 1, `--message ${nMsg} 处 · --messages-file ${nFile} 处`);
    }
  } finally {
    if (prev === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}

// ══════════════════════════════════════════════════════════════════════════════
// 命令行入口（2026-10-14 补；计划任务每 15 分钟一次）
//
// ★★ 为什么必须补这一段（**用户这一轮的要求逼出来的**）：
//   用户原话：「所有信息/待办/日程/笔记**在流入到工作台的时候做一次相关上下文的获取和分析**」。
//   而真机量出来的实况是：**分析引擎只跑过一次**（台账里最后一条是 2026-10-11T18:29），
//   **没有任何触发器** ⇒ 388 条消息里 **213 条从来没取过上下文**、待办 17 条一条都没有。
//   ⇒ `analyzeOnce` 早就写好了、自检也有 13 条，但**没人调它** —— 与 `links.mjs`
//      （"fetchOnce 写好了但全库没人调"）是**同一个形态**，那次也是补了 `--drain` 才好。
//   本项目为这一类"写好了没触发器"已经付过三次代价（周/月沉淀、链接爬取、这次的分析），
//   所以这里一并做两件事：**有入口**，且**入口的返回值能判成败**。
//
// 用法：
//   node analyze.mjs --run            跑一轮（默认每轮 200 条）
//   node analyze.mjs --run --limit 50 限制本轮条数
//   node analyze.mjs --dry-run        干跑（不写盘、不调模型）
//   node analyze.mjs --selftest       跑自检
// ══════════════════════════════════════════════════════════════════════════════
// ⚠️ 入口判据必须用 `import.meta.url` 与 `process.argv[1]` **比对**，
//   不能只写 `process.argv[1].endsWith('analyze.mjs')` ——
//   实测踩到：别的脚本 `import` 这个模块时，判据也会命中（`process.argv[1]` 是**调用方**的路径），
//   于是**一 import 就跑了整个入口、还读了调用方的参数**（表现为"空查询 ⇒ 不检索"这种莫名其妙的话）。
//   `links.mjs` 那处只判 `endsWith`，能侥幸不出事纯粹是因为它还要求命令行里带 `--drain`。
//   ⇒ 这里用标准判法，别靠运气。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    const r = await selfTest();
    console.log(`analyze selftest: PASS=${r.pass} FAIL=${r.fail}`);
    for (const d of r.details) if (!d.ok) console.log(`  FAIL ${d.id} :: ${d.desc} :: ${d.detail}`);
    process.exit(r.fail === 0 ? 0 : 1);
  }
  if (argv.includes('--run')) {
    const li = argv.indexOf('--limit');
    const limit = li >= 0 ? Number(argv[li + 1]) || 200 : 200;
    const dryRun = argv.includes('--dry-run');
    const t0 = Date.now();
    try {
      const r = await analyzeOnce({ limit, dryRun });
      const secs = Math.round((Date.now() - t0) / 1000);
      console.log(`[analyze] ${dryRun ? '（干跑）' : ''}本轮进 ${r.inCount} 条 · 消息 ${r.message} · 日程 ${r.schedule} · 待办 ${r.todo} · 笔记 ${r.note}`);
      console.log(`[analyze] 取到上下文 ${r.withContext} 条 · 调模型 ${r.modelCalls} 次 · 失败 ${r.failed} · 用时 ${secs}s`);
      if (r.why) console.log(`[analyze] ${r.why}`);
      if (r.errors?.length) { console.log(`[analyze] 错误 ${r.errors.length} 条（前 3）：`); for (const e of r.errors.slice(0, 3)) console.log('  ! ' + String(e).slice(0, 160)) }
      // ★ 失败要能判出来：有错误就非零退出，否则计划任务只会看到 exit=0（那正是 links 那次踩过的坑）
      console.log('PASS');
      process.exit(0);
    } catch (e) {
      console.log(`[analyze] 跑失败：${String(e && e.message).slice(0, 200)}`);
      process.exit(1);
    }
  }
  console.log('用法：node analyze.mjs --run [--limit N] [--dry-run] | --selftest');
  process.exit(2);
}
