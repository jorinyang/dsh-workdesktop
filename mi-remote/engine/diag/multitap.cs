// multitap.cs —— 多通道按键采集器：一次按键，同时用三条独立机制去收，看哪条收得到。
//
// 背景（2026-10-11）：低级键盘钩子在这台机器上**只对本进程的输入生效** —— 本进程的窗口在前台
// 时收得到遥控器按键，焦点一移到别的窗口就完全收不到；而自己 SendInput 注入的键任何情况下
// 都收得到（那条路不经过同一个检查，极具误导性）。
// 已经排除：hMod 传 exe 句柄/NULL、GetMessage/PeekMessage、WMI 启动/用户双击、关闭 360、
//           有无控制台窗口、装钩子前预建消息队列。
// 所以换三条完全独立的机制来试：
//   [A] hook      低级键盘钩子（已知只在本进程前台时有效，作为对照基线）
//   [B] rawinput  RegisterRawInputDevices + RIDEV_INPUTSINK —— 从驱动层来，专为"后台接收"设计
//   [C] keystate  GetAsyncKeyState 轮询 —— 直接查按键状态，完全不经钩子/消息
//   [D] hidread   CreateFile 直接打开遥控器的 HID 设备读原始报告
//
// 编译：csc /target:exe /platform:x64 /out:multitap.exe multitap.cs
// 用法：multitap.exe --out <路径> [--seconds N]
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class MultiTap
{
    // ── 通用 ──────────────────────────────────────────────────────────────
    private static StreamWriter _out;
    private static readonly object Gate = new object();

    private static void Emit(string json)
    {
        lock (Gate)
        {
            try { if (_out != null) { _out.WriteLine(json); _out.Flush(); } } catch (Exception) { }
            try { if (GetConsoleWindow() != IntPtr.Zero) { Console.WriteLine(json); Console.Out.Flush(); } } catch (Exception) { }
        }
    }

    private static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }

    // ── [A] 低级键盘钩子 ──────────────────────────────────────────────────
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100, WM_SYSKEYDOWN = 0x0104, WM_KEYUP = 0x0101, WM_SYSKEYUP = 0x0105;
    private const uint LLKHF_INJECTED = 0x00000010;
    private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }

    private static readonly LowLevelKeyboardProc HookProc = HookCallback;
    private static IntPtr _hook = IntPtr.Zero;

    private static IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var d = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            int m = wParam.ToInt32();
            bool down = m == WM_KEYDOWN || m == WM_SYSKEYDOWN;
            bool up = m == WM_KEYUP || m == WM_SYSKEYUP;
            if (down || up)
                Emit("{\"ch\":\"hook\",\"vk\":" + d.vkCode + ",\"scan\":" + d.scanCode +
                     ",\"down\":" + (down ? "true" : "false") +
                     ",\"injected\":" + ((d.flags & LLKHF_INJECTED) != 0 ? "true" : "false") +
                     ",\"t\":" + Now() + "}");
        }
        return CallNextHookEx(_hook, code, wParam, lParam);
    }

    // ── [B] Raw Input ─────────────────────────────────────────────────────
    private const int WM_INPUT = 0x00FF;
    private const uint RIDEV_INPUTSINK = 0x00000100;
    private const uint RID_INPUT = 0x10000003;
    private const uint RIM_TYPEKEYBOARD = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTDEVICE { public ushort usUsagePage, usUsage; public uint dwFlags; public IntPtr hwndTarget; }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTHEADER { public uint dwType, dwSize; public IntPtr hDevice, wParam; }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWKEYBOARD
    {
        public ushort MakeCode, Flags, Reserved, VKey, Message;
        public uint ExtraInformation;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WNDCLASSEX
    {
        public uint cbSize, style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public IntPtr hInstance, hIcon, hCursor, hbrBackground;
        public string lpszMenuName, lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    private static readonly WndProcDelegate WndProcKeepAlive = WndProc;
    private static IntPtr _hwnd = IntPtr.Zero;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern ushort RegisterClassExW(ref WNDCLASSEX wc);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName,
        uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")]
    private static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);
    [DllImport("user32.dll")]
    private static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string name);

    private static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_INPUT)
        {
            uint size = 0;
            GetRawInputData(lParam, RID_INPUT, IntPtr.Zero, ref size, (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER)));
            if (size > 0)
            {
                IntPtr buf = Marshal.AllocHGlobal((int)size);
                try
                {
                    if (GetRawInputData(lParam, RID_INPUT, buf, ref size, (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER))) == size)
                    {
                        var header = (RAWINPUTHEADER)Marshal.PtrToStructure(buf, typeof(RAWINPUTHEADER));
                        if (header.dwType == RIM_TYPEKEYBOARD)
                        {
                            IntPtr body = new IntPtr(buf.ToInt64() + Marshal.SizeOf(typeof(RAWINPUTHEADER)));
                            var kb = (RAWKEYBOARD)Marshal.PtrToStructure(body, typeof(RAWKEYBOARD));
                            if (kb.VKey != 0xFF && kb.VKey != 0)
                            {
                                bool down = (kb.Flags & 0x01) == 0;   // RI_KEY_BREAK = 0x01
                                Emit("{\"ch\":\"rawinput\",\"vk\":" + kb.VKey + ",\"scan\":" + kb.MakeCode +
                                     ",\"down\":" + (down ? "true" : "false") + ",\"t\":" + Now() + "}");
                            }
                        }
                    }
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            return IntPtr.Zero;
        }
        if (msg == 0x0010) { System.Diagnostics.Process.GetCurrentProcess().Kill(); return IntPtr.Zero; }  // WM_CLOSE
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    // ── [C] GetAsyncKeyState 轮询 ─────────────────────────────────────────
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vkey);

    private static readonly int[] PollKeys = { 36, 93, 192, 37, 38, 39, 40, 13, 116, 27, 8 };

    private static void PollLoop()
    {
        var held = new Dictionary<int, bool>();
        foreach (int k in PollKeys) held[k] = false;
        while (true)
        {
            foreach (int k in PollKeys)
            {
                bool now = (GetAsyncKeyState(k) & 0x8000) != 0;
                if (now != held[k])
                {
                    held[k] = now;
                    Emit("{\"ch\":\"keystate\",\"vk\":" + k + ",\"down\":" + (now ? "true" : "false") + ",\"t\":" + Now() + "}");
                }
            }
            Thread.Sleep(15);
        }
    }

    // ── [D] 直接读 HID 设备 ───────────────────────────────────────────────
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr h, byte[] buf, uint toRead, out uint read, IntPtr ov);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetRawInputDeviceList(IntPtr list, ref uint count, uint size);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetRawInputDeviceInfoW(IntPtr device, uint command, StringBuilder data, ref uint size);

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTDEVICELIST { public IntPtr hDevice; public uint dwType; }

    private const uint RIDI_DEVICENAME = 0x20000007;

    private static void HidLoop(string nameFilter)
    {
        uint count = 0;
        uint entrySize = (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICELIST));
        GetRawInputDeviceList(IntPtr.Zero, ref count, entrySize);
        if (count == 0) { Emit("{\"ch\":\"hidread\",\"error\":\"no-devices\"}"); return; }
        IntPtr list = Marshal.AllocHGlobal((int)(count * entrySize));
        var targets = new List<string>();
        try
        {
            if (GetRawInputDeviceList(list, ref count, entrySize) == uint.MaxValue) return;
            for (uint i = 0; i < count; i++)
            {
                IntPtr item = new IntPtr(list.ToInt64() + i * entrySize);
                var e = (RAWINPUTDEVICELIST)Marshal.PtrToStructure(item, typeof(RAWINPUTDEVICELIST));
                uint ns = 0;
                GetRawInputDeviceInfoW(e.hDevice, RIDI_DEVICENAME, null, ref ns);
                if (ns == 0) continue;
                var sb = new StringBuilder((int)ns + 2);
                if (GetRawInputDeviceInfoW(e.hDevice, RIDI_DEVICENAME, sb, ref ns) == uint.MaxValue) continue;
                string name = sb.ToString();
                if (name.IndexOf("HID#", StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (nameFilter.Length > 0 && name.IndexOf(nameFilter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                targets.Add(name);
            }
        }
        finally { Marshal.FreeHGlobal(list); }

        var handles = new List<IntPtr>();
        foreach (string n in targets)
        {
            // 共享读：HID 设备本来允许多客户端；不共享会被系统那套独占挡在外面。
            IntPtr h = CreateFileW(n, 0x80000000u, 0x00000001u | 0x00000002u, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (h == new IntPtr(-1))
            {
                Emit("{\"ch\":\"hidread\",\"open\":\"failed\",\"err\":" + Marshal.GetLastWin32Error() +
                     ",\"name\":" + Json(n) + "}");
                continue;
            }
            Emit("{\"ch\":\"hidread\",\"open\":\"ok\",\"name\":" + Json(n) + "}");
            handles.Add(h);
        }
        if (handles.Count == 0) return;

        foreach (IntPtr h in handles)
        {
            IntPtr captured = h;
            var th = new Thread(() =>
            {
                var buf = new byte[256];
                while (true)
                {
                    uint got;
                    if (!ReadFile(captured, buf, 256, out got, IntPtr.Zero) || got == 0) break;
                    var sb = new StringBuilder();
                    for (uint i = 0; i < got; i++) sb.Append(buf[i].ToString("X2")).Append(i + 1 < got ? " " : "");
                    Emit("{\"ch\":\"hidread\",\"len\":" + got + ",\"hex\":" + Json(sb.ToString()) + ",\"t\":" + Now() + "}");
                }
            });
            th.IsBackground = true;
            th.Start();
        }
    }

    private static string Json(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append("\"").ToString();
    }

    // ── 入口 ──────────────────────────────────────────────────────────────
    [DllImport("user32.dll")]
    private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();
    [DllImport("user32.dll")]
    private static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessageW(ref MSG msg);

    private static int Main(string[] args)
    {
        if (GetConsoleWindow() == IntPtr.Zero) AllocConsole();

        string outPath = null, nameFilter = "32b8";
        int seconds = 0;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--out" && i + 1 < args.Length) outPath = args[++i];
            else if (args[i] == "--name" && i + 1 < args.Length) nameFilter = args[++i];
            else if (args[i] == "--seconds" && i + 1 < args.Length) int.TryParse(args[++i], out seconds);
        }
        if (outPath != null) { try { _out = new StreamWriter(outPath, true, new UTF8Encoding(false)) { AutoFlush = true }; } catch (Exception) { } }

        // 消息队列先建出来（低级钩子的回调要靠它投递）
        MSG warmup;
        PeekMessageW(out warmup, IntPtr.Zero, 0, 0, 0);

        // [A] 钩子
        _hook = SetWindowsHookExW(WH_KEYBOARD_LL, HookProc, IntPtr.Zero, 0);
        Emit("{\"ch\":\"hook\",\"installed\":" + (_hook != IntPtr.Zero ? "true" : "false") +
             ",\"err\":" + (_hook != IntPtr.Zero ? 0 : Marshal.GetLastWin32Error()) + "}");

        // [B] Raw Input：注册键盘那一类 + Generic Desktop 全部，都带 RIDEV_INPUTSINK（后台可收）
        var wc = new WNDCLASSEX();
        wc.cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
        wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(WndProcKeepAlive);
        wc.lpszClassName = "MultiTapWnd";
        wc.hInstance = GetModuleHandleW(null);
        ushort atom = RegisterClassExW(ref wc);
        _hwnd = CreateWindowExW(0, "MultiTapWnd", "multitap", 0x00000000, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
        var devices = new RAWINPUTDEVICE[2];
        devices[0].usUsagePage = 0x01; devices[0].usUsage = 0x06; devices[0].dwFlags = RIDEV_INPUTSINK; devices[0].hwndTarget = _hwnd;
        devices[1].usUsagePage = 0x01; devices[1].usUsage = 0x00; devices[1].dwFlags = RIDEV_INPUTSINK; devices[1].hwndTarget = _hwnd;
        bool rawOk = RegisterRawInputDevices(devices, 2, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
        Emit("{\"ch\":\"rawinput\",\"registered\":" + (rawOk ? "true" : "false") +
             ",\"err\":" + (rawOk ? 0 : Marshal.GetLastWin32Error()) + ",\"hwnd\":" + _hwnd.ToInt64() + "}");

        // [C] 轮询线程
        var poll = new Thread(PollLoop) { IsBackground = true };
        poll.Start();

        // [D] 直接读 HID
        var hid = new Thread(() => HidLoop(nameFilter)) { IsBackground = true };
        hid.Start();

        Emit("{\"type\":\"ready\",\"channels\":[\"hook\",\"rawinput\",\"keystate\",\"hidread\"],\"pid\":" +
             System.Diagnostics.Process.GetCurrentProcess().Id + "}");

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
        return 0;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookExW(int idHook, LowLevelKeyboardProc proc, IntPtr module, uint threadId);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PeekMessageW(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
}
