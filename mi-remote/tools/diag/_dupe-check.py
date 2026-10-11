# _dupe-check.py —— 确认"一次注入会不会被发两遍"。
#
# 现象：诊断页上，一次 inject.py "Ctrl+Alt+Q" 却收到两轮完全相同的
#   ControlLeft↓ AltLeft↓ KeyQ↓ KeyQ↑ AltLeft↑ ControlLeft↑
# 如果属实，那"音量键触发两次"之类的毛病就不只是多引擎造成的。
#
# 做法：直接数 SendInput 的调用次数和返回，不经浏览器。
import ctypes
import sys
import time
from ctypes import wintypes

sys.path.insert(0, 'engine')
import importlib.util

spec = importlib.util.spec_from_file_location('inj', r'engine\inject.py')
inj = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inj)

user32 = inj.user32
INPUT = inj.INPUT
_orig = user32.SendInput


calls = []


def counting_send(n, ptr, size):
    # 记录每一次 SendInput 请求：几个事件、什么标志
    inp = ctypes.cast(ptr, ctypes.POINTER(INPUT))[0]
    calls.append({
        'n': n,
        'type': inp.type,
        'vk': inp.u.ki.wVk,
        'scan': inp.u.ki.wScan,
        'flags': inp.u.ki.dwFlags,
    })
    return _orig(n, ptr, size)


# 把 SendInput 换成计数版（只统计，行为不变）
user32.SendInput = counting_send

for combo in ['Ctrl+Alt+Q', 'F9', 'Ctrl+Alt+B']:
    calls.clear()
    ok, err = inj.send(combo)
    print('  %-14s send() -> ok=%s  共 %d 次 SendInput:' % (combo, ok, len(calls)))
    for c in calls:
        up = 'UP' if (c['flags'] & 2) else 'down'
        ext = ' EXT' if (c['flags'] & 1) else ''
        print('      vk=0x%02X scan=0x%02X %s%s' % (c['vk'], c['scan'], up, ext))
    time.sleep(0.3)
