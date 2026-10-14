# read-engine.py —— 按键映射的**执行半段**（Python 版，取代 KeyBridge.exe 的 read 模式）。
#
# 为什么要有这个 Python 版本（2026-10-11 查了一整天才定位到）：
#   这台机器上 360 的内核驱动一直在跑（360Box64 沙箱 + 360AntiHijack 防劫持，StartMode=System，
#   关掉 360 的界面进程也不卸载）。它是**按程序身份降级**的：
#       python.exe（有数字签名）        → High(12288)
#       我们自己编译的 KeyBridge.exe    → Low(4096)，由谁启动都一样（连计划任务 /rl highest 也是 Low）
#   而 Windows 的 UIPI 规定：**低完整性进程注入到更高完整性的窗口会被静默丢弃**，
#   SendInput 照样返回成功 —— 于是引擎日志全绿、界面毫无反应。
#
#   python 是 High，所以由它来注入就绕过了这条限制，**不需要卸载 360、不需要重启**。
#
# 职责与 KeyBridge.exe 的 read 模式完全一致：
#   读采集器写的 keys.jsonl（每行一次按键状态变化）→ 判定单击/双击/长按 → 注入。
#
# 用法: python read-engine.py --config <mapping.json> --file <keys.jsonl> [--out <log>] [--verbose]
import ctypes
import json
import os
import subprocess
import sys
import threading
import time
from ctypes import wintypes

# ── 注入层（SendInput）────────────────────────────────────────────────────
user32 = ctypes.WinDLL('user32', use_last_error=True)
INPUT_KEYBOARD = 1
INPUT_MOUSE = 0
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_EXTENDEDKEY = 0x0001
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040


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
user32.SendInput.restype = wintypes.UINT
user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
user32.MapVirtualKeyW.restype = wintypes.UINT
MAPVK_VK_TO_VSC = 0
_SCAN_CACHE = {}


def scan_code(vk):
    """
    取虚拟键码对应的**扫描码**。

    为什么必须填：DSH 的快捷键按 `event.code`（**物理键码**，如 'KeyB' / 'Enter' / 'Slash'）匹配
    —— 见 D:\\deepseek-harness\\packages\\client\\shortcuts\\src\\binding.ts:14
    "One or two distinct **physical keys** held together"。
    而浏览器算 `event.code` 靠的正是键盘的**扫描码**。
    只填 wVk、wScan=0 时浏览器拿不到物理键码 → event.code 不对 → DSH 匹配不上；
    表现就是"物理键盘按得好好的，遥控器注入进去毫无反应"（2026-10-11 定位到）。
    """
    sc = _SCAN_CACHE.get(vk)
    if sc is None:
        sc = user32.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) & 0xFF
        _SCAN_CACHE[vk] = sc
    return sc

KEYS = {
    'ctrl': 0x11, 'control': 0x11, 'alt': 0x12, 'shift': 0x10, 'win': 0x5B, 'meta': 0x5B,
    'lwin': 0x5B, 'rwin': 0x5C, 'lshift': 0xA0, 'rshift': 0xA1,
    'lctrl': 0xA2, 'rctrl': 0xA3, 'lcontrol': 0xA2, 'rcontrol': 0xA3,
    'lalt': 0xA4, 'ralt': 0xA5, 'lmenu': 0xA4, 'rmenu': 0xA5,
    'enter': 0x0D, 'return': 0x0D, 'esc': 0x1B, 'escape': 0x1B,
    'tab': 0x09, 'space': 0x20, 'backspace': 0x08, 'delete': 0x2E,
    'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27,
    'arrowup': 0x26, 'arrowdown': 0x28, 'arrowleft': 0x25, 'arrowright': 0x27,
    'home': 0x24, 'end': 0x23, 'pageup': 0x21, 'pagedown': 0x22,
    'volumeup': 0xAF, 'volumedown': 0xAE, 'volumemute': 0xAD,
    'mediaplaypause': 0xB3, 'medianext': 0xB0, 'mediaprev': 0xB1,
    'mouseleft': 0x01, 'mouseright': 0x02, 'mousemiddle': 0x04,
    # ── OEM 标点键 ──
    # DSH 有几个快捷命令的默认键位就在这几个键上（settings.open = Ctrl+Alt+,
    # shortcuts.open = Ctrl+/、terminal.new = Ctrl+`），所以必须能按下它们。
    # 用 VK 而不是字符：SendInput 走的是虚拟键，而且 scan code 由 MapVirtualKey 反查，
    # 这样浏览器算出来的 event.code 才是对的（Comma / Slash / Backquote）。
    # 2026-10-11 补：改对预设表之后，自检"按键类预设的组合键全能翻译成键码"当场报出
    # 这三个键 unknown —— 之前表是错的，所以从没暴露过。
    ',': 0xBC, 'comma': 0xBC,
    '.': 0xBE, 'period': 0xBE,
    '/': 0xBF, 'slash': 0xBF,
    ';': 0xBA, 'semicolon': 0xBA,
    "'": 0xDE, 'quote': 0xDE,
    '[': 0xDB, 'bracketleft': 0xDB,
    ']': 0xDD, 'bracketright': 0xDD,
    '\\': 0xDC, 'backslash': 0xDC,
    '-': 0xBD, 'minus': 0xBD,
    '=': 0xBB, 'equal': 0xBB,
    '`': 0xC0, 'backquote': 0xC0,
}
for _c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
    KEYS[_c.lower()] = ord(_c)
for _d in '0123456789':
    KEYS[_d] = ord(_d)
for _i in range(1, 25):
    KEYS['f%d' % _i] = 0x6F + _i

# 扩展键要带这个位，否则方向键/右 Alt 这类会被应用当成别的键
EXTENDED = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E,
            0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5}
MOUSE_VKS = {0x01, 0x02, 0x04}


def _key_input(vk, up):
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.u.ki.wVk = vk
    # 扫描码必须一起填：浏览器靠它算 event.code，而 DSH 的快捷键是按 event.code 匹配的
    inp.u.ki.wScan = scan_code(vk)
    flags = KEYEVENTF_KEYUP if up else 0
    if vk in EXTENDED:
        flags |= KEYEVENTF_EXTENDEDKEY
    inp.u.ki.dwFlags = flags
    inp.u.ki.dwExtraInfo = None
    return inp


def _mouse_input(which, up):
    inp = INPUT()
    inp.type = INPUT_MOUSE
    inp.u.mi.dx = 0
    inp.u.mi.dy = 0
    inp.u.mi.mouseData = 0
    if which == 0x01:
        inp.u.mi.dwFlags = MOUSEEVENTF_LEFTUP if up else MOUSEEVENTF_LEFTDOWN
    elif which == 0x02:
        inp.u.mi.dwFlags = MOUSEEVENTF_RIGHTUP if up else MOUSEEVENTF_RIGHTDOWN
    else:
        inp.u.mi.dwFlags = MOUSEEVENTF_MIDDLEUP if up else MOUSEEVENTF_MIDDLEDOWN
    inp.u.mi.dwExtraInfo = None
    return inp


def _send(inp):
    return user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT)) == 1


def parse_combo(combo):
    """'Ctrl+Alt+K' → [vk...]；解析不了抛 ValueError。"""
    vks = []
    for raw in str(combo).split('+'):
        p = raw.strip().lower()
        if p == '':
            continue
        if p not in KEYS:
            raise ValueError('unknown-key:%s' % raw.strip())
        vks.append(KEYS[p])
    if not vks:
        raise ValueError('empty-combo')
    return vks


def combo(combo_str):
    """按一下组合键：修饰键先按住，主键按下抬起，再松开修饰键。
    必须分批发、中间留几毫秒 —— 同一批次里修饰键和主键同刻入队，应用认不出是组合键。

    **重复键**：`Esc+Esc` 这种写法表示"同一个键连按两次"（DSH 的「停止回复」就是 Esc 连按两下）。
    按普通组合键处理会变成"按住 Esc 不放、再按一次 Esc"，应用根本认不出是两下。
    """
    vks = parse_combo(combo_str)
    if len(vks) > 1 and all(v == vks[0] for v in vks):
        for i in range(len(vks)):
            _send(_key_input(vks[0], False))
            time.sleep(0.030)
            _send(_key_input(vks[0], True))
            if i + 1 < len(vks):
                time.sleep(0.060)      # 两下之间要留间隔，太快会被系统合成成一下
        return
    mods, main = vks[:-1], vks[-1]
    for m in mods:
        _send(_mouse_input(m, False) if m in MOUSE_VKS else _key_input(m, False))
    if mods:
        time.sleep(0.006)
    _send(_mouse_input(main, False) if main in MOUSE_VKS else _key_input(main, False))
    time.sleep(0.008)
    _send(_mouse_input(main, True) if main in MOUSE_VKS else _key_input(main, True))
    if mods:
        time.sleep(0.005)
    for m in reversed(mods):
        _send(_mouse_input(m, True) if m in MOUSE_VKS else _key_input(m, True))


def hold_down(combo_str):
    """只按下、不抬起（给"按住不放"型动作用）。"""
    for vk in parse_combo(combo_str):
        _send(_key_input(vk, False))
        time.sleep(0.005)


def hold_up(combo_str):
    for vk in reversed(parse_combo(combo_str)):
        _send(_key_input(vk, True))


MOVE_PIXELS = 12


def move(combo_str, pixels=MOVE_PIXELS):
    """鼠标相对移动。动作名 MoveUp/MoveDown/MoveLeft/MoveRight。"""
    name = str(combo_str).strip().lower()
    dx = dy = 0
    if name == 'moveup':
        dy = -pixels
    elif name == 'movedown':
        dy = pixels
    elif name == 'moveleft':
        dx = -pixels
    elif name == 'moveright':
        dx = pixels
    else:
        return False
    inp = INPUT()
    inp.type = INPUT_MOUSE
    inp.u.mi.dx = dx
    inp.u.mi.dy = dy
    inp.u.mi.mouseData = 0
    inp.u.mi.dwFlags = MOUSEEVENTF_MOVE
    inp.u.mi.dwExtraInfo = None
    return user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT)) == 1


def is_move(action):
    return str(action or '').strip().lower() in ('moveup', 'movedown', 'moveleft', 'moveright')


def launch(name):
    try:
        os.startfile(name)          # 交给 shell 解析（PATH / App Paths / 完整路径都行）
        return True
    except Exception:
        try:
            subprocess.Popen([name], shell=False)
            return True
        except Exception:
            return False


# ── 采集器用法表 → 按键名 ─────────────────────────────────────────────────
USAGE_TO_BUTTON = {
    0x00F1: 'back', 0x0028: 'ok', 0x0035: 'tv', 0x004A: 'home',
    0x004F: 'right', 0x0050: 'left', 0x0051: 'down', 0x0052: 'up',
    0x0065: 'menu', 0x0066: 'power', 0x007F: 'volmute',
    0x0080: 'volup', 0x0081: 'voldown', 0x003E: 'voice',
}

DOUBLE_MS = 320
HOLD_MS = 650


class Engine:
    def __init__(self, mapping, out_path, verbose):
        self.mapping = mapping
        self.out_path = out_path
        self.verbose = verbose
        self.lock = threading.Lock()
        self.state = {}          # usage → 判定状态
        self.held = {}           # usage → 正被"按住不放"的组合键
        self.move_timer = None
        self.move_action = None
        self._out = None
        if out_path:
            try:
                self._out = open(out_path, 'a', encoding='utf-8')
            except Exception:
                self._out = None

    def emit(self, obj):
        '''
        每条记录都带一个墙钟时间戳 `ts`（毫秒）。

        为什么必须带：原来 `key` 和 `fire` 两类记录**都没有时间**，于是排查时
        分不清"这条 Backspace 是改配置之前的旧记录，还是现在还在发"——
        2026-10-11 那次判断就在这上面卡住了（日志 22000 多行、append-only、
        最后几条可能是几天前的）。有了 `ts` 才能量出"两次按压隔多久""改完之后有没有再发"。
        '''
        if isinstance(obj, dict) and 'ts' not in obj:
            obj = dict(obj)
            obj['ts'] = int(time.time() * 1000)
        line = json.dumps(obj, ensure_ascii=False)
        try:
            if self._out:
                self._out.write(line + '\n')
                self._out.flush()
        except Exception:
            pass
        try:
            print(line, flush=True)
        except Exception:
            pass

    def row_of(self, usage):
        """这个 usage 对应的映射行（没有就是空 dict）。"""
        button = USAGE_TO_BUTTON.get(usage)
        if button is None:
            return {}
        return self.mapping.get(button) or {}

    def has_slot(self, usage, slot):
        """这个键配了某个档位吗（单击/双击/长按）。松手要不要等双击窗口就看它。"""
        return bool(self.row_of(usage).get(slot))

    def fire(self, usage, slot):
        button = USAGE_TO_BUTTON.get(usage)
        if button is None:
            self.emit({'type': 'unmapped', 'usage': usage, 'slot': slot})
            return
        row = self.mapping.get(button) or {}
        action = row.get(slot)
        if not action:
            return
        kind = action.get('type')
        value = action.get('combo') or ''
        ok, err = False, ''
        try:
            if is_move(value):
                ok = move(value)
                if slot == 'hold':
                    self.start_move_repeat(value)
            elif kind == 'app':
                ok = launch(value)
            elif kind == 'holdkey':
                if slot == 'hold':
                    hold_down(value)
                    with self.lock:
                        self.held[usage] = value
                    ok = True
                else:
                    combo(value)
                    ok = True
            else:
                combo(value)
                ok = True
        except Exception as e:
            err = str(e)
        self.emit({'type': 'fire', 'button': button, 'slot': slot, 'action': value,
                   'ok': ok, 'error': err})

    def start_move_repeat(self, action):
        self.stop_move_repeat()
        self.move_action = action

        def tick():
            if self.move_action is None:
                return
            move(self.move_action)
            self.move_timer = threading.Timer(0.06, tick)
            self.move_timer.daemon = True
            self.move_timer.start()

        self.move_timer = threading.Timer(0.22, tick)
        self.move_timer.daemon = True
        self.move_timer.start()

    def stop_move_repeat(self):
        self.move_action = None
        if self.move_timer is not None:
            try:
                self.move_timer.cancel()
            except Exception:
                pass
            self.move_timer = None

    def on_key(self, usage, down):
        with self.lock:
            st = self.state.setdefault(usage, {'down': False, 'at': 0.0, 'hold': None,
                                               'click': None, 'pending_double': False,
                                               'hold_fired': False})
            now = time.time()
            if down:
                if st['down']:
                    return
                st['down'] = True
                st['at'] = now
                st['hold_fired'] = False
                if st['click'] is not None:
                    st['click'].cancel()
                    st['click'] = None
                    st['pending_double'] = True
                else:
                    st['pending_double'] = False
                t = threading.Timer(HOLD_MS / 1000.0, self._on_hold, args=(usage,))
                t.daemon = True
                st['hold'] = t
                t.start()
            else:
                if not st['down']:
                    return
                st['down'] = False
                if st['hold'] is not None:
                    st['hold'].cancel()
                    st['hold'] = None
                # 物理松开时，先把"按住不放"型的键放开
                combo_held = self.held.pop(usage, None)
                if combo_held:
                    try:
                        hold_up(combo_held)
                    except Exception as e:
                        self.emit({'type': 'release', 'usage': usage, 'action': combo_held,
                                   'ok': False, 'error': str(e)})
                    else:
                        self.emit({'type': 'release', 'usage': usage, 'action': combo_held, 'ok': True})
                '''
                ★ 松开时**必须把"长按连续移动鼠标"的循环停掉**。
                原来这里只处理了 holdkey 型的"按住不放"，没管移动循环 ——
                于是长按方向键开始移动之后**一直移下去停不下来**（用户 2026-10-11 报的）。
                '''
                if self.move_action is not None:
                    self.stop_move_repeat()
                    self.emit({'type': 'move-stop', 'usage': usage})
                if st['hold_fired']:
                    return
                double_now = st['pending_double']
                st['pending_double'] = False
                if double_now:
                    self.fire(usage, 'double')
                elif self.has_slot(usage, 'double'):
                    '''
                    这个键**配了双击动作** → 必须等双击窗口过去，才能确定"这不是双击的第一下"。
                    代价是单击固定慢 DOUBLE_MS。
                    '''
                    def fire_click(btn=usage):
                        with self.lock:
                            s = self.state.get(btn)
                            if s is not None:
                                s['click'] = None
                        self.fire(btn, 'click')

                    t = threading.Timer(DOUBLE_MS / 1000.0, fire_click)
                    t.daemon = True
                    st['click'] = t
                    t.start()
                else:
                    '''
                    这个键**没配双击动作** → 松手立刻执行，一秒都不用等。
                    这是手感的关键：原来不分青红皂白一律等 320ms，
                    而多数键（TV / 电源 / 主页…）根本没配双击，那 320ms 是白等的
                    —— 实测它是整条延迟里最大的一段（约占八成），表现就是"慢半拍"。
                    '''
                    self.fire(usage, 'click')

    def _on_hold(self, usage):
        with self.lock:
            st = self.state.get(usage)
            if st is None or not st['down']:
                return
            st['hold_fired'] = True
            st['hold'] = None
        self.fire(usage, 'hold')


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


def main():
    args = sys.argv[1:]
    config = file_path = out_path = None
    verbose = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--config' and i + 1 < len(args):
            config = args[i + 1]; i += 2; continue
        if a == '--file' and i + 1 < len(args):
            file_path = args[i + 1]; i += 2; continue
        if a == '--out' and i + 1 < len(args):
            out_path = args[i + 1]; i += 2; continue
        if a == '--verbose':
            verbose = True
        i += 1
    if not config or not os.path.exists(config):
        print('config-missing: %s' % config, flush=True)
        return 2
    if not file_path:
        print('file-missing（用 --file 指定采集器写的 JSON 行文件）', flush=True)
        return 2

    with open(config, 'r', encoding='utf-8') as f:
        doc = json.load(f)
    mapping = doc.get('buttons') or {}

    eng = Engine(mapping, out_path, verbose)
    lv = self_integrity()
    eng.emit({'type': 'ready', 'mode': 'read', 'impl': 'python', 'file': file_path,
              'buttons': len(mapping), 'usages': len(USAGE_TO_BUTTON),
              'integrity': lv})

    held = set()
    '''
    `offset = None` 表示"起点还没定" —— 第一次看到 keys.jsonl 时把它定成**当时的文件末尾**，
    也就是只处理**从这一刻起新写进来的行**，不重放历史。

    ★ 为什么必须这样（2026-10-11 用户报的 bug）：
      原来是 `offset = 0`，于是**每次引擎启动都把 keys.jsonl 里的全部历史事件重放一遍**，
      每个配置好的动作各触发一次。触发路径是：
          刷新 DSH 页面 → 客户端挂载时调 /bridge/auto → 杀掉旧引擎、起一个新引擎
          → 新引擎 offset=0 → 从头发读 180 行历史 → 所有快捷键被"全部触发一次"
      用户的原话：「每次刷新 DSH 的页面之后，所有遥控上的快捷键就会被全部触发一次」。

    ⚠️ 但 `size < offset` 时仍然要 `offset = 0`（下面的循环里有）：那是**文件被截断**的情形
      （链路重拉会重建 keys.jsonl），截断后的内容全是新的，从头读才对。
      这两种情形必须分开：**启动时跳过历史 ≠ 截断后重读**。
    '''
    offset = None
    pending = ''
    read_error_reported = False
    # 映射文件的热重载：记住上次读到的 mtime，变了就重读。
    # 原来只在启动时读一次，面板里改完必须重启引擎才生效（用户 2026-10-11 反馈"绑定之后没立即生效"）。
    mapping_mtime = None
    try:
        mapping_mtime = os.path.getmtime(config)
    except OSError:
        pass
    reload_check_at = 0.0
    while True:
        try:
            # 每秒检查一次映射文件有没有被改过（很便宜，不影响按键延迟）
            now_check = time.time()
            if now_check - reload_check_at > 1.0:
                reload_check_at = now_check
                try:
                    mt = os.path.getmtime(config)
                    if mapping_mtime is None or mt > mapping_mtime:
                        with open(config, 'r', encoding='utf-8') as mf:
                            doc2 = json.load(mf)
                        new_map = doc2.get('buttons') or {}
                        eng.mapping = new_map
                        mapping_mtime = mt
                        eng.emit({'type': 'mapping-reloaded', 'buttons': len(new_map)})
                except Exception as e:
                    eng.emit({'type': 'error', 'where': 'mapping-reload', 'error': str(e)})

            if not os.path.exists(file_path):
                time.sleep(0.2); continue
            size = os.path.getsize(file_path)
            if offset is None:
                # 首次看到文件：起点定在当前末尾 —— 只处理新行，不重放历史（理由见上面 offset 那段）
                offset = size
                eng.emit({'type': 'tail-from-end', 'bytes': size})
            if size < offset:
                # 文件被截断（链路重拉会重建它）⇒ 剩下的内容全是新的，从头读
                offset = 0; held.clear()
            if size > offset:
                '''
                用**二进制**模式按字节偏移读。文本模式下 TextIOWrapper.seek() 只接受 tell()
                返回的"cookie"，拿字节数去 seek 会抛异常 —— 而外层是宽泛的 except，
                异常被吞掉的表现就是"就绪行打出来了、之后一个字都没有"（2026-10-11 踩过）。
                '''
                with open(file_path, 'rb') as f:
                    f.seek(offset)
                    chunk = f.read().decode('utf-8', errors='replace')
                    offset = f.tell()
                pending += chunk
        except Exception as e:
            # 不能再静默：读文件失败必须留痕，否则外面看到的就是"引擎在跑但没反应"
            if not read_error_reported:
                read_error_reported = True
                eng.emit({'type': 'error', 'where': 'tail', 'error': str(e), 'file': file_path})
            time.sleep(0.2); continue

        while '\n' in pending:
            line, pending = pending.split('\n', 1)
            # 容忍 BOM：Windows PowerShell 的 `Add-Content -Encoding UTF8` 会写出 BOM，
            # 那样首行是 '\ufeff{...}'，startswith('{') 判否 → 整行被静默跳过（2026-10-11 实测到过）。
            line = line.strip().lstrip('\ufeff')
            if not line or not line.startswith('{'):
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            usages = obj.get('usages')
            if not isinstance(usages, list):
                continue
            now = set()
            for u in usages:
                try:
                    v = int(u)
                except Exception:
                    continue
                if v:
                    now.add(v)
            for u in list(held):
                if u not in now:
                    held.discard(u)
                    if verbose:
                        eng.emit({'type': 'key', 'usage': u,
                                  'button': USAGE_TO_BUTTON.get(u, ''), 'down': False})
                    eng.on_key(u, False)
            for u in now:
                if u not in held:
                    held.add(u)
                    if verbose:
                        eng.emit({'type': 'key', 'usage': u,
                                  'button': USAGE_TO_BUTTON.get(u, ''), 'down': True})
                    eng.on_key(u, True)
        time.sleep(0.006)   # 轮询间隔：20ms 太钝，按键要等它一轮


if __name__ == '__main__':
    sys.exit(main())
