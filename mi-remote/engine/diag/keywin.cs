// keywin.cs —— 带窗口的按键监视器：把自己显示出来并置前，然后记录收到的每个键。
//
// 为什么需要它：这台机器上低级键盘钩子**只对本进程在前台时收到的真实按键有效**
// （2026-10-11 反复实测的结论）。原来那个 keytap.exe 不创建窗口，所以它永远不是前台，
// 拿它去验证"HID 层改写出来的 Alt 到底 Windows 认不认"是验证不了的。
//
// 这个版本会：创建窗口 → ShowWindow → SetForegroundWindow → 装 WH_KEYBOARD_LL → 把每个
// 按键写成一行 JSON。**置前那一步是关键**，不然钩子还是收不到真实按键。
//
// 它会自己显示倒计时，到点自动关窗退出，不用人去点。
//
// 编译：csc /target:winexe /platform:x64 /out:keywin.exe keywin.cs
// 用法：keywin.exe --out <路径> --seconds 45
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;      // 只为 Application.Run 的消息循环与窗口生命周期

internal static class KeyWin
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100, WM_SYSKEYDOWN = 0x0104, WM_KEYUP = 0x0101, WM_SYSKEYUP = 0x0105;
    private const uint LLKHF_INJECTED = 0x00000010;
    private const uint LLKHF_EXTENDED = 0x00000001;

    private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookExW(int idHook, LowLevelKeyboardProc proc, IntPtr module, uint threadId);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string name);

    private static readonly LowLevelKeyboardProc Proc = Callback;
    private static IntPtr _hook = IntPtr.Zero;
    private static StreamWriter _out;
    private static readonly object Gate = new object();
    private static int _hits;

    /** 虚拟键码 → 好认的名字（只列我们关心的）。 */
    private static string Name(uint vk)
    {
        switch (vk)
        {
            case 0xA4: return "LAlt";
            case 0xA5: return "RAlt";
            case 0x12: return "Alt(generic)";
            case 0xA0: return "LShift";
            case 0xA1: return "RShift";
            case 0xA2: return "LCtrl";
            case 0xA3: return "RCtrl";
            case 0x5B: return "LWin";
            case 0x5C: return "RWin";
            case 0x74: return "F5";
            case 0x00F1 & 0xFFFF: return "?";
            default: return "vk" + vk;
        }
    }

    private static IntPtr Callback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var d = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            int m = wParam.ToInt32();
            bool down = m == WM_KEYDOWN || m == WM_SYSKEYDOWN;
            bool up = m == WM_KEYUP || m == WM_SYSKEYUP;
            if (down || up)
            {
                _hits++;
                string line = "{\"vk\":" + d.vkCode + ",\"name\":\"" + Name(d.vkCode) + "\",\"down\":" +
                    (down ? "true" : "false") +
                    ",\"injected\":" + ((d.flags & LLKHF_INJECTED) != 0 ? "true" : "false") +
                    ",\"extended\":" + ((d.flags & LLKHF_EXTENDED) != 0 ? "true" : "false") +
                    ",\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}";
                lock (Gate) { try { if (_out != null) { _out.WriteLine(line); _out.Flush(); } } catch (Exception) { } }
            }
        }
        return CallNextHookEx(_hook, code, wParam, lParam);
    }

    [STAThread]
    private static void Main(string[] args)
    {
        string outPath = null;
        int seconds = 45;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--out" && i + 1 < args.Length) outPath = args[++i];
            else if (args[i] == "--seconds" && i + 1 < args.Length) int.TryParse(args[++i], out seconds);
        }
        if (outPath != null)
        {
            try { _out = new StreamWriter(outPath, true, new UTF8Encoding(false)) { AutoFlush = true }; }
            catch (Exception) { }
        }

        var form = new Form
        {
            Text = "按键监视器 —— 先按实体键盘 a，再按遥控器 mic",
            Width = 620,
            Height = 240,
            StartPosition = FormStartPosition.CenterScreen,
            TopMost = true,
        };
        var label = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = System.Drawing.ContentAlignment.MiddleCenter,
            Font = new System.Drawing.Font("Microsoft YaHei UI", 11F),
        };
        form.Controls.Add(label);

        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        var timer = new System.Windows.Forms.Timer { Interval = 250 };
        bool lastFg = false;
        timer.Tick += (s, e) =>
        {
            /*
             * 自己报告"我是不是前台窗口"。
             * 这一步是必须的：钩子**只对本进程前台时收到的真实按键有效**，而注入的键
             * 任何情况下都收得到。所以"只看到 injected:true"有两种截然不同的解释 ——
             * 要么窗口没在前台（测试无效），要么遥控器的键真的不产生键盘事件（结论有效）。
             * 不把前台状态记下来，这两种就分不开（2026-10-11 就卡在这里）。
             */
            bool fg = GetForegroundWindow() == form.Handle;
            if (fg != lastFg)
            {
                lastFg = fg;
                lock (Gate)
                {
                    try
                    {
                        if (_out != null)
                        {
                            _out.WriteLine("{\"type\":\"foreground\",\"on\":" + (fg ? "true" : "false") +
                                ",\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}");
                            _out.Flush();
                        }
                    }
                    catch (Exception) { }
                }
            }
            double left = (deadline - DateTime.UtcNow).TotalSeconds;
            if (left <= 0) { form.Close(); return; }
            label.Text = (fg ? "【前台 ✓ 钩子有效】" : "【不在前台 ✗ 真实按键收不到】") +
                "\n\n先按实体键盘的 a，再按遥控器 mic\n剩余 " + ((int)left) + " 秒 · 已收到 " + _hits + " 个事件";
        };

        form.Shown += (s, e) =>
        {
            // 置前是关键：钩子只在本进程前台时收得到真实按键
            ShowWindow(form.Handle, 5);          // SW_SHOW
            SetForegroundWindow(form.Handle);
            form.Activate();
            _hook = SetWindowsHookExW(WH_KEYBOARD_LL, Proc, GetModuleHandleW(null), 0);
            lock (Gate)
            {
                try
                {
                    if (_out != null)
                    {
                        _out.WriteLine("{\"type\":\"ready\",\"hook\":" + (_hook != IntPtr.Zero ? "true" : "false") +
                            ",\"hwnd\":" + form.Handle.ToInt64() + "}");
                        _out.Flush();
                    }
                }
                catch (Exception) { }
            }
            timer.Start();
        };

        Application.Run(form);
        if (_hook != IntPtr.Zero) { /* 进程退出即卸载 */ }
    }
}
