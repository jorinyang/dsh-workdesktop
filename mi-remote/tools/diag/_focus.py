# _focus.py —— 把指定标题的窗口切到最前（用脚本文件，避开命令行引号被吃的问题）
import ctypes
import sys
import time

u = ctypes.windll.user32
keyword = sys.argv[1] if len(sys.argv) > 1 else 'DSH'

found = []


def cb(h, l):
    buf = ctypes.create_unicode_buffer(400)
    u.GetWindowTextW(h, buf, 400)
    title = buf.value
    if title and keyword in title and u.IsWindowVisible(h):
        found.append((h, title))
    return True


u.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(cb), None)

if not found:
    print('  没找到含「%s」的可见窗口' % keyword)
    sys.exit(1)

for h, t in found:
    print('  找到: %s' % t[:70])

hwnd = found[0][0]
u.ShowWindow(hwnd, 9)          # SW_RESTORE
u.SetForegroundWindow(hwnd)
time.sleep(0.6)
fg = u.GetForegroundWindow()
buf = ctypes.create_unicode_buffer(400)
u.GetWindowTextW(fg, buf, 400)
print('  置前结果: %s' % buf.value[:70])
