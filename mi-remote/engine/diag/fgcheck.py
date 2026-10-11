# fgcheck.py —— 一次问清"注入能不能到达前台窗口"。
#
# 为什么用 Python 写：这台机器上 360 的沙箱驱动把**未签名的可执行文件**降级到低完整性，
# 而低完整性进程**读不到**更高完整性进程的令牌（OpenProcessToken 被拒），
# 所以之前用 C# 写的 fgcheck.exe 永远读不到浏览器那一侧，结论也就不可信。
# python.exe 有数字签名，实测跑在 High(12288)，能读到。
#
# 用法：python fgcheck.py
import ctypes
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
advapi32 = ctypes.WinDLL('advapi32', use_last_error=True)

advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
advapi32.OpenProcessToken.restype = wintypes.BOOL
advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                         wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
advapi32.GetTokenInformation.restype = wintypes.BOOL
kernel32.GetCurrentProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TokenIntegrityLevel = 25


def integrity_of_token(token):
    size = wintypes.DWORD(0)
    advapi32.GetTokenInformation(token, TokenIntegrityLevel, None, 0, ctypes.byref(size))
    if size.value == 0:
        return -1
    buf = ctypes.create_string_buffer(size.value)
    if not advapi32.GetTokenInformation(token, TokenIntegrityLevel, buf, size.value, ctypes.byref(size)):
        return -1
    sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
    count = ctypes.cast(sid, ctypes.POINTER(ctypes.c_ubyte))[1]
    if count <= 0:
        return -1
    return ctypes.cast(sid + 8 + (count - 1) * 4, ctypes.POINTER(ctypes.c_int))[0]


def self_integrity():
    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), TOKEN_QUERY, ctypes.byref(token)):
        return -1
    return integrity_of_token(token)


def process_integrity(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return -1, ctypes.get_last_error()
    try:
        token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(h, TOKEN_QUERY, ctypes.byref(token)):
            return -1, ctypes.get_last_error()
        return integrity_of_token(token), 0
    finally:
        kernel32.CloseHandle(h)


def name_of(level):
    if level < 0:
        return '读不到'
    if level >= 0x4000:
        return 'System(系统)'
    if level >= 0x3000:
        return 'High(管理员)'
    if level >= 0x2000:
        return 'Medium(普通)'
    if level >= 0x1000:
        return 'Low(低)'
    return 'Untrusted(不可信 %d)' % level


def main():
    me = self_integrity()
    hwnd = user32.GetForegroundWindow()
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    fg, err = process_integrity(pid.value)

    # 取前台窗口的进程名（用任务列表，避免依赖 psutil）
    pname = '?'
    try:
        out = __import__('subprocess').run(
            ['tasklist', '/FI', 'PID eq %d' % pid.value, '/FO', 'CSV', '/NH'],
            capture_output=True, text=True, timeout=10).stdout.strip()
        if out:
            pname = out.split(',')[0].strip('"')
    except Exception:
        pass

    # 窗口标题
    title = ''
    try:
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, buf, 512)
        title = buf.value
    except Exception:
        pass

    print('  我自己            = %s (%d)' % (name_of(me), me))
    print('  前台窗口          = %s (pid=%d)' % (pname, pid.value))
    if title:
        print('  窗口标题          = %s' % title[:70])
    print('  它的级别          = %s%s' % (name_of(fg), '' if fg >= 0 else '  (err=%d)' % err))
    allowed = me >= 0 and fg >= 0 and me >= fg
    print('  → 我能往里注入吗  = %s' % ('能' if allowed else '不能（会被 UIPI 静默丢弃，SendInput 仍返回成功）'))


if __name__ == '__main__':
    main()
