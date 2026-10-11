# inject.py —— 用 Python 直接做键盘注入。
#
# 为什么要有它（2026-10-11 查到的根因）：
#   这台机器上装了 360，它的内核驱动（360Box64 沙箱 + 360AntiHijack 防劫持）**一直在跑**，
#   即使 360 的界面进程被关掉也不卸载（StartMode=System，开机加载）。
#   它的行为是"**按程序身份降级**"：有数字签名的程序照常运行（python.exe 自报 High 12288），
#   我们自己编译的 KeyBridge.exe 无论由谁启动都被强制关进低完整性（自报 Low 4096）。
#   而 Windows 的 UIPI 规定：**低完整性进程注入到更高完整性的窗口会被静默丢弃**，
#   并且 SendInput 照样返回成功 —— 于是引擎日志全绿、界面毫无反应。
#
#   python.exe 自报 High，所以由它来注入就绕过了这条限制（不需要卸载 360 或重启）。
#
# 用法：python inject.py "Ctrl+Alt+K"
import ctypes
import sys
import time
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_EXTENDEDKEY = 0x0001
MAPVK_VK_TO_VSC = 0


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('mouseData', wintypes.DWORD),
                ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD),
                ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [('uMsg', wintypes.DWORD), ('wParamL', wintypes.WORD), ('wParamH', wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [('ki', KEYBDINPUT), ('mi', MOUSEINPUT), ('hi', HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', wintypes.DWORD), ('u', _INPUTUNION)]


user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT

# 和 KeyBridge.exe 的键表保持一致（只列常用的）
KEYS = {
    'ctrl': 0x11, 'control': 0x11, 'alt': 0x12, 'shift': 0x10, 'win': 0x5B,
    'lwin': 0x5B, 'rwin': 0x5C, 'lshift': 0xA0, 'rshift': 0xA1,
    'lctrl': 0xA2, 'rctrl': 0xA3, 'lalt': 0xA4, 'ralt': 0xA5,
    'enter': 0x0D, 'return': 0x0D, 'esc': 0x1B, 'escape': 0x1B,
    'tab': 0x09, 'space': 0x20, 'backspace': 0x08, 'delete': 0x2E,
    'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27,
    'home': 0x24, 'end': 0x23, 'pageup': 0x21, 'pagedown': 0x22,
}
for _c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
    KEYS[_c.lower()] = ord(_c)
for _d in '0123456789':
    KEYS[_d] = ord(_d)
for _i in range(1, 25):
    KEYS['f%d' % _i] = 0x6F + _i

# 方向键这类"扩展键"要带这个位，不然部分应用（尤其浏览器）会当另一个键
EXTENDED = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E,
            0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5}


def make(vk, up):
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.u.ki.wVk = vk
    # 扫描码必须一起填：浏览器靠它算 event.code，而 DSH 的快捷键是按 event.code 匹配的
    # （只填 wVk、wScan=0 时浏览器拿不到物理键码，快捷键永远匹配不上）
    inp.u.ki.wScan = user32.MapVirtualKeyW(vk, 0) & 0xFF
    flags = KEYEVENTF_KEYUP if up else 0
    if vk in EXTENDED:
        flags |= KEYEVENTF_EXTENDEDKEY
    inp.u.ki.dwFlags = flags
    inp.u.ki.time = 0
    inp.u.ki.dwExtraInfo = None
    return inp


def send(combo):
    parts = [p.strip().lower() for p in combo.split('+') if p.strip() != '']
    vks = []
    for p in parts:
        if p not in KEYS:
            return False, 'unknown-key:%s' % p
        vks.append(KEYS[p])
    if not vks:
        return False, 'empty-combo'
    mods, main = vks[:-1], vks[-1]
    # 分批发、中间留几毫秒 —— 同一批次里修饰键和主键同刻入队，应用认不出是组合键
    for m in mods:
        user32.SendInput(1, ctypes.byref(make(m, False)), ctypes.sizeof(INPUT))
    if mods:
        time.sleep(0.012)
    user32.SendInput(1, ctypes.byref(make(main, False)), ctypes.sizeof(INPUT))
    time.sleep(0.014)
    user32.SendInput(1, ctypes.byref(make(main, True)), ctypes.sizeof(INPUT))
    if mods:
        time.sleep(0.010)
    for m in reversed(mods):
        user32.SendInput(1, ctypes.byref(make(m, True)), ctypes.sizeof(INPUT))
    return True, ''


def self_integrity():
    advapi32 = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                             wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        return -1
    size = wintypes.DWORD(0)
    advapi32.GetTokenInformation(token, 25, None, 0, ctypes.byref(size))
    buf = ctypes.create_string_buffer(size.value)
    if not advapi32.GetTokenInformation(token, 25, buf, size.value, ctypes.byref(size)):
        return -1
    sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
    count = ctypes.cast(sid, ctypes.POINTER(ctypes.c_ubyte))[1]
    return ctypes.cast(sid + 8 + (count - 1) * 4, ctypes.POINTER(ctypes.c_int))[0]


if __name__ == '__main__':
    lv = self_integrity()
    print('  本进程完整性级别: %d' % lv)
    if len(sys.argv) < 2:
        print('用法: python inject.py "Ctrl+Alt+K"')
        sys.exit(1)
    ok, err = send(sys.argv[1])
    print('  注入 %s -> ok=%s %s' % (sys.argv[1], ok, err))
