# frida-rc003.py —— 照抄 SayAll 的做法，从蓝牙驱动宿主里读遥控器的 HID 报告。
#
# 做法来源：sayall-helper.exe 里内嵌的 rc003_agent.js（2026-10-11 从中提取，5220 行）。
# 它的关键三步，一字不改地照搬：
#   1. hook  ntdll!NtDeviceIoControlFile
#   2. 在 **onEnter** 里判断（不是 onLeave —— 报告数据在"调用之前"就已经填在输出缓冲区里了）
#   3. 过滤条件：IoControlCode == 0x80018483 且 inLen == 8 且 outLen >= 9
#                且 输入的第 5/6 字节 == 0x02/0x01  且 输出第 1 字节（报告 ID）== 0x01
#   命中后，输出缓冲区就是 HID 报告：1 字节报告 ID + 每 2 字节一个小端 usage。
#
# 用法: python frida-rc003.py <WUDFHost 的 pid> [秒数]
import os
import sys
import time

import frida

# 遥控器的 usage → 按键名（从 rc003_agent.js 抄的，13 个键全在）
USAGE_NAMES = {
    0x00F1: 'back', 0x0028: 'ok', 0x0035: 'tv', 0x004A: 'home',
    0x004F: 'right', 0x0050: 'left', 0x0051: 'down', 0x0052: 'up',
    0x0065: 'menu', 0x0066: 'power', 0x007F: 'volume_mute',
    0x0080: 'volume_up', 0x0081: 'volume_down', 0x003E: 'voice',
}

SOURCE = r"""
var TARGET_IOCTL = 0x80018483;
var REPORT_ID = 0x01;

var ntdll = Process.getModuleByName('ntdll.dll');
var fn = ntdll.getExportByName('NtDeviceIoControlFile');
if (fn === null || fn.isNull()) {
  send({ kind: 'error', text: 'NtDeviceIoControlFile not found' });
} else {
  send({ kind: 'info', text: 'hooked NtDeviceIoControlFile @ ' + fn });
  var calls = 0, hits = 0;
  Interceptor.attach(fn, {
    onEnter: function (args) {
      calls++;
      if (args[5].toUInt32() !== TARGET_IOCTL) return;
      var inLen = args[7].toUInt32();
      var outLen = args[9].toUInt32();
      if (inLen !== 8 || outLen < 9) return;
      var inPtr = args[6];
      var outPtr = args[8];
      if (inPtr.isNull() || outPtr.isNull()) return;
      var inBytes = new Uint8Array(inPtr.readByteArray(8));
      if (inBytes[4] !== 0x02 || inBytes[5] !== 0x01) return;
      if (outPtr.readU8() !== REPORT_ID) return;

      hits++;
      // 9 字节就够：1 字节报告 ID + 4 个 usage
      var n = outLen < 9 ? outLen : 9;
      var bytes = new Uint8Array(outPtr.readByteArray(n));
      var usages = [];
      for (var i = 1; i + 1 < bytes.length; i += 2) {
        var u = bytes[i] | (bytes[i + 1] << 8);
        if (u !== 0) usages.push(u);
      }
      send({ kind: 'report', calls: calls, hits: hits, usages: usages, raw: Array.from(bytes) });
    }
  });
}
"""

messages = []


def on_message(message, data):
    messages.append(message)


def usage_names(usages):
    out = []
    for u in usages:
        name = USAGE_NAMES.get(u)
        out.append(('%s(0x%04X)' % (name, u)) if name else ('?(0x%04X)' % u))
    return ' + '.join(out) if out else '(空)'


def main():
    if len(sys.argv) < 2:
        print('用法: python frida-rc003.py <WUDFHost pid> [秒数]')
        return 1
    pid = int(sys.argv[1])
    seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 300

    log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_frida-rc003.log')
    log = open(log_path, 'a', encoding='utf-8')

    def emit(line):
        print(line)
        try:
            log.write(line + '\n')
            log.flush()
        except Exception:
            pass
        sys.stdout.flush()

    session = frida.attach(pid)
    script = session.create_script(SOURCE)
    script.on('message', on_message)
    script.load()
    emit('=== ATTACHED pid=%d, %d seconds, log=%s ===' % (pid, seconds, log_path))
    emit('    等遥控器按键（照 rc003_agent.js 的过滤条件：IOCTL 0x80018483）')

    deadline = time.time() + seconds
    printed = 0
    while time.time() < deadline:
        time.sleep(0.3)
        while printed < len(messages):
            m = messages[printed]
            printed += 1
            payload = m.get('payload') if isinstance(m, dict) else None
            if isinstance(payload, dict) and payload.get('kind') == 'report':
                emit('REPORT #%d (ioctl 调用 %d 次)  %s   raw=%s' % (
                    payload['hits'], payload['calls'], usage_names(payload['usages']),
                    ' '.join('%02X' % b for b in payload['raw'])))
            elif isinstance(payload, dict) and payload.get('kind') == 'info':
                emit('  ' + payload['text'])
            else:
                emit('  %s' % m)

    session.detach()
    emit('DONE')
    return 0


if __name__ == '__main__':
    sys.exit(main())
