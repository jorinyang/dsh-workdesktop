# re003-tap.py —— 遥控器按键采集器：Frida 附加到蓝牙驱动宿主，把每次报告写成一行 JSON。
#
# 做法完全照搬 sayall-helper.exe 里内嵌的 rc003_agent.js（2026-10-11 提取）：
#   1. hook ntdll!NtDeviceIoControlFile
#   2. 在 **onEnter** 里判断 —— 报告数据在"调用之前"就已经填在输出缓冲区里了
#   3. 过滤：IoControlCode == 0x80018483 · inLen == 8 · outLen >= 9
#            输入第 5/6 字节 == 0x02/0x01 · 输出第 1 字节（报告 ID）== 0x01
#   4. 输出缓冲区 = 1 字节报告 ID + 每 2 字节一个小端 usage；全 0 表示所有键松开
#
# 输出（每行一个 JSON，供 KeyBridge --from-file 消费）：
#   {"usages":[241],"names":["back"],"t":1791672000000}
#   {"usages":[],"names":[],"t":1791672000050}          ← 全松开
#
# ⚠️ 只在**按键集合真的变化**时才写一行（去重）。
# 为什么必须去重：同一个物理按压会连着来好几份一模一样的报告 —— 实测一次按 mic 键产生了
# 4 组 down/up，其中两组的时间戳完全相同。引擎的判定器看到"松开后 0 毫秒又按下"就判成双击，
# 而双击那一档通常是空的，于是**短按完全没反应**（2026-10-11 查了很久才定位到）。
# 这里本来就是"状态"语义（当前哪些键按着），重复报告没有意义。
#
# 用法: python rc003-tap.py <WUDFHost pid> <输出文件> [秒数]
import json
import os
import sys
import time

import frida

USAGE_NAMES = {
    0x00F1: 'back', 0x0028: 'ok', 0x0035: 'tv', 0x004A: 'home',
    0x004F: 'right', 0x0050: 'left', 0x0051: 'down', 0x0052: 'up',
    0x0065: 'menu', 0x0066: 'power', 0x007F: 'volume_mute',
    0x0080: 'volume_up', 0x0081: 'volume_down', 0x003E: 'voice',
}

SOURCE = r"""
var TARGET_IOCTL = 0x80018483;
var REPORT_ID = 0x01;
/*
 * 遥控器语音键（HID usage 0x003E）的处理。
 *
 * 两件事：
 *   ① Windows 把这个 usage 映射成 **F5**，所以它绝不能原样交给系统
 *      （按一下 mic 键浏览器就刷新 —— 用户 2026-10-11 报的正是这个）。
 *   ② 我们要用它当"按住说话"的开关，而**不能用 SendInput 造按键** ——
 *      SendInput 的事件强制带 LLKHF_INJECTED 标志，微信输入法一看是模拟的就丢掉。
 *
 * 做法抄自 sayall-helper.exe 内嵌的 rc003_agent.js：**直接改写报告**。
 * 它在 onEnter 里把输出缓冲区里的 usage 换掉再写回去（先 Memory.protect 成可写），
 * 这样 Windows 的 HID 驱动以为"设备真的按了那个键"，产生的是货真价实的硬件级按键，
 * 没有 injected 标志，输入法认。它自己就是用这招把 0x003E 换成 0x00E2（左Alt）的。
 *
 * 报告布局（标准 HID 键盘报告，脚本里按 3 个 usage 槽处理）：
 *   [0] 报告 ID   [1] 修饰键位图   [2] 保留   [3..4] [5..6] [7..8] = 三个 usage 槽
 * （HID 键盘页里 0xE0~0xE7 正好是八个修饰键：E0 左Ctrl E1 左Shift E2 左Alt E3 左Win
 *   E4 右Ctrl E5 右Shift E6 右Alt E7 右Win）
 *
 * **锁存语义**（用户 2026-10-11 提的，比自己按住更好用）：
 *   第 1 次按 mic → 报告里补上"左Alt"   → Windows 认为 Alt 按着 → 微信开始说话
 *   第 2 次按 mic → 报告里撤掉"左Alt"   → Windows 认为 Alt 松开 → 微信结束、进输入框
 * 之所以能"一直按着"，是因为报告是**状态快照** —— 只要后续每一份报告里都补上 0x00E2，
 * 系统就一直认为 Alt 没松，跟用户还按不按遥控器无关。
 */
var VOICE_USAGE = 0x003E;
var LATCH_USAGE = __LATCH_USAGE__;   // 默认 0x00E2（左Alt）；--latch-usage 可覆盖，用来做"看得见"的诊断
var STRIP_VOICE = true;        // 原样的 0x003E 永远不交给系统（它是 F5）
var LATCH_ENABLED = __LATCH_ENABLED__;
/*
 * SAYALL_OWNS_VOICE：语音键**完全不动**，原样放行。
 *
 * 用于"语音独占 = SayAll"那一档：SayAll 自己的 gadget 也在同一个驱动宿主里盯着同一个 IOCTL，
 * 两边同时改写会互相打架。这种模式下我们只**观察**（把按键报给引擎、面板照样显示），
 * 一个字节都不改，把语音键整条路让给 SayAll。
 * 按键映射不受影响 —— 那是引擎注入的事，跟这份报告无关。
 */
var SAYALL_OWNS_VOICE = __SAYALL_OWNS_VOICE__;

var latchOn = false;           // 当前是否处于"Alt 按着"的状态
var voiceWasDown = false;      // 上一次报告里语音键是否按着（用来取上升沿）

/** 三个 usage 槽的字节偏移。 */
var SLOTS = [3, 5, 7];

function slotUsage(bytes, o) { return bytes[o] | (bytes[o + 1] << 8); }

var ntdll = Process.getModuleByName('ntdll.dll');
var fn = ntdll.getExportByName('NtDeviceIoControlFile');
if (fn === null || fn.isNull()) {
  send({ kind: 'error', text: 'export missing' });
} else {
  send({ kind: 'info', text: 'hooked @ ' + fn });
  Interceptor.attach(fn, {
    /*
     * ⚠️ 改写必须放在 **onLeave**，不能在 onEnter —— 这是整件事的关键。
     *
     * IOCTL 的执行顺序：
     *   ① 内核（HID 类驱动）发起请求
     *   ② 进入 NtDeviceIoControlFile          ← onEnter 在这里
     *   ③ 框架/驱动把**真正的报告**填进输出缓冲区   ← 会覆盖 onEnter 里写的东西
     *   ④ 返回内核                            ← onLeave 在这里
     *
     * 在 ② 改：当时的缓冲区装的是**上一次轮询的残留**，我们改它、回读也确认改成了，
     * 但 ③ 会把它整块覆盖 —— 于是"回读 stuck:true、系统毫无反应"这个假象。
     * （2026-10-11 先怀疑过写时复制，实测 path=direct 直接写成功就排除了；真正的原因是这个时机。）
     *
     * onEnter 只负责"认出这是目标 IOCTL"并把指针存下来；真正读报告、判定、改写都在 onLeave。
     */
    onEnter: function (args) {
      this.skip = true;
      if (args[5].toUInt32() !== TARGET_IOCTL) return;
      if (args[7].toUInt32() !== 8) return;
      var outLen = args[9].toUInt32();
      if (outLen < 9) return;
      var inPtr = args[6], outPtr = args[8];
      if (inPtr.isNull() || outPtr.isNull()) return;
      var inBytes = new Uint8Array(inPtr.readByteArray(8));
      if (inBytes[4] !== 0x02 || inBytes[5] !== 0x01) return;
      this.skip = false;
      this.outPtr = outPtr;
      this.n = outLen < 9 ? outLen : 9;
    },
    onLeave: function (retval) {
      if (this.skip === true) return;
      var outPtr = this.outPtr;
      var n = this.n;
      if (outPtr === null || outPtr.isNull() || n === undefined || n < 9) return;

      var bytes = new Uint8Array(outPtr.readByteArray(n));
      if (bytes[0] !== REPORT_ID) return;   // 驱动填完之后才判报告头

      // 原始 usage（只统计三个槽），报给引擎用
      var usages = [];
      var voiceDown = false;
      for (var s = 0; s < SLOTS.length; s++) {
        var u = slotUsage(bytes, SLOTS[s]);
        if (u !== 0) usages.push(u);
        if (u === VOICE_USAGE) voiceDown = true;
      }

      // 上升沿 → 翻转锁存
      var toggled = false;
      if (LATCH_ENABLED && voiceDown && !voiceWasDown) { latchOn = !latchOn; toggled = true; }
      voiceWasDown = voiceDown;

      /*
       * ht = hook 自己的时间戳（毫秒）。
       *
       * 为什么必须带：Python 那边是**每 150ms 批量排空**一次消息队列，写文件时打的时间戳
       * 是"写入时刻"而不是"报告时刻"，于是同一批里的几条会拿到几乎相同的 t ——
       * 看起来像"同一毫秒里按了又松、松了又按"，把真实时序抹平了（2026-10-11 排查
       * 「长按攒不满、音量触发两次」时就卡在这个假象上）。带上 ht 才能看出真实间隔。
       */
      send({ kind: 'report', usages: usages, latch: latchOn, toggled: toggled, ht: Date.now() });

      // SayAll 接管语音时，一个字节都不改，原样放行
      if (SAYALL_OWNS_VOICE) return;

      // 构造交给 Windows 的那一份
      var patched = new Uint8Array(bytes.length);
      patched.set(bytes);
      var changed = false;
      for (var i = 0; i < SLOTS.length; i++) {
        var o = SLOTS[i];
        if (slotUsage(bytes, o) === VOICE_USAGE && STRIP_VOICE) {
          patched[o] = 0; patched[o + 1] = 0; changed = true;
        }
      }
      if (LATCH_ENABLED && latchOn) {
        var present = false;
        for (var k = 0; k < SLOTS.length; k++) {
          if (slotUsage(patched, SLOTS[k]) === LATCH_USAGE) { present = true; break; }
        }
        if (!present) {
          for (var m = 0; m < SLOTS.length; m++) {
            if (slotUsage(patched, SLOTS[m]) === 0) {
              patched[SLOTS[m]] = LATCH_USAGE & 0xff;
              patched[SLOTS[m] + 1] = (LATCH_USAGE >> 8) & 0xff;
              changed = true;
              break;
            }
          }
        }
      }
      if (!changed) return;

      // 先直接写（走共享页，驱动可见）；写不动才退回改页保护
      var writePath = null;
      var writeErr = null;
      try {
        outPtr.writeByteArray(patched.buffer);
        writePath = 'direct';
      } catch (e1) {
        try {
          Memory.protect(outPtr, n, 'rw-');
          outPtr.writeByteArray(patched.buffer);
          writePath = 'protect';
        } catch (e2) {
          writeErr = String(e1) + ' / ' + String(e2);
        }
      }
      var after = new Uint8Array(outPtr.readByteArray(n));
      send({
        kind: 'frame',
        latch: latchOn,
        voiceDown: voiceDown,
        path: writePath,
        orig: Array.prototype.slice.call(bytes),
        patched: Array.prototype.slice.call(patched),
        after: Array.prototype.slice.call(after),
        writeErr: writeErr
      });
    }
  });
}
"""


def self_integrity():
    """
    读**本进程自己**的完整性级别（Windows 的 SID S-1-16-<level>）。

    为什么要内建：2026-10-11 查"引擎注入到不了浏览器"，用外部程序读各进程令牌结果自相矛盾
    —— `whoami`（微软签名程序）报 High，而自己编译的读取器报 Low。让每个进程**自己报自己**，
    就没有跨进程读取这层不确定性了。
    UIPI 规定：低完整性进程注入到更高完整性的窗口会被**静默丢弃**，而 SendInput 照样返回成功。
    """
    try:
        import ctypes
        from ctypes import wintypes
        advapi32 = ctypes.WinDLL('advapi32', use_last_error=True)
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        # 必须显式声明 argtypes/restype：不然 64 位句柄会被当成 int 截断，调用直接失败返回 -1。
        advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        advapi32.OpenProcessToken.restype = wintypes.BOOL
        advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                                 wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        advapi32.GetTokenInformation.restype = wintypes.BOOL
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE

        token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
            return -1
        size = wintypes.DWORD(0)
        advapi32.GetTokenInformation(token, 25, None, 0, ctypes.byref(size))
        if size.value == 0:
            return -1
        buf = ctypes.create_string_buffer(size.value)
        if not advapi32.GetTokenInformation(token, 25, buf, size.value, ctypes.byref(size)):
            return -1
        sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
        count = ctypes.cast(sid, ctypes.POINTER(ctypes.c_ubyte))[1]
        if count <= 0:
            return -1
        return ctypes.cast(sid + 8 + (count - 1) * 4, ctypes.POINTER(ctypes.c_int))[0]
    except Exception:
        return -1


def integrity_name(level):
    if level < 0:
        return 'unknown'
    if level >= 0x4000:
        return 'system'
    if level >= 0x3000:
        return 'high'
    if level >= 0x2000:
        return 'medium'
    if level >= 0x1000:
        return 'low'
    return 'untrusted'


def main():
    if len(sys.argv) < 3:
        print('用法: python rc003-tap.py <WUDFHost pid> <输出文件> [秒数] [--latch-usage 4a] [--sayall-owns-voice]')
        return 1

    pid = int(sys.argv[1])
    out_path = sys.argv[2]

    '''
    参数解析必须**与顺序无关**，只把"纯数字的位置参数"当秒数。

    原来的写法是 `seconds = int(sys.argv[3])`，一旦 host 传进来的是个选项就当场崩：
        ValueError: invalid literal for int() with base 10: '--sayall-owns-voice'
    而 host 那边用的是 stdio:'ignore'，这个 traceback **完全看不到** ——
    表现就是"spawn 返回了 pid、进程下一秒就不见了、按键全无反应"。
    2026-10-11 把采集器的 stdio 改成落日志才一眼看到（见 lib/index.js 的 spawnCollector）。
    '''
    seconds = 0
    latch_usage = '0x00E2'
    latch_enabled = 'true'
    sayall_owns = 'false'
    merge_ms = 0            # 按下合并窗口，0 = 不做合并（默认关，见下）
    known_flags = ('--latch-usage', '--no-latch', '--sayall-owns-voice', '--verbose')
    for i, a in enumerate(sys.argv):
        if i < 3:
            continue                                  # 0=脚本 1=宿主pid 2=输出文件
        if a == '--latch-usage' and i + 1 < len(sys.argv):
            latch_usage = '0x' + sys.argv[i + 1].strip().lower().replace('0x', '').zfill(4)
        elif a == '--no-latch':
            latch_enabled = 'false'
        elif a == '--sayall-owns-voice':
            # 语音独占交给 SayAll：只观察不改写，一个字节都不动
            sayall_owns = 'true'
        elif a == '--merge-ms' and i + 1 < len(sys.argv):
            # 诊断用：0 = 不做合并，把驱动给的原始"按下/松开"序列原样写出来
            try:
                merge_ms = max(0, int(sys.argv[i + 1]))
            except ValueError:
                pass
        elif a in known_flags:
            continue                                  # 其他已知开关，吞掉
        else:
            try:
                seconds = int(a)                      # 只有"纯数字"才算秒数
            except ValueError:
                print('未知参数: %s（已忽略）' % a, file=sys.stderr)

    source = (SOURCE
              .replace('__LATCH_USAGE__', latch_usage)
              .replace('__LATCH_ENABLED__', latch_enabled)
              .replace('__SAYALL_OWNS_VOICE__', sayall_owns))

    messages = []

    def on_message(message, data):
        messages.append(message)

    session = frida.attach(pid)
    script = session.create_script(source)
    script.on('message', on_message)
    script.load()

    with open(out_path, 'a', encoding='utf-8') as out:
        lvl = self_integrity()
        out.write(json.dumps({'type': 'ready', 'pid': pid, 'integrity': lvl,
                              'integrityName': integrity_name(lvl),
                              't': int(time.time() * 1000)}) + '\n')
        out.flush()

        deadline = time.time() + seconds if seconds > 0 else None
        printed = 0
        '''
        按下状态的"合并窗口"（毫秒）。**默认 0 = 不合并。**

        为什么默认关掉：我一度以为驱动会把一次按压抖成好几组「按下—松开」，于是加了这个合并。
        后来用**不合并的原始采集器**实测（`--merge-ms 0`），驱动给的报告是完全干净的：
        一次按压就是一组 {按下} → {松开}，中间没有任何多余往返。

        真正的"抖动"来自**两个采集器同时跑、都往同一个 keys.jsonl 写** —— 两边的按下/松开交错，
        看起来就像一次按压抖成了好几组。那是进程重复的问题，已经在 host 侧堵住
        （killStrayPipeline 的名单补上了 python 版引擎，/bridge/auto 每次先清干净）。
        在源头解决就不必付延迟：合并窗口会让**每次松手都晚 MERGE_MS 才生效**，
        而手感正是靠这个边沿。

        要诊断时再显式打开：`--merge-ms 180`。
        '''
        MERGE_MS = merge_ms
        logical = set()          # 对外报的"逻辑按下集合"
        pending_off = {}         # usage -> 它第一次从报告里消失的 hook 时间戳
        last_usages = None

        def emit_report(usages, latch, toggled, ht):
            line = {
                'usages': usages,
                'names': [USAGE_NAMES.get(u, 'usage_%04X' % u) for u in usages],
                # 锁存态：True = 我们正让 Windows 认为"左Alt 按着"（说话中）
                'latch': latch,
                # 这一份是不是"翻转锁存"的那一下
                'toggled': toggled,
                # ht = hook 那一侧的时间戳（真实报告时刻）；t = 落盘时刻。两者差得多说明有积压。
                'ht': ht,
                't': int(time.time() * 1000),
            }
            out.write(json.dumps(line) + '\n')
            out.flush()

        latch_now = False
        while deadline is None or time.time() < deadline:
            # 排空间隔：150ms 太钝 —— 一批里的几条会拿到几乎相同的时间戳，把真实时序抹平，
            # 排查"长按攒不满 / 音量触发两次"时就被这个假象误导过。降到 10ms。
            time.sleep(0.010)
            now_wall = int(time.time() * 1000)
            while printed < len(messages):
                m = messages[printed]
                printed += 1
                payload = m.get('payload') if isinstance(m, dict) else None
                if isinstance(payload, dict) and payload.get('kind') == 'report':
                    latch = bool(payload.get('latch'))
                    toggled = bool(payload.get('toggled'))
                    latch_now = latch
                    ht = payload.get('ht')
                    if not isinstance(ht, int):
                        ht = now_wall
                    now = set(payload.get('usages') or [])
                    # 报告里有的 → 进逻辑集合，并撤销它的挂起
                    for u in now:
                        logical.add(u)
                        pending_off.pop(u, None)
                    # 报告里没有的 → 先挂起，不立刻算松开
                    for u in list(logical):
                        if u not in now and u not in pending_off:
                            pending_off[u] = ht
                    cur = sorted(logical)
                    if cur != last_usages or toggled:
                        last_usages = cur
                        emit_report(cur, latch_now, toggled, ht)
                elif isinstance(payload, dict) and payload.get('kind') == 'frame':
                    # 回读校验帧：原始 / 我们写的 / 写完读回来的，三个都记，用来判断改写有没有生效
                    hexa = lambda arr: ' '.join('%02X' % b for b in arr)
                    out.write(json.dumps({
                        'type': 'frame',
                        'latch': payload.get('latch'),
                        'voiceDown': payload.get('voiceDown'),
                        # direct = 直接写共享页（驱动可见）；protect = 改了页保护（可能写进私有副本）
                        'path': payload.get('path'),
                        'orig': hexa(payload.get('orig') or []),
                        'patched': hexa(payload.get('patched') or []),
                        'after': hexa(payload.get('after') or []),
                        'stuck': (payload.get('after') == payload.get('patched')),
                        'err': payload.get('writeErr'),
                        't': int(time.time() * 1000),
                    }) + '\n')
                    out.flush()
                elif isinstance(payload, dict) and payload.get('kind') == 'info':
                    out.write(json.dumps({'type': 'info', 'text': payload['text']}) + '\n')
                    out.flush()

            '''
            ★ 用**墙钟**再扫一遍挂起的松开 —— 不能只在"收到新报告"时判超时。

            因为：用户松手之后驱动可能就不再上报了。只在消息循环里判超时的话，
            那个 usage 永远等不到下一次比对 —— **键会卡在"按下"状态出不来**，
            引擎那边就一直当成按着不放（长按动作反而会被误触发）。
            这里每轮（10ms）用墙钟兜一次，保证松手一定能在 MERGE_MS 内报出去。

            ht 是 hook 侧的 Date.now()，和这里的 time.time() 是同一个时钟（都是墙钟毫秒），
            所以两者可以直接相减。
            '''
            for u in list(pending_off):
                if now_wall - pending_off[u] >= MERGE_MS:
                    logical.discard(u)
                    pending_off.pop(u, None)
            cur = sorted(logical)
            if cur != last_usages:
                last_usages = cur
                emit_report(cur, latch_now, False, now_wall)

    session.detach()
    return 0


if __name__ == '__main__':
    sys.exit(main())
