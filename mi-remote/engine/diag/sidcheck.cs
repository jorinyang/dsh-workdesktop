// sidcheck.cs —— 极简：把自己的令牌完整性 SID 原始字节打出来。
// 目的是校准解析（上一版把所有进程都读成 Low，而 whoami 显示 High，说明解析错了）。
using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class SidCheck
{
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, uint len, out uint ret);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr h);

    private static void Main()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token))
        {
            Console.WriteLine("OpenProcessToken 失败: " + Marshal.GetLastWin32Error());
            return;
        }
        uint len;
        GetTokenInformation(token, 25 /*TokenIntegrityLevel*/, IntPtr.Zero, 0, out len);
        Console.WriteLine("需要的长度: " + len);
        IntPtr buf = Marshal.AllocHGlobal((int)len);
        if (!GetTokenInformation(token, 25, buf, len, out len))
        {
            Console.WriteLine("GetTokenInformation 失败: " + Marshal.GetLastWin32Error());
            return;
        }
        IntPtr sid = Marshal.ReadIntPtr(buf);
        Console.WriteLine("SID 指针: 0x" + sid.ToInt64().ToString("X"));
        var sb = new StringBuilder();
        for (int i = 0; i < 24; i++) sb.Append(Marshal.ReadByte(sid, i).ToString("X2")).Append(' ');
        Console.WriteLine("SID 前 24 字节: " + sb.ToString());
        int rev = Marshal.ReadByte(sid, 0);
        int count = Marshal.ReadByte(sid, 1);
        Console.WriteLine("Revision=" + rev + " SubAuthorityCount=" + count);
        for (int i = 0; i < count; i++)
        {
            int v = Marshal.ReadInt32(sid, 8 + i * 4);
            Console.WriteLine("  SubAuthority[" + i + "] = " + v + " (0x" + v.ToString("X") + ")");
        }
        Console.WriteLine("→ 最高的那个子授权就是完整性级别；12288=High / 8192=Medium / 4096=Low / 16384=System");
        Marshal.FreeHGlobal(buf);
    }
}
