# test-buttons.py —— 逐键测试：每个已绑定的按键 × 每一档（单击/双击/长按）都过一遍。
#
# 为什么要有它：单键测过不代表整套没问题（曾经出现"多个引擎同时跑→音量触发两次"，
# 单看一个键是正常的）。这个脚本**从 mapping.json 自动生成用例**，映射一改就能重跑。
#
# 判据：每次操作必须**恰好触发 1 次**，且 slot 和 action 都和映射一致。
#       触发 0 次 = 没生效；触发 ≥2 次 = 有重复注入（多半是引擎实例不唯一）。
#
# 用法：python tools\test-buttons.py
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYS = os.path.join(ROOT, 'state', 'keys.jsonl')
RUNLOG = os.path.join(ROOT, 'state', 'bridge-run.jsonl')
MAPPING = os.path.join(ROOT, 'state', 'mapping.json')

# 遥控器用法码 → 按键名（和引擎的 USAGE_TO_BUTTON 保持一致）
USAGE = {
    'back': 0x00F1, 'ok': 0x0028, 'tv': 0x0035, 'home': 0x004A,
    'right': 0x004F, 'left': 0x0050, 'down': 0x0051, 'up': 0x0052,
    'menu': 0x0065, 'power': 0x0066, 'volmute': 0x007F,
    'volup': 0x0080, 'voldown': 0x0081, 'voice': 0x003E,
}
ORDER = ['ok', 'up', 'down', 'left', 'right', 'back', 'home', 'menu', 'tv',
         'volup', 'voldown', 'power', 'volmute', 'voice']


def write(usages):
    with open(KEYS, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'usages': usages, 'names': [], 't': int(time.time() * 1000)}) + '\n')
        f.flush()


def log_len():
    try:
        with open(RUNLOG, 'r', encoding='utf-8', errors='replace') as f:
            return len(f.read().splitlines())
    except OSError:
        return 0


def read_since(n):
    try:
        with open(RUNLOG, 'r', encoding='utf-8', errors='replace') as f:
            return f.read().splitlines()[n:]
    except OSError:
        return []


def act(usage, kind):
    """按一次。kind: click=短按 / hold=长按 / double=双击。"""
    long_ms = 0.9 if kind == 'hold' else 0.20
    if kind == 'double':
        for i in range(2):
            write([usage]); time.sleep(0.12); write([])
            if i == 0:
                time.sleep(0.12)
    else:
        write([usage]); time.sleep(long_ms); write([])
    time.sleep(1.6)     # 等判定窗口走完（双击窗口 320ms + 余量）


def main():
    with open(MAPPING, 'r', encoding='utf-8') as f:
        buttons = (json.load(f).get('buttons') or {})

    cases = []
    for name in ORDER:
        row = buttons.get(name) or {}
        for kind in ('click', 'double', 'hold'):
            a = row.get(kind)
            if not a:
                continue
            cases.append((name, kind, a.get('combo') or '?', a.get('label') or ''))

    if not cases:
        print('  映射里没有任何已配置的动作')
        return 1

    print('  用例 %d 个（从 mapping.json 自动生成）' % len(cases))
    print('')
    print('  %-9s %-7s %-16s %-6s %s' % ('按键', '档位', '期望动作', '结果', '实际'))
    print('  ' + '-' * 74)

    bad = 0
    for name, kind, expect, label in cases:
        usage = USAGE.get(name)
        if usage is None:
            print('  %-9s %-7s %-16s %-6s 未知按键' % (name, kind, expect, '跳过'))
            continue
        n0 = log_len()
        act(usage, kind)
        fires = [l for l in read_since(n0) if '"fire"' in l]
        got = []
        for l in fires:
            try:
                o = json.loads(l)
                got.append('%s:%s' % (o.get('slot'), o.get('action')))
            except Exception:
                got.append('?')
        ok = (len(fires) == 1 and got[0] == '%s:%s' % (kind, expect))
        if not ok:
            bad += 1
        mark = '通过' if ok else '★失败'
        print('  %-9s %-7s %-16s %-6s %s' % (name, kind, expect, mark, ', '.join(got) if got else '（无触发）'))
        time.sleep(0.4)

    print('')
    if bad == 0:
        print('  全部通过：%d 个用例，每个都恰好触发一次、动作与映射一致。' % len(cases))
    else:
        print('  ★ 有 %d 个用例不通过（见上）。' % bad)
        print('    触发 0 次 → 没生效；触发 ≥2 次 → 多半有多个引擎在跑，跑 tools\\kill-strays.ps1 清掉。')
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
