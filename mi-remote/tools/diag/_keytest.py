# _keytest.py —— 直接往采集器的输出文件里灌按键序列，测引擎的判定与执行。
#
# 为什么要它：PowerShell 传内联 Python 时引号会被吃掉，写文件最稳。
# 用法：python _keytest.py <场景>
#   hold   —— 主页按下 900ms 再松开（应触发 长按 → Ctrl+Alt+N 新建会话）
#   click  —— 返回键短按 150ms（应触发 单击 → Backspace）
#   vol    —— 音量+ 短短短地抖两下（复现"一次触发两次"）
#   volfix —— 音量+ 抖两下，但用最小间隔（看现在的行为）
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYS = os.path.join(ROOT, 'state', 'keys.jsonl')


def write(usages):
    with open(KEYS, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'usages': usages, 'names': [], 't': int(time.time() * 1000)}) + '\n')
        f.flush()


def main():
    scene = sys.argv[1] if len(sys.argv) > 1 else 'click'
    if scene == 'hold':
        # 主页（74）：按住 900ms —— 超过 650ms 的长按阈值
        write([74]); time.sleep(0.9); write([])
        print('  主页：按下 900ms 后松开')
    elif scene == 'click':
        # 返回（241）：短按 150ms
        write([241]); time.sleep(0.15); write([])
        print('  返回：短按 150ms')
    elif scene == 'vol':
        # 音量+（128）：模拟采集器那种"松了又按"的抖动
        for _ in range(2):
            write([128]); time.sleep(0.15); write([]); time.sleep(0.001)
        print('  音量+：抖动两下')
    elif scene == 'vol1':
        write([128]); time.sleep(0.15); write([])
        print('  音量+：正常按一下')
    time.sleep(2.2)


if __name__ == '__main__':
    main()
