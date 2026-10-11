// integrity.cs —— 读各进程的完整性级别（Integrity Level）。
//
// 为什么要它：SendInput 注入受 **UIPI** 限制 —— 低完整性进程**无法**把输入送进高完整性
// 进程的窗口，而且系统**不会报错**（SendInput 照样返回成功）。表现就是
// "引擎日志显示 ok:true、目标窗口毫无反应"，非常难查。
//
// 用法：integrity.exe           列出相关进程的级别
//       integrity.exe <pid>...  只看指定进程
//       integrity.exe --dump    把 SID 原始字节打出来（排查解析错误用）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal static class Integrity
{
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, uint len, out uint ret);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern int GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr GetSidSubAuthority(IntPtr sid, int index);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);

    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenIntegrityLevel = 25;

    private static bool _dump;

    /*
     * 完整性级别的 SID 形如 S-1-16-<level>：
     *   byte0 = Revision(1)   byte1 = SubAuthorityCount
     *   byte2..7 = IdentifierAuthority（6 字节，大端）
     *   byte8..   = SubAuthority[]（每个 4 字节，小端）
     * 级别值在**最后一个** SubAuthority 里。
     *
     * 第一版自己按偏移算，结果把所有进程（包括 High 的管理员进程）都读成 Low ——
     * 直接用 GetSidSubAuthorityCount / GetSidSubAuthority 这两个 API 才靠谱。
     */
    private static int LastSubAuthority(IntPtr sid)
    {
        int count = GetSidSubAuthorityCount(sid);
        if (count <= 0) return -1;
        IntPtr p = GetSidSubAuthority(sid, count - 1);
        return p == IntPtr.Zero ? -1 : Marshal.ReadInt32(p);
    }

    private static string LevelName(int rid)
    {
        if (rid < 0) return "读不到";
        if (rid >= 0x4000) return "System(系统)";
        if (rid >= 0x3000) return "High(管理员)";
        if (rid >= 0x2000) return "Medium(普通)";
        if (rid >= 0x1000) return "Low(低)";
        return "Untrusted(不可信)";
    }

    private static string GetIntegrity(int pid)
    {
        IntPtr proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (proc == IntPtr.Zero) return "打不开进程(err=" + Marshal.GetLastWin32Error() + ")";
        IntPtr token;
        if (!OpenProcessToken(proc, TOKEN_QUERY, out token))
        {
            int e = Marshal.GetLastWin32Error();
            CloseHandle(proc);
            return "打不开令牌(err=" + e + ")";
        }
        try
        {
            uint len;
            GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out len);
            IntPtr buf = Marshal.AllocHGlobal((int)len);
            try
            {
                if (!GetTokenInformation(token, TokenIntegrityLevel, buf, len, out len)) return "读不到";
                // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES Label { PSID Sid; DWORD Attributes; } }
                IntPtr sid = Marshal.ReadIntPtr(buf);
                if (sid == IntPtr.Zero) return "SID 为空";
                if (_dump)
                {
                    int n = GetSidSubAuthorityCount(sid);
                    var sb = new System.Text.StringBuilder("  [dump] rev=" + Marshal.ReadByte(sid, 0) +
                        " count=" + n + " subs=");
                    for (int i = 0; i < n; i++) sb.Append(GetSidSubAuthority(sid, i) == IntPtr.Zero ? "?" :
                        Marshal.ReadInt32(GetSidSubAuthority(sid, i)).ToString()).Append(i + 1 < n ? "," : "");
                    Console.WriteLine(sb.ToString());
                }
                int rid = LastSubAuthority(sid);
                return LevelName(rid) + " (S-" + rid + ")";
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        finally { CloseHandle(token); CloseHandle(proc); }
    }

    private static void Main(string[] args)
    {
        var wanted = new List<int>();
        foreach (string a in args)
        {
            if (a == "--dump") { _dump = true; continue; }
            int v;
            if (int.TryParse(a, out v)) wanted.Add(v);
        }

        var targets = new List<Process>();
        if (wanted.Count > 0)
        {
            foreach (int pid in wanted)
            {
                try { targets.Add(Process.GetProcessById(pid)); }
                catch (Exception ex) { Console.WriteLine("  pid " + pid + " 取不到: " + ex.GetType().Name); }
            }
        }
        else
        {
            foreach (string name in new[] { "KeyBridge", "python", "quark", "chrome", "msedge", "firefox",
                                            "node", "explorer", "sayall-windows-app", "winlogon" })
            {
                try { targets.AddRange(Process.GetProcessesByName(name)); } catch (Exception) { }
            }
        }

        var me = Process.GetCurrentProcess();
        Console.WriteLine("  自己(" + me.ProcessName + " pid=" + me.Id + "): " + GetIntegrity(me.Id));
        foreach (var p in targets)
        {
            if (p.Id == me.Id) continue;
            Console.WriteLine("  " + p.ProcessName + " (pid=" + p.Id + "): " + GetIntegrity(p.Id));
        }
    }
}
