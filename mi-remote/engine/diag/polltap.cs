// polltap.cs —— 纯轮询采集器：直接问系统"这些键现在按着没有"。
//
// 为什么先做这条：前面把"钩子/消息循环/hMod/启动方式/360/控制台/消息队列"全排除了，
// 而 GetAsyncKeyState 是**完全不同的机制** —— 不装钩子、不建窗口、不跑消息循环，
// 只是每 15 毫秒问一次系统"按键状态"。它绕开了前面所有可疑环节。
//
// 代价：查不到 vk=255（电源键）—— 255 不是合法的虚拟键码。其余全都能查。
//
// 编译：csc /target:exe /platform:x64 /out:polltap.exe polltap.cs
// 用法：polltap.exe --out <路径> [--seconds N]
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class PollTap
{
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vkey);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    // 遥控器在 Windows 里报的码 + 几个对照键
    private static readonly int[] Keys = { 36, 93, 192, 38, 40, 37, 39, 13, 116, 27, 8, 65 };

    private static readonly Dictionary<int, string> Names = new Dictionary<int, string>
    {
        { 36, "home" }, { 93, "menu" }, { 192, "tv" }, { 38, "up" }, { 40, "down" },
        { 37, "left" }, { 39, "right" }, { 13, "ok" }, { 116, "voice" }, { 27, "esc" },
        { 8, "backspace" }, { 65, "a" },
    };

    private static StreamWriter _out;
    private static readonly object Gate = new object();

    private static void Emit(string s)
    {
        lock (Gate)
        {
            try { if (_out != null) { _out.WriteLine(s); _out.Flush(); } } catch (Exception) { }
            try { if (GetConsoleWindow() != IntPtr.Zero) { Console.WriteLine(s); Console.Out.Flush(); } } catch (Exception) { }
        }
    }

    private static int Main(string[] args)
    {
        if (GetConsoleWindow() == IntPtr.Zero) AllocConsole();

        string outPath = null;
        int seconds = 0;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--out" && i + 1 < args.Length) outPath = args[++i];
            else if (args[i] == "--seconds" && i + 1 < args.Length) int.TryParse(args[++i], out seconds);
        }
        if (outPath != null) { try { _out = new StreamWriter(outPath, true, new UTF8Encoding(false)) { AutoFlush = true }; } catch (Exception) { } }

        Emit("{\"type\":\"ready\",\"ch\":\"keystate\",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id +
             ",\"keys\":" + Keys.Length + "}");
        Emit("{\"type\":\"note\",\"text\":\"这个通道查不到 vk=255(电源键)，其余都能查\"}");

        var held = new Dictionary<int, bool>();
        foreach (int k in Keys) held[k] = false;

        var stop = DateTime.UtcNow.AddSeconds(seconds > 0 ? seconds : 3600);
        long polls = 0;
        while (DateTime.UtcNow < stop)
        {
            foreach (int k in Keys)
            {
                bool now = (GetAsyncKeyState(k) & 0x8000) != 0;
                if (now != held[k])
                {
                    held[k] = now;
                    string name;
                    if (!Names.TryGetValue(k, out name)) name = "vk" + k;
                    Emit("{\"ch\":\"keystate\",\"vk\":" + k + ",\"name\":\"" + name + "\",\"down\":" +
                         (now ? "true" : "false") + ",\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}");
                }
            }
            polls++;
            if (polls % 400 == 0)
                Emit("{\"type\":\"alive\",\"polls\":" + polls + ",\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}");
            Thread.Sleep(15);
        }
        return 0;
    }
}
