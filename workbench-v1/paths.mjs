/**
 * v1/paths.mjs —— **路径的唯一收口**（2026-10-12 加 · 为"能独立发布"而做）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件（实测事故）
 *   原先 19 个模块各自写 `ROOT = path.resolve(HERE, '..','..','..','..')` ——
 *   按"我住在 `_meta/workbench/v1/<子目录>/`"这个**嵌套深度**往上数。
 *   把 v1 整体复制到别处一跑：**318 PASS / 17 FAIL**（API 套件全红，第一条就是
 *   "登记表已加载（13 条写路径）"）——因为 `../../write-routes.json` 已经指到包外去了。
 *   ⇒ 一个跑不过自己自检的包不能发布。路径假设必须收成**一处**。
 *
 * 两个根，别混
 *   · **PKG_ROOT** = 本包自己的目录（`paths.mjs` 所在目录）。包内资源一律相对它解析 ⇒ 挪到哪都对。
 *   · **KB_ROOT**  = 知识库根（包**外面**的东西：`_meta/out/**`、`Other/**`、RAG 桥）。
 *     解析顺序：① 环境变量 `WB_V1_KB_ROOT`（显式指定，最优先）
 *               ② 若本包正住在 `<KB>/_meta/workbench/v1/` 里 ⇒ 自动认出 `<KB>`
 *               ③ 否则**抛错**（不猜、不静默用一个错的根 —— 猜错的后果是往别人目录里写东西）
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根目录（包内一切资源相对它） */
export const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 从某个目录往上找知识库根：判据是同时存在 `_meta` 与 `Work`（够独特，不会误认） */
function looksLikeKb(dir) {
  try {
    return fs.existsSync(path.join(dir, '_meta')) && fs.existsSync(path.join(dir, 'Work'));
  } catch { return false; }
}

function detectKbRoot() {
  if (process.env.WB_V1_KB_ROOT) return path.resolve(process.env.WB_V1_KB_ROOT);
  // ① 标准布局：<KB>/_meta/workbench/v1[/子目录] —— 从本包往上找
  let d = PKG_ROOT;
  for (let i = 0; i < 6; i++) {
    if (looksLikeKb(d)) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  // ② 兜底：从工作目录往上找（发布后以"配置了 KB 路径"的方式跑时用到）
  d = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (looksLikeKb(d)) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

const DETECTED = detectKbRoot();

/** 知识库根。用之前请用 `hasKbRoot()` 判断，或直接让它抛（见下） */
export const KB_ROOT = DETECTED ?? (() => {
  throw new Error(
    '找不到知识库根：请设置环境变量 `WB_V1_KB_ROOT` 指向知识库目录'
    + '（判据是同时存在 `_meta` 与 `Work`），或把本包放回 `<KB>/_meta/workbench/v1/`。'
    + ' **故意不猜** —— 猜错会往无关目录里写文件。',
  );
})();

export const hasKbRoot = () => DETECTED !== null;

/** 运行态目录（可写）。默认落知识库的 `_meta/out/v1`；也能用 `WB_V1_OUT` 指定 */
export function v1Out() {
  if (process.env.WB_V1_OUT) return path.resolve(process.env.WB_V1_OUT);
  return hasKbRoot() ? path.join(DETECTED, '_meta', 'out', 'v1') : path.join(PKG_ROOT, '.runtime');
}

/** 包内资源 */
export const pkgPath = (...seg) => path.join(PKG_ROOT, ...seg);

/**
 * 知识库侧的外部依赖（**包外**的东西，按 KB_ROOT 解析）
 * 这些是 v1 **复用**而不是重写的东西：RAG 桥、客户别名表、开关真相源。
 */
export const kbPath = (...seg) => {
  if (!hasKbRoot()) {
    throw new Error(`需要知识库根才能定位 ${seg.join('/')}（请设 WB_V1_KB_ROOT）`);
  }
  return path.join(DETECTED, ...seg);
};

/** RAG 桥的位置（召回层用它；它属于知识库侧，不在本包内） */
export function ragBridgePath() {
  return kbPath('_meta', 'workbench', 'rag-bridge.mjs');
}
