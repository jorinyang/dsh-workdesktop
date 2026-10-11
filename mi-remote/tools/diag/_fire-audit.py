# _fire-audit.py —— 查"引擎有没有在没人按键的情况下自己执行动作"。
#
# 用户报「时不时跳出搜索框」。搜索框 = Ctrl+Alt+K = 主页单击。
# 所以要么是主页被按了，要么是引擎凭空执行了。这个脚本把日志按时间摊开，
# 逐条对齐"按键事件"和"执行事件"，并把**没有对应按键的执行**单独挑出来。
import json
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, 'state', 'bridge-run.jsonl')

rows = []
with open(LOG, 'r', encoding='utf-8', errors='replace') as f:
    for line in f:
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue

if not rows:
    print('  日志是空的')
    sys.exit(0)

print('  日志共 %d 条' % len(rows))

# 只看最后 N 条，避免远古噪声
tail = rows[-400:]
print('  分析最后 %d 条' % len(tail))
print('')

# 1) 按键事件统计
keys = [r for r in tail if r.get('type') == 'key']
fires = [r for r in tail if r.get('type') == 'fire']
print('  按键事件 %d 条 · 执行事件 %d 条' % (len(keys), len(fires)))
print('')

# 2) 每个 down 是不是都有对应的 up
pending = {}
unpaired = []
for r in keys:
    u = r.get('usage')
    if r.get('down'):
        if u in pending:
            unpaired.append(('重复按下（上一个还没松开）', u, r))
        pending[u] = r
    else:
        if u not in pending:
            unpaired.append(('凭空松开（没有对应按下）', u, r))
        else:
            pending.pop(u, None)
if pending:
    for u, r in pending.items():
        unpaired.append(('只按下没松开（可能卡住）', u, r))

if unpaired:
    print('  ⚠ 不成对的按键事件 %d 条：' % len(unpaired))
    for kind, u, r in unpaired[:12]:
        print('     %-28s usage=%-5s %s' % (kind, u, json.dumps(r, ensure_ascii=False)[:90]))
else:
    print('  ✓ 所有按键事件都成对（按下↔松开），没有卡住的键')
print('')

# 3) 每个 fire 之前是否有对应的 key up
print('  执行事件逐条核对（看它前面有没有对应的松开）：')
last_key_by_usage = {}
idx_of_key = {}
for i, r in enumerate(tail):
    if r.get('type') == 'key':
        last_key_by_usage[r.get('usage')] = r
        idx_of_key[r.get('usage')] = i

suspicious = 0
for i, r in enumerate(tail):
    if r.get('type') != 'fire':
        continue
    # 找同一个按键最近一次 key 事件
    btn = r.get('button')
    usage = None
    for u, kr in last_key_by_usage.items():
        if kr.get('button') == btn and idx_of_key.get(u, -1) < i:
            usage = u
    gap = (i - idx_of_key.get(usage, -1)) if usage is not None else None
    ok = usage is not None and gap is not None and gap <= 8
    if not ok:
        suspicious += 1
        print('     ★ 可疑: idx=%d %s  最近同键事件距离=%s' % (i, json.dumps(r, ensure_ascii=False)[:100], gap))
if suspicious == 0:
    print('     ✓ 每个执行事件前面都有对应的按键事件，没有"凭空执行"')
print('')

# 4) 执行事件的间隙 —— 有没有人在没按的时候执行
print('  最后 20 条执行事件（button / slot / action）：')
for r in fires[-20:]:
    print('     %-7s %-7s %s' % (r.get('button'), r.get('slot'), r.get('action')))
print('')

# 5) home 键的详细轨迹（搜索框 = Ctrl+Alt+K = 主页单击，重点看它）
print('  主页(home) 最近 20 条相关事件：')
home = [r for r in tail if r.get('button') == 'home']
for r in home[-20:]:
    if r.get('type') == 'key':
        print('     key  %s' % ('按下' if r.get('down') else '松开'))
    else:
        print('     fire %s → %s' % (r.get('slot'), r.get('action')))
