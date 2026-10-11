# _combotest.py —— 验证组合键解析（含 Esc+Esc 这种"同一个键连按两下"）
import sys

src = open(r'engine\read-engine.py', encoding='utf-8').read().split('if __name__')[0]
ns = {'__name__': 'readengine'}
exec(compile(src, 'read-engine.py', 'exec'), ns)
parse_combo = ns['parse_combo']

for c in ['Esc+Esc', 'Enter', 'Ctrl+Alt+B', 'Shift+Enter', 'ArrowUp', 'Ctrl+Alt+K']:
    try:
        print('  %-14s -> %s' % (c, [hex(v) for v in parse_combo(c)]))
    except Exception as ex:
        print('  %-14s -> 错误: %s' % (c, ex))
