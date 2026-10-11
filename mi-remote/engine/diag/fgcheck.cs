// fgcheck.cs —— 一次问清"注入能不能到达前台窗口"。
//
// 背景（2026-10-11）：引擎日志里 SendInput 全是 ok:true，但界面毫无反应。成因候选里最硬的一条是
// **UIPI**：低完整性进程无法把输入注入到更高完整性的窗口，而且 SendInput **不报错**。
// 要判定它，必须同时知道三件事：① 自己是几级 ② 前台窗口那个进程是几级 ③ 两者是否允许注入。
// 分开测会互相矛盾（whoami 和自写解析器就对不上），所以放在同一个进程里一起读。
//
// 用法：fgcheck.exe            看当前前台窗口
//       fgcheck.exe --watch N  每秒看一次，持续 N 秒（切窗口时能看到变化）
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal static class FgCheck
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, uint len, out uint ret);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);

    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenIntegrityLevel = 25;

    /**
     * 读某个进程令牌的完整性级别。
     *
     * SID 布局：base S-1-16-<level>；byte1 = SubAuthorityCount，SubAuthority[0] 起于偏移 8。
     * 完整性 SID 只有一个子授权（就是级别值），所以直接读偏移 8。
     * **注意**：不要假设它一定是 1 个 —— 这里按 count 取最后一个。
     */
    private static int ReadLevel(IntPtr token)
    {
        uint len;
        GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out len);
        if (len == 0) return -1;
        IntPtr buf = Marshal.AllocHGlobal((int)len);
        try
        {
            if (!GetTokenInformation(token, TokenIntegrityLevel, buf, len, out len)) return -1;
            IntPtr sid = Marshal.ReadIntPtr(buf);
            if (sid == IntPtr.Zero) return -1;
            int count = Marshal.ReadByte(sid, 1);
            if (count <= 0) return -1;
            return Marshal.ReadInt32(sid, 8 + (count - 1) * 4);
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    private static int ProcessLevel(int pid)
    {
        IntPtr proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (proc == IntPtr.Zero) return -1;
        IntPtr token;
        if (!OpenProcessToken(proc, TOKEN_QUERY, out token)) { CloseHandle(proc); return -1; }
        try { return ReadLevel(token); }
        finally { CloseHandle(token); CloseHandle(proc); }
    }

    private static int SelfLevel()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) return -1;
        try { return ReadLevel(token); } finally { CloseHandle(token); }
    }

    private static string Name(int rid)
    {
        if (rid < 0) return "读不到(-1)";
        if (rid >= 0x4000) return "System(16384)";
        if (rid >= 0x3000) return "High(12288)";
        if (rid >= 0x2000) return "Medium(8192)";
        if (rid >= 0x1000) return "Low(4096)";
        return "Untrusted(" + rid + ")";
    }

    private static void Report()
    {
        int me = SelfLevel();
        IntPtr hwnd = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        string procName = "?";
        try { procName = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
        int fg = ProcessLevel((int)pid);

        Console.WriteLine("  我 = " + Name(me) + " (" + me + ")");
        Console.WriteLine("  前台窗口 = " + procName + " (pid=" + pid + ") 级别 = " + Name(fg) + " (" + fg + ")");
        // UIPI：调用方级别必须 >= 目标级别才允许注入
        bool can = me >= 0 && fg >= 0 && me >= fg;
        Console.WriteLine("  → 允许注入: " + (can ? "是" : "否（会被 UIPI 静默丢弃，SendInput 仍返回成功）"));
        Console.WriteLine("");
    }

    private static void Main(string[] args)
    {
        int watch = 0;
        var wanted = new System.Collections.Generic.List<int>();
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--watch" && i + 1 < args.Length) int.TryParse(args[++i], out watch);
            else { int v; if (int.TryParse(args[i], out v)) wanted.Add(v); }
        }

        if (wanted.Count > 0)
        {
            // 指定 pid：只报级别（用来看 dsh / 引擎 / 浏览器各是几级）
            Console.WriteLine("== 指定进程 ==");
            int me0 = SelfLevel();
            Console.WriteLine("  我 = " + Name(me0) + " (" + me0 + ")");
            foreach (int pid in wanted)
            {
                string nm = "?";
                try { nm = Process.GetProcessById(pid).ProcessName; } catch (Exception) { }
                int lv = ProcessLevel(pid);
                Console.WriteLine("  " + nm + " (pid=" + pid + ") = " + Name(lv) + " (" + lv + ")" +
                    (lv < 0 ? "   ← 打不开令牌，说明它比我高" : ""));
            }
            return;
        }

        if (watch <= 0) { Console.WriteLine("== fgcheck =="); Report(); return; }
        Console.WriteLine("== fgcheck --watch " + watch + " ==");
        for (int t = 0; t < watch; t++)
        {
            Console.WriteLine("[t=" + t + "s]");
            Report();
            System.Threading.Thread.Sleep(1000);
        }
    }
}
