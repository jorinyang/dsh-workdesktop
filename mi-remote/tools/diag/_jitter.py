# _jitter.py —— 用采集器写的 ht（hook 真实时间戳）分析按键抖动的真实节奏。
#
# 背景：用户报"页面持续刷新 + 反复触发工作区搜索/鼠标左右键"。
# 怀疑是采集器把一次按键写成了"按下-松开-按下-松开"的交替序列，引擎照单全收、反复执行。
# 之前 150ms 才排空一次队列，写文件时打的时间戳抹平了真实间隔，看不出节奏。
# 现在 hook 侧带了 ht，可以量准。
import json
import os
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYS = os.path.join(ROOT, 'state', 'keys.jsonl')

rows = []
with open(KEYS, 'r', encoding='utf-8', errors='replace') as f:
    for line in f:
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if 'usages' not in o:
            continue
        rows.append(o)

print('  按键报告共 %d 条' % len(rows))
if not rows:
    sys.exit(0)

# 只留有 ht 的（新采集器才有）
have_ht = [r for r in rows if r.get('ht')]
print('  其中带 ht（hook 真实时间戳）的 %d 条' % len(have_ht))
print('')

# 统计：同一组 usages 连续出现多少次（这就是"重复注入"的直接来源）
runs = []
prev_key = None
count = 0
for r in rows:
    k = tuple(r.get('usages') or [])
    if k == prev_key:
        count += 1
    else:
        if prev_key is not None:
            runs.append((prev_key, count))
        prev_key = k
        count = 1
if prev_key is not None:
    runs.append((prev_key, count))

print('  连续相同集合的"段"共 %d 个，段长分布：' % len(runs))
for length, n in sorted(Counter(l for _, l in runs).items()):
    print('    长度 %-3d : %d 段' % (length, n))

# 交替模式：非空/空 交替多少次
alt = 0
for i in range(1, len(rows)):
    a = bool(rows[i - 1].get('usages'))
    b = bool(rows[i].get('usages'))
    if a != b:
        alt += 1
print('')
print('  空/非空 交替次数：%d（占 %d 条报告的 %.0f%%）' % (alt, len(rows), 100.0 * alt / max(1, len(rows) - 1)))

# 用 ht 算：同一个 usage 的按下→松开→再按下 间隔
if len(have_ht) >= 3:
    print('')
    print('  真实时间轴（ht）上的前 30 条：')
    t0 = have_ht[0]['ht']
    prev_t = None
    for r in have_ht[:30]:
        dt = '' if prev_t is None else ('+%dms' % (r['ht'] - prev_t))
        prev_t = r['ht']
        print('    +%-7d %-22s %s' % (r['ht'] - t0, str(r.get('usages')), dt))

    # 找"同 usage 的 松开→再按下"间隔
    gaps = []
    last_present_t = {}
    last_absent = {}
    for r in have_ht:
        now = set(r.get('usages') or [])
        allu = set(last_present_t) | now
        for u in allu:
            if u in now:
                if u in last_absent:
                    gaps.append((r['ht'] - last_absent[u], u))
                    del last_absent[u]
                last_present_t[u] = r['ht']
            else:
                if u in last_present_t:
                    last_absent[u] = r['ht']
                    del last_present_t[u]
    if gaps:
        gs = sorted(g for g, _ in gaps)
        print('')
        print('  "松开→再按下"的间隔（%d 次）：' % len(gs))
        print('    最小 %dms  中位 %dms  最大 %dms' % (gs[0], gs[len(gs) // 2], gs[-1]))
        print('    分布：', ', '.join('%dms×%d' % (k, v) for k, v in sorted(Counter(gs).items())[:12]))
