# frida-btproxy.py —— 看用户态蓝牙栈（Microsoft.Bluetooth.Proxy.dll / libzdtp64.dll）的导出，
# 找"GATT 通知 / 特征值变化"这类函数作为拦截点。
#
# 为什么换到这里：HID 报告在到达那个 UMDF 驱动之前，必然先经过用户态蓝牙栈。
# 而 hidovergatt.dll 只有 1 个导出（无从下手）、WUDFPlatform.dll 读不到导出，
# 所以往"上游"退一层找。
import sys
import time

import frida

PID = int(sys.argv[1]) if len(sys.argv) > 1 else 24664
TARGETS = ["Microsoft.Bluetooth.Proxy.dll", "libzdtp64.dll", "SafeWrapper.dll"]

SOURCE = r"""
var out = [];
var targets = TARGETS_JSON;
targets.forEach(function (name) {
  var m = Process.findModuleByName(name);
  if (m === null) { out.push({ mod: name, found: false, exps: [] }); return; }
  var exps = [];
  try { exps = m.enumerateExports(); } catch (e) { exps = []; }
  var names = exps.map(function (e) { return e.name; });
  out.push({ mod: name, found: true, count: names.length, exps: names });
});
send({ kind: 'res', items: out });
""".replace("TARGETS_JSON", "[" + ",".join("'" + t + "'" for t in TARGETS) + "]")

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
    if not isinstance(payload, dict) or payload.get("kind") != "res":
        print("  %s" % m)
        continue
    for item in payload["items"]:
        if not item.get("found"):
            print("=== %s : NOT LOADED ===" % item["mod"])
            continue
        print("=== %s : %d exports ===" % (item["mod"], item.get("count", 0)))
        for n in sorted(item.get("exps", []))[:40]:
            print("  " + n)
        print("")

session.detach()
print("DONE")
