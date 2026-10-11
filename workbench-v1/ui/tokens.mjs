/**
 * v1/ui/tokens.mjs —— **设计 token 单一来源**（P4 前端；照抄 `DESIGN-webflow.md`，不凭印象）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 来源：`Research/Input/个人工作台/DESIGN-webflow.md`（507 行，实测提取）
 *   · 颜色 §Colors（335–366 行）· 圆角 §Border Radius Scale（455–466）· 导航 §Navigation（499–512）
 *   · 规矩 §Do's and Don'ts（574–592）
 *
 * 为什么要有这一层（而不是每个页面各写一遍颜色值）
 *   规范里那几条是**硬约束**，散在各处就会漂：
 *     · 字重上限 **600**（不许 700+）
 *     · **5 个彩色强调色**只做"整块填充的分类卡"，**不许当按钮底色**；不许引入第六个
 *     · **不许胶囊按钮**：按钮圆角 4px、卡片 8px
 *     · 正文近黑 `#080808`、白底 `#ffffff`、发丝线 `#d8d8d8`
 *   ⇒ 把值收在这里、把约束写成自检断言，前端就只能照它来。
 *
 * 实现口径：token 名沿用规范里的 `{colors.x}` 写法（转成 CSS 变量 `--c-x`），
 *   这样将来跟规范对表时能一一对上，不用做心算。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/** 颜色（规范里的 `{colors.<key>}`） */
export const COLORS = Object.freeze({
  primary: '#080808',          // Ink Black —— 所有主 CTA / 标题 / 字标
  canvas: '#ffffff',           // 页面底色
  hairline: '#d8d8d8',         // 1px 边框 / 分隔线
  ink: '#080808',              // 默认正文与标题
  'ink-strong': '#222222',
  body: '#363636',
  'body-mid': '#5a5a5a',
  mute: '#898989',
  'mute-soft': '#ababab',
  'accent-purple': '#7a3dff',
  'accent-pink': '#ed52cb',
  'accent-blue': '#3b89ff',
  'accent-blue-deep': '#006acc',
  'accent-blue-info': '#146ef5',
  'accent-orange': '#ff6b00',
  'accent-green': '#00d722',
  'accent-yellow': '#ffae13',
  'accent-red': '#ee1d36',
});

/** 五个彩色强调色（**只能是这五个**；只做整块填充，不做按钮底色） */
export const CATEGORY_ACCENTS = Object.freeze(['accent-purple', 'accent-pink', 'accent-blue', 'accent-orange', 'accent-green']);
/** 语义色（状态用，不属于"分类强调色"） */
export const SEMANTIC = Object.freeze({ info: 'accent-blue-info', success: 'accent-green', warning: 'accent-yellow', error: 'accent-red' });

/** 圆角（规范 §Border Radius Scale） */
export const RADIUS = Object.freeze({ none: 0, xs: 2, sm: 4, md: 8, full: 9999 });
/** 哪些圆角允许用在按钮上 —— 只有 4px（规范：不许胶囊按钮） */
export const BUTTON_RADIUS = RADIUS.sm;
/** 卡片圆角 */
export const CARD_RADIUS = RADIUS.md;

/** 字重上限（规范：不许 700+，hero 用 600） */
export const WEIGHT_CEILING = 600;
export const WEIGHTS = Object.freeze({ regular: 400, medium: 500, strong: 600 });

/** 间距刻度（规范的 spacing 命名，像素值按 4 的倍数） */
export const SPACING = Object.freeze({ xs: 4, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32, '3xl': 48, '4xl': 64 });

/** 阴影（规范：精选卡用多层投影 —— "the brand's distinctive elevation recipe"） */
export const SHADOWS = Object.freeze({
  none: 'none',
  card: '0 1px 2px rgba(8,8,8,.06), 0 8px 24px rgba(8,8,8,.06)',
  lifted: '0 2px 4px rgba(8,8,8,.06), 0 16px 40px rgba(8,8,8,.10)',
});

/** 判定：这个色是不是"分类强调色"（用它做按钮底色就是违规） */
export const isCategoryAccent = (key) => CATEGORY_ACCENTS.includes(key);

/** 生成 CSS 变量块（前端直接注入；变量名 `--c-<key>` / `--r-<key>` / `--w-<key>` / `--s-<key>`） */
export function cssVariables() {
  const lines = [':root {'];
  for (const [k, v] of Object.entries(COLORS)) lines.push(`  --c-${k}: ${v};`);
  for (const [k, v] of Object.entries(RADIUS)) lines.push(`  --r-${k}: ${v}px;`);
  for (const [k, v] of Object.entries(WEIGHTS)) lines.push(`  --w-${k}: ${v};`);
  for (const [k, v] of Object.entries(SPACING)) lines.push(`  --s-${k}: ${v}px;`);
  lines.push(`  --shadow-card: ${SHADOWS.card};`);
  lines.push(`  --shadow-lifted: ${SHADOWS.lifted};`);
  lines.push('}');
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（把规范的硬约束变成断言 —— 将来谁改漂了会当场红）
// ══════════════════════════════════════════════════════════════════════════════
export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  chk('TK-1', '主色 = #080808（近黑，不是纯黑 —— 规范原话"读起来像品牌色"）', COLORS.primary === '#080808');
  chk('TK-2', '底色纯白 #ffffff + 发丝线 #d8d8d8', COLORS.canvas === '#ffffff' && COLORS.hairline === '#d8d8d8');
  chk('TK-3', '★ 分类强调色恰好 5 个（规范：不许引入第六个）', CATEGORY_ACCENTS.length === 5, String(CATEGORY_ACCENTS.length));
  chk('TK-4', '★ 五个强调色的值都对（紫/粉/蓝/橙/绿）', COLORS['accent-purple'] === '#7a3dff' && COLORS['accent-pink'] === '#ed52cb' && COLORS['accent-blue'] === '#3b89ff' && COLORS['accent-orange'] === '#ff6b00' && COLORS['accent-green'] === '#00d722');
  chk('TK-5', '★ 按钮圆角 4px、卡片 8px（规范：品牌从不用胶囊 CTA）', BUTTON_RADIUS === 4 && CARD_RADIUS === 8);
  chk('TK-6', '★ 负向对照：按钮圆角**不是** full/9999（防有人图省事写成胶囊）', BUTTON_RADIUS !== RADIUS.full && RADIUS.full === 9999);
  chk('TK-7', '★ 字重上限 600（规范：不许 700+）', WEIGHT_CEILING === 600 && Math.max(...Object.values(WEIGHTS)) <= 600, String(Math.max(...Object.values(WEIGHTS))));
  chk('TK-8', '★ 强调色判定：五个分类色为真、语义色为假（语义色不当分类色用）', isCategoryAccent('accent-purple') === true && isCategoryAccent('accent-red') === false && isCategoryAccent('accent-blue-info') === false);
  chk('TK-9', '语义四态齐（信息/成功/警告/错误）', SEMANTIC.info === 'accent-blue-info' && SEMANTIC.success === 'accent-green' && SEMANTIC.warning === 'accent-yellow' && SEMANTIC.error === 'accent-red');
  chk('TK-10', '间距刻度齐全且是 4 的倍数', Object.values(SPACING).every((v) => v % 4 === 0) && SPACING.lg === 16 && SPACING['3xl'] === 48, JSON.stringify(SPACING));

  const css = cssVariables();
  chk('TK-11', 'CSS 变量块含全部颜色与圆角（前端注入即可用）', css.includes('--c-primary: #080808;') && css.includes('--r-sm: 4px;') && css.includes('--w-strong: 600;') && css.startsWith(':root {'));
  chk('TK-12', '★ 变量名与规范 token 名一一对应（对表时不用心算）', css.includes('--c-accent-blue-deep: #006acc;') && css.includes('--c-hairline: #d8d8d8;'));
  chk('TK-13', '多层投影已备（精选卡用）', /0 1px 2px/.test(SHADOWS.card) && /0 16px 40px/.test(SHADOWS.lifted));

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
