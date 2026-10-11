# frida-modules.py —— 列出驱动宿主进程的全部模块，并在 UMDF 框架里找"IO 请求完成"这类拦截点。
#
# 思路：HID 报告是**驱动从蓝牙栈收到、再往上层交**的。往上层交这一步在 UMDF 里叫
# "完成一个 IO 请求"，走 WUDFPlatform.dll 的 Wdf* 系列函数（WdfRequestCompleteWithInformation 之类）。
# 拦住它就能看到每一份报告的原始字节 —— 比拦 DeviceIoControl（方向反了）靠谱。
import os
import sys
import time

import frida

PID = int(sys.argv[1]) if len(sys.argv) > 1 else 24664

SOURCE = r"""
var out = { kind: 'mods', all: [], wdf: [] };
Process.enumerateModules().forEach(function (m) {
  out.all.push(m.name);
  var n = m.name.toLowerCase();
  if (n.indexOf('wudf') >= 0 || n.indexOf('wdf') >= 0 || n.indexOf('umdf') >= 0) {
    var exps = [];
    try { exps = m.enumerateExports(); } catch (e) { exps = []; }
    exps.forEach(function (e) {
      var en = e.name;
      // 关心"完成请求 / 取缓冲 / 队列"这几类
      if (en.indexOf('Complete') >= 0 || en.indexOf('Retrieve') >= 0 ||
          en.indexOf('Queue') >= 0 || en.indexOf('Request') >= 0) {
        out.wdf.push(m.name + ' :: ' + en);
      }
    });
  }
});
send(out);
"""

messages = []


def on_message(message, data):
    messages.append(message)


session = frida.attach(PID)
script = session.create_script(SOURCE)
script.on("message", on_message)
script.load()
time.sleep(2.5)

for m in messages:
    payload = m.get("payload") if isinstance(m, dict) else None
    if not isinstance(payload, dict) or payload.get("kind") != "mods":
        print("  %s" % m)
        continue
    print("=== all modules (%d) ===" % len(payload["all"]))
    for name in sorted(payload["all"]):
        print("  " + name)
    print("")
    print("=== Wdf*/UMDF candidates (%d) ===" % len(payload["wdf"]))
    for line in sorted(payload["wdf"]):
        print("  " + line)

session.detach()
print("DONE")
