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

  // 语音：先看**平台是不是已经把转写放在正文里了**；没有才去调 ASR。
  //
  // ★★ 2026-10-14 修（**这一条把 149 条已经拿到的转写全丢了**）：
  //   实测（钉钉原始事件流 10338 行里的 198 条语音）：
  //     · **149 条**的 content 是「转写正文 + `[语音消息](mediaId=…)` + 下载提示」—— 标记**在正文后面**；
  //     · 49 条的标记在**开头**（系统消息/通话类），确实没有转写。
  //   而原来的逻辑是：一认出 `[语音消息]` 就**判 voice ⇒ 调 ASR hook**，
  //   hook 没接线 ⇒ `ok:false` ⇒ **整条进 deferred**，
  //   ⇒ **正文里那段转写跟着一起被丢掉**（它明明已经在手上了）。
  //   后果：198 条语音一条都没进库，而其中 149 条**根本不需要转写**。
  //
  //   判据：**转写文本在标记之前**（`i > 0` 且有非空内容）⇒ 直接用，`by:'platform'`（平台自带，不花钱、不依赖外接）。
  //   ⚠️ 为什么用"标记之前"而不是"有没有中文"：标记之后的下载提示里也有中文，
  //     按"有没有中文"判会把那句提示当成转写 —— 那是编数据。
  if (modality === 'voice') {
    const s = String(content ?? '');
    const i = s.indexOf('[语音消息]') >= 0 ? s.indexOf('[语音消息]') : s.search(/\[(语音|音频)\]/);
    const pre = i > 0 ? s.slice(0, i).trim() : '';
    if (pre.length >= 2) {
      return { ok: true, modality, text: pre, fileRef: null, why: null, mediaId, by: 'platform' };
    }
    // 到这儿说明**确实没有转写**（标记在开头）⇒ 才需要 ASR
    if (!mediaId) return { ok: false, modality, text: null, fileRef: null, why: '语音消息没有 mediaId ⇒ 无法转写', mediaId: null, by: 'none' };
    if (typeof h.asr !== 'function') return { ok: false, modality, text: null, fileRef: null, why: '本条没有平台自带转写，且 ASR 通道未接线（hook 为空）⇒ 留在队列，不伪装成已转写', mediaId, by: 'none' };
    const r = h.asr(mediaId, ctx);
    if (!r || r.ok !== true || typeof r.text !== 'string' || r.text.trim() === '') {
      return { ok: false, modality, text: null, fileRef: null, why: `转写失败：${r?.why ?? '未返回文本'}`, mediaId, by: 'asr' };
    }
    return { ok: true, modality, text: r.text, fileRef: null, why: null, mediaId, by: 'asr' };
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

  // ★★ 2026-10-14 加：**平台自带转写优先，不调 ASR**。
  //   实测依据：钉钉 198 条语音里 149 条的 content 是「转写正文 + 标记 + 下载提示」。
  //   加这一条之前，它们全被判 voice、去调未接线的 ASR、然后**连正文一起丢进 deferred**。
  const REAL_VOICE_WITH_TEXT = '我想试试能不能直接发给自己[语音消息](mediaId=@lR_PJxEH90bnNu0AALAHp2goIbVm3AqZqUDJX1AA) 注意：如需下载使用dws chat message download-media命令下载';
  const pv = convert(REAL_VOICE_WITH_TEXT);   // ⚠️ **不注入 ASR**：就是要证明"不需要 ASR"
  chk('MOD-14', '★★ 平台自带转写 ⇒ 直接用它，**不调 ASR**（未接线也能成功）',
    pv.ok === true && pv.modality === 'voice' && pv.text === '我想试试能不能直接发给自己' && pv.by === 'platform',
    JSON.stringify(pv));
  chk('MOD-15', '★ 平台转写里**不含**那句下载提示（标记之后的内容不算转写）',
    !String(pv.text ?? '').includes('注意：如需下载') && !String(pv.text ?? '').includes('mediaId'),
    String(pv.text));
  // 负向对照：标记在**开头**（真没有转写）⇒ 仍必须去调 ASR / 如实失败，不许把空串当转写
  const pvNone = convert('[语音消息](mediaId=abc==)');
  chk('MOD-16', '★ 负向对照：标记在开头（确实没转写）⇒ 仍然 ok:false（不许蒙一个文本出来）',
    pvNone.ok === false && pvNone.by === 'none', JSON.stringify(pvNone));
  // 负向对照：标记之后有中文**不算**转写（防空串/提示被当成正文）
  const pvAfter = convert('[语音消息](mediaId=abc==) 这是标记之后的说明文字');
  chk('MOD-17', '★ 负向对照：标记**之后**的文字不算转写（防把说明当成正文）',
    pvAfter.ok === false, JSON.stringify(pvAfter));

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
