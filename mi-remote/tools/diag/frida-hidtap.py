# frida-hidtap.py —— 在"遥控器的驱动宿主"里拦 DeviceIoControl，把 HID 报告的原始字节打出来。
#
# 依据：那个模块的导入表里只有 143 个导入，其中 `DeviceIoControl` 是唯一一条"驱动↔用户态"
# 的数据通道（其余是 CRT / 线程池 / WNF 通知之类）。HID 输入报告从驱动出来必然走它。
# 这就是 SayAll 那条路的核心（它日志里的 [TAP] 就是在这个进程里插桩）。
#
# 这个脚本只做一件事：把经过的 IOCTL 码和输出缓冲打出来，看按遥控器时哪一条在动。
import os
import sys
import time

import frida

PID = int(sys.argv[1]) if len(sys.argv) > 1 else 24664
SECONDS = int(sys.argv[2]) if len(sys.argv) > 2 else 60

SOURCE = r"""
var seen = {};
// ⚠️ Frida 17 移除了 Module.findExportByName —— 这里按新旧 API 依次尝试，
//    第一次就是踩了这个（TypeError: not a function）。
function findExport(name) {
  try { if (typeof Module.getGlobalExportByName === 'function') { return Module.getGlobalExportByName(name); } } catch (e) {}
  try { if (typeof Module.findExportByName === 'function') { return Module.findExportByName(null, name); } } catch (e) {}
  try { return Process.getModuleByName('kernel32.dll').findExportByName(name); } catch (e) {}
  return null;
}
var fn = findExport('DeviceIoControl');
if (fn === null) {
  send({ kind: 'error', text: 'DeviceIoControl not found' });
} else {
  send({ kind: 'info', text: 'hooked DeviceIoControl @ ' + fn });
  Interceptor.attach(fn, {
    onEnter: function (args) {
      // DeviceIoControl(hDevice, dwIoControlCode, lpInBuffer, nInBufferSize,
      //                 lpOutBuffer, nOutBufferSize, lpBytesReturned, lpOverlapped)
      this.ioctl = args[1].toInt32();
      this.outBuf = args[4];
      this.outSize = args[5].toInt32();
      this.retPtr = args[6];
    },
    onLeave: function (retval) {
      if (retval.toInt32() === 0) { return; }          // 失败的调用不看
      var code = this.ioctl;
      var key = '0x' + (code >>> 0).toString(16).toUpperCase();
      var got = 0;
      try { if (!this.retPtr.isNull()) { got = this.retPtr.readU32(); } } catch (e) { got = 0; }
      var hex = '';
      if (got > 0 && got <= 256 && !this.outBuf.isNull()) {
        try {
          var bytes = this.outBuf.readByteArray(got);
          var arr = new Uint8Array(bytes);
          var parts = [];
          for (var i = 0; i < arr.length; i++) {
            parts.push(('0' + arr[i].toString(16)).slice(-2).toUpperCase());
          }
          hex = parts.join(' ');
        } catch (e) { hex = '<read-failed>'; }
      }
      // 只报"有数据回来"的调用，否则会被无数据的轮询刷屏
      if (got > 0) {
        seen[key] = (seen[key] || 0) + 1;
        send({ kind: 'ioctl', code: key, bytes: got, hex: hex, count: seen[key] });
      }
    }
  });
}
"""

messages = []


def on_message(message, data):
    messages.append(message)


# 同时写一份到文件：后台起的时候 stdout 抓不回来，文件才是随时能看的。
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_frida-tap.log")
log = open(LOG_PATH, "a", encoding="utf-8")


def emit(line):
    print(line)
    try:
        log.write(line + "\n")
        log.flush()
    except Exception:
        pass
    sys.stdout.flush()


session = frida.attach(PID)
script = session.create_script(SOURCE)
script.on("message", on_message)
script.load()
emit("HOOKED pid=%d, listening %d seconds - press remote keys now (log=%s)" % (PID, SECONDS, LOG_PATH))

deadline = time.time() + SECONDS
printed = 0
while time.time() < deadline:
    time.sleep(0.4)
    while printed < len(messages):
        m = messages[printed]
        printed += 1
        payload = m.get("payload") if isinstance(m, dict) else None
        if isinstance(payload, dict) and payload.get("kind") == "ioctl":
            emit("IOCTL %-12s bytes=%-3d #%d  %s" % (
                payload["code"], payload["bytes"], payload["count"], payload["hex"][:110]))
        else:
            emit("  %s" % m)

session.detach()
emit("DONE")
