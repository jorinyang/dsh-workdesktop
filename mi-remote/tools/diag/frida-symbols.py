# frida-symbols.py —— 在驱动宿主里看 HID-over-GATT 那个模块的导出与导入，
# 找出"按键报告流经哪些函数"，作为拦截点的候选。
import sys
import time

import frida

PID = int(sys.argv[1]) if len(sys.argv) > 1 else 24664
MODULE = "microsoft.bluetooth.profiles.hidovergatt.dll"

SOURCE = """
var name = MODULE_NAME;
var m = Process.findModuleByName(name);
if (m === null) {
  send({ kind: 'error', text: 'module not found' });
} else {
  var exps = m.enumerateExports();
  var imps = m.enumerateImports();
  var want = function (n) {
    n = n.toLowerCase();
    return n.indexOf('report') >= 0 || n.indexOf('input') >= 0 || n.indexOf('read') >= 0 ||
           n.indexOf('hid') >= 0 || n.indexOf('gatt') >= 0 || n.indexOf('notif') >= 0 ||
           n.indexOf('indicat') >= 0 || n.indexOf('io') >= 0 || n.indexOf('request') >= 0 ||
           n.indexOf('complete') >= 0 || n.indexOf('queue') >= 0;
  };
  var hits = [];
  exps.forEach(function (e) { if (want(e.name)) hits.push('EXP ' + e.type + ' ' + e.name); });
  imps.forEach(function (i) { if (want(i.name)) hits.push('IMP ' + i.type + ' ' + i.module + '!' + i.name); });
  send({ kind: 'symbols', exports: exps.length, imports: imps.length, hits: hits });
}
""".replace("MODULE_NAME", "'" + MODULE + "'")

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
    if isinstance(payload, dict) and payload.get("kind") == "symbols":
        print("exports=%d imports=%d" % (payload["exports"], payload["imports"]))
        for h in payload["hits"]:
            print("  " + h)
        if not payload["hits"]:
            print("  (no matching symbols)")
    else:
        print("  %s" % m)

session.detach()
print("DONE")
