# _replay-test.py —— 精确复现"刷新页面 → 所有快捷键被触发一次"，并验证修复。
#
# 用户报的场景：
#   刷新 DSH 页面 → 面板挂载 → POST /bridge/auto
#   → 采集器还在跑（复用分支）→ 只起一个新引擎、**不动 keys.jsonl**
#   → 新引擎原来 offset=0 → 从头发读全部历史 → 每个配置好的动作各触发一次
#
# 这个脚本复现它：先往 keys.jsonl 里塞几组"会触发动作"的历史事件，
# 再调 /bridge/auto（走复用分支），然后数引擎执行了几次。
#
# 期望：0 次。修复前会是"每个动作一次"。
import json
import os
import sys
import time
import urllib.request

# 脚本在 tools/diag/ ⇒ 上提三层才是插件根（tools/diag → tools → 插件根）
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KEYS = os.path.join(ROOT, 'state', 'keys.jsonl')
LOG = os.path.join(ROOT, 'state', 'bridge-run.jsonl')

BASE = 'http://127.0.0.1:3080'


def post(path, body):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def count_fires():
    if not os.path.exists(LOG):
        return 0
    n = 0
    with open(LOG, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            if '"fire"' in line and '"type": "fire"' in line:
                n += 1
    return n


# 造几组"按下→松开"的历史事件。ok 单击 = Ctrl+Alt+F、back 单击 = Backspace、home 单击 = Ctrl+Alt+K
# —— 只要被重放，日志里就会各出现一次 fire。
SYNTH = [
    (40, 'ok'), (241, 'back'), (74, 'home'), (53, 'tv'), (98, 'menu'),
]
now = int(time.time() * 1000)
lines = []
t = now - 60000          # 一分钟前，明确是"历史"
for usage, name in SYNTH:
    lines.append(json.dumps({'usages': [usage], 'names': [name], 'latch': False,
                             'toggled': False, 'ht': t, 't': t}))
    t += 300
    lines.append(json.dumps({'usages': [], 'names': [], 'latch': False,
                             'toggled': False, 'ht': t, 't': t}))
    t += 300

before_size = os.path.getsize(KEYS) if os.path.exists(KEYS) else 0
with open(KEYS, 'a', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')
after_size = os.path.getsize(KEYS)
print('  往 keys.jsonl 追加了 %d 行历史事件（%d → %d 字节）' % (len(lines), before_size, after_size))
print('  这 %d 个键如果被重放，日志里会出现 %d 次 fire' % (len(SYNTH), len(SYNTH)))

# 清空引擎日志，好干净地数
open(LOG, 'w', encoding='utf-8').close()
print('  已清空引擎日志')

print('')
print('  调 /bridge/auto（等价于刷新页面触发的那一次）…')
try:
    res = post('/bridge/auto', {})
    print('    → ok=%s reused=%s enginePid=%s collectorPid=%s'
          % (res.get('ok'), res.get('reused'), res.get('enginePid'), res.get('collectorPid')))
except Exception as e:
    print('    ★ 调用失败: %s' % e)
    sys.exit(2)

time.sleep(9)
fires = count_fires()
print('')
print('  引擎启动后执行的动作数：%d' % fires)
print('')
if fires == 0:
    print('  ✓ 没有重放 —— 修复生效')
else:
    print('  ★ 仍然重放 %d 次 —— 修复没生效，或还有另一条重放路径' % fires)

# 看引擎有没有报 tail-from-end
if os.path.exists(LOG):
    with open(LOG, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            if 'tail-from-end' in line:
                print('  引擎自报：' + line.strip()[:150])
                break
