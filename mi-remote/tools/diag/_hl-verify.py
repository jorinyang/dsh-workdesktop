# _hl-verify.py —— 决定性验证：搜索之后那条结果到底有没有被高亮。
#
# 为什么要这个：用户报"打开搜索框下第一条对话还是不行"。
# 我改了两处（读 placeholder、给结果树加键盘导航+高亮），但都只是纸面改完，
# 没有在**真实页面上**看到过高亮出现。这个脚本直接把那套操作跑一遍：
#   ① 把 DSH 窗口切到最前
#   ② 注入 Ctrl+Alt+K（DSH 的 session.search，聚焦左侧栏搜索框）
#   ③ 用 KEYEVENTF_UNICODE 直接打一个中文词（走 Unicode 通道，绕开输入法）
#   ④ 截图左侧栏，看有没有蓝色高亮框
#
# 用 Unicode 注入而不是按键码：中文没有对应的虚拟键，必须走 Unicode。
import ctypes
import sys
import time
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_EXTENDEDKEY = 0x0001


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]


class _INPUTunion(ctypes.Union):
    _fields_ = [('ki', KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', wintypes.DWORD), ('u', _INPUTunion)]


def scan_of(vk):
    return user32.MapVirtualKeyW(vk, 0) & 0xFF


def key(vk, up=False):
    inp = INPUT(type=INPUT_KEYBOARD)
    inp.u.ki = KEYBDINPUT(wVk=vk, wScan=scan_of(vk),
                          dwFlags=(KEYEVENTF_KEYUP if up else 0), time=0, dwExtraInfo=None)
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


def combo(text):
    """注入一个组合键，例如 'Ctrl+Alt+K'。"""
    parts = text.split('+')
    mods = {'Ctrl': 0x11, 'Alt': 0x12, 'Shift': 0x10, 'Win': 0x5B}
    vks = [mods[p] for p in parts[:-1]]
    main = ord(parts[-1].upper())
    for m in vks:
        key(m)
    time.sleep(0.010)
    key(main)
    time.sleep(0.012)
    key(main, True)
    time.sleep(0.008)
    for m in reversed(vks):
        key(m, True)


def type_unicode(text):
    """走 Unicode 通道直接打字符 —— 中文没有虚拟键码，只能这样。"""
    for ch in text:
        for up in (False, True):
            inp = INPUT(type=INPUT_KEYBOARD)
            inp.u.ki = KEYBDINPUT(wVk=0, wScan=ord(ch),
                                  dwFlags=KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if up else 0),
                                  time=0, dwExtraInfo=None)
            user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
            time.sleep(0.012)
        time.sleep(0.030)


def foreground_title():
    hwnd = user32.GetForegroundWindow()
    buf = ctypes.create_unicode_buffer(300)
    user32.GetWindowTextW(hwnd, buf, 300)
    return buf.value


WORD = sys.argv[1] if len(sys.argv) > 1 else '飞书'

print('  当前前台: ' + foreground_title())
print('  ① 注入 Ctrl+Alt+K（DSH 的搜索会话）')
combo('Ctrl+Alt+K')
time.sleep(0.9)
print('     前台变成: ' + foreground_title())

print('  ② 用 Unicode 通道打「%s」' % WORD)
type_unicode(WORD)
time.sleep(1.6)
print('  ③ 完成 —— 现在截图看左侧栏有没有高亮')
