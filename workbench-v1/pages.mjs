/**
 * v1/pages.mjs —— 工作台 v1.0 **页面与状态栏契约（唯一来源）**（P0-5）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么要有这一层（旧世界的教训）
 *   旧工作台的"卡名/卡顺序"被**六处以上**声明钉死（client.js 两份 + host 一份 + 两个套件各自一份
 *   + card-order.json），2026-09-17 一次改名让 **9 条真机断言整批假红**。
 *   ⇒ v1.0 把"页面集合与顺序"收敛到**这一个文件**，其余地方（前端、host、套件、文档）
 *     一律**从这里读**或由守卫对着它比对；判断"改没改对"只跑一条守卫。
 *
 * 契约内容（用户 2026-10-12 需求 3.3.x + Q2）
 *   · 五个页面 + 顺序（顶部导航横向，与导航顺序同源）
 *   · 底部状态栏七项（DWS/MCP/本地工具/浏览器 = 只读状态；实时回复/响应功能/向量检索 = 开关）
 *   · 三种形态（Q2）：全屏 / tab 半屏 / 移动端
 *
 * 纪律
 *   · 本文件**只声明**，不含渲染逻辑；前端按 key 取数据与渲染。
 *   · 改动必须同时更新 `contract.json`（冻结锚点）——守卫会比对两者，不一致即红。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACT_PATH = path.join(HERE, 'contract.json');

export const PAGES_SCHEMA = 'workbench-v1-pages/1';

/**
 * 五个页面（顺序 = 顶部导航顺序 = 默认页 order 最小者）。
 * `glyph` 是导航用的单字标记（与模板的 glyph 模式一致，不用图标字体）。
 */
export const PAGES = Object.freeze([
  { key: 'overview',  title: '今日总览', glyph: '览', order: 1, default: true,  dataKey: null,        spec: '3.3.2 四项统计 + 三类提醒（重要日程/行程、逾期临期任务、长期未回复）' },
  { key: 'messages',  title: '消息',     glyph: '信', order: 2, default: false, dataKey: 'message',  spec: '3.3.3 四统计 + 新增（带 KB 召回）+ 五 Tab 列表 + 详情浮层（转待办/转日程/已回复）' },
  { key: 'todos',     title: '待办',     glyph: '务', order: 3, default: false, dataKey: 'todo',     spec: '3.3.4 今日/本周/待定/已完成 + 新增 + 列表 + 详情（交付物/已搁置·转日程·已完成）' },
  { key: 'schedules', title: '日程',     glyph: '程', order: 4, default: false, dataKey: 'schedule', spec: '3.3.5 今日/未来7天/前30日已完成 + 热力图与动态分析 + 新增 + 列表 + 详情' },
  { key: 'notes',     title: '笔记',     glyph: '笔', order: 5, default: false, dataKey: 'note',     spec: '3.3.6 总数/本月新增/标签数 + 新增 + 列表 + 详情（上下文/分析建议/可视化构建）' },
]);

/** 底部状态栏（需求 3.3.1）：七项横排一行；前三段只读状态，后三项是可点开关 */
export const STATUS_BAR = Object.freeze([
  { key: 'dws',            label: 'DWS',       kind: 'status' },
  { key: 'mcp',            label: 'MCP',       kind: 'status' },
  { key: 'localtools',     label: '本地工具',   kind: 'status' },
  { key: 'browser',        label: '浏览器',     kind: 'status' },
  { key: 'realtime_reply', label: '实时回复',   kind: 'switch' },   // 开关名与 system-switches 一致，别改名
  { key: 'voice_command',  label: '响应功能',   kind: 'switch' },
  { key: 'vector_search',  label: '向量检索',   kind: 'switch' },
]);

/** 三种形态（Q2）：一套代码三种布局 */
export const FORM_FACTORS = Object.freeze([
  { key: 'fullscreen', label: '全屏（官方侧边栏全屏）', minWidth: 1200 },
  { key: 'tab',        label: 'tab（日常侧边栏半屏）',  minWidth: 420 },
  { key: 'mobile',     label: '移动端（手机查看）',      minWidth: 0 },
]);

/** 稳定序列化 + 哈希（沿用旧顺序契约的约定：紧凑单行 JSON 的 sha256） */
export const canonical = (arr) => JSON.stringify(arr);
export const hashOf = (arr) => crypto.createHash('sha256').update(canonical(arr), 'utf8').digest('hex');

export const pageKeys = () => PAGES.slice().sort((a, b) => a.order - b.order).map((p) => p.key);
export const statusKeys = () => STATUS_BAR.map((s) => s.key);
export const pagesHash = () => hashOf(pageKeys());
export const statusHash = () => hashOf(statusKeys());
export const defaultPage = () => PAGES.find((p) => p.default)?.key ?? null;

/** 当前契约的完整快照（守卫与前端都用它） */
export function snapshot() {
  return {
    schema: PAGES_SCHEMA,
    pages: pageKeys(),
    pagesSha256: pagesHash(),
    statusBar: statusKeys(),
    statusBarSha256: statusHash(),
    formFactors: FORM_FACTORS.map((f) => f.key),
    defaultPage: defaultPage(),
  };
}

export function loadContract() {
  try {
    return JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  } catch (e) {
    return { ok: false, error: `contract.json 读不到：${e.message}` };
  }
}

/**
 * 契约自检：**返回问题数组**（空 = 一致）。
 * 判否口径：pages/pagesSha256/statusBar/statusBarSha256/formFactors/defaultPage 逐项比对。
 */
export function checkContract() {
  const problems = [];
  const live = snapshot();
  const c = loadContract();
  if (c.ok === false) return [c.error];

  if (c.schema !== live.schema) problems.push(`schema 不一致：锚点 ${c.schema} vs 现值 ${live.schema}`);
  if (JSON.stringify(c.pages) !== JSON.stringify(live.pages)) {
    problems.push(`页面集合/顺序不一致：\n  锚点 ${JSON.stringify(c.pages)}\n  现值 ${JSON.stringify(live.pages)}`);
  }
  if (c.pagesSha256 !== live.pagesSha256) problems.push(`pagesSha256 不一致（改了顺序没重算锚点）：锚点 ${String(c.pagesSha256).slice(0, 16)}… vs 现值 ${live.pagesSha256.slice(0, 16)}…`);
  if (JSON.stringify(c.statusBar) !== JSON.stringify(live.statusBar)) problems.push(`状态栏不一致：锚点 ${JSON.stringify(c.statusBar)} vs 现值 ${JSON.stringify(live.statusBar)}`);
  if (c.statusBarSha256 !== live.statusBarSha256) problems.push(`statusBarSha256 不一致：锚点 ${String(c.statusBarSha256).slice(0, 16)}… vs 现值 ${live.statusBarSha256.slice(0, 16)}…`);
  if (JSON.stringify(c.formFactors) !== JSON.stringify(live.formFactors)) problems.push(`形态集合不一致：锚点 ${JSON.stringify(c.formFactors)} vs 现值 ${JSON.stringify(live.formFactors)}`);
  if (c.defaultPage !== live.defaultPage) problems.push(`默认页不一致：锚点 ${c.defaultPage} vs 现值 ${live.defaultPage}`);

  // 内部自洽
  const keys = pageKeys();
  if (new Set(keys).size !== keys.length) problems.push('页面 key 有重复');
  const orders = PAGES.map((p) => p.order);
  if (new Set(orders).size !== orders.length) problems.push('页面 order 有重复');
  if (PAGES.filter((p) => p.default).length !== 1) problems.push('"默认页"必须且只能有一个');
  return problems;
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（含负向对照：这些必须是"能判否"的）
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  chk('PG-1', '锚点与现值一致（本文件与 contract.json 对得上）', checkContract().length === 0, checkContract().join('；'));
  chk('PG-2', '五页 + 顺序唯一', PAGES.length === 5 && new Set(PAGES.map((p) => p.order)).size === 5);
  chk('PG-3', '默认页是今日总览（需求 3.3.2）', defaultPage() === 'overview', String(defaultPage()));
  chk('PG-4', '状态栏七项且开关三项（需求 3.3.1）', STATUS_BAR.length === 7 && STATUS_BAR.filter((s) => s.kind === 'switch').length === 3);
  chk('PG-5', '开关名与 system-switches 的能力名一致', ['realtime_reply', 'voice_command', 'vector_search'].every((k) => statusKeys().includes(k)));
  chk('PG-6', '三种形态齐备（Q2）', FORM_FACTORS.length === 3);

  // 负向对照：注入一个错序，哈希必须变（证明"改顺序必被发现"）
  const good = pageKeys();
  const badOrder = ['messages', 'overview', 'todos', 'schedules', 'notes'];
  chk('PG-7', '★ 负向对照：调换前两页顺序 ⇒ 哈希必变', hashOf(badOrder) !== hashOf(good));
  chk('PG-8', '★ 负向对照：删掉一页 ⇒ 哈希必变', hashOf(good.slice(0, 4)) !== hashOf(good));
  chk('PG-9', '★ 负向对照：状态栏多一项 ⇒ 哈希必变', statusHash() !== hashOf([...statusKeys(), 'zzz']));

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
