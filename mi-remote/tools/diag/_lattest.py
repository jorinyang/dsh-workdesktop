# _lattest.py —— 精确量"松手 → 执行"这一段花了多久。
#
# 为什么要量：用户反馈按键"慢半拍"。链路是
#   遥控器 → 采集器 → keys.jsonl → 引擎轮询读文件 → 判定 → SendInput
# 其中"等双击窗口"（320ms）原本对每个键都要走一遍，是最大的一段。
# 现在改成：**没配双击动作的键，松手立刻执行**。这个脚本就是来验证差别的。
import json
import os
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PY = sys.executable
ENGINE = os.path.join(ROOT, 'engine', 'read-engine.py')
CONFIG = os.path.join(ROOT, 'state', 'mapping.json')
KEYS = os.path.join(ROOT, 'tmp', '_lat-keys.jsonl')
OUT = os.path.join(ROOT, 'tmp', '_lat-out.jsonl')

for p in (KEYS, OUT):
    try:
        os.remove(p)
    except OSError:
        pass
open(KEYS, 'w').close()

proc = subprocess.Popen([PY, ENGINE, '--config', CONFIG, '--file', KEYS, '--out', OUT],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(3)

results = []
seen = 0


def press(usage, label):
    """按一下再松开，量从松手到 fire 的时间。"""
    global seen
    with open(KEYS, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'usages': [usage], 't': 1}) + '\n')
    time.sleep(0.12)
    t_release = time.time()
    with open(KEYS, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'usages': [], 't': 2}) + '\n')
    # 等 fire 行出现
    deadline = t_release + 3.0
    while time.time() < deadline:
        try:
            with open(OUT, 'r', encoding='utf-8') as f:
                lines = f.read().splitlines()
        except OSError:
            lines = []
        fires = [l for l in lines if '"fire"' in l]
        if len(fires) > seen:
            seen = len(fires)
            dt = (time.time() - t_release) * 1000
            results.append((label, dt, fires[-1]))
            return
        time.sleep(0.002)
    results.append((label, -1, '（超时，没有 fire）'))


# 从 mapping.json 读一下哪些键配了双击，好解释结果
with open(CONFIG, 'r', encoding='utf-8') as f:
    mapping = json.load(f).get('buttons') or {}

CASES = [
    (74, '主页', 'home'),
    (53, 'TV', 'tv'),
    (102, '电源', 'power'),
    (101, '菜单', 'menu'),
    (40, 'OK', 'ok'),
]

print('  键位       配了双击?   松手→执行')
print('  ' + '-' * 46)
for usage, label, key in CASES:
    has_double = bool((mapping.get(key) or {}).get('double'))
    press(usage, label)
    label2, dt, line = results[-1]
    dtxt = ('%.0f ms' % dt) if dt >= 0 else '超时'
    print('  %-8s  %-9s  %s' % (label, '有' if has_double else '没有', dtxt))

proc.terminate()
print('')
print('  说明：配了双击的键必须等 320ms 双击窗口过去才能确定"这不是双击的第一下"，')
print('        没配双击的键现在松手就执行，不再白等。')
