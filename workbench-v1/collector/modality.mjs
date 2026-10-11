/**
 * v1/collector/modality.mjs —— **模态识别与转换**（P1-7）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 需求 2.2 原文的落地：
 *   · 语音      → **转文字识别**（ASR）
 *   · 图片/视频 → **转文件**（下载落盘，模态变成"文件"）
 *   · 文件      → **不改变其模态**（原样落盘）
 *
 * 纪律（本项目反复踩过的坑）
 *   · **转换失败必须如实上报**，绝不用"空文本"冒充"转写完成"；
 *     否则筛选引擎会把空消息当正常消息收进去，事后无人能查出丢了什么。
 *   · 通道（ASR / 下载）用**可注入的 hook**：默认未接线 ⇒ 返回 `ok:false` + `why`，
 *     等 dev 时按实测选型接上（本地 sensevoice 或百炼 `bl speech`；下载用 `dws ... download-media`）。
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/** 模态标记（与 schema 的 message.modality 取值一致） */
export const MODALITIES = Object.freeze(['text', 'voice', 'image', 'video', 'file']);

/**
 * 从消息正文识别模态。
 * 依据：钉钉 Stream 事件里多媒体消息的正文形如
 *   `[图片消息](mediaId=$xxx) 注意：如需下载使用dws chat message download-media命令下载`
 *   `[语音消息](mediaId=...)` / `[视频消息](mediaId=...)` / `[文件](mediaId=...)`
 * 飞书的正文多为预渲染文本（`lark-cli` 已转成人话），识别不到就按 text 处理。
 */
export function detectModality(content) {
  const s = String(content ?? '');
  if (/\[图片消息\]|\[图片\]/.test(s)) return 'image';
  if (/\[语音消息\]|\[语音\]|\[音频\]/.test(s)) return 'voice';
  if (/\[视频消息\]|\[视频\]/.test(s)) return 'video';
  if (/\[文件\]|\[file\]/i.test(s)) return 'file';
  return 'text';
}

/** 取 mediaId（未识别到返回 null）
 *  ⚠️ 实测（2026-10-12）：mediaId 有**两种前缀** —— `$iwEc…` 与 `@lQLPK…`。
 *  早先用了白名单字符集 `[A-Za-z0-9$+/=_-]`，把 `@` 开头的全部挡在外面 ⇒
 *  8 条排队项里 6 条被误报成"没有 mediaId"（**假缺口**：消息其实带 mediaId）。
 *  ⇒ 改成"取到空白或右括号为止"的宽松口径，不再靠字符白名单猜。 */
export function extractMediaId(content) {
  const m = /mediaId=([^\s)）]+)/.exec(String(content ?? ''));
  return m ? m[1] : null;
}

/** 去掉钉钉附在正文尾部的那句"下载提示"，它不该进信息原文
 *  ★ 实测样本里提示含**空格**（`使用dws chat message download-media命令下载`）⇒ 不能用 `\S*` 硬匹配 */
export function stripDownloadHint(content) {
  return String(content ?? '')
    .replace(/\s*注意：如需下载[\s\S]*?命令下载\s*$/u, '')
    .trim();
}

/** 默认 hook：未接线时**如实失败**（不是"返回空字符串"） */
export const NO_HOOK = {
  asr: null,        // (mediaId, {sender, at}) => { ok, text, model?, why? }
  download: null,   // (mediaId, {sender, at}) => { ok, path, why? }
};

/**
 * 转换一条消息正文。
 * @returns {{ok:boolean, modality:string, text:string|null, fileRef:string|null, why:string|null, mediaId:string|null}}
 */
export function convert(content, hooks = NO_HOOK, ctx = {}) {
  const modality = detectModality(content);
  const mediaId = extractMediaId(content);
  const h = { ...NO_HOOK, ...hooks };

  if (modality === 'text') {
    return { ok: true, modality, text: stripDownloadHint(content), fileRef: null, why: null, mediaId };
  }

  // 语音：必须先转写；转不出来就不算成功
  if (modality === 'voice') {
    if (!mediaId) return { ok: false, modality, text: null, fileRef: null, why: '语音消息没有 mediaId ⇒ 无法转写', mediaId: null };
    if (typeof h.asr !== 'function') return { ok: false, modality, text: null, fileRef: null, why: '语音转写通道未接线（ASR hook 为空）⇒ 本条留在队列，不伪装成已转写', mediaId };
    const r = h.asr(mediaId, ctx);
    if (!r || r.ok !== true || typeof r.text !== 'string' || r.text.trim() === '') {
      return { ok: false, modality, text: null, fileRef: null, why: `转写失败：${r?.why ?? '未返回文本'}`, mediaId };
    }
    return { ok: true, modality, text: r.text, fileRef: null, why: null, mediaId };
  }

  // 图片 / 视频：转成文件（模态变 file）
  if (modality === 'image' || modality === 'video') {
    if (!mediaId) return { ok: false, modality, text: null, fileRef: null, why: `${modality} 没有 mediaId ⇒ 无法落盘`, mediaId: null };
    if (typeof h.download !== 'function') return { ok: false, modality, text: null, fileRef: null, why: `${modality} 下载通道未接线（download hook 为空）⇒ 本条留在队列`, mediaId };
    const r = h.download(mediaId, ctx);
    if (!r || r.ok !== true || !r.path) return { ok: false, modality, text: null, fileRef: null, why: `下载失败：${r?.why ?? '未返回路径'}`, mediaId };
    return { ok: true, modality: 'file', text: stripDownloadHint(content), fileRef: r.path, why: null, mediaId };
  }

  // 文件：不改变模态，但要落盘留引用
  if (modality === 'file') {
    if (typeof h.download !== 'function') return { ok: false, modality, text: null, fileRef: null, why: '文件下载通道未接线（download hook 为空）⇒ 本条留在队列', mediaId };
    const r = h.download(mediaId, ctx);
    if (!r || r.ok !== true || !r.path) return { ok: false, modality, text: null, fileRef: null, why: `文件下载失败：${r?.why ?? '未返回路径'}`, mediaId };
    return { ok: true, modality: 'file', text: stripDownloadHint(content), fileRef: r.path, why: null, mediaId };
  }

  return { ok: false, modality, text: null, fileRef: null, why: `未支持的模态 ${modality}`, mediaId };
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（用真实事件里的正文样本，不凭空造）
// ══════════════════════════════════════════════════════════════════════════════
const REAL_IMAGE = '[图片消息](mediaId=$iwEcAqNwbmcDAQTRBwgF0QKuBrCOZ73_lzfmpgqclOO1xJ0AB9IZMABvCAAJomltCgAL0gABKNQ) 注意：如需下载使用dws chat message download-media命令下载';

export function selfTest() {
  const out = [];
  const chk = (id, desc, ok, detail = '') => out.push({ id, desc, ok: !!ok, detail });

  chk('MOD-1', '纯文字 ⇒ text', detectModality('明天下午三点对一下验收清单') === 'text');
  chk('MOD-2', '真实图片样本 ⇒ image（用生产事件原文）', detectModality(REAL_IMAGE) === 'image');
  chk('MOD-3', '语音 ⇒ voice', detectModality('[语音消息](mediaId=abc==) 注意：如需下载使用dws命令下载') === 'voice');
  chk('MOD-4', '视频 ⇒ video', detectModality('[视频消息](mediaId=abc==)') === 'video');
  chk('MOD-5', '文件 ⇒ file', detectModality('[文件](mediaId=abc==)') === 'file');
  chk('MOD-6', 'mediaId 抽取正确', extractMediaId(REAL_IMAGE) === '$iwEcAqNwbmcDAQTRBwgF0QKuBrCOZ73_lzfmpgqclOO1xJ0AB9IZMABvCAAJomltCgAL0gABKNQ');
  chk('MOD-7', '下载提示被剥离（不污染信息原文）', stripDownloadHint(REAL_IMAGE).startsWith('[图片消息]') && !stripDownloadHint(REAL_IMAGE).includes('注意：如需下载'));

  // 文字：未接线也能成功（不需要 hook）
  const t = convert('你好');
  chk('MOD-8', '文字转换不依赖 hook ⇒ ok', t.ok === true && t.modality === 'text' && t.text === '你好');

  // ★ 语音未接线 ⇒ 必须**如实失败**，不许伪造空文本
  const v = convert('[语音消息](mediaId=abc==)');
  chk('MOD-9', '★ 语音未接线 ⇒ ok:false 且给出 why（不伪造空文本）', v.ok === false && typeof v.why === 'string' && v.text === null, JSON.stringify(v));

  // ★ 图片未接线 ⇒ 同样如实失败
  const i = convert(REAL_IMAGE);
  chk('MOD-10', '★ 图片未接线 ⇒ ok:false（不假装已落盘）', i.ok === false && i.fileRef === null, JSON.stringify(i));

  // 接线后行为：ASR 成功 ⇒ text；ASR 返回空 ⇒ 仍失败
  const okAsr = convert('[语音消息](mediaId=abc==)', { asr: () => ({ ok: true, text: '帮我看一下这个合同' }) });
  chk('MOD-11', 'ASR 接线且返回文本 ⇒ ok + text', okAsr.ok === true && okAsr.text === '帮我看一下这个合同' && okAsr.modality === 'voice');
  const emptyAsr = convert('[语音消息](mediaId=abc==)', { asr: () => ({ ok: true, text: '   ' }) });
  chk('MOD-12', '★ ASR 返回空文本 ⇒ 仍判失败（防空数据冒充成功）', emptyAsr.ok === false, JSON.stringify(emptyAsr));

  // 图片下载成功 ⇒ 模态变 file 且有 fileRef
  const okDl = convert(REAL_IMAGE, { download: () => ({ ok: true, path: 'Other/Inflow/文件/2026-10/x.png' }) });
  chk('MOD-13', '图片下载成功 ⇒ 模态转 file + fileRef 就位（需求 2.2）', okDl.ok === true && okDl.modality === 'file' && !!okDl.fileRef);

  // 无 mediaId 的多媒体 ⇒ 失败（不能瞎猜）
  const noId = convert('[图片消息] 没有 id');
  chk('MOD-14', '★ 多媒体缺 mediaId ⇒ 失败（不瞎猜）', noId.ok === false && /mediaId/.test(noId.why), noId.why);

  // ★ 两种前缀都要认（实测：@ 开头的那批曾被白名单字符集挡掉 ⇒ 6 条假缺口）
  const atPrefix = '[图片消息](mediaId=@lQLPKck4jBI_1I3NAYvNAcGwrBt7GU_5sHcKnJMKiTWkAA)@老陈  我今晚上积分消耗异常啊。';
  chk('MOD-15', '★ `@` 前缀的 mediaId 也要抽得到（实测踩过的假缺口）', extractMediaId(atPrefix) === '@lQLPKck4jBI_1I3NAYvNAcGwrBt7GU_5sHcKnJMKiTWkAA', String(extractMediaId(atPrefix)));
  chk('MOD-16', '`$` 前缀仍要抽得到（两种都对）', extractMediaId(REAL_IMAGE).startsWith('$iwEc'));
  chk('MOD-17', '★ 取到右括号为止（后面跟着 @某人 的正文不会被吞进 mediaId）', extractMediaId(atPrefix).endsWith('AA') && !extractMediaId(atPrefix).includes('老陈'));

  const pass = out.filter((x) => x.ok).length;
  return { pass, fail: out.length - pass, details: out };
}
