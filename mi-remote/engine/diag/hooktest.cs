// hooktest.cs —— 最小钩子测试：只做"装一个低级键盘钩子 + 把收到的按键打到控制台"。
//
// 为什么要单独写这个：主引擎 KeyBridge.cs 在 2026-10-11 一夜之间改了很多处
// （Emit 的写法、SetWindowsHookEx 的 hMod 参数、隐藏/分配控制台……），而"曾经能收到
// 真实按键"的那版源码没有备份。与其继续在主引擎里猜，不如用一个"什么都不带的"最小程序
// 把责任分清：
//   · 它能收到真实按键 → 问题在主引擎的某处改动，逐条比即可
//   · 它也收不到       → 问题在系统环境（钩子链脏了），重启即可
//
// 编译：csc /target:exe /platform:x64 /out:hooktest.exe hooktest.cs
// 用法：hooktest.exe        跑 60 秒，收到的每个键都打出来
//       hooktest.exe 300    跑 300 秒
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class HookTest
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

    private static readonly LowLevelKeyboardProc Callback = OnKey;   // 必须持引用，否则委托被回收
    private static IntPtr _hook = IntPtr.Zero;
    private static System.IO.StreamWriter _file;                     // --out 时同时落文件（控制台抓不回来）

    private static void Say(string line)
    {
        Console.WriteLine(line);
        Console.Out.Flush();
        if (_file != null) { _file.WriteLine(line); _file.Flush(); }
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
                Say(string.Format("KEY vk={0,-4} scan={1,-4} {2} {3}",
                    data.vkCode, data.scanCode, down ? "DOWN" : "UP  ", injected ? "(injected)" : "(REAL)"));
            }
        }
        return CallNextHookEx(_hook, code, wParam, lParam);
    }

    private static int Main(string[] args)
    {
        if (GetConsoleWindow() == IntPtr.Zero) AllocConsole();

        int seconds = 60;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--out" && i + 1 < args.Length)
                _file = new System.IO.StreamWriter(args[++i], false, new UTF8Encoding(false)) { AutoFlush = true };
            else
            {
                int parsed;
                if (int.TryParse(args[i], out parsed)) seconds = parsed;
            }
        }

        _hook = SetWindowsHookExW(WH_KEYBOARD_LL, Callback, GetModuleHandleW(null), 0);
        if (_hook == IntPtr.Zero)
        {
            Say("SetWindowsHookEx failed: " + Marshal.GetLastWin32Error());
            return 1;
        }
        Say(string.Format("HOOKED. listening {0}s. Press any key (real keyboard or remote).", seconds));

        if (seconds > 0)
        {
            var timer = new Timer(_ => { if (_file != null) { try { _file.Flush(); } catch (Exception) { } } Environment.Exit(0); },
                null, seconds * 1000, Timeout.Infinite);
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
