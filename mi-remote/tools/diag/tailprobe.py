# tailprobe.py —— 单独验证"跟着文件读新行"这段逻辑本身对不对。
# 2026-10-11：read-engine.py 打出了 ready 行却再也读不到任何按键，而异常也没冒出来，
# 所以把这段逻辑单独拎出来跑，确认问题在逻辑还是在别处。
import os
import sys
import time

fp = sys.argv[1]
offset = 0
pending = ''
for i in range(25):
    try:
        exists = os.path.exists(fp)
        size = os.path.getsize(fp) if exists else -1
        if exists and size > offset:
            with open(fp, 'rb') as f:
                f.seek(offset)
                chunk = f.read().decode('utf-8', errors='replace')
                offset = f.tell()
            pending += chunk
            print('[%d] size=%d offset=%s 读到 %d 字节: %r' % (i, size, offset, len(chunk), chunk[:70]), flush=True)
        else:
            print('[%d] exists=%s size=%d offset=%s 无新内容' % (i, exists, size, offset), flush=True)
    except Exception as e:
        print('[%d] 异常: %r' % (i, e), flush=True)
    time.sleep(0.4)
