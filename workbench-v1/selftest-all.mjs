#!/usr/bin/env node
/**
 * v1/selftest-all.mjs —— **v1 全部套件的聚合入口**（P8 守卫迁移）
 *
 * 为什么要有它：v1 的套件分散在 collector / processor / storage / api / ui 各处，
 *   有的自带 CLI、有的只导出 `selfTest()`。若把每条都登记进 `verify-all.mjs` 的 PLAN，
 *   将来增删一条就要动两处（易漂）。⇒ 收成**一个入口**，总回归里只登记这一条。
 *
 * 输出与既有套件同一约定：末尾一行 `PASS = n   FAIL = m`；有 FAIL 则退出码 1。
 * 用法：node _meta/workbench/v1/selftest-all.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rows = [];
let pass = 0; let fail = 0;
/** 要包外文件而跳过的组（**不计入 pass / fail**，末尾单独列 —— 不假装它们跑过） */
const skipped = [];
/** 子模块自己报的"本机跑不了"条数（例如缺工程图 helper），同样不计入 pass / fail */
let skippedTotal = 0;

async function run(id, label, loader) {
  // 每条套件在**自己的临时运行态**里跑，互不污染；同时也保证不碰真实数据
  const prevOut = process.env.WB_V1_OUT;
  const prevKb = process.env.WB_V1_KB_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `wb-v1-all-${id}-`));
  process.env.WB_V1_OUT = path.join(tmp, 'out');
  process.env.WB_V1_KB_ROOT = path.join(tmp, 'kb');
  try {
    const res = await loader();
    const p = res?.pass ?? 0; const f = res?.fail ?? 0;
    // ★ 2026-10-14：子模块自己报的 skipped 也累加进来（例如 visual.mjs 的 VIS-14
    //   "本机没有工程图 helper ⇒ 这条跑不了"）。**skipped 不进 pass 也不进 fail** ——
    //   算进 pass 是虚报覆盖，算进 fail 是把"跑不了"说成"没通过"。
    const sk = res?.skipped ?? 0;
    pass += p; fail += f; skippedTotal += sk;
    rows.push({ id, label, pass: p, fail: f, skipped: sk, failed: (res?.details ?? []).filter((d) => !d.ok).map((d) => `${d.id} ${d.desc}`) });
    console.log(`  ${f === 0 ? '✓' : '✗'} ${label.padEnd(22)} PASS=${String(p).padStart(3)} FAIL=${f}${sk ? ` 跳过=${sk}` : ''}`);
  } catch (e) {
    // ★★ 2026-10-14 加：**包外依赖要"跳过并说清"，不能算一次失败**。
    //   现象（在裸 clone 里实测）：`P1t` 组加载的是 `../system-switches.mjs` ——
    //   那个文件在**知识库侧**（`_meta/workbench/` 下），**不在本包里**。
    //   于是这一条在发布件里必然抛 `Cannot find module`，套件以 FAIL=1、退出码 1 收场。
    //   后果很坏：**"clone 下来就能自证"这句承诺当场破产**，而且失败信息是一条原始模块错，
    //   看的人只会以为包坏了，看不出"这条本来就跑不了"。
    //   ⇒ 认这个错误码，记成**跳过**（不计入 pass / fail），并在末尾单独列出来。
    //     判据是 `ERR_MODULE_NOT_FOUND`，不是"错误消息里含某个词" —— 后者会误吞真的写错路径。
    if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || /ERR_MODULE_NOT_FOUND/.test(String(e.message)))) {
      const need = /'([^']+)'/.exec(String(e.message));
      const what = need ? need[1] : '(未知)';
      skipped.push({ id, label, need: what });
      console.log(`  ⊘ ${label.padEnd(22)} 跳过：要包外文件 ${what}（本包不含，属知识库侧）`);
    } else {
      fail += 1;
      rows.push({ id, label, pass: 0, fail: 1, failed: [`抛异常：${e.message}`] });
      console.log(`  ✗ ${label.padEnd(22)} 抛异常：${e.message}`);
    }
  } finally {
    if (prevOut === undefined) delete process.env.WB_V1_OUT; else process.env.WB_V1_OUT = prevOut;
    if (prevKb === undefined) delete process.env.WB_V1_KB_ROOT; else process.env.WB_V1_KB_ROOT = prevKb;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

console.log('############ 工作台 v1.0 · 全部套件 ############');
const base = new URL('.', import.meta.url).href;

await run('P0', 'P0 骨架与契约', async () => {
  // 既有入口自带 CLI（会自己 process.exit）⇒ 这里自己做同样的事：用它们的 selfTest 导出
  const mod = await import(base + 'schema.mjs');
  const store = await import(base + 'store.mjs');
  const ledger = await import(base + 'ledger.mjs');
  const pages = await import(base + 'pages.mjs');
  const s = mod.selfTest(); const st = store.selfTest(); const lg = ledger.selfTest(); const pg = pages.selfTest();
  const details = [...s.details, ...st.details, ...lg.details, ...pg.details];
  return { pass: pass_(details), fail: details.length - pass_(details), details };
});
function pass_(ds) { return ds.filter((d) => d.ok).length; }

await run('P1', 'P1 采集器', async () => (await import(base + 'collector/registry.mjs')).selfTest());
await run('P1b', 'P1 水位线', async () => (await import(base + 'collector/state.mjs')).selfTest());
await run('P1c', 'P1 模态转换', async () => (await import(base + 'collector/modality.mjs')).selfTest());
await run('P1d', 'P1 钉钉待办通路', async () => (await import(base + 'collector/dingtalk-todo.mjs')).selfTest());
await run('P1e', 'P1 钉钉日程通路', async () => (await import(base + 'collector/dingtalk-calendar.mjs')).selfTest());
await run('P1f', 'P1 飞书日程通路', async () => (await import(base + 'collector/feishu-calendar.mjs')).selfTest());
await run('P1g', 'P1 飞书任务通路', async () => (await import(base + 'collector/feishu-task.mjs')).selfTest());
await run('P1h', 'P1 iMessage 通路', async () => (await import(base + 'collector/imessage.mjs')).selfTest());
await run('P1i', 'P1 钉钉知识库通路', async () => (await import(base + 'collector/dingtalk-wiki.mjs')).selfTest());
await run('P1j', 'P1 飞书云文档通路', async () => (await import(base + 'collector/feishu-drive.mjs')).selfTest());
await run('P1k', 'P1 取数层命令拼装', async () => (await import(base + 'collector/cli.mjs')).selfTest());
await run('P1l', 'P1 飞书妙记通路', async () => (await import(base + 'collector/feishu-minutes.mjs')).selfTest());
await run('P1m', 'P1 飞书多维表记录段', async () => (await import(base + 'collector/feishu-bitable.mjs')).selfTest());
await run('P1n', 'P1 飞书聊天实时', async () => (await import(base + 'collector/feishu-events.mjs')).selfTest());
// ★ 2026-10-13 加：钉钉聊天通路的**入库前过滤**（用户裁定：移除机器人/功能提醒/我发的）。
//   为什么单开一组：这是"**丢数据**"的一步 —— 判错的后果是消息静默消失，最该被检查钉住。
await run('P1o', 'P1 钉钉聊天·入库前过滤', async () => (await import(base + 'collector/dingtalk-im.mjs')).selfTest());
// ★ 2026-10-13 加：**跨组织白名单群的全量采集**（用户裁定）。
//   为什么单开一组：那两个群**Stream 收不到**（跨组织事件不推），只能走 API 拉取 + 跨组织授权；
//   而"授权不在"必须被单独认出来，不能与"这个群没消息"混同 —— 这条错了的后果是**静默收不到**。
await run('P1p', 'P1 钉钉·跨组织白名单群（全量）', async () => (await import(base + 'collector/dingtalk-cross-org.mjs')).selfTest());
// ★ 2026-10-13 加：**范围闸**（用户裁定：两个白名单群全量，其余群只收 @我）。
//   单开一组的原因：这道闸**挡掉的是绝大多数群消息**（实测 467 → 58），
//   判错的方向是"该收的没收到"或"无关的污染进来"，两种都难在事后发现 ⇒ 值得各自钉住。
await run('P1q', 'P1 钉钉·消息范围闸（白名单群全量 / 其余只收@我）', async () => (await import(base + 'collector/scope-gate.mjs')).selfTest());
// ★★ 2026-10-15 加：**多媒体下载通道**。
//   为什么单独立一组：这个模块**此前一个自检都没有**，所以它不在任何回归里 ——
//   而它就断在那里：`deferred.jsonl` 里 **4 条图片永远下不来**（mediaId 是完整网址，
//   却被当资源 id 交给 `dws`），没人发现，直到这一轮逐条翻 deferred 才看到。
//   自检起一个**本地 HTTP 服务**当真源（不依赖外网、也不拿真实网址当夹具 ——
//   那种夹具会随"那个网站还在不在"红绿，本项目已经吃过这种亏）。
await run('P1r', 'P1 多媒体下载（网址直取 / dws 两条路各归各位）', async () => (await import(base + 'collector/media.mjs')).selfTest());
// ★ 2026-10-14 加：**提醒闸**（用户裁定：28 个白名单群的发言照旧收，但非 @我 的不提醒）。
//   收与提醒分开各开一组 —— 两条规矩的产地不同（scope-gate / notice-gate），
//   将来各自会改；合在一组里改一条会连带动到另一条。
await run('P1r', 'P1 提醒闸（群里非@我 ⇒ 只收不提醒）', async () => (await import(base + 'processor/notice-gate.mjs')).selfTest());
// ★ 2026-10-14 加：**相关上下文的 LLM 概括**（用户这一轮四个页面的详情都点名同一条：
//   "检索 RAG 与本身知识库 → 经 LLM 概括后展示 → **不得显示文件路径**"）。
//   单开一组的原因：它有一条**明文禁止**（不许出现路径），而"路径露出来"这种事
//   只有靠"输出端兜一道 + 检查钉住"才拦得住 —— 光靠提示词管不住模型。
await run('P1s', 'P1 相关上下文概括（LLM 概括 · 不带路径）', async () => (await import(base + 'api/context-summary.mjs')).selfTest());
// ★ 2026-10-14 加：**把一段话收成"一句话"**（用户第 5.1 / 6.1 条：「消息转待办/转日程：
//   **概括消息内容为一句话**」）。
//   单开一组的理由：它的失效方式很安静 —— 原来那两处取的是"原文截断"，看起来也是"一段文字"，
//   只有把真样例摆出来才看得出**那是断在半句上的**，不是一句话。
await run('P1u', 'P1 一句话概括（消息转待办/转日程的标题）', async () => (await import(base + 'processor/brief.mjs')).selfTest());
// ★ 2026-10-14 加：**"还要不要取相关上下文"的唯一判据**（用户原话：「流入时取一次」、
//   「转换时按已有的」、「执行动作时不再重复获取」）。
//   单开一组的理由：这条判据被**接口新建**和**分析引擎清扫**两处共用 ——
//   两处各写一份必然漂，而漂了的表现是"同一个东西被召回两次"（白打检索服务、且看不出来）。
await run('P1v', 'P1 上下文判据（流入取一次 · 之后不重复取）', async () => (await import(base + 'processor/context-gate.mjs')).selfTest());
// ★ 2026-10-14 加：**底部状态栏「实时回复」四态**（用户第 1 条：黄=仅监听 / 绿=响应中 / 灰=关闭 / 红=离线）。
//   单开一组：这三个灯是**用户眼睛直接看的东西**，而它们是"文案 + 颜色"两处拼出来的，
//   任何一处被改歪都表现为"灯的颜色和字对不上" —— 那种错不盯着屏幕看不出来，所以要写成可判的。
await run('P1t', 'P1 实时回复四态（颜色与文案对得上）', async () => (await import('../system-switches.mjs')).selfTest());
await run('P2', 'P2 意图判定', async () => (await import(base + 'processor/intent.mjs')).selfTest());
// P2 消息判定与自动创建（用户 Q2：高置信自动建 / 低置信标待处置；幂等）
await run('P2det', 'P2 消息判定与自动创建', async () => (await import(base + 'processor/detect.mjs')).selfTest());
await run('P2b', 'P2 链接队列', async () => (await import(base + 'processor/links.mjs')).selfTest());
await run('P2c', 'P2 筛选主链', async () => (await import(base + 'processor/filter.mjs')).selfTest());
await run('P2d', 'P3 召回层', async () => (await import(base + 'processor/recall.mjs')).selfTest());
await run('P3', 'P3 分析引擎', async () => (await import(base + 'processor/analyze.mjs')).selfTest());
// ★★ 2026-10-14 补登记（**五个模块自带自检，却一直没进总回归 —— 合计 60 条等于白守**）：
//   盘点工作台时发现的：这些模块各自 `selfTest()` 都能跑、也都过，但**没有任何入口把它们汇总进来**。
//   后果：改坏它们，总回归照样全绿 —— 那是**假绿**，比没有检查更坏（会让人以为守住了）。
//   判据很简单：**凡是有 `selfTest()` 的模块，就必须有一条 `run(...)` 把它挂上**；这条以后按此办。
await run('P3x', 'P3 会话级上下文', async () => (await import(base + 'processor/conv-context.mjs')).selfTest());
await run('P3y', 'P3 字段提取器', async () => (await import(base + 'processor/extract.mjs')).selfTest());
await run('P3z', 'P3 会话聚合', async () => (await import(base + 'processor/conversations.mjs')).selfTest());
// P1 可视化构建器（需求 3.2.2 后半句）：真调工具建模型，**成功才置 built**；失败留痕
await run('P3v', 'P3 可视化构建器', async () => (await import(base + 'processor/visual.mjs')).selfTest());
await run('P5b', 'P5 审计与归档', async () => (await import(base + 'processor/archive.mjs')).selfTest());
await run('P5', 'P5 自动关闭', async () => (await import(base + 'processor/close.mjs')).selfTest());
await run('P6', 'P6 存储周期', async () => (await import(base + 'storage/cycles.mjs')).selfTest());
await run('P4a', 'P4 设计 token', async () => (await import(base + 'ui/tokens.mjs')).selfTest());
await run('P4b', 'P4 渲染外壳', async () => (await import(base + 'ui/shell.mjs')).selfTest());
await run('P4c', 'P4 客户端脚本', async () => (await import(base + 'ui/client.mjs')).selfTest());
await run('P4d', 'P4 页面数据接口', async () => (await import(base + 'api/pages.mjs')).selfTest());
// ★ 同上：这两条也是"自带自检却没登记"的（真机点击 15 条 · 状态栏探针 7 条）。
//   注意"真机点击"那条是**源码级**的检查（不启浏览器），所以进总回归不会拖慢套件。
await run('P4e', 'P4 真机点击检查', async () => (await import(base + 'ui/interactions.mjs')).selfTest());
await run('P4f', 'P4 状态栏探针', async () => (await import(base + 'ui/probes.mjs')).selfTest());
await run('P7a', 'P7 驾驶舱数据', async () => (await import(base + 'api/cockpit.mjs')).selfTest());
await run('P7b', 'P7 驾驶舱页面', async () => (await import(base + 'ui/cockpit-page.mjs')).selfTest());
// ★ 2026-10-14 加：**驾驶舱每日生成**（用户第 8 节：「驾驶舱每天幂等执行…所有内容不断积累，无上限」）。
//   单开一组的理由：这条要求的失效方式**特别安静** —— 不幂等不会报错，
//   只会每天白烧五次模型调用，**没人会发现**。
await run('P7c', 'P7 驾驶舱每日生成（幂等 · 逐块独立 · 记账）', async () => (await import(base + 'cockpit/daily.mjs')).selfTest());
await run('API', 'P4/P5 本地接口', async () => (await import(base + 'api/server.mjs')).selfTest());
// ★ EP（2026-10-12 新增）：**直接对接口的检查**。
//   来由：旧 13 卡面板退役后，真机那组里有 58 条检查失去对象（其中相当一部分验的是**数据出口**）。
//   那五个出口实测全部 200、全部在产数据 ⇒ 这件事重新管起来，**不经过面板**。
//   本组是**纯离线**判定自检（样例照真实结构抄的，含负向对照）；
//   真机那一遍另外跑：`node _meta/workbench/v1/api/endpoints.mjs`。
await run('EP', '接口产出（离线判定）', async () => (await import(base + 'api/endpoints.mjs')).selfTest());

// ★★ 2026-10-14 加：**全库体检 —— 命令行入口的"是不是被直接运行"判据够不够严**。
//   来由（真机踩到的）：给分析引擎补 `--run` 入口时写的是
//     `if (process.argv[1].endsWith('analyze.mjs')) { … }`
//   —— 于是**别的脚本 import 这个模块时，判据也命中**（`process.argv[1]` 是**调用方**的路径），
//   一 import 就跑整个入口、还读了调用方的参数（表现是我那个验证脚本莫名其妙打出一句
//   "空查询 ⇒ 不检索"然后自己退了）。全库扫下来**12 个文件**都是这个写法。
//   ⇒ 这是一条**全库性**的检查（不是某一个文件的事），所以放在总套件这一层。
{
  const fsx = await import('node:fs');
  const px = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const baseDir = fileURLToPath(base);            // ⚠️ `base` 是 file URL，扫描目录要用真路径
  const files = [];
  const walk = (d) => {
    for (const x of fsx.readdirSync(d, { withFileTypes: true })) {
      const p = px.join(d, x.name);
      if (x.isDirectory()) walk(p); else if (x.name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(baseDir);
  const weak = [];
  for (const f of files) {
    const lines = fsx.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (/^\s*(\*|\/\/)/.test(l)) return;                                  // 注释不算
      if (/process\.argv\[1\][^\n]*\.endsWith\(/.test(l)) {
        weak.push(`${px.relative(baseDir, f)}:${i + 1}`);
      }
    });
  }
  const out = [];
  out.push({
    id: 'CLI-GUARD',
    desc: '★★ 全库：入口判据不许只判文件名后缀（否则别人 import 时会顺带跑一遍入口）',
    ok: weak.length === 0,
    detail: weak.join(' · ') || `扫了 ${files.length} 个文件，全部用 import.meta.url 精确比对`,
  });
  await run('P7d', 'P7 全库体检（入口判据）', async () => ({ pass: out.filter((x) => x.ok).length, fail: out.filter((x) => !x.ok).length, details: out }));
}

console.log('');
const bad = rows.filter((r) => r.fail > 0);
if (bad.length) {
  console.log('未通过项：');
  for (const r of bad) for (const f of r.failed) console.log(`  - [${r.id}] ${f}`);
  console.log('');
}
// ★ 跳过的组单独列出来。**不写进 PASS/FAIL**，也不假装跑过 ——
//   看的人要能一眼分清"这些过了 / 这些没过 / 这些根本没跑（缺包外文件）"。
if (skipped.length) {
  console.log('跳过的组（要包外文件，本包不含 ⇒ **没有跑**，不计入下面的数）：');
  for (const s of skipped) console.log(`  - [${s.id}] ${s.label} —— 需要 ${s.need}`);
  console.log('  说明：这些组测的是知识库侧的同名模块（如 system-switches.mjs）。');
  console.log('        本包只含引擎与页面，故在裸 clone 里跑不了；放回 <KB>/_meta/workbench/v1/ 即可全跑。');
  console.log('');
}
if (skippedTotal > 0) {
  console.log(`本机跑不了的检查项：${skippedTotal} 条（不在下面的数里；缺的是本机没有的东西，不是代码问题）`);
  console.log('');
}
console.log(`PASS = ${pass}   FAIL = ${fail}`);
process.exit(fail === 0 ? 0 : 1);
