// keytap.cs —— 专职的"遥控器按键采集器"。
//
// 为什么单独做一个：主引擎 KeyBridge.cs 的钩子一直收不到真实硬件按键，而下面这个极简结构
// **实测能收到**（2026-10-11 hooktest：遥控器的 主页/菜单/TV/电源/方向键/OK/语音键 全部以
// (REAL) 收到）。与其继续在主引擎里猜"到底哪一处让钩子失效"，不如把"收键"这件事交给一个
// 已经验证过的最小程序，职责分开：
//   keytap.exe   —— 只收键，追加成 JSON 行写入文件（不判定、不注入、不碰别的）
//   KeyBridge    —— 读这个文件，做单击/双击/长按判定与注入（这部分本来就是好的）
//
// 设计上刻意与 hooktest 保持一字不差：同样的 SetWindowsHookExW 参数、同样的纯 GetMessageW
// 消息循环、回调里直接写（实测这样能工作）。唯一区别是输出格式改成一行一个 JSON，方便机器读。
//
// 编译：csc /target:exe /platform:x64 /out:keytap.exe keytap.cs
// 用法：keytap.exe --out <路径> [--seconds N]     （--seconds 0 或不给 = 一直跑）
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class KeyTap
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYUP = 0x0105;
    private const uint LLKHF_INJECTED = 0x00000010;

    private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookExW(int idHook, LowLevelKeyboardProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PeekMessageW(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    private const uint PM_NOREMOVE = 0x0000;
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessageW(ref MSG msg);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    private static readonly LowLevelKeyboardProc Callback = OnKey;   // 必须持引用
    private static IntPtr _hook = IntPtr.Zero;
    private static StreamWriter _out;

    private static void Write(string line)
    {
        // 与 hooktest 保持一致：直接写，不搞队列/后台线程（那套实测反而把真实按键弄丢过）。
        try { if (_out != null) { _out.WriteLine(line); _out.Flush(); } } catch (Exception) { }
        try { if (GetConsoleWindow() != IntPtr.Zero) { Console.WriteLine(line); Console.Out.Flush(); } } catch (Exception) { }
    }

    private static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            int msg = wParam.ToInt32();
            bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            bool up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if (down || up)
            {
                bool injected = (data.flags & LLKHF_INJECTED) != 0;
                Write("{\"vk\":" + data.vkCode + ",\"scan\":" + data.scanCode +
                      ",\"flags\":" + data.flags +
                      ",\"down\":" + (down ? "true" : "false") +
                      ",\"injected\":" + (injected ? "true" : "false") +
                      ",\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}");
            }
        }
        return CallNextHookEx(_hook, code, wParam, lParam);
    }

    private static int Main(string[] args)
    {
        if (GetConsoleWindow() == IntPtr.Zero) AllocConsole();

        /*
         * ⚠️ 装钩子之前，先强制把本线程的"消息队列"建出来。
         *
         * Windows 的消息队列是**惰性创建**的：线程第一次调用 USER32 函数时才建立。
         * 而低级键盘钩子的回调是**通过往消息队列投递**来送达的 —— 如果装钩子的时候队列还不存在，
         * 钩子就挂在一个"没有队列的线程"上：真实按键一个都收不到，而自己 SendInput 注入的键
         * 因为在本进程内直接派发，照样看得到（2026-10-11 就是这个现象把人带偏了一整夜）。
         * PeekMessage(PM_NOREMOVE) 不会取走任何消息，只负责"把队列建出来"。
         */
        MSG warmup;
        PeekMessageW(out warmup, IntPtr.Zero, 0, 0, PM_NOREMOVE);

        string outPath = null;
        int seconds = 0;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--out" && i + 1 < args.Length) outPath = args[++i];
            else if (args[i] == "--seconds" && i + 1 < args.Length) int.TryParse(args[++i], out seconds);
        }

        if (outPath != null)
        {
            try
            {
                _out = new StreamWriter(outPath, true, new UTF8Encoding(false)) { AutoFlush = true };
            }
            catch (Exception) { _out = null; }
        }

        /*
         * ⚠️ hMod 必须传 NULL。
         *
         * 用户 2026-10-11 实测发现的规律：传 exe 自己的模块句柄时，**只有本进程的窗口在前台
         * 才收得到按键**，焦点切到别的窗口就完全收不到。原因：传了 hMod，系统会认为"钩子过程
         * 住在那个模块里"，于是要把该模块注入到每个目标进程才能收键；而可执行文件无法被当钩子
         * DLL 注入 —— 钩子就退化成"只对本进程有效"。
         * 低级钩子（WH_KEYBOARD_LL）的回调本来就在装钩子的进程里执行，不需要任何 DLL，传 NULL 才对。
         * （注入的键任何时候都收得到，因为 SendInput 不依赖焦点 —— 这一点一直误导排查方向。）
         */
        _hook = SetWindowsHookExW(WH_KEYBOARD_LL, Callback, IntPtr.Zero, 0);
        if (_hook == IntPtr.Zero)
        {
            Write("{\"type\":\"error\",\"error\":\"sethook-failed\",\"code\":" + Marshal.GetLastWin32Error() + "}");
            return 1;
        }
        Write("{\"type\":\"ready\",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}");

        if (seconds > 0)
        {
            var timer = new Timer(_ => Environment.Exit(0), null, seconds * 1000, Timeout.Infinite);
            GC.KeepAlive(timer);
        }

        MSG msg;
        while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }
        UnhookWindowsHookEx(_hook);
        return 0;
    }
}
