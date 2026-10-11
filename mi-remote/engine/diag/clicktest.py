# clicktest.py —— 决定性验证：点进 DSH 的聊天输入框，打一个字母，看它出不出现。
#
# 为什么要这个：插件预设里的 Ctrl+Alt+K 之类**不是 DSH 的内置快捷键** ——
# DSH 的快捷键是"命令 + 用户自己绑键"（存在浏览器 localStorage 的 dsh.keybindings.v1 里）。
# 所以注入那些组合键时浏览器收到了、但没有任何东西在听，看起来就像"完全没反应"。
# 打字母不依赖任何绑定：字母出现就说明"注入 → 浏览器 → 页面"这条路是通的。
import ctypes
import sys
import time
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)
INPUT_KEYBOARD = 1
INPUT_MOUSE = 0
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_EXTENDEDKEY = 0x0001
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('mouseData', wintypes.DWORD),
                ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD),
                ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [('uMsg', wintypes.DWORD), ('wParamL', wintypes.WORD), ('wParamH', wintypes.WORD)]


class _U(ctypes.Union):
    _fields_ = [('ki', KEYBDINPUT), ('mi', MOUSEINPUT), ('hi', HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', wintypes.DWORD), ('u', _U)]


user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]


def click(x, y):
    user32.SetCursorPos(x, y)
    time.sleep(0.12)
    for flags in (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP):
        inp = INPUT()
        inp.type = INPUT_MOUSE
        inp.u.mi.dwFlags = flags
        user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        time.sleep(0.05)


def key(vk):
    for up in (False, True):
        inp = INPUT()
        inp.type = INPUT_KEYBOARD
        inp.u.ki.wVk = vk
        flags = KEYEVENTF_KEYUP if up else 0
        if vk in (0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2E, 0x5B, 0x5C, 0xA3, 0xA5):
            flags |= KEYEVENTF_EXTENDEDKEY
        inp.u.ki.dwFlags = flags
        user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        time.sleep(0.03)


def type_text(s):
    for ch in s:
        vk = ctypes.windll.user32.VkKeyScanW(ord(ch)) & 0xFF
        if vk == 0xFF or vk == 0:
            continue
        key(vk)
        time.sleep(0.06)


if __name__ == '__main__':
    x = int(sys.argv[1]) if len(sys.argv) > 1 else 2160
    y = int(sys.argv[2]) if len(sys.argv) > 2 else 1830
    text = sys.argv[3] if len(sys.argv) > 3 else 'abc'
    print('  先点一下输入框 (%d, %d)' % (x, y))
    click(x, y)
    time.sleep(0.4)
    print('  输入: %s' % text)
    type_text(text)
    print('  完成')
