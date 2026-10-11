# frida-probe.py —— 探 B 方案的可行性：能不能附加到"遥控器的 HID 驱动宿主"（WUDFHost.exe）。
#
# 背景：SayAll 在 Windows 上就是靠 Frida 注入 WUDFHost 拿到全部按键的（它的日志里有
# [HOST] exe=WUDFHost.exe / [GADGET] frida-gadget.dll / [TAP] scan=ok 这几行）。
# 我们要拿的"返回 / 音量 ±"在钩子那层收不到（被系统当消费类控制吃了），
# 所以只能从驱动内部截 —— 这脚本就是验证"能不能进去、进去后能看到哪些模块"。
import sys
import time

import frida

PID = int(sys.argv[1]) if len(sys.argv) > 1 else 24664

try:
    session = frida.attach(PID)
    print("ATTACH-OK pid=%d session=%s" % (PID, session))
except Exception as exc:
    print("ATTACH-FAILED: %s" % exc)
    sys.exit(1)

# 进去之后先看两件事：模块列表里有没有 HID/蓝牙相关的，以及能不能跑 JS。
SOURCE = """
var mods = Process.enumerateModules();
var hits = [];
mods.forEach(function (m) {
  var n = m.name.toLowerCase();
  if (n.indexOf('hid') >= 0 || n.indexOf('bth') >= 0 ||
      n.indexOf('umdf') >= 0 || n.indexOf('wudf') >= 0 || n.indexOf('usb') >= 0) {
    hits.push(m.name + ' @ ' + m.base);
  }
});
send({ kind: 'modules', total: mods.length, hits: hits });
"""

messages = []


def on_message(message, data):
    messages.append(message)


try:
    script = session.create_script(SOURCE)
    script.on("message", on_message)
    script.load()
    time.sleep(2.0)
    print("SCRIPT-OK messages=%d" % len(messages))
    for m in messages:
        payload = m.get("payload") if isinstance(m, dict) else None
        if isinstance(payload, dict) and payload.get("kind") == "modules":
            print("  total modules: %d" % payload.get("total", -1))
            for h in payload.get("hits", []):
                print("    %s" % h)
        else:
            print("  %s" % m)
    session.detach()
    print("DONE")
except Exception as exc:
    print("SCRIPT-FAILED: %s" % exc)
