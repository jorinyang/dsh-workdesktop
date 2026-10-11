# frida-nttap.py —— 拦 ntdll 层的 IO 调用（NtDeviceIoControlFile / NtReadFile / NtWriteFile）。
#
# 为什么要往下退一层：UMDF 的内核反射器（WUDFx02000.dll）跟内核通信时，
# 很可能**不走 kernel32 的 DeviceIoControl**，而是直接调 ntdll 的 Nt* 版本。
# 前面拦 DeviceIoControl 一条都没看到，正好与这个判断相符。
import os
import sys
import time

import frida

PID = int(sys.argv[1]) if len(sys.argv) > 1 else 24664
SECONDS = int(sys.argv[2]) if len(sys.argv) > 2 else 180

SOURCE = r"""
function findExport(mod, name) {
  try { var m = Process.getModuleByName(mod); if (m) { var p = m.findExportByName(name); if (p) { return p; } } } catch (e) {}
  try { if (typeof Module.getGlobalExportByName === 'function') { return Module.getGlobalExportByName(name); } } catch (e) {}
  return null;
}

var stats = {};

function hookIoctl(sym) {
  var fn = findExport('ntdll.dll', sym);
  if (fn === null) { send({ kind: 'info', text: sym + ' NOT FOUND' }); return; }
  send({ kind: 'info', text: sym + ' @ ' + fn });
  Interceptor.attach(fn, {
    onEnter: function (args) {
      // NtDeviceIoControlFile(FileHandle, Event, ApcRoutine, ApcContext,
      //                       IoStatusBlock, IoControlCode, InputBuffer, InputBufferLength,
      //                       OutputBuffer, OutputBufferLength)
      this.code = args[5].toInt32();
      this.outBuf = args[8];
      this.outLen = args[9].toInt32();
      this.iosb = args[4];
      this.sym = sym;
    },
    onLeave: function (retval) {
      if (retval.toInt32() !== 0) { return; }        // 只看成功
      var info = 0;
      try { if (!this.iosb.isNull()) { info = this.iosb.add(8).readU32(); } } catch (e) { info = 0; }
      if (info <= 0 || info > 512) { return; }
      var hex = '';
      try {
        var arr = new Uint8Array(this.outBuf.readByteArray(info));
        var parts = [];
        for (var i = 0; i < arr.length; i++) { parts.push(('0' + arr[i].toString(16)).slice(-2).toUpperCase()); }
        hex = parts.join(' ');
      } catch (e) { hex = '<read-failed>'; }
      var key = this.sym + ' 0x' + (this.code >>> 0).toString(16).toUpperCase();
      stats[key] = (stats[key] || 0) + 1;
      send({ kind: 'io', sym: this.sym, code: '0x' + (this.code >>> 0).toString(16).toUpperCase(),
             bytes: info, hex: hex, count: stats[key] });
    }
  });
}

hookIoctl('NtDeviceIoControlFile');
hookIoctl('NtFsControlFile');
hookIoctl('NtReadFile');
hookIoctl('NtWriteFile');
send({ kind: 'ready' });
"""

messages = []


def on_message(message, data):
    messages.append(message)


LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_frida-nt.log")
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
emit("=== ATTACHED pid=%d, %d seconds (log=%s) ===" % (PID, SECONDS, LOG_PATH))

deadline = time.time() + SECONDS
printed = 0
while time.time() < deadline:
    time.sleep(0.35)
    while printed < len(messages):
        m = messages[printed]
        printed += 1
        payload = m.get("payload") if isinstance(m, dict) else None
        if isinstance(payload, dict) and payload.get("kind") == "io":
            emit("IO %-22s %-12s bytes=%-3d #%d  %s" % (
                payload["sym"], payload["code"], payload["bytes"], payload["count"], payload["hex"][:100]))
        elif isinstance(payload, dict) and payload.get("kind") == "info":
            emit("  " + payload["text"])
        else:
            emit("  %s" % m)

session.detach()
emit("DONE")
