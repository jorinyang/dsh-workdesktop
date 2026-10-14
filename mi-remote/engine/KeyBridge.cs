/*
 * KeyBridge.cs — DSH 侧的小米遥控器按键桥（dsh-mi-remote 的执行半段）
 *
 * 为什么要有它：DSH 面板能配置映射，但「配置生效」需要一个执行者。SayAll 的按键映射
 * 由它自己的界面独占（它的官方 AI 协议也明确禁止外部脚本改它的配置），所以按它的实现方式
 * 在 DSH 侧重做一份：**Raw Input 监听 → 单击/双击/长按判定 → SendInput 注入**。
 * SayAll 的自定义按键映射默认关闭，所以两者不打架；若用户开启了 SayAll 的映射，会双触发
 * （面板上会写明这一点）。
 *
 * 三种模式：
 *   KeyBridge.exe list                        列出所有 Raw Input 键盘设备（含 VID/PID）
 *   KeyBridge.exe learn [--seconds N] [--any] 学习模式：打印收到的按键（设备名 + VKey）
 *   KeyBridge.exe run --config <mapping.json> 运行：按映射注入动作
 *
 * 设备过滤：默认只认 VID_2717（小米）的键盘类设备；learn 的 --any 打开全部设备。
 * 注：不装钩子、不独占设备、不抢焦点 —— RIDEV_INPUTSINK 让隐藏窗口在后台也能收到按键。
 *
 * 编译（不需要 dotnet SDK，Win11 自带 .NET Framework 4.8）：
 *   <Roslyn csc> /target:exe /platform:x64 /out:KeyBridge.exe KeyBridge.cs
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DshMiRemote
{
    internal static class Native
    {
        // ---- 窗口与消息 ----
        public delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct WNDCLASS
        {
            public uint style;
            public WndProc lpfnWndProc;
            public int cbClsExtra;
            public int cbWndExtra;
            public IntPtr hInstance;
            public IntPtr hIcon;
            public IntPtr hCursor;
            public IntPtr hbrBackground;
            // 必须显式声明为 LPWStr：默认按 ANSI 封送会让 RegisterClassW 注册的类名
            // 与 CreateWindowExW 查找的类名对不上，后者直接失败 1407（找不到窗口类）。
            [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern ushort RegisterClassW(ref WNDCLASS lpWndClass);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName,
            uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
        [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern int GetMessageW(out MSG msg, IntPtr hWnd, uint min, uint max);
        /// <summary>非阻塞取消息（保留备用）。注意：消息循环**不要**用它 —— 见 SetTimer 的说明。</summary>
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PeekMessageW(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);
        public const uint PM_REMOVE = 0x0001;
        /// <summary>
        /// 线程定时器：每 20ms 往**本线程的消息队列**投一个 WM_TIMER，把阻塞中的 GetMessageW
        /// 唤醒一次，主线程就趁机把内存里的日志落盘。
        ///
        /// 为什么不能改用 PeekMessage + Sleep 代替它：低级钩子的回调是系统**在装钩子的线程上**
        /// 调用的，而那个线程必须处在"等待消息"的状态。PeekMessage + Sleep 让线程睡在 Sleep 里，
        /// 系统叫不醒 —— 回调就被丢了。2026-10-11 实测：换成 PeekMessage 后自己注入的键还收得到，
        /// 真实硬件按键全丢（和 hooktest 的唯一差别就是这里）。
        /// </summary>
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetTimer(IntPtr hWnd, IntPtr id, uint interval, IntPtr proc);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool KillTimer(IntPtr hWnd, IntPtr id);
        public const uint WM_TIMER = 0x0113;
        [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
        [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG msg);
        [DllImport("user32.dll")] public static extern void PostQuitMessage(int code);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string name);

        // ---- Raw Input ----
        [StructLayout(LayoutKind.Sequential)]
        public struct RAWINPUTDEVICE
        {
            public ushort usUsagePage;
            public ushort usUsage;
            public uint dwFlags;
            public IntPtr hwndTarget;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RAWINPUTHEADER
        {
            public uint dwType;
            public uint dwSize;
            public IntPtr hDevice;
            public IntPtr wParam;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RAWKEYBOARD
        {
            public ushort MakeCode;
            public ushort Flags;
            public ushort Reserved;
            public ushort VKey;
            public uint Message;
            public uint ExtraInformation;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RAWMOUSE
        {
            public ushort usFlags;
            public ushort usButtonFlags;      // RI_MOUSE_* 位：左/右/中键的按下与抬起各占一位
            public ushort usButtonData;
            public uint ulRawButtons;
            public int lLastX;
            public int lLastY;
            public uint ulExtraInformation;
        }

        /// <summary>
        /// HID 原始报告头（厂商自定义那几路，比如遥控器的 返回/主页/电源）。
        /// 后面紧跟着 `dwCount * dwSizeHid` 个字节的原始报告 —— 每个键的含义只能靠"按一次看一眼"学出来。
        /// </summary>
        [StructLayout(LayoutKind.Sequential)]
        public struct RAWHID
        {
            public uint dwSizeHid;
            public uint dwCount;
            // bRawData 是变长的，按指针读，不在这里声明
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RAWINPUTDEVICELIST
        {
            public IntPtr hDevice;
            public uint dwType;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetRawInputData(IntPtr rawInput, uint command, IntPtr data, ref uint size, uint headerSize);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetRawInputDeviceList(IntPtr devices, ref uint count, uint size);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern uint GetRawInputDeviceInfoW(IntPtr device, uint command, StringBuilder data, ref uint size);

        /*
         * ── 低级键盘钩子（2026-10-11）────────────────────────────────────────
         * 为什么加：Raw Input 在这台机器上**实测一直收不到东西**（两次 live 测试都是 0 条，
         * 连普通键盘都没有），而逐段看过代码都是标准写法。与其继续猜，换成更简单可靠的钩子：
         * WH_KEYBOARD_LL 不依赖"窗口 + RegisterRawInputDevices + 消息循环"这一整套，
         * 挂上就能收，而且拿到的是**系统分发层**的事件 —— 遥控器的方向键正是 Windows 正在用的那些。
         * 代价：钩子拿不到"设备"，只能拿到 vkCode/scanCode —— 先看它到底能收到什么。
         */
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookExW(int idHook, LowLevelKeyboardProc callback, IntPtr module, uint threadId);
        [DllImport("kernel32.dll")]
        public static extern IntPtr GetConsoleWindow();
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AllocConsole();
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;
        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr GetThreadDesktop(uint threadId);
        /// <summary>打开"当前正在接收用户输入的那个桌面"。打不开就说明本进程进不去交互式桌面。</summary>
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder info, uint length, out uint needed);
        public const int UOI_NAME = 2;
        public const uint DESKTOP_READOBJECTS = 0x0001;
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

        public delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);
        public const int WH_KEYBOARD_LL = 13;
        /// <summary>LLKHF_INJECTED：这个键是注入出来的（我们自己发的也会带上，用它过滤掉自问自答）。</summary>
        public const uint LLKHF_INJECTED = 0x00000010;

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }
        /*
         * ── HID 直读（2026-10-11）────────────────────────────────────────────
         * 为什么要它：Raw Input 拿到的是**系统翻译过**的输入 —— 遥控器只有一个顶级集合
         * （键盘），所以返回/主页/电源那些"厂商自定义报告"根本到不了 Raw Input。
         * 而 HID 设备本身是允许被多个客户端读的，直接 CreateFile + ReadFile 能拿到**原始报告流**，
         * 里面包含所有 Report ID 的内容（这正是 Windows 自己那套翻译看不见的部分）。
         */
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security,
            uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ReadFile(IntPtr handle, byte[] buffer, uint toRead, out uint read, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
        [DllImport("hid.dll")]
        public static extern bool HidD_GetPreparsedData(IntPtr handle, out IntPtr preparsed);
        [DllImport("hid.dll")]
        public static extern bool HidD_FreePreparsedData(IntPtr preparsed);
        [DllImport("hid.dll")]
        public static extern int HidP_GetCaps(IntPtr preparsed, ref HIDP_CAPS caps);
        [DllImport("hid.dll")]
        public static extern bool HidD_GetProductString(IntPtr handle, StringBuilder buffer, uint length);

        [StructLayout(LayoutKind.Sequential)]
        public struct HIDP_CAPS
        {
            public ushort Usage;
            public ushort UsagePage;
            public ushort InputReportByteLength;
            public ushort OutputReportByteLength;
            public ushort FeatureReportByteLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)]
            public ushort[] Reserved;
            public ushort NumberLinkCollectionNodes;
            public ushort NumberInputButtonCaps;
            public ushort NumberInputValueCaps;
            public ushort NumberInputDataIndices;
            public ushort NumberOutputButtonCaps;
            public ushort NumberOutputValueCaps;
            public ushort NumberOutputDataIndices;
            public ushort NumberFeatureButtonCaps;
            public ushort NumberFeatureValueCaps;
            public ushort NumberFeatureDataIndices;
        }
        /// <summary>
        /// 同一个 Win32 函数，但第三个参数收原始指针 —— RIDI_DEVICEINFO 要往一块内存里写结构体，
        /// StringBuilder 那个签名传不了。两个签名共存是合法的（同一个 EntryPoint，不同 CLR 类型）。
        /// </summary>
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetRawInputDeviceInfoW")]
        public static extern uint GetRawInputDeviceInfoPtr(IntPtr device, uint command, IntPtr data, ref uint size);

        // ---- 注入 ----
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION
        {
            // 必须放上最大的那个成员（x64 下 MOUSEINPUT 32 字节 > KEYBDINPUT 24 字节）：
            // 只放键盘结构会让 INPUT 变成 32 字节而不是 40，SendInput 直接报 87（参数错误）。
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public INPUTUNION u;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint count, INPUT[] inputs, int size);

        public const uint WM_INPUT = 0x00FF;
        public const uint WM_DESTROY = 0x0002;
        public const uint RIDEV_INPUTSINK = 0x00000100;
        /*
         * Raw Input 是**按"顶级集合"（UsagePage / Usage）登记**的 —— 登记了键盘 0x01/0x06 就只能收到
         * 键盘那一类。遥控器的返回/主页/电源很可能落在厂商自定义页（0xFFxx）上，不知道具体值就没法登记。
         * 这个常量配合 hidinfo 模式把每个设备真实的顶级集合读出来。
         */
        public const uint RIDI_DEVICEINFO = 0x2000000b;
        /*
         * Raw Input 的三类数据。2026-10-11 加后两类 —— 用户实测遥控器不是一个键盘：
         * 方向键/OK 走键盘；**菜单键走鼠标**（他看到的实际效果是"鼠标右键"）；
         * 音量与返回/主页/电源走消费类控制与厂商自定义（RAWHID 原始报告）。
         * 以前这里只登记了键盘，所以除方向键之外全部收不到。
         */
        public const uint RIM_TYPEMOUSE = 1;
        public const uint RIM_TYPEHID = 2;
        // 鼠标按钮位（RAWMOUSE.usButtonFlags）
        public const ushort RI_MOUSE_LEFT_BUTTON_DOWN = 0x0001;
        public const ushort RI_MOUSE_LEFT_BUTTON_UP = 0x0002;
        public const ushort RI_MOUSE_RIGHT_BUTTON_DOWN = 0x0004;
        public const ushort RI_MOUSE_RIGHT_BUTTON_UP = 0x0008;
        public const ushort RI_MOUSE_MIDDLE_BUTTON_DOWN = 0x0010;
        public const ushort RI_MOUSE_MIDDLE_BUTTON_UP = 0x0020;
        public const uint RID_INPUT = 0x10000003;
        public const uint RIDI_DEVICENAME = 0x20000007;
        public const uint RIM_TYPEKEYBOARD = 1;
        public const uint WM_KEYDOWN = 0x0100;
        public const uint WM_KEYUP = 0x0101;
        public const uint WM_SYSKEYDOWN = 0x0104;
        public const uint WM_SYSKEYUP = 0x0105;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        /// <summary>扩展键（方向键、右 Ctrl/Alt、Home/End/Insert/Delete 等）要带这个位，不然部分应用认不出来。</summary>
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        /// <summary>
        /// 用 wScan 而不是 wVk 发送。不带它就只能填虚拟键码，而虚拟键码发出去的按键
        /// **扫描码是 0**，在系统看来"没有物理来源" —— 输入法这类挑剔的接收方会直接丢弃。
        /// </summary>
        public const uint KEYEVENTF_SCANCODE = 0x0008;
        /// <summary>MapVirtualKeyW 的转换类型：虚拟键码 → 扫描码。</summary>
        public const uint MAPVK_VK_TO_VSC = 0;
        [DllImport("user32.dll")]
        public static extern uint MapVirtualKeyW(uint code, uint mapType);

        /*
         * 读**自己**的完整性级别。
         *
         * 为什么要内建：2026-10-11 查"引擎注入到不了浏览器"时，用外部程序读各进程令牌，
         * 结果自相矛盾（whoami 说 High、自写读取器说 Low），白耗了很多时间。
         * 让引擎把自己的级别写进 ready 行，就不存在"跨进程读取"这层不确定性了。
         * Windows 的 UIPI 规定：**低完整性进程注入到更高完整性的窗口会被静默丢弃，
         * 而 SendInput 照样返回成功** —— 所以这个级别直接决定注入能不能生效。
         */
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, uint len, out uint ret);
        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        /// <summary>本进程完整性级别（4096=Low / 8192=Medium / 12288=High / 16384=System），读不到返回 -1。</summary>
        public static int SelfIntegrityLevel()
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x0008 /*TOKEN_QUERY*/, out token)) return -1;
            try
            {
                uint len;
                GetTokenInformation(token, 25 /*TokenIntegrityLevel*/, IntPtr.Zero, 0, out len);
                if (len == 0) return -1;
                IntPtr buf = Marshal.AllocHGlobal((int)len);
                try
                {
                    if (!GetTokenInformation(token, 25, buf, len, out len)) return -1;
                    IntPtr sid = Marshal.ReadIntPtr(buf);      // TOKEN_MANDATORY_LABEL.Label.Sid
                    if (sid == IntPtr.Zero) return -1;
                    int count = Marshal.ReadByte(sid, 1);      // SID 的子授权个数
                    if (count <= 0) return -1;
                    return Marshal.ReadInt32(sid, 8 + (count - 1) * 4);
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            finally { CloseHandle(token); }
        }

        /// <summary>完整性级别的可读名字。</summary>
        public static string IntegrityName(int level)
        {
            if (level < 0) return "unknown";
            if (level >= 0x4000) return "system";
            if (level >= 0x3000) return "high";
            if (level >= 0x2000) return "medium";
            if (level >= 0x1000) return "low";
            return "untrusted";
        }
        public const uint INPUT_KEYBOARD = 1;
        public const uint INPUT_MOUSE = 0;
        /*
         * 鼠标事件的 flag：**按下与抬起是两套不同的值**，不是"加个 UP 位"那么简单 ——
         * 写错的话表现是"只按不松"，系统里那个键会一直保持按下状态。
         */
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        /// <summary>相对移动。**不加** MOUSEEVENTF_ABSOLUTE，dx/dy 就是"从当前位置挪多少像素"。</summary>
        public const uint MOUSEEVENTF_MOVE = 0x0001;
    }

    /// <summary>隐藏消息窗口 + Raw Input 订阅；把按键回调出去。</summary>
    internal sealed class RawKeyboardListener : IDisposable
    {
        /// <summary>成功登记了几路 Raw Input（键盘一定算一路）。ready 行会带上它，方便一眼看出监听是否完整。</summary>
        public static int RegisteredPaths;

        private readonly Native.WndProc _proc;          // 必须持有引用，否则委托被回收
        private readonly string _className;
        private IntPtr _hwnd = IntPtr.Zero;

        /// <summary>(deviceHandle, vkey, isDown, makeCode) —— makeCode 用来区分注入(0)与物理按键。</summary>
        public event Action<IntPtr, ushort, bool, ushort> OnKey;

        public RawKeyboardListener()
        {
            _proc = WndProcImpl;
            _className = "DshMiRemoteKeyBridge_" + Guid.NewGuid().ToString("N").Substring(0, 8);
            var wc = new Native.WNDCLASS();
            wc.lpfnWndProc = _proc;
            wc.hInstance = Native.GetModuleHandleW(null);
            wc.lpszClassName = _className;
            if (Native.RegisterClassW(ref wc) == 0)
                throw new InvalidOperationException("RegisterClassW failed: " + Marshal.GetLastWin32Error());
            // 只建窗口不显示：RIDEV_INPUTSINK 让它在后台也能收 Raw Input
            _hwnd = Native.CreateWindowExW(0, _className, "dsh-mi-remote bridge", 0, 0, 0, 0, 0,
                IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
            if (_hwnd == IntPtr.Zero)
                throw new InvalidOperationException("CreateWindowExW failed: " + Marshal.GetLastWin32Error());
            /*
             * ⚠️ 键盘那一路**必须注册成功**，否则直接失败 —— 它是主力。
             * 今天（2026-10-11）为了收鼠标/消费类，这里一度改成"四条逐条注册、成功几条算几条"，
             * 结果键盘那条失败时被静默跳过（只要别的成功就不抛），表现是**什么都收不到**，
             * 而且 ready 行看起来一切正常。教训记这儿：主力通道不许"尽力而为"。
             */
            var keyboard = new Native.RAWINPUTDEVICE[1];
            keyboard[0].usUsagePage = 0x01;   // Generic Desktop
            keyboard[0].usUsage = 0x06;       // Keyboard
            keyboard[0].dwFlags = Native.RIDEV_INPUTSINK;
            keyboard[0].hwndTarget = _hwnd;
            if (!Native.RegisterRawInputDevices(keyboard, 1, (uint)Marshal.SizeOf(typeof(Native.RAWINPUTDEVICE))))
                throw new InvalidOperationException("RegisterRawInputDevices(keyboard) failed: " + Marshal.GetLastWin32Error());
            RegisteredPaths = 1;

            // 其余几路：尽力而为，失败不影响键盘（鼠标走菜单键那一路，消费类走音量）。
            var extras = new ushort[][] {
                new ushort[] { 0x01, 0x02 },   // Mouse
                new ushort[] { 0x0C, 0x01 },   // Consumer Control
                new ushort[] { 0x01, 0x00 },   // Generic Desktop 全部
            };
            foreach (ushort[] pair in extras)
            {
                var one = new Native.RAWINPUTDEVICE[1];
                one[0].usUsagePage = pair[0];
                one[0].usUsage = pair[1];
                one[0].dwFlags = Native.RIDEV_INPUTSINK;
                one[0].hwndTarget = _hwnd;
                if (Native.RegisterRawInputDevices(one, 1, (uint)Marshal.SizeOf(typeof(Native.RAWINPUTDEVICE))))
                    RegisteredPaths++;
            }
        }

        private IntPtr WndProcImpl(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            if (msg == Native.WM_INPUT)
            {
                HandleInput(lParam);
                return IntPtr.Zero;
            }
            if (msg == Native.WM_DESTROY)
            {
                Native.PostQuitMessage(0);
                return IntPtr.Zero;
            }
            return Native.DefWindowProcW(hWnd, msg, wParam, lParam);
        }

        /// <summary>HID 那几路：记住最后一次按下的码，好把"全零报告"翻译成同一个码的抬起。</summary>
        private ushort _lastHidCode;

        private void HandleInput(IntPtr rawInputHandle)
        {
            uint size = 0;
            Native.GetRawInputData(rawInputHandle, Native.RID_INPUT, IntPtr.Zero, ref size,
                (uint)Marshal.SizeOf(typeof(Native.RAWINPUTHEADER)));
            if (size == 0) return;
            IntPtr buffer = Marshal.AllocHGlobal((int)size);
            try
            {
                uint read = Native.GetRawInputData(rawInputHandle, Native.RID_INPUT, buffer, ref size,
                    (uint)Marshal.SizeOf(typeof(Native.RAWINPUTHEADER)));
                if (read == 0 || read == uint.MaxValue) return;
                var header = (Native.RAWINPUTHEADER)Marshal.PtrToStructure(buffer, typeof(Native.RAWINPUTHEADER));
                IntPtr body = new IntPtr(buffer.ToInt64() + Marshal.SizeOf(typeof(Native.RAWINPUTHEADER)));
                var handler = OnKey;

                if (header.dwType == Native.RIM_TYPEKEYBOARD)
                {
                    var kb = (Native.RAWKEYBOARD)Marshal.PtrToStructure(body, typeof(Native.RAWKEYBOARD));
                    // 只丢真正的伪键（VKey 255）。
                    // ⚠️ 不能用 `MakeCode == 0` 过滤：SendInput 注入的键 MakeCode 就是 0，
                    //    部分真实遥控器按键也会报 0 —— 那样会把要收的键一起丢掉（实测踩过）。
                    if (kb.VKey == 255 || kb.VKey == 0) return;
                    bool down = kb.Message == Native.WM_KEYDOWN || kb.Message == Native.WM_SYSKEYDOWN;
                    bool up = kb.Message == Native.WM_KEYUP || kb.Message == Native.WM_SYSKEYUP;
                    if (!down && !up) return;
                    if (handler != null) handler(header.hDevice, kb.VKey, down, kb.MakeCode);
                    return;
                }

                if (header.dwType == Native.RIM_TYPEMOUSE)
                {
                    /*
                     * 鼠标那一路。遥控器的「菜单键」就在这里 —— 用户 2026-10-11 实测它的实际效果是
                     * 鼠标右键。这里把它翻成 Windows 标准鼠标虚拟键（1/2/4），
                     * 跟面板录制区存下来的 MouseLeft / MouseRight / MouseMiddle 是同一套码。
                     */
                    var ms = (Native.RAWMOUSE)Marshal.PtrToStructure(body, typeof(Native.RAWMOUSE));
                    ushort flags = ms.usButtonFlags;
                    if (handler != null)
                    {
                        if ((flags & Native.RI_MOUSE_LEFT_BUTTON_DOWN) != 0) handler(header.hDevice, 0x01, true, 0);
                        if ((flags & Native.RI_MOUSE_LEFT_BUTTON_UP) != 0) handler(header.hDevice, 0x01, false, 0);
                        if ((flags & Native.RI_MOUSE_RIGHT_BUTTON_DOWN) != 0) handler(header.hDevice, 0x02, true, 0);
                        if ((flags & Native.RI_MOUSE_RIGHT_BUTTON_UP) != 0) handler(header.hDevice, 0x02, false, 0);
                        if ((flags & Native.RI_MOUSE_MIDDLE_BUTTON_DOWN) != 0) handler(header.hDevice, 0x04, true, 0);
                        if ((flags & Native.RI_MOUSE_MIDDLE_BUTTON_UP) != 0) handler(header.hDevice, 0x04, false, 0);
                    }
                    return;
                }

                if (header.dwType == Native.RIM_TYPEHID)
                {
                    /*
                     * HID 原始报告（厂商自定义那几路：返回 / 主页 / 电源 / TV 大概都在这）。
                     * 报告格式各厂商不同，没法通用解析，只能"学"：把报告里第一个非零字节抬到
                     * 0x100 以上当作这个键的码；全零报告＝上一次那个键抬起了。
                     * 这样同一个键每次算出来的码都一样，学习模式打印出来就能直接绑定到某个按键。
                     */
                    var head = (Native.RAWHID)Marshal.PtrToStructure(body, typeof(Native.RAWHID));
                    int total = (int)(head.dwSizeHid * head.dwCount);
                    if (total <= 0) return;
                    IntPtr data = new IntPtr(body.ToInt64() + Marshal.SizeOf(typeof(Native.RAWHID)));
                    byte first = 0;
                    for (int i = 0; i < total; i++)
                    {
                        byte value = Marshal.ReadByte(data, i);
                        if (value != 0) { first = value; break; }
                    }
                    if (first != 0)
                    {
                        _lastHidCode = (ushort)(0x100 + first);
                        if (handler != null) handler(header.hDevice, _lastHidCode, true, 0);
                    }
                    else if (_lastHidCode != 0)
                    {
                        if (handler != null) handler(header.hDevice, _lastHidCode, false, 0);
                        _lastHidCode = 0;
                    }
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        /// <summary>
        /// 跑消息循环。用 PeekMessage（非阻塞）而不是 GetMessage，每轮空隙调用一次 onIdle ——
        /// 日志落盘就走这里。这样"写文件"永远发生在**主线程**，绝不会落在会超时的钩子回调里。
        /// </summary>
        public void Run(Action onIdle = null)
        {
            // 主线程只做一件事：**阻塞在 GetMessageW 上等消息**。
            // 这里必须与那个能收到真实按键的最小测试程序一字不差 —— 任何"顺手做点别的"的改动
            // （PeekMessage + Sleep、SetTimer 定时唤醒）都会让低级钩子的回调送不到，
            // 表现就是"自己注入的键收得到、真实硬件按键全丢"。落盘改由独立的后台线程负责。
            Native.MSG msg;
            while (Native.GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                Native.TranslateMessage(ref msg);
                Native.DispatchMessageW(ref msg);
            }
        }

        public static string DeviceName(IntPtr device)
        {
            uint size = 0;
            Native.GetRawInputDeviceInfoW(device, Native.RIDI_DEVICENAME, null, ref size);
            if (size == 0) return "";
            var sb = new StringBuilder((int)size + 2);
            if (Native.GetRawInputDeviceInfoW(device, Native.RIDI_DEVICENAME, sb, ref size) == uint.MaxValue) return "";
            return sb.ToString();
        }

        public static List<string> AllKeyboards()
        {
            var list = new List<string>();
            uint count = 0;
            uint structSize = (uint)Marshal.SizeOf(typeof(Native.RAWINPUTDEVICELIST));
            Native.GetRawInputDeviceList(IntPtr.Zero, ref count, structSize);
            if (count == 0) return list;
            IntPtr buffer = Marshal.AllocHGlobal((int)(count * structSize));
            try
            {
                if (Native.GetRawInputDeviceList(buffer, ref count, structSize) == uint.MaxValue) return list;
                for (int i = 0; i < count; i++)
                {
                    IntPtr item = new IntPtr(buffer.ToInt64() + i * (int)structSize);
                    var entry = (Native.RAWINPUTDEVICELIST)Marshal.PtrToStructure(item, typeof(Native.RAWINPUTDEVICELIST));
                    if (entry.dwType != Native.RIM_TYPEKEYBOARD) continue;
                    list.Add(DeviceName(entry.hDevice));
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
            return list;
        }

        public void Dispose()
        {
            if (_hwnd != IntPtr.Zero) { Native.PostQuitMessage(0); _hwnd = IntPtr.Zero; }
        }
    }

    /// <summary>组合键注入与打开应用。</summary>
    internal static class Injector
    {
        private static readonly Dictionary<string, ushort> Keys = BuildKeyTable();

        private static Dictionary<string, ushort> BuildKeyTable()
        {
            var table = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
            for (ushort vk = 0x30; vk <= 0x39; vk++) table[((char)vk).ToString()] = vk;      // 0-9
            for (ushort vk = 0x41; vk <= 0x5A; vk++) table[((char)vk).ToString()] = vk;      // A-Z
            for (ushort vk = 0x70; vk <= 0x87; vk++) table["F" + (vk - 0x6F)] = vk;          // F1-F24
            table["Ctrl"] = 0x11; table["Control"] = 0x11; table["Alt"] = 0x12; table["Shift"] = 0x10;
            table["Win"] = 0x5B; table["Meta"] = 0x5B; table["Cmd"] = 0x5B;
            /*
             * 左右区分的修饰键（用户 2026-10-11 要用：点按遥控器语音键 = 右 Win + 右 Shift）。
             * 这几个必须写成真正的"左/右"虚拟键码（VK_LWIN 0x5B / VK_RWIN 0x5C / VK_LSHIFT 0xA0 /
             * VK_RSHIFT 0xA1 / VK_LCONTROL 0xA2 / VK_RCONTROL 0xA3 / VK_LMENU 0xA4 / VK_RMENU 0xA5），
             * 不能退回通用的 0x10/0x11/0x12 —— 那样收方分不出左右，微信输入法这类按左右认快捷键的就不认。
             * RWin / RAlt / RCtrl 还要带 KEYEVENTF_EXTENDEDKEY，见 IsExtendedKey。
             */
            table["LWin"] = 0x5B; table["RWin"] = 0x5C;
            table["LShift"] = 0xA0; table["RShift"] = 0xA1;
            table["LCtrl"] = 0xA2; table["RCtrl"] = 0xA3; table["LControl"] = 0xA2; table["RControl"] = 0xA3;
            table["LAlt"] = 0xA4; table["RAlt"] = 0xA5; table["LMenu"] = 0xA4; table["RMenu"] = 0xA5;
            table["Enter"] = 0x0D; table["Return"] = 0x0D; table["Esc"] = 0x1B; table["Escape"] = 0x1B;
            table["Tab"] = 0x09; table["Space"] = 0x20; table["Backspace"] = 0x08; table["Delete"] = 0x2E;
            table["Up"] = 0x26; table["Down"] = 0x28; table["Left"] = 0x25; table["Right"] = 0x27;
            table["ArrowUp"] = 0x26; table["ArrowDown"] = 0x28; table["ArrowLeft"] = 0x25; table["ArrowRight"] = 0x27;
            table["Home"] = 0x24; table["End"] = 0x23; table["PageUp"] = 0x21; table["PageDown"] = 0x22;
            table["MediaPlayPause"] = 0xB3; table["MediaNext"] = 0xB0; table["MediaPrev"] = 0xB1;
            table["VolumeUp"] = 0xAF; table["VolumeDown"] = 0xAE; table["VolumeMute"] = 0xAD;
            /*
             * 鼠标键用 Windows **标准的鼠标虚拟键**（VK_LBUTTON / VK_RBUTTON / VK_MBUTTON）。
             * 这么接的好处：解析、--dry-run、组合键注入这三条路一行都不用改 ——
             * 只有"造输入"那一步（MakeInput）需要按虚拟键分流出 MOUSEINPUT。
             * 面板侧的录制区就是按这三个名字存下来的。
             */
            table["MouseLeft"] = 0x01; table["MouseRight"] = 0x02; table["MouseMiddle"] = 0x04;
            /*
             * OEM 标点键。
             *
             * DSH 有几个快捷命令的默认键位就在这几个键上：settings.open = Ctrl+Alt+,
             * shortcuts.open = Ctrl+/、terminal.new = Ctrl+`。少了它们，那三条预设
             * 连"组合键能不能被认出来"都过不了（Parse 直接回 unknown-key）。
             *
             * 用 VK 而不是字符：注入走虚拟键，扫描码另外反查，这样浏览器算出来的
             * event.code 才是对的（Comma / Slash / Backquote / Period …）。
             *
             * 2026-10-11 补。Python 版引擎（read-engine.py）里那张表要同步 ——
             * 两边对同一个组合键必须给出同一个判断，否则"换个引擎就不好使"极难查。
             */
            table[","] = 0xBC; table["Comma"] = 0xBC;
            table["."] = 0xBE; table["Period"] = 0xBE;
            table["/"] = 0xBF; table["Slash"] = 0xBF;
            table[";"] = 0xBA; table["Semicolon"] = 0xBA;
            table["'"] = 0xDE; table["Quote"] = 0xDE;
            table["["] = 0xDB; table["BracketLeft"] = 0xDB;
            table["]"] = 0xDD; table["BracketRight"] = 0xDD;
            table["\\"] = 0xDC; table["Backslash"] = 0xDC;
            table["-"] = 0xBD; table["Minus"] = 0xBD;
            table["="] = 0xBB; table["Equal"] = 0xBB;
            table["`"] = 0xC0; table["Backquote"] = 0xC0;
            return table;
        }

        /// <summary>
        /// 把组合键字符串解析成 VK 序列（**不注入**）。给 --dry-run 与自测用：
        /// 映射能不能生效，先看它的组合键能不能被认出来 —— 认不出来就不必真按键了。
        /// </summary>
        public static bool Parse(string combo, out List<ushort> vkeys, out List<string> names, out string error)
        {
            vkeys = new List<ushort>();
            names = new List<string>();
            error = null;
            if (string.IsNullOrEmpty(combo)) { error = "empty-combo"; return false; }
            foreach (string rawPart in combo.Split('+'))
            {
                string part = rawPart.Trim();
                // 空段只可能来自「没写完」（`Ctrl+`）或连写（`Ctrl++N`）。
                // 静默丢掉它会降级成单键 Ctrl —— 那种误触发比直接报错难查得多，所以明确拒绝。
                if (part.Length == 0) { error = "empty-key-part"; return false; }
                ushort vk;
                if (!Keys.TryGetValue(part, out vk)) { error = "unknown-key:" + part; return false; }
                vkeys.Add(vk);
                names.Add(part);
            }
            if (vkeys.Count == 0) { error = "empty-combo"; return false; }
            return true;
        }

        public static bool Combo(string combo, out string error)
        {
            error = null;
            List<ushort> vks;
            List<string> names;
            if (!Parse(combo, out vks, out names, out error)) return false;
            /*
             * ⚠️ 必须**分批发、中间留几毫秒**，不能六个事件挤在一次 SendInput 里。
             *
             * 原来是一批发完（Ctrl↓ Alt↓ K↓ K↑ Alt↑ Ctrl↑），实测表现是"SendInput 报成功、
             * 前台毫无反应" —— 用户 2026-10-11 报的就是这个：日志里 ok:true，界面没动静。
             * 原因：同一批次里修饰键和主键几乎是同一时刻入队，应用看不到"修饰键正按着"的
             * 中间状态，于是把它当成几个孤立按键（Ctrl、Alt、K 各按一下）而不是组合键。
             * 单个键（tap F24）一直是好的，正好印证问题只在组合键。
             */
            return SendChord(vks, out error);
        }

        /// <summary>把一串虚拟键当成"组合键"发出去：修饰键先按住，主键按下抬起，再松开修饰键。</summary>
        private static bool SendChord(List<ushort> vks, out string error)        {
            error = null;
            if (vks.Count == 0) { error = "empty-combo"; return false; }
            int modifiers = vks.Count - 1;
            ushort main = vks[vks.Count - 1];

            for (int i = 0; i < modifiers; i++)
            {
                if (!SendOne(MakeInput(vks[i], false), out error)) { ReleaseModifiers(vks, modifiers); return false; }
            }
            /*
             * 分批之间的等待：**不能省，但要短**。
             * 同刻入队的话应用认不出这是组合键（修饰键和主键要能分出先后）；
             * 但原来 12/14/10 = 36ms 纯属白等 —— 实测降到 6/8/5 = 19ms 依然被正确识别
             * （2026-10-11 用诊断页核对过：code/ctrlKey/altKey 都对）。
             */
            if (modifiers > 0) Thread.Sleep(6);           // 让应用先"看到"修饰键按下
            if (!SendOne(MakeInput(main, false), out error)) { ReleaseModifiers(vks, modifiers); return false; }
            Thread.Sleep(8);                               // 主键按住一小会儿，别和修饰键同刻
            if (!SendOne(MakeInput(main, true), out error)) { ReleaseModifiers(vks, modifiers); return false; }
            if (modifiers > 0) Thread.Sleep(5);
            return ReleaseModifiers(vks, modifiers);
        }

        private static bool ReleaseModifiers(List<ushort> vks, int modifiers)
        {
            string ignored;
            bool ok = true;
            for (int i = modifiers - 1; i >= 0; i--)
            {
                if (!SendOne(MakeInput(vks[i], true), out ignored)) ok = false;
            }
            return ok;
        }

        /*
         * 「按住不放」用的一对 —— 用户 2026-10-11 的需求：
         * 遥控器语音键**长按**时把 Alt 按住，**松开语音键**时才放开 Alt（微信输入法那类"按住说话"就是这个模式）。
         * 和 Combo 的区别：Combo 是"按下+抬起"一条龙，这里是分成两次调用，中间由调用方决定什么时候松。
         */
        public static bool Down(string combo, out string error)
        {
            error = null;
            List<ushort> vks;
            List<string> names;
            if (!Parse(combo, out vks, out names, out error)) return false;
            if (vks.Count == 0) { error = "empty-combo"; return false; }
            // 组合键的按住：修饰键先下，主键最后下（顺序和 SendChord 一致，应用才认得出是组合）。
            for (int i = 0; i < vks.Count; i++)
            {
                if (!SendOne(MakeInput(vks[i], false), out error)) return false;
                if (i + 1 < vks.Count) Thread.Sleep(12);
            }
            return true;
        }

        public static bool Up(string combo, out string error)
        {
            error = null;
            List<ushort> vks;
            List<string> names;
            if (!Parse(combo, out vks, out names, out error)) return false;
            if (vks.Count == 0) { error = "empty-combo"; return false; }
            // 松开按相反顺序：主键先起，修饰键后起。
            for (int i = vks.Count - 1; i >= 0; i--)
            {
                if (!SendOne(MakeInput(vks[i], true), out error)) return false;
            }
            return true;
        }

        private static bool SendOne(Native.INPUT input, out string error)
        {
            error = null;
            var batch = new Native.INPUT[1] { input };
            uint sent = Native.SendInput(1, batch, Marshal.SizeOf(typeof(Native.INPUT)));
            if (sent != 1) { error = "sendinput-failed:" + Marshal.GetLastWin32Error(); return false; }
            return true;
        }

        /// <summary>鼠标虚拟键？Windows 标准：VK_LBUTTON / VK_RBUTTON / VK_MBUTTON。</summary>
        public static bool IsMouseVk(ushort vk) { return vk == 0x01 || vk == 0x02 || vk == 0x04; }

        public static Native.INPUT MakeInput(ushort vk, bool keyUp)
        {
            var input = new Native.INPUT();
            if (IsMouseVk(vk))
            {
                /*
                 * 鼠标键：走 MOUSEINPUT。**不带坐标**（dx/dy 全 0 且不加 MOUSEEVENTF_ABSOLUTE）
                 * ⇒ 点的是**光标当前位置**，这也是"点一下我现在指着的东西"最自然的含义。
                 * 组合键照旧能用：Combo 会先按下修饰键、点、再依次松开。
                 */
                input.type = Native.INPUT_MOUSE;
                input.u.mi.dx = 0;
                input.u.mi.dy = 0;
                input.u.mi.mouseData = 0;
                input.u.mi.time = 0;
                input.u.mi.dwExtraInfo = IntPtr.Zero;
                if (vk == 0x01)
                    input.u.mi.dwFlags = keyUp ? Native.MOUSEEVENTF_LEFTUP : Native.MOUSEEVENTF_LEFTDOWN;
                else if (vk == 0x02)
                    input.u.mi.dwFlags = keyUp ? Native.MOUSEEVENTF_RIGHTUP : Native.MOUSEEVENTF_RIGHTDOWN;
                else
                    input.u.mi.dwFlags = keyUp ? Native.MOUSEEVENTF_MIDDLEUP : Native.MOUSEEVENTF_MIDDLEDOWN;
                return input;
            }
            /*
             * 发按键：**虚拟键码和扫描码一起填**。
             *
             * ⚠️ 扫描码不能省（2026-10-11 定位到的关键）。
             * 浏览器算 `event.code`（物理键码，如 'KeyB' / 'Enter' / 'Slash'）靠的就是扫描码；
             * 只填 wVk、wScan=0 时浏览器拿不到物理键码，`event.code` 是空的 ——
             * 而 DSH 的快捷键正是按 `event.code` 匹配的
             * （见 D:\deepseek-harness\packages\client\shortcuts\src\binding.ts:14
             *   "One or two distinct physical keys held together"）。
             * 症状：物理键盘按 Ctrl+Alt+B 好使，遥控器注入进去毫无反应。
             * 实测（诊断页读到的浏览器事件）：修好前 code 为空，修好后
             *   keydown ControlLeft(ctrl=true) → AltLeft(alt=true) → KeyB(ctrl=true,alt=true)，DSH 正常响应。
             *
             * ⚠️ 也**不要**改成 `wVk=0 + wScan=扫描码 + KEYEVENTF_SCANCODE` —— 那个组合实测
             * 会让注入彻底失效（SendInput 返回成功、连低级钩子都收不到）。正确写法是**两个都填、
             * 不带 KEYEVENTF_SCANCODE**。
             */
            input.type = Native.INPUT_KEYBOARD;
            input.u.ki.wVk = vk;
            input.u.ki.wScan = (ushort)(Native.MapVirtualKeyW(vk, Native.MAPVK_VK_TO_VSC) & 0xFF);
            /*
             * 扩展键要带 KEYEVENTF_EXTENDEDKEY：方向键、右 Ctrl/Alt、Home/End/Insert/Delete
             * 这些在主键盘区之外，不带这个位时部分应用（尤其浏览器）会把它们当另一个键。
             */
            uint flags = keyUp ? Native.KEYEVENTF_KEYUP : 0;
            if (IsExtendedKey(vk)) flags |= Native.KEYEVENTF_EXTENDEDKEY;
            input.u.ki.dwFlags = flags;
            input.u.ki.time = 0;
            input.u.ki.dwExtraInfo = IntPtr.Zero;
            return input;
        }

        /// <summary>是不是"扩展键"（Windows 的扩展扫描码那一批）。</summary>
        private static bool IsExtendedKey(ushort vk)
        {
            switch (vk)
            {
                case 0x21: case 0x22: case 0x23: case 0x24:   // PageUp PageDown End Home
                case 0x25: case 0x26: case 0x27: case 0x28:   // Left Up Right Down
                case 0x2D: case 0x2E:                          // Insert Delete
                case 0x5B: case 0x5C: case 0x5D:               // LWin RWin Apps
                case 0x6F: case 0x90: case 0xA3: case 0xA5:   // 小键盘 / NumLock 右Ctrl 右Alt
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>
        /// 鼠标**相对移动**（用户 2026-10-11 的真实需求：长按方向键连续移动光标）。
        /// 动作名 MoveUp / MoveDown / MoveLeft / MoveRight —— 刻意不叫 MouseUp 之类，
        /// 因为 MouseLeft/Right/Middle 已经被"鼠标按键"占用了，重名会分不清是点还是移。
        /// </summary>
        public static bool Move(string which, int pixels, out string error)
        {
            error = null;
            int dx = 0;
            int dy = 0;
            switch ((which ?? "").ToLowerInvariant())
            {
                case "moveup": dy = -pixels; break;
                case "movedown": dy = pixels; break;
                case "moveleft": dx = -pixels; break;
                case "moveright": dx = pixels; break;
                default: error = "unknown-move:" + which; return false;
            }
            var input = new Native.INPUT();
            input.type = Native.INPUT_MOUSE;
            input.u.mi.dx = dx;
            input.u.mi.dy = dy;
            input.u.mi.mouseData = 0;
            input.u.mi.dwFlags = Native.MOUSEEVENTF_MOVE;   // 相对位移
            input.u.mi.time = 0;
            input.u.mi.dwExtraInfo = IntPtr.Zero;
            var batch = new Native.INPUT[1] { input };
            uint sent = Native.SendInput(1, batch, Marshal.SizeOf(typeof(Native.INPUT)));
            if (sent != 1) { error = "sendinput-failed:" + Marshal.GetLastWin32Error(); return false; }
            return true;
        }

        public static bool IsMoveAction(string combo)
        {
            if (string.IsNullOrEmpty(combo)) return false;
            string value = combo.ToLowerInvariant();
            return value == "moveup" || value == "movedown" || value == "moveleft" || value == "moveright";
        }

        public static bool Launch(string target, out string error)
        {
            error = null;
            if (string.IsNullOrEmpty(target)) { error = "empty-target"; return false; }
            try
            {
                var start = new ProcessStartInfo(target);
                start.UseShellExecute = true;
                Process.Start(start);
                return true;
            }
            catch (Exception ex) { error = "launch-failed:" + ex.Message; return false; }
        }
    }

    /// <summary>
    /// 低级键盘钩子监听：挂上就能收，不依赖窗口与 Raw Input 注册。
    /// 回调里**只观察、不拦截**（一律 CallNextHookEx），所以不会影响正常打字。
    /// </summary>
    internal sealed class HookKeyboardListener : IDisposable
    {
        /// <summary>(vkCode, isDown, scanCode, flags) —— flags 里的 LLKHF_INJECTED 用来识别注入的键。</summary>
        public event Action<ushort, bool, uint, uint> OnKey;

        private readonly Native.LowLevelKeyboardProc _proc;   // 必须持有引用，否则委托被回收
        private IntPtr _hook = IntPtr.Zero;

        public HookKeyboardListener()
        {
            _proc = Callback;
            /*
             * ⚠️ hMod 必须传 NULL（IntPtr.Zero）。
             *
             * 用户 2026-10-11 实测的关键规律：传 exe 自己的模块句柄时，**只有本进程的窗口在前台
             * 才收得到按键**，焦点切到别的窗口就完全收不到。原因：传了 hMod，系统认为"钩子过程
             * 住在那个模块里"，于是要把该模块注入到每个目标进程才能收键；可执行文件无法被当钩子
             * DLL 注入 —— 钩子于是退化成"只对本进程有效"。
             * 低级钩子（WH_KEYBOARD_LL）的回调本来就在装钩子的进程里执行，不需要任何 DLL。
             * 别再改回 GetModuleHandleW(null) —— 之前我"验证"过它"能收到"，其实只是因为
             * 那个测试窗口当时恰好在前台（AllocConsole 新建的窗口会抢焦点）。
             * 另外：注入的键任何情况下都收得到（SendInput 不依赖焦点），所以拿注入的键
             * 判断"钩子好没好"永远会得出错误结论。
             */
            _hook = Native.SetWindowsHookExW(Native.WH_KEYBOARD_LL, _proc, IntPtr.Zero, 0);
            if (_hook == IntPtr.Zero)
                throw new InvalidOperationException("SetWindowsHookEx(WH_KEYBOARD_LL) failed: " + Marshal.GetLastWin32Error());
        }

        private IntPtr Callback(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                var data = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                int msg = wParam.ToInt32();
                bool down = msg == Native.WM_KEYDOWN || msg == Native.WM_SYSKEYDOWN;
                bool up = msg == Native.WM_KEYUP || msg == Native.WM_SYSKEYUP;
                if (down || up)
                {
                    var handler = OnKey;
                    if (handler != null) handler((ushort)data.vkCode, down, data.scanCode, data.flags);
                }
            }
            // 只观察，不吞键 —— 返回 1 会把按键拦下来，那会破坏正常使用。
            return Native.CallNextHookEx(_hook, code, wParam, lParam);
        }

        /// <summary>
        /// 跑消息循环（低级钩子的回调靠它派发）。
        /// 用 PeekMessage（非阻塞）而不是 GetMessage，每轮空隙调用一次 onIdle —— 日志落盘走那里。
        /// 这是这一夜最关键的修正：**落盘绝不能发生在钩子回调里**（回调有 300 毫秒超时，
        /// 写文件一超，系统就把钩子摘掉，之后真实按键全丢，而注入的键照样收得到）。
        /// </summary>
        public void Run(Action onIdle = null)
        {
            // 主线程只做一件事：**阻塞在 GetMessageW 上等消息**。
            // 这里必须与那个能收到真实按键的最小测试程序一字不差 —— 任何"顺手做点别的"的改动
            // （PeekMessage + Sleep、SetTimer 定时唤醒）都会让低级钩子的回调送不到，
            // 表现就是"自己注入的键收得到、真实硬件按键全丢"。落盘改由独立的后台线程负责。
            Native.MSG msg;
            while (Native.GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                Native.TranslateMessage(ref msg);
                Native.DispatchMessageW(ref msg);
            }
        }

        public void Dispose()
        {
            if (_hook != IntPtr.Zero) { Native.UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        }
    }

    /// <summary>把一个按键的原始按下/抬起，判定成 单击 / 双击 / 长按。</summary>
    internal sealed class ClickClassifier
    {
        private const int DoubleClickMs = 320;   // 两次按下间隔小于它算双击
        private const int HoldMs = 650;          // 按住超过它算长按
        private readonly object _gate = new object();
        private readonly Dictionary<ushort, State> _states = new Dictionary<ushort, State>();
        private readonly Action<ushort, string> _fire;
        /*
         * "这个键配了双击动作吗"。
         *
         * 为什么要问：单击和双击靠 DoubleClickMs 窗口区分，所以单击**必须等窗口过去**才能确定
         * "这不是双击的第一下"。但多数键根本没配双击，那 320ms 是白等的 ——
         * 实测它是整条延迟里最大的一段（松手→执行原本约 370ms），手感就是"慢半拍"。
         * 没配双击的键直接松手就执行，实测降到 24~37ms（2026-10-11 用户要求）。
         */
        private readonly Func<ushort, bool> _hasDouble;

        private sealed class State
        {
            public DateTime DownAt;
            public bool Down;
            public Timer HoldTimer;
            public Timer ClickTimer;
            public bool HoldFired;
            public bool DoublePending;
        }

        public ClickClassifier(Action<ushort, string> fire) : this(fire, null) { }

        /// <param name="hasDouble">这个键配了双击动作吗；null 表示"一律当配了"（保持旧行为，安全兜底）</param>
        public ClickClassifier(Action<ushort, string> fire, Func<ushort, bool> hasDouble)
        {
            _fire = fire;
            _hasDouble = hasDouble;
        }

        /// <summary>没给判定函数时一律返回 true —— 宁可慢一点，也不能把双击判没了。</summary>
        private bool HasDoubleAction(ushort vkey)
        {
            return _hasDouble == null || _hasDouble(vkey);
        }

        public void OnKey(ushort vkey, bool down)
        {
            lock (_gate)
            {
                State state;
                if (!_states.TryGetValue(vkey, out state)) { state = new State(); _states[vkey] = state; }
                if (down)
                {
                    if (state.Down) return;      // 重复按下（自动重复）忽略
                    state.Down = true;
                    state.DownAt = DateTime.UtcNow;
                    state.HoldFired = false;
                    if (state.ClickTimer != null) { state.ClickTimer.Dispose(); state.ClickTimer = null; state.DoublePending = true; }
                    else state.DoublePending = false;
                    state.HoldTimer = new Timer(_ => FireHold(vkey), null, HoldMs, Timeout.Infinite);
                }
                else
                {
                    if (!state.Down) return;
                    state.Down = false;
                    if (state.HoldTimer != null) { state.HoldTimer.Dispose(); state.HoldTimer = null; }
                    if (state.HoldFired) return;  // 长按已经触发过，抬起不再算点击
                    bool doubleNow = state.DoublePending;
                    state.DoublePending = false;
                    if (doubleNow)
                    {
                        if (state.ClickTimer != null) { state.ClickTimer.Dispose(); state.ClickTimer = null; }
                        _fire(vkey, "double");
                    }
                    else if (HasDoubleAction(vkey))
                    {
                        /*
                         * 这个键**配了双击动作** → 必须等双击窗口过去，才能确定"这不是双击的第一下"。
                         * 代价是单击固定慢 DoubleClickMs。
                         */
                        state.ClickTimer = new Timer(_ => FireClick(vkey), null, DoubleClickMs, Timeout.Infinite);
                    }
                    else
                    {
                        /*
                         * 这个键**没配双击动作** → 松手立刻执行，一秒都不用等。
                         *
                         * 原来不分青红皂白一律等 DoubleClickMs，而多数键（TV / 电源 / 主页…）
                         * 根本没配双击，那 320ms 是白等的 —— 实测它是整条延迟里最大的一段
                         * （松手→执行原本约 370ms，其中 320ms 耗在这里），手感就是"慢半拍"。
                         * 2026-10-11 用户明确要求："没配双击的键，松手立刻执行"。
                         */
                        _fire(vkey, "click");
                    }
                }
            }
        }

        private void FireClick(ushort vkey)
        {
            lock (_gate)
            {
                State state;
                if (_states.TryGetValue(vkey, out state) && state.ClickTimer != null)
                {
                    state.ClickTimer.Dispose();
                    state.ClickTimer = null;
                }
            }
            _fire(vkey, "click");
        }

        private void FireHold(ushort vkey)
        {
            lock (_gate)
            {
                State state;
                if (!_states.TryGetValue(vkey, out state) || !state.Down) return;
                state.HoldFired = true;
                if (state.ClickTimer != null) { state.ClickTimer.Dispose(); state.ClickTimer = null; }
            }
            _fire(vkey, "hold");
        }
    }

    internal static class Program
    {
        private static bool _verbose;
        // 默认**不监听任何设备**：本机 VID_2717 底下除了（未来的）遥控器，还有小米 USB 键鼠复合设备，
        // 按厂商号过滤会把用户键盘的按键一起收进来（用户用那块键盘打字时会重复触发映射）。
        // 所以 run 模式必须显式给 --filter，值应当是 learn 模式实测出来的遥控器设备名片段。
        private static string _filter = "";
        private static bool _anyDevice;
        private static bool _injectTest;   // doctor 的 --inject：要不要连注入一起验（默认不验，免得打扰人）
        private static string _nameFilter = "";   // hidread 的设备名过滤（空 = 所有 HID）
        private static bool _useHook;             // learn --hook：用低级键盘钩子听（Raw Input 收不到东西时的替代）
        private static bool _bothChannels;        // learn --both：钩子与 Raw Input 同时开，日志标明来源
        private static string _readFile;          // read --file：从"按键采集器"写的 JSON 行里读（Frida 那条路）
        private static string _configPath;        // read --config：映射文件

        /*
         * 「按住不放」型动作当前按着哪些键：遥控器 usage → 正被按住的组合键。
         * 语音键长按时会往这里记一条，等那颗遥控器键松开时再放开（见 HandleReportLine）。
         * 用锁是因为判定器的长按是在 Timer 线程上触发的。
         */
        private static readonly Dictionary<ushort, string> HeldByKey = new Dictionary<ushort, string>();
        private static readonly object HeldGate = new object();

        /*
         * 「长按连续移动鼠标」的循环状态。
         *
         * 为什么必须是**静态字段**：松开要停掉这个循环，而松开是在 HandleReportLine（静态方法）里处理的
         * —— 放在 RunFromFile 的局部变量里它看不见。
         * 2026-10-11 用户报"鼠标上/下/左/右移按了之后开始移动就不会停下来"：
         * 原来 read 模式只启动了循环、没有任何地方停它（run 模式那段有停，read 模式漏了）。
         */
        private static Timer MoveRepeat = null;
        private static ushort MoveRepeatKey = 0;
        private static string MoveRepeatCombo = null;
        private static readonly object MoveGate = new object();

        /// <summary>停掉长按连续移动的循环（松手时调）。</summary>
        private static void StopMoveRepeat()
        {
            lock (MoveGate)
            {
                if (MoveRepeat != null) { MoveRepeat.Dispose(); MoveRepeat = null; }
                MoveRepeatCombo = null;
                MoveRepeatKey = 0;
            }
        }

        /*
         * 遥控器的 HID usage → 按键 id。
         *
         * 这张表直接抄自 sayall-helper.exe 里内嵌的 rc003_agent.js（2026-10-11 提取出来，
         * 5220 行）。它是**唯一能拿到全部按键**的路 —— 低级钩子只能在本进程前台时收到、
         * 且拿不到 返回/音量；Raw Input 和 GetAsyncKeyState 在这台机器上完全收不到。
         * 实测（frida-rc003.py）12 个键一个不缺，且不受前台焦点影响。
         */
        private static readonly Dictionary<int, string> UsageToButton = new Dictionary<int, string>
        {
            { 0x00F1, "back" }, { 0x0028, "ok" }, { 0x0035, "tv" }, { 0x004A, "home" },
            { 0x004F, "right" }, { 0x0050, "left" }, { 0x0051, "down" }, { 0x0052, "up" },
            { 0x0065, "menu" }, { 0x0066, "power" }, { 0x007F, "volmute" },
            { 0x0080, "volup" }, { 0x0081, "voldown" }, { 0x003E, "voice" },
        };
        private static StreamWriter _tee;
        private static Timer _stopTimer;   // 必须持引用：局部 Timer 会被 GC 回收，回调不再触发

        /*
         * 输出队列 + 后台写盘线程。
         *
         * ⚠️ 为什么 Emit 必须**非阻塞**：低级键盘钩子（WH_KEYBOARD_LL）有回调超时
         * （Windows 默认 300 毫秒），超了系统会把钩子**直接摘掉**，之后真实按键再也不投递。
         * 2026-10-11 踩的就是这个：钩子回调里同步拼 JSON、写文件、Flush 磁盘，
         * 现象是"第一次能用，之后真实按键全部收不到，而自己 SendInput 注入的键还能收到"
         * —— 因为注入那条路不经过超时检查，所以看着像"钩子还活着"，其实早被摘了。
         * 所以：回调路径上只入队（纯内存，微秒级），写盘交给这个后台线程。
         */
        private static readonly Queue<string> _emitQueue = new Queue<string>();
        private static readonly object _emitGate = new object();
        private static readonly AutoResetEvent _emitSignal = new AutoResetEvent(false);

        private static void StartEmitWorker()
        {
            if (Emitting != null) return;
            var worker = new Thread(() =>
            {
                while (true)
                {
                    string line = null;
                    lock (_emitGate)
                    {
                        if (_emitQueue.Count > 0) line = _emitQueue.Dequeue();
                    }
                    if (line == null) { _emitSignal.WaitOne(200); continue; }
                    try { Console.WriteLine(line); } catch (Exception) { /* 没有 stdout 就算了 */ }
                    try { if (_tee != null) { _tee.WriteLine(line); _tee.Flush(); } } catch (Exception) { }
                }
            });
            worker.IsBackground = true;
            worker.Start();
            Emitting = worker;
        }

        /// <summary>写盘线程的句柄。非空即表示已经起过 —— 用它代替"再判一次 _emitWorker"，避免无锁读的可见性问题。</summary>
        public static Thread Emitting;

        /// <summary>
        /// 输出一行 JSON。stdout 之外，给了 --out 时同时落一份到文件 —— 管道缓冲在
        /// 后台启动时不可靠（实测 ReadToEndAsync 拿不到内容），文件是稳的取证通道。
        /// 注意：这里**只入队**，见上面关于钩子回调超时的说明。
        /// </summary>
        /// <summary>
        /// 输出一行 JSON —— **只往内存队列里塞一下，绝不碰文件、绝不碰 Console**。
        ///
        /// ⚠️ 这是这一夜追出来的最关键一条。Emit 会被**低级键盘钩子的回调**调用，而回调有
        /// 300 毫秒超时：超了 Windows 直接把钩子摘掉，之后真实硬件按键全部消失，
        /// 而自己 SendInput 注入的键照样收得到（那条路不经过同一个检查）—— 极具误导性。
        /// 之前的写法是同步 `Console.WriteLine`（无控制台时会阻塞）或 `_tee.Flush()`（落盘几十毫秒），
        /// 两者都能把回调拖超时。现在改成入队（微秒级），真正的写出由主线程的 PumpLog 做
        /// （主线程用 PeekMessage 轮询，每轮空隙刷一次）。
        /// </summary>
        private static void Emit(string line)
        {
            lock (_emitGate)
            {
                // 队列太长说明消费跟不上。宁可丢日志，也不能让回调变慢 —— 回调一慢，钩子就没了。
                while (_emitQueue.Count > 5000) _emitQueue.Dequeue();
                _emitQueue.Enqueue(line);
            }
        }

        /// <summary>
        /// 主线程调用：把内存里攒的日志真正写出去。
        /// Console 只在"确实有控制台"时才碰（无控制台的进程里 Console.WriteLine 会阻塞）。
        /// </summary>
        private static void PumpLog()
        {
            bool wrote = false;
            while (true)
            {
                string line;
                lock (_emitGate)
                {
                    if (_emitQueue.Count == 0) break;
                    line = _emitQueue.Dequeue();
                }
                /*
                 * stdout 无条件写。原来加了"只在有控制台时才写"的判断，那是错的：
                 * 被 execFileSync 之类以管道方式启动时进程**没有控制台**，但 stdout 是有效的，
                 * 判断一挡，外部就什么都读不到（2026-10-11 自测一次性挂了十几项就是这个）。
                 * 而"无控制台时 Console.WriteLine 会阻塞"这个担心也不成立 —— 那个能正常工作的
                 * 最小测试程序 hooktest 就是无条件写的。
                 */
                try { Console.WriteLine(line); } catch (Exception) { }
                if (_tee != null) { try { _tee.WriteLine(line); } catch (Exception) { } }
                wrote = true;
            }
            if (wrote && _tee != null) { try { _tee.Flush(); } catch (Exception) { } }
        }

        /// <summary>
        /// 启动一个专门写日志的后台线程。
        ///
        /// ⚠️ 必须在**启动时**就起好，而且**只有它**做文件 IO。
        /// 主线程的消息循环要保持成"纯粹的 GetMessageW 等待"（和那个能收到真实按键的最小测试
        /// 程序一字不差）—— 一旦主线程被别的事分心（PeekMessage + Sleep、SetTimer 定时唤醒），
        /// 低级钩子的回调就送不到了。而回调里更不能做 IO（300 毫秒超时）。
        /// 两头都堵死之后，写盘就只剩"独立线程"这一个位置。
        /// </summary>
        private static void StartLogThread()
        {
            if (_logThread != null) return;
            _logThread = new Thread(() =>
            {
                while (true) { PumpLog(); Thread.Sleep(50); }
            });
            _logThread.IsBackground = true;
            _logThread.Start();
        }

        private static Thread _logThread;

        /// <summary>本进程有没有控制台。没有的话 Console.WriteLine 可能阻塞，绝不能走它。</summary>
        private static bool _hasConsole;

        /// <summary>
        /// 退出前把队列写干净。
        /// 注意"队列空"不等于"已落盘"—— worker 是先从队列取走、再去写盘，
        /// 所以队列一空就返回的话，进程会在 worker 写盘之前退出（env 这种短命令踩过）。
        /// 末尾那 300ms 就是给"取走了但还没写完"那一行留的时间。
        /// </summary>
        private static void FlushEmitQueue()
        {
            var deadline = DateTime.UtcNow.AddSeconds(2);
            while (DateTime.UtcNow < deadline)
            {
                lock (_emitGate) { if (_emitQueue.Count == 0) break; }
                Thread.Sleep(30);
            }
            Thread.Sleep(300);
            try { if (_tee != null) { _tee.Flush(); } } catch (Exception) { }
        }

        /// <summary>读一个 USER 对象（窗口站/桌面）的名字。</summary>
        private static string UserObjectName(IntPtr handle)
        {
            if (handle == IntPtr.Zero) return "<null>";
            var sb = new StringBuilder(256);
            uint needed;
            if (!Native.GetUserObjectInformationW(handle, Native.UOI_NAME, sb, (uint)(sb.Capacity * 2), out needed))
                return "<err:" + Marshal.GetLastWin32Error() + ">";
            return sb.ToString();
        }

        /// <summary>
        /// 报告本进程所在的窗口站与桌面，以及"当前接收输入的那个桌面"叫什么。
        ///
        /// 为什么要它：低级钩子和 Raw Input 都只收**本进程所在桌面**的输入。如果本进程
        /// 被起在了别的桌面（服务桌面、或另一个 window station），现象就是"自己注入的键
        /// 收得到（SendInput 插进的是本桌面的队列），用户真实按键一条都收不到"。
        /// 这条命令让我不用麻烦用户按键就能自查。
        /// </summary>
        private static int RunEnv()
        {
            string station = UserObjectName(Native.GetProcessWindowStation());
            string desktop = UserObjectName(Native.GetThreadDesktop(Native.GetCurrentThreadId()));
            IntPtr input = Native.OpenInputDesktop(0, false, Native.DESKTOP_READOBJECTS);
            uint openError = input == IntPtr.Zero ? (uint)Marshal.GetLastWin32Error() : 0;
            string inputName = input == IntPtr.Zero ? ("<打不开:" + openError + ">") : UserObjectName(input);
            if (input != IntPtr.Zero) Native.CloseDesktop(input);
            bool same = input != IntPtr.Zero && string.Equals(inputName, desktop, StringComparison.OrdinalIgnoreCase);
            Emit("{\"type\":\"env\",\"session\":" + Process.GetCurrentProcess().SessionId +
                ",\"windowStation\":" + Json(station) + ",\"desktop\":" + Json(desktop) +
                ",\"inputDesktop\":" + Json(inputName) + ",\"openInputDesktopError\":" + openError +
                ",\"sameDesktop\":" + (same ? "true" : "false") +
                ",\"verdict\":" + Json(same
                    ? "本进程就在接收输入的那个桌面上 —— 钩子/Raw Input 理论上收得到真实按键"
                    : "本进程不在接收输入的那个桌面上 —— 这就是真实按键收不到的原因") + "}");
            FlushEmitQueue();
            return same ? 0 : 1;
        }

        private static int Main(string[] args)
        {
            /*
             * 第一件事：把自己的控制台窗口藏掉。
             *
             * 为什么不在外面藏：DSH 用 Node 的 spawn(..., { windowsHide: true }) 起引擎，那个选项
             * 等价于给进程加 CREATE_NO_WINDOW 标志 —— 而对照实验证明（2026-10-11）：
             * **带这个标志的进程收不到全局键盘钩子**（Start-Process -WindowStyle Hidden 能收到，
             * CreateNoWindow=true 收不到，同一份代码、同一个会话）。
             * 所以在外面藏行不通。改成：外面用最普通的方式起（不加那个标志），
             * 引擎自己进来第一件事就把窗口藏掉 —— 用户最多看到一闪，功能却是好的。
             */
            try { Native.ShowWindow(Native.GetConsoleWindow(), 0 /* SW_HIDE */); }
            catch (Exception) { /* 没有控制台（比如被重定向）就算了 */ }
            /*
             * ⚠️ 必须有控制台，没有就自己分配一个 —— 这是"真实按键能不能收到"的分水岭。
             *
             * 用户 2026-10-11 观察到的规律：功能正常的那几次，桌面上都有一个**常驻的控制台窗口**；
             * 而窗口"一闪就没"的版本，真实按键一条都收不到。根因是 WMI 起的进程
             * （父进程是 Session 0 的服务、且不带 CREATE_NEW_CONSOLE）**根本没有控制台**，
             * 而低级键盘钩子要靠"线程有正常的输入队列"来接收真实硬件输入 —— 没有控制台就没有它。
             * （自己 SendInput 注入的键仍收得到，所以极具误导性。）
             *
             * 所以主动 AllocConsole()，**并且让窗口正常显示在桌面上**：
             *   · 不要 ShowWindow(SW_HIDE) —— 隐藏同样会让钩子失效（试过）
             *   · 也不要 SetWindowPos 挪到屏幕外 —— 用户就看不到"它在跑"了，
             *     而且他明确指出：窗口能常驻桌面，正是功能正常的标志。
             */
            try
            {
                if (Native.GetConsoleWindow() == IntPtr.Zero) Native.AllocConsole();
            }
            catch (Exception) { /* 分配不到就算了，照常往下走 */ }
            try { _hasConsole = Native.GetConsoleWindow() != IntPtr.Zero; } catch (Exception) { _hasConsole = false; }
            StartLogThread();   // 落盘线程：主线程要留给"纯粹的 GetMessageW 等待"，回调里更不能做 IO
            /*
             * ⚠️ 退出前必须把日志队列刷干净。
             * Emit 是异步入队的（因为会被钩子回调调用，而回调有 300 毫秒超时），
             * 但 tap / doctor / testclassifier 这些短命令**干完就退出** —— 不等一下的话，
             * 那几行 JSON 还在队列里，进程就没了，外部读到的 stdout/文件全是空的
             * （2026-10-11 自测一次性挂了 16 项，就是这个）。
             */
            try
            {
                int code = MainInner(args);
                FlushEmitQueue();
                return code;
            }
            catch (Exception ex)
            {
                // 崩溃也要留证据：stdout 可能已经不可用，所以同时写一份到 stderr 与临时文件。
                string detail = "{\"type\":\"crash\",\"error\":" + Json(ex.GetType().Name + ": " + ex.Message) +
                    ",\"stack\":" + Json(ex.StackTrace ?? "") + "}";
                // 后台/无控制台启动时 stdout 与 stderr 都可能写不出去，--out 的文件才是稳的。
                try { if (_tee != null) { _tee.WriteLine(detail); _tee.Flush(); } } catch { }
                try { Console.Error.WriteLine(detail); } catch { }
                try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "keybridge-crash.log"), detail + Environment.NewLine, new UTF8Encoding(false)); } catch { }
                return 3;
            }
        }

        private static int MainInner(string[] args)
        {
            // stdout 被重定向（后台启动）时设置 OutputEncoding 会抛 IOException —— 必须容错，
            // 否则进程在解析参数之前就崩（退出码 0xE0434352），而且什么都不打印，极难查。
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
            string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "help";
            string configPath = null;
            string outPath = null;
            int seconds = 0;
            for (int i = 1; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--config" && i + 1 < args.Length) { configPath = args[++i]; }
                else if (a == "--seconds" && i + 1 < args.Length) { int.TryParse(args[++i], out seconds); }
                else if (a == "--any") { _anyDevice = true; }
                else if (a == "--filter" && i + 1 < args.Length) { _filter = args[++i]; }
                else if (a == "--verbose") { _verbose = true; }
                else if (a == "--inject") { _injectTest = true; }
                else if (a == "--name") { if (i + 1 < args.Length) { _nameFilter = args[i + 1]; i++; } }
                else if (a == "--hook") { _useHook = true; }
                else if (a == "--both") { _bothChannels = true; }
                else if (a == "--file" && i + 1 < args.Length) { _readFile = args[++i]; }
                else if (a == "--verbose") { _verbose = true; }
                else if (a == "--out" && i + 1 < args.Length) { outPath = args[++i]; }
            }

            if (outPath != null)
            {
                /*
                 * --out 打不开时**必须把原因说出来**。
                 * 原来是 `catch { _tee = null; }`，于是"日志文件没生成"完全无迹可循 ——
                 * 2026-10-11 查了很久才发现是路径问题，而进程自己一声不吭。
                 */
                try { _tee = new StreamWriter(outPath, false, new UTF8Encoding(false)); _tee.AutoFlush = true; }
                catch (Exception ex)
                {
                    _tee = null;
                    try
                    {
                        Console.WriteLine("{\"type\":\"warn\",\"warning\":\"out-open-failed\",\"path\":" +
                            Json(outPath) + ",\"error\":" + Json(ex.GetType().Name + ": " + ex.Message) + "}");
                    }
                    catch (Exception) { }
                }
            }

            switch (mode)
            {
                case "list": return RunList();
                case "learn": return RunLearn(seconds);
                case "run": return RunBridge(configPath, seconds);
                case "tap": return RunTap(args);
                case "selftest": return RunSelfTest();
                case "testclassifier": return RunClassifierTest();
                case "testmouse": return RunMouseTest();
                case "hidinfo": return RunHidInfo();
                case "env": return RunEnv();
                case "read": return RunFromFile(configPath, _readFile);
                case "hidread": return RunHidRead(seconds, _nameFilter);
                case "doctor": return RunDoctor(_injectTest);
                default:
                    Console.WriteLine("KeyBridge — DSH 侧小米遥控器按键桥");
                    Console.WriteLine("  list                        列出 Raw Input 键盘设备");
                    Console.WriteLine("  learn [--seconds N] [--any] 学习模式：打印收到的按键");
                    Console.WriteLine("  testclassifier              自测单击/双击/长按判定（模拟时序，不碰系统）");
                    Console.WriteLine("  run --config <mapping.json> 运行：按映射注入");
                    Console.WriteLine("  tap <combo>                 自测/诊断：注入一个组合键（如 tap F24）");
                    return 1;
            }
        }

        /// <summary>
        /// 自问自答：同一个进程里注册 Raw Input 监听，然后自己 SendInput 注入几个键，
        /// 看到底能不能收到。用来判定「注入的键走不走 Raw Input」这条事实 ——
        /// 跨进程测的时候收不到，但同进程能收到的话，就说明问题不在监听实现上。
        ///
        /// 注意窗口必须在**它自己的线程**上建并跑消息循环：Win32 只把窗口消息投给创建该窗口的线程。
        /// </summary>
        /// <summary>
        /// 一键体检：这台机器上引擎能不能干活、缺什么。**默认不注入**（不想在别人打游戏时发按键），
        /// 要连注入一起验就加 --inject。判定逻辑那部分纯内存跑，不碰系统。
        /// </summary>
        private static int RunDoctor(bool inject)
        {
            var keyboards = RawKeyboardListener.AllKeyboards();
            int realCount = 0;
            var names = new List<string>();
            foreach (string name in keyboards)
            {
                bool looksReal = name.IndexOf("VID_", StringComparison.OrdinalIgnoreCase) >= 0
                    && name.IndexOf("PID_", StringComparison.OrdinalIgnoreCase) >= 0;
                if (looksReal) realCount++;
                names.Add((looksReal ? "[real] " : "[virt] ") + name);
            }

            // 能不能建窗口并注册 Raw Input —— 这是监听能不能工作的前提
            string listenError = null;
            try { using (var probe = new RawKeyboardListener()) { } }
            catch (Exception ex) { listenError = ex.GetType().Name + ": " + ex.Message; }

            // 判定逻辑（单击/双击/长按）跑一遍：纯内存，不碰系统
            var fired = new List<string>();
            var classifier = new ClickClassifier((vk, slot) => { lock (fired) { fired.Add(vk + ":" + slot); } });
            classifier.OnKey(1, true); Thread.Sleep(50); classifier.OnKey(1, false); Thread.Sleep(400);
            classifier.OnKey(2, true); Thread.Sleep(50); classifier.OnKey(2, false); Thread.Sleep(110);
            classifier.OnKey(2, true); Thread.Sleep(50); classifier.OnKey(2, false); Thread.Sleep(400);
            classifier.OnKey(3, true); Thread.Sleep(750); classifier.OnKey(3, false); Thread.Sleep(200);
            string classifierResult;
            lock (fired) { classifierResult = string.Join(",", fired); }

            string injectError = null;
            bool injectOk = false;
            if (inject) injectOk = Injector.Combo("F24", out injectError);

            var sb = new StringBuilder();
            sb.Append("{\"type\":\"doctor\"");
            sb.Append(",\"keyboards\":").Append(keyboards.Count);
            sb.Append(",\"realKeyboards\":").Append(realCount);
            sb.Append(",\"listen\":").Append(listenError == null ? "\"ok\"" : Json(listenError));
            sb.Append(",\"classifier\":").Append(Json(classifierResult));
            sb.Append(",\"classifierOk\":").Append(classifierResult == "1:click,2:double,3:hold" ? "true" : "false");
            sb.Append(",\"injectTested\":").Append(inject ? "true" : "false");
            if (inject) sb.Append(",\"inject\":").Append(injectOk ? "\"ok\"" : Json(injectError ?? "failed"));
            sb.Append(",\"devices\":[");
            for (int i = 0; i < names.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append(Json(names[i]));
            }
            sb.Append("]}");
            Emit(sb.ToString());
            return listenError == null ? 0 : 1;
        }

        /// <summary>
        /// 直接读遥控器的**原始 HID 报告流**（绕开 Raw Input 那套系统翻译）。
        ///
        /// 为什么走这条：Raw Input 只送"系统认得的那一类"（遥控器只有键盘集合），
        /// 返回/主页/电源这些厂商自定义报告到不了那里。HID 设备允许多个客户端同时读，
        /// 所以这里 CreateFile + ReadFile 把**全部 Report ID 的原始字节**打出来 ——
        /// 拿到字节才知道每个键长什么样，也才能谈"学习"。
        /// </summary>
        private static int RunHidRead(int seconds, string wantName)
        {
            uint count = 0;
            uint entrySize = (uint)Marshal.SizeOf(typeof(Native.RAWINPUTDEVICELIST));
            Native.GetRawInputDeviceList(IntPtr.Zero, ref count, entrySize);
            if (count == 0) { Emit("{\"type\":\"hidread\",\"error\":\"no-devices\"}"); return 1; }
            IntPtr list = Marshal.AllocHGlobal((int)(count * entrySize));
            var targets = new List<string>();
            try
            {
                if (Native.GetRawInputDeviceList(list, ref count, entrySize) == uint.MaxValue)
                { Emit("{\"type\":\"hidread\",\"error\":\"enum-failed\"}"); return 1; }
                for (uint i = 0; i < count; i++)
                {
                    IntPtr item = new IntPtr(list.ToInt64() + (i * entrySize));
                    var entry = (Native.RAWINPUTDEVICELIST)Marshal.PtrToStructure(item, typeof(Native.RAWINPUTDEVICELIST));
                    uint nameSize = 0;
                    Native.GetRawInputDeviceInfoW(entry.hDevice, Native.RIDI_DEVICENAME, null, ref nameSize);
                    if (nameSize == 0) continue;
                    var sb = new StringBuilder((int)nameSize + 2);
                    if (Native.GetRawInputDeviceInfoW(entry.hDevice, Native.RIDI_DEVICENAME, sb, ref nameSize) == uint.MaxValue) continue;
                    string name = sb.ToString();
                    if (name.IndexOf("HID#", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (wantName.Length > 0 && name.IndexOf(wantName, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    targets.Add(name);
                }
            }
            finally { Marshal.FreeHGlobal(list); }

            var opened = new List<string>();
            var handles = new List<IntPtr>();
            foreach (string name in targets)
            {
                // 共享读 —— HID 设备本来就是多客户端可读的；不共享的话会被系统那套占用挡在外面。
                IntPtr handle = Native.CreateFileW(name, 0x80000000u /* GENERIC_READ */, 0x00000001u | 0x00000002u /* SHARE_READ|WRITE */,
                    IntPtr.Zero, 3 /* OPEN_EXISTING */, 0, IntPtr.Zero);
                if (handle == new IntPtr(-1)) continue;
                int reportLen = 64;
                IntPtr preparsed;
                if (Native.HidD_GetPreparsedData(handle, out preparsed))
                {
                    var caps = new Native.HIDP_CAPS();
                    if (Native.HidP_GetCaps(preparsed, ref caps) == 0x00110000 /* HIDP_STATUS_SUCCESS */ && caps.InputReportByteLength > 0)
                        reportLen = caps.InputReportByteLength;
                    Native.HidD_FreePreparsedData(preparsed);
                }
                handles.Add(handle);
                opened.Add("{\"name\":" + Json(name) + ",\"reportLength\":" + reportLen + "}");
            }

            Emit("{\"type\":\"hidread\",\"phase\":\"ready\",\"opened\":" + opened.Count + ",\"channels\":[" + string.Join(",", opened.ToArray()) + "]}");
            if (handles.Count == 0) return 1;

            // 每个设备一个读线程：阻塞式 ReadFile，收到就打印十六进制。
            var threads = new List<Thread>();
            foreach (IntPtr handle in handles)
            {
                IntPtr captured = handle;
                var worker = new Thread(() =>
                {
                    var buffer = new byte[256];
                    while (true)
                    {
                        uint got;
                        if (!Native.ReadFile(captured, buffer, 256, out got, IntPtr.Zero) || got == 0) break;
                        var hex = new StringBuilder();
                        for (uint i = 0; i < got; i++) hex.Append(buffer[i].ToString("X2")).Append(i + 1 < got ? " " : "");
                        Emit("{\"type\":\"hidreport\",\"len\":" + got + ",\"hex\":" + Json(hex.ToString()) + "}");
                    }
                });
                worker.IsBackground = true;
                worker.Start();
                threads.Add(worker);
            }

            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            while (stopwatch.Elapsed.TotalSeconds < seconds) Thread.Sleep(200);
            foreach (IntPtr handle in handles)
            {
                try { Native.CloseHandle(handle); }
                catch (Exception) { /* 已经关了就算了 */ }
            }
            Emit("{\"type\":\"hidread\",\"phase\":\"done\"}");
            return 0;
        }

        /// <summary>
        /// 列出所有 HID 设备的**顶级集合**（UsagePage / Usage）。
        ///
        /// 为什么需要它：Raw Input 是按顶级集合登记的 —— 登记了键盘 0x01/0x06 就只能收到键盘那一类。
        /// 用户 2026-10-11 实测：遥控器只有方向键/OK 能被系统当成键盘处理，返回/主页/电源毫无反应，
        /// 而退出 SayAll 之后依然收不到 ⇒ 不是被别人独占，是**那几路压根没登记**。
        /// 要知道该登记什么，就得先把每个设备真实的 UsagePage/Usage 读出来（RIDI_DEVICEINFO）。
        /// </summary>
        private static int RunHidInfo()
        {
            uint count = 0;
            uint entrySize = (uint)Marshal.SizeOf(typeof(Native.RAWINPUTDEVICELIST));
            Native.GetRawInputDeviceList(IntPtr.Zero, ref count, entrySize);
            var rows = new List<string>();
            if (count > 0)
            {
                IntPtr buffer = Marshal.AllocHGlobal((int)(count * entrySize));
                try
                {
                    if (Native.GetRawInputDeviceList(buffer, ref count, entrySize) != uint.MaxValue)
                    {
                        for (uint i = 0; i < count; i++)
                        {
                            IntPtr item = new IntPtr(buffer.ToInt64() + (i * entrySize));
                            var entry = (Native.RAWINPUTDEVICELIST)Marshal.PtrToStructure(item, typeof(Native.RAWINPUTDEVICELIST));

                            // 设备名（RIDI_DEVICENAME 先问长度，再取内容）
                            string name = "";
                            uint nameSize = 0;
                            Native.GetRawInputDeviceInfoW(entry.hDevice, Native.RIDI_DEVICENAME, null, ref nameSize);
                            if (nameSize > 0)
                            {
                                var sb = new StringBuilder((int)nameSize + 2);
                                if (Native.GetRawInputDeviceInfoW(entry.hDevice, Native.RIDI_DEVICENAME, sb, ref nameSize) != uint.MaxValue)
                                    name = sb.ToString();
                            }

                            // RIDI_DEVICEINFO：只取 HID 那一段的 UsagePage/Usage。
                            // 结构是 cbSize(4) + dwType(4) + union(最大 24) ⇒ HID 的这两个字段在偏移 24 / 26。
                            int usagePage = -1;
                            int usage = -1;
                            uint infoSize = 64;
                            IntPtr info = Marshal.AllocHGlobal(64);
                            try
                            {
                                /*
                                 * ⚠️ 调用前必须把 cbSize 写好 —— RIDI_DEVICEINFO 靠这个字段认结构版本，
                                 * 不填的话调用直接失败、UsagePage/Usage 全是空的（第一次就是这么踩的）。
                                 */
                                Marshal.WriteInt32(info, 0, 32);
                                if (Native.GetRawInputDeviceInfoPtr(entry.hDevice, Native.RIDI_DEVICEINFO, info, ref infoSize) != uint.MaxValue)
                                {
                                    uint type = (uint)Marshal.ReadInt32(info, 4);
                                    // type: 0=鼠标 1=键盘 2=HID
                                    if (type == 2)
                                    {
                                        usagePage = Marshal.ReadInt16(info, 24) & 0xFFFF;
                                        usage = Marshal.ReadInt16(info, 26) & 0xFFFF;
                                    }
                                    else
                                    {
                                        usagePage = type == 0 ? 0x01 : 0x01;
                                        usage = type == 0 ? 0x02 : 0x06;
                                    }
                                }
                            }
                            finally { Marshal.FreeHGlobal(info); }

                            rows.Add("{\"type\":" + entry.dwType + ",\"usagePage\":" + usagePage
                                + ",\"usage\":" + usage + ",\"name\":" + Json(name) + "}");
                        }
                    }
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            Emit("{\"type\":\"hidinfo\",\"count\":" + rows.Count + ",\"items\":[" + string.Join(",", rows.ToArray()) + "]}");
            return 0;
        }

        /// <summary>
        /// 鼠标注入的**结构自测**：不真的发事件，只检查三个鼠标键造出来的 INPUT 对不对
        /// （type 必须是 MOUSE、按下与抬起各用哪一套 flag、坐标必须是 0＝点光标当前位置）。
        ///
        /// 为什么需要它：真发一次点击会点到用户屏幕上正指着的东西，不能在自测里做；
        /// 而结构写错的表现是"只按不松"（比如按下抬起的 flag 弄反或复用同一个），
        /// 那种故障在真机上极难查 —— 系统里那个键会一直保持按下状态。
        /// </summary>
        private static int RunMouseTest()
        {
            var cases = new[] {
                new object[] { "MouseLeft", (ushort)0x01, Native.MOUSEEVENTF_LEFTDOWN, Native.MOUSEEVENTF_LEFTUP },
                new object[] { "MouseRight", (ushort)0x02, Native.MOUSEEVENTF_RIGHTDOWN, Native.MOUSEEVENTF_RIGHTUP },
                new object[] { "MouseMiddle", (ushort)0x04, Native.MOUSEEVENTF_MIDDLEDOWN, Native.MOUSEEVENTF_MIDDLEUP },
            };
            bool allOk = true;
            var rows = new List<string>();
            foreach (object[] item in cases)
            {
                string name = (string)item[0];
                ushort vk = (ushort)item[1];
                uint wantDown = (uint)item[2];
                uint wantUp = (uint)item[3];
                Native.INPUT down = Injector.MakeInput(vk, false);
                Native.INPUT up = Injector.MakeInput(vk, true);
                bool ok = down.type == Native.INPUT_MOUSE && up.type == Native.INPUT_MOUSE
                    && down.u.mi.dwFlags == wantDown && up.u.mi.dwFlags == wantUp
                    && down.u.mi.dx == 0 && down.u.mi.dy == 0 && up.u.mi.dx == 0 && up.u.mi.dy == 0
                    && down.u.mi.dwFlags != up.u.mi.dwFlags;      // 按下与抬起绝不能是同一个值
                if (!ok) allOk = false;
                rows.Add("{\"key\":" + Json(name) + ",\"type\":" + down.type
                    + ",\"down\":" + down.u.mi.dwFlags + ",\"up\":" + up.u.mi.dwFlags
                    + ",\"wantDown\":" + wantDown + ",\"wantUp\":" + wantUp + ",\"ok\":" + (ok ? "true" : "false") + "}");
            }
            // 键盘那条路不能被改坏：普通键仍要造出 KEYBOARD 类型。
            Native.INPUT keyDown = Injector.MakeInput(0x0D, false);
            Native.INPUT keyUp = Injector.MakeInput(0x0D, true);
            bool keyOk = keyDown.type == Native.INPUT_KEYBOARD && keyUp.type == Native.INPUT_KEYBOARD
                && keyDown.u.ki.wVk == 0x0D && keyDown.u.ki.dwFlags == 0 && keyUp.u.ki.dwFlags == Native.KEYEVENTF_KEYUP;
            if (!keyOk) allOk = false;
            Emit("{\"type\":\"mousetest\",\"ok\":" + (allOk ? "true" : "false")
                + ",\"keyboardIntact\":" + (keyOk ? "true" : "false")
                + ",\"cases\":[" + string.Join(",", rows.ToArray()) + "]}");
            return allOk ? 0 : 1;
        }

        /// <summary>
        /// 判定逻辑自测：单击 / 双击 / 长按是引擎最核心的一段，平时要靠真实按键时序才跑得到。
        /// 这里用**模拟时序**把它单独跑一遍 —— 遥控器还没接进来时也能确认判定是对的，
        /// 而且全程不碰系统（不注册 Raw Input、不注入）。
        /// </summary>
        private static int RunClassifierTest()
        {
            var events = new List<string>();
            var classifier = new ClickClassifier((vkey, slot) =>
            {
                lock (events) { events.Add(vkey + ":" + slot); }
            });

            // ① 单击：按 60ms、抬起，再等过双击窗口
            classifier.OnKey(1, true); Thread.Sleep(60); classifier.OnKey(1, false);
            Thread.Sleep(450);

            // ② 双击：两下之间 120ms（小于 320ms 的窗口）
            classifier.OnKey(2, true); Thread.Sleep(50); classifier.OnKey(2, false);
            Thread.Sleep(120);
            classifier.OnKey(2, true); Thread.Sleep(50); classifier.OnKey(2, false);
            Thread.Sleep(450);

            // ③ 长按：按住 800ms（超过 650ms 阈值），抬起时不应再算单击
            classifier.OnKey(3, true); Thread.Sleep(800); classifier.OnKey(3, false);
            Thread.Sleep(250);

            // ④ 自动重复：按住期间设备连发 down（只能算一次，不能变三次点击）
            classifier.OnKey(4, true); Thread.Sleep(50);
            classifier.OnKey(4, true); Thread.Sleep(50);
            classifier.OnKey(4, true); Thread.Sleep(50);
            classifier.OnKey(4, false);
            Thread.Sleep(450);

            string joined;
            lock (events) { joined = string.Join(",", events); }
            const string expected = "1:click,2:double,3:hold,4:click";
            bool ok = joined == expected;
            var quoted = new List<string>();
            lock (events) { foreach (string item in events) quoted.Add("\"" + item + "\""); }
            Emit("{\"type\":\"classifier\",\"events\":[" + string.Join(",", quoted.ToArray()) +
                "],\"expect\":" + Json(expected) + ",\"ok\":" + (ok ? "true" : "false") + "}");
            return ok ? 0 : 1;
        }

        private static int RunSelfTest()
        {
            var received = new List<string>();
            var ready = new ManualResetEventSlim(false);
            var thread = new Thread(() =>
            {
                try
                {
                    var listener = new RawKeyboardListener();
                    listener.OnKey += (device, vkey, down, makeCode) =>
                    {
                        if (!down) return;
                        lock (received) { received.Add("0x" + vkey.ToString("X2")); }
                    };
                    ready.Set();
                    listener.Run(PumpLog);
                }
                catch (Exception ex)
                {
                    Emit("{\"type\":\"listener-error\",\"error\":" + Json(ex.Message) + "}");
                    ready.Set();
                }
            });
            thread.IsBackground = true;
            thread.Start();
            ready.Wait(3000);
            Emit("{\"type\":\"ready\",\"mode\":\"selftest\"}");
            Thread.Sleep(500);

            var sent = new List<string>();
            foreach (string combo in new[] { "F24", "F23", "F22" })
            {
                string error;
                bool ok = Injector.Combo(combo, out error);
                sent.Add(combo);
                Emit("{\"type\":\"inject\",\"combo\":" + Json(combo) + ",\"ok\":" + (ok ? "true" : "false") +
                    ",\"error\":" + Json(error ?? "") + "}");
                Thread.Sleep(350);
            }
            Thread.Sleep(700);

            string keys;
            int count;
            lock (received) { keys = string.Join(",", received); count = received.Count; }
            Emit("{\"type\":\"result\",\"injected\":" + Json(string.Join(",", sent)) + ",\"received\":" + count +
                ",\"keys\":" + Json(keys) + ",\"sameProcessVisible\":" + (count > 0 ? "true" : "false") + "}");
            return 0;
        }

        /// <summary>自测用：注入一个组合键；--dry-run 时只解析不注入。</summary>
        private static int RunTap(string[] args)
        {
            // 选项可能写在组合键前面（`tap --dry-run Enter`），所以要跳过 -- 开头的再取组合键。
            string combo = null;
            bool dryRun = false;
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == "--dry-run") { dryRun = true; continue; }
                if (args[i].StartsWith("--")) continue;
                if (combo == null) combo = args[i];
            }
            if (combo == null) { Emit("{\"type\":\"error\",\"error\":\"tap-needs-combo\"}"); return 2; }
            if (dryRun)
            {
                List<ushort> vkeys;
                List<string> names;
                string parseError;
                bool parsed = Injector.Parse(combo, out vkeys, out names, out parseError);
                Emit("{\"type\":\"tap\",\"combo\":" + Json(combo) + ",\"dryRun\":true,\"ok\":" + (parsed ? "true" : "false") +
                    ",\"names\":" + Json(string.Join("+", names)) +
                    ",\"vkeys\":" + Json(string.Join(",", vkeys.ConvertAll(v => v.ToString()).ToArray())) +
                    ",\"error\":" + Json(parseError ?? "") + "}");
                return parsed ? 0 : 1;
            }
            string error;
            bool ok = Injector.Combo(combo, out error);
            Emit("{\"type\":\"tap\",\"combo\":" + Json(combo) + ",\"ok\":" + (ok ? "true" : "false") +
                ",\"error\":" + Json(error ?? "") + "}");
            return ok ? 0 : 1;
        }

        private static int RunList()
        {
            Emit("{\"type\":\"devices\",\"items\":[");
            List<string> list = RawKeyboardListener.AllKeyboards();
            for (int i = 0; i < list.Count; i++)
            {
                string name = list[i];
                bool mi = name.IndexOf("VID_2717", StringComparison.OrdinalIgnoreCase) >= 0;
                Console.WriteLine((i > 0 ? "," : "") + "{\"name\":" + Json(name) + ",\"xiaomi\":" + (mi ? "true" : "false") + "}");
            }
            Console.WriteLine("]}");
            return 0;
        }

        private static int RunLearn(int seconds)
        {
            /*
             * --both：两条通道**同时**开，日志里标明事件是从哪条来的。
             *
             * 为什么要这个：低级钩子有个"能自测"的陷阱 —— 用 tap 注入一个键，钩子能收到，
             * 看着像"工作正常"，但那可能只是本进程内的直接调用；真实硬件的按键要经过
             * 系统钩子链，被前面的钩子吞掉、或者自己根本没挂上链，都表现为"注入的收得到、
             * 真实的收不到"。两条通道一起开、一次按键，就能分清是"通道不行"还是"键没送到系统"。
             */
            if (_bothChannels)
            {
                var raw = new RawKeyboardListener();
                var hookSide = new HookKeyboardListener();
                Emit("{\"type\":\"ready\",\"mode\":\"learn-both\",\"paths\":" + RawKeyboardListener.RegisteredPaths + "}");
                raw.OnKey += (device, vkey, down, makeCode) =>
                {
                    string name = RawKeyboardListener.DeviceName(device);
                    Emit("{\"type\":\"keyboth\",\"channel\":\"rawinput\",\"vk\":" + vkey +
                        ",\"makeCode\":" + makeCode + ",\"down\":" + (down ? "true" : "false") +
                        ",\"device\":" + Json(name) + "}");
                };
                hookSide.OnKey += (vk, down, scan, flags) =>
                {
                    Emit("{\"type\":\"keyboth\",\"channel\":\"hook\",\"vk\":" + vk +
                        ",\"scan\":" + scan + ",\"flags\":" + flags +
                        ",\"injected\":" + (((flags & Native.LLKHF_INJECTED) != 0) ? "true" : "false") +
                        ",\"down\":" + (down ? "true" : "false") + "}");
                };
                if (seconds > 0)
                {
                    _stopTimer = new Timer(_ => { FlushEmitQueue(); Environment.Exit(0); },
                        null, seconds * 1000, Timeout.Infinite);
                }
                raw.Run(PumpLog);   // Raw Input 那条自带窗口与消息循环，钩子的回调也靠它派发
                return 0;
            }
            /*
             * --hook：用低级键盘钩子听。
             * Raw Input 在这台机器上实测收不到任何东西（连普通键盘都没有），所以先用钩子
             * 把"系统分发层到底有什么"看清楚 —— 遥控器的方向键正是 Windows 正在用的那些。
             */
            if (_useHook)
            {
                var hook = new HookKeyboardListener();
                Emit("{\"type\":\"ready\",\"mode\":\"learn-hook\",\"console\":" + (_hasConsole ? "true" : "false") +
                    ",\"consoleWindow\":" + Native.GetConsoleWindow().ToInt64() + "}");
                hook.OnKey += (vk, down, scan, flags) =>
                {
                    Emit("{\"type\":\"keyhook\",\"vk\":" + vk + ",\"scan\":" + scan + ",\"flags\":" + flags +
                        ",\"injected\":" + (((flags & Native.LLKHF_INJECTED) != 0) ? "true" : "false") +
                        ",\"down\":" + (down ? "true" : "false") + "}");
                };
                if (seconds > 0)
                {
                    _stopTimer = new Timer(_ => { if (_tee != null) { _tee.Flush(); _tee.Dispose(); } Environment.Exit(0); },
                        null, seconds * 1000, Timeout.Infinite);
                }
                hook.Run(PumpLog);
                return 0;
            }
            var listener = new RawKeyboardListener();
            Emit("{\"type\":\"ready\",\"mode\":\"learn\",\"filter\":" + Json(_anyDevice ? "*" : _filter) + "}");
            listener.OnKey += (device, vkey, down, makeCode) =>
            {
                string name = RawKeyboardListener.DeviceName(device);
                if (!_anyDevice && name.IndexOf(_filter, StringComparison.OrdinalIgnoreCase) < 0) return;
                Emit("{\"type\":\"key\",\"device\":" + Json(name) + ",\"vkey\":" + vkey +
                    ",\"hex\":" + Json("0x" + vkey.ToString("X2")) + ",\"makeCode\":" + makeCode +
                    ",\"injected\":" + (makeCode == 0 ? "true" : "false") +
                    ",\"down\":" + (down ? "true" : "false") + "}");
            };
            if (seconds > 0)
            {
                // ⚠️ 定时器必须存在静态字段里：局部变量会被 GC 回收，回调就再也不触发了
                //    （上一版就是这样，--seconds 150 的进程跑了一整夜都没退）。
                _stopTimer = new Timer(_ => { if (_tee != null) { _tee.Flush(); _tee.Dispose(); } Environment.Exit(0); },
                    null, seconds * 1000, Timeout.Infinite);
            }
            listener.Run(PumpLog);
            return 0;
        }

        private static int RunBridge(string configPath, int seconds)
        {
            // 钩子模式不需要 --filter：它拿不到设备名，认键靠 vkeys 里的码（见下面的说明）。
            if (!_useHook && !_anyDevice && _filter.Length == 0)
            {
                Emit("{\"type\":\"error\",\"error\":\"need-filter\",\"hint\":" +
                    Json("先用 learn 模式按遥控器上的键，记下打印出来的设备名，再用 --filter <片段> 启动（不按厂商号，避免误收键盘）") + "}");
                return 2;
            }
            if (configPath == null || !File.Exists(configPath))
            {
                Emit("{\"type\":\"error\",\"error\":\"config-missing\",\"path\":" + Json(configPath ?? "") + "}");
                return 2;
            }
            Dictionary<string, Dictionary<string, ActionSpec>> mapping = LoadMapping(configPath, out string loadError);
            if (mapping == null)
            {
                Emit("{\"type\":\"error\",\"error\":" + Json(loadError) + "}");
                return 2;
            }
            // VKey → 按键 id：遥控器在 Windows 里报什么码，需要 learn 模式先量出来；
            // 这份表允许被 config 的 vkeys 段覆盖（见 mapping.json 的 vkeys 字段）。
            Dictionary<ushort, string> vkeyToButton = LoadVKeyTable(configPath);

            /*
             * 两条监听路二选一：
             *   · Raw Input（默认）—— 能按**设备名**过滤，所以只认这台遥控器，不会碰键盘。
             *   · 低级键盘钩子（--hook）—— 从"系统分发层"看输入，能拿到遥控器那 4 个独有键
             *     （主页 36 / 菜单 93 / TV 192 / 电源 255），这些在 Raw Input 那层根本到不了。
             *     代价是**拿不到设备**，只能按 vkeys 里的码认键；而方向键/OK 与普通键盘同码，
             *     所以钩子模式必须配合面板上那个总开关用（不想插手时就关掉）。
             */
            RawKeyboardListener listener = null;
            HookKeyboardListener hookListener = null;
            if (_useHook) hookListener = new HookKeyboardListener();
            else listener = new RawKeyboardListener();
            // 记下最近一次命中过滤串的设备名：日志里能看出到底匹配到了谁。
            // 本机 VID_2717 底下除了（未来的）遥控器还有小米 USB 键鼠 —— 选错设备时，
            // 这一行是唯一能一眼看出来的地方。
            string lastDevice = "";
            /*
             * 长按重复（用户 2026-10-11 的需求：长按方向键让鼠标持续移动）。
             * 只有"移动"这类动作才重复 —— 别的动作重复会连着触发好几次，那是事故不是功能。
             * 定时器被这两段 lambda 共同捕获，所以不会被 GC 回收（局部 Timer 被回收这个坑踩过一次）。
             */
            Timer moveRepeat = null;
            ushort moveVkey = 0;
            string moveCombo = null;
            const int MovePixels = 12;
            var classifier = new ClickClassifier((vkey, slot) =>
            {
                string button;
                if (!vkeyToButton.TryGetValue(vkey, out button))
                {
                    Emit("{\"type\":\"unmapped\",\"vkey\":" + vkey + ",\"slot\":" + Json(slot) +
                        ",\"device\":" + Json(lastDevice) + "}");
                    return;
                }
                Dictionary<string, ActionSpec> row;
                if (!mapping.TryGetValue(button, out row)) return;
                ActionSpec action;
                if (!row.TryGetValue(slot, out action) || action == null) return;
                string error;
                bool ok;
                if (Injector.IsMoveAction(action.Combo))
                {
                    ok = Injector.Move(action.Combo, MovePixels, out error);
                    // 长按 ⇒ 除了这次，再按住期间每隔 60ms 挪一次
                    if (slot == "hold")
                    {
                        moveVkey = vkey;
                        moveCombo = action.Combo;
                        if (moveRepeat != null) { moveRepeat.Dispose(); moveRepeat = null; }
                        moveRepeat = new Timer(_ =>
                        {
                            if (moveCombo == null) return;
                            string ignored;
                            Injector.Move(moveCombo, MovePixels, out ignored);
                        }, null, 220, 60);
                    }
                }
                else if (action.Type == "app") ok = Injector.Launch(action.Combo, out error);
                else ok = Injector.Combo(action.Combo, out error);
                Emit("{\"type\":\"fire\",\"button\":" + Json(button) + ",\"slot\":" + Json(slot) +
                    ",\"action\":" + Json(action.Combo) + ",\"ok\":" + (ok ? "true" : "false") +
                    ",\"error\":" + Json(error ?? "") + ",\"device\":" + Json(lastDevice) + "}");
            });

            // 两条路共用的后半段：抬键停重复 + 交给判定器。
            Action<ushort, bool> feed = (vkey, down) =>
            {
                // 抬键必须停掉重复，否则光标会一直飘下去。
                if (!down && moveRepeat != null && vkey == moveVkey)
                {
                    moveRepeat.Dispose();
                    moveRepeat = null;
                    moveCombo = null;
                }
                classifier.OnKey(vkey, down);
            };

            if (listener != null)
            {
                listener.OnKey += (device, vkey, down, makeCode) =>
                {
                    if (!_anyDevice)
                    {
                        string name = RawKeyboardListener.DeviceName(device);
                        if (name.IndexOf(_filter, StringComparison.OrdinalIgnoreCase) < 0) return;
                        lastDevice = name;
                    }
                    feed(vkey, down);
                };
            }
            if (hookListener != null)
            {
                hookListener.OnKey += (vk, down, scan, flags) =>
                {
                    // 滤掉自己注入的键，否则会"自问自答"套娃。
                    if ((flags & Native.LLKHF_INJECTED) != 0) return;
                    // --verbose：把钩子收到的每个事件都记一行。
                    // 排查"某个键不触发"时，这一行能区分"事件没到"和"到了但没匹配上按键名"。
                    if (_verbose)
                    {
                        Emit("{\"type\":\"hookkey\",\"vk\":" + vk + ",\"scan\":" + scan +
                            ",\"down\":" + (down ? "true" : "false") +
                            ",\"mapped\":" + Json(vkeyToButton.ContainsKey(vk) ? vkeyToButton[vk] : "") + "}");
                    }
                    feed(vk, down);
                };
            }

            Emit("{\"type\":\"ready\",\"mode\":\"run\",\"source\":" + Json(_useHook ? "hook" : "rawinput") +
                ",\"filter\":" + Json(_anyDevice ? "*" : _filter) +
                ",\"paths\":" + RawKeyboardListener.RegisteredPaths +
                ",\"buttons\":" + mapping.Count + ",\"vkeys\":" + vkeyToButton.Count + "}");
            if (seconds > 0)
            {
                // 限时运行：冒烟测试用，也方便"只想让它跑一会儿"的场合（定时器必须存字段，见 learn）。
                _stopTimer = new Timer(_ => { if (_tee != null) { _tee.Flush(); } Environment.Exit(0); },
                    null, seconds * 1000, Timeout.Infinite);
            }
            if (hookListener != null) hookListener.Run(PumpLog);
            else listener.Run(PumpLog);
            return 0;
        }

        /// <summary>
        /// read 模式：从"按键采集器"写的 JSON 行文件里读按键 —— 这是 Frida 那条路（唯一能拿到全部按键的）。
        ///
        /// 为什么拆成两个进程：Frida 只能从 Python 侧驱动，而判定/注入的代码在 C# 引擎里。
        /// 所以采集器只负责"把报告写成一行 JSON"，引擎负责"读、判定、注入"。
        /// 采集器：engine/rc003-tap.py（照 rc003_agent.js 的做法）。
        ///
        /// 文件格式（每行一个 JSON）：
        ///   {"usages":[241],"names":["back"],"t":...}   有键按下（usages 里是 HID usage）
        ///   {"usages":[],"names":[],"t":...}           所有键松开
        ///
        /// usage 直接当作"键码"喂给判定器 —— 它们都是 &lt; 0xFFFF 的整数，正好当 ushort 用。
        /// </summary>
        private static int RunFromFile(string configPath, string filePath)
        {
            if (configPath == null || !File.Exists(configPath))
            {
                Emit("{\"type\":\"error\",\"error\":\"config-missing\",\"path\":" + Json(configPath ?? "") + "}");
                // ⚠️ 必须等一下：Emit 是异步入队的，进程立刻退出的话那行日志根本写不出去
                //    （这个坑当场踩过：read 模式的参数接错了，报错行却完全看不到，白查一轮）。
                Thread.Sleep(400);
                return 2;
            }
            if (filePath == null)
            {
                Emit("{\"type\":\"error\",\"error\":\"file-missing\",\"hint\":" +
                    Json("用 --file 指定采集器（rc003-tap.py）写的 JSON 行文件") + "}");
                Thread.Sleep(400);
                return 2;
            }
            var mapping = LoadMapping(configPath, out string loadError);
            if (mapping == null)
            {
                Emit("{\"type\":\"error\",\"error\":" + Json(loadError) + "}");
                Thread.Sleep(400);
                return 2;
            }

            const int MovePixels = 12;

            var classifier = new ClickClassifier((key, slot) =>
            {
                string button;
                if (!UsageToButton.TryGetValue(key, out button))
                {
                    Emit("{\"type\":\"unmapped\",\"usage\":" + key + ",\"slot\":" + Json(slot) + "}");
                    return;
                }
                Dictionary<string, ActionSpec> row;
                if (!mapping.TryGetValue(button, out row)) return;
                ActionSpec action;
                if (!row.TryGetValue(slot, out action) || action == null) return;
                string error;
                bool ok;
                if (Injector.IsMoveAction(action.Combo))
                {
                    ok = Injector.Move(action.Combo, MovePixels, out error);
                    if (slot == "hold")
                    {
                        // 状态放静态字段，好让 HandleReportLine 在松手时能停掉它（见 StopMoveRepeat）
                        lock (MoveGate)
                        {
                            if (MoveRepeat != null) { MoveRepeat.Dispose(); MoveRepeat = null; }
                            MoveRepeatKey = key;
                            MoveRepeatCombo = action.Combo;
                            MoveRepeat = new Timer(_ =>
                            {
                                string ignored;
                                lock (MoveGate)
                                {
                                    if (MoveRepeatCombo == null) return;
                                    Injector.Move(MoveRepeatCombo, MovePixels, out ignored);
                                }
                            }, null, 220, 60);
                        }
                    }
                }
                else if (action.Type == "app") ok = Injector.Launch(action.Combo, out error);
                else if (action.Type == "holdkey")
                {
                    /*
                     * 「按住不放」型动作（用户 2026-10-11 的语音键需求）：
                     *   长按触发 → 把 action.Combo 按住，并记住是哪颗遥控器键按的；
                     *   遥控器键松开时（见 HandleReportLine）再把它放开。
                     * 短按那一档不走这里 —— 那时用户要的是"右 Win + 右 Shift 按一下"，
                     * 配成普通组合键即可（走下面的 Combo 分支）。
                     */
                    if (slot == "hold")
                    {
                        ok = Injector.Down(action.Combo, out error);
                        if (ok) { lock (HeldGate) { HeldByKey[key] = action.Combo; } }
                    }
                    else ok = Injector.Combo(action.Combo, out error);
                }
                else ok = Injector.Combo(action.Combo, out error);
                Emit("{\"type\":\"fire\",\"button\":" + Json(button) + ",\"slot\":" + Json(slot) +
                    ",\"action\":" + Json(action.Combo) + ",\"ok\":" + (ok ? "true" : "false") +
                    ",\"error\":" + Json(error ?? "") + "}");
            },
            /*
             * "这个键配了双击动作吗" —— 决定松手要不要等双击窗口。
             * 没配双击的键立刻执行，实测松手→执行从约 370ms 降到 24~37ms。
             */
            vkey =>
            {
                string btn;
                if (!UsageToButton.TryGetValue(vkey, out btn)) return false;
                Dictionary<string, ActionSpec> r;
                if (!mapping.TryGetValue(btn, out r) || r == null) return false;
                ActionSpec a;
                return r.TryGetValue("double", out a) && a != null;
            });

            int selfLevel = Native.SelfIntegrityLevel();
            Emit("{\"type\":\"ready\",\"mode\":\"read\",\"file\":" + Json(filePath) +
                ",\"buttons\":" + mapping.Count + ",\"usages\":" + UsageToButton.Count +
                // 自己的完整性级别：低于前台窗口的级别时，SendInput 会被 UIPI 静默丢弃
                ",\"integrity\":" + selfLevel + ",\"integrityName\":" + Json(Native.IntegrityName(selfLevel)) + "}");

            var held = new HashSet<ushort>();
            /*
             * offset = -1 表示"起点还没定"：第一次看到 keys.jsonl 时把它定成**当时的文件长度**，
             * 也就是只处理从这一刻起新写进来的行，不重放历史。
             *
             * ★ 为什么必须这样（2026-10-11 用户报的 bug，与 Python 版引擎是同一个）：
             *   原来是 `long offset = 0`，于是**每次引擎启动都把文件里的全部历史事件重放一遍**，
             *   每个配置好的动作各触发一次。触发路径：
             *       刷新 DSH 页面 → 客户端挂载时调 /bridge/auto → 杀掉旧引擎、起一个新的
             *       → 新引擎 offset=0 → 从头发读全部历史 → 「所有快捷键被全部触发一次」
             *
             * ⚠️ 但下面 `fs.Length < offset` 时仍要归零：那是**文件被截断**（链路重拉会重建它），
             *   截断后的内容全是新的，从头读才对。这两种情形必须分开。
             */
            long offset = -1;
            var pending = new StringBuilder();
            // 映射热重载用的两个状态（见循环里的注释）
            var mappingMtime = File.Exists(configPath) ? File.GetLastWriteTimeUtc(configPath) : DateTime.MinValue;
            int lastMappingCheck = Environment.TickCount;
            while (true)
            {
                try
                {
                    if (!File.Exists(filePath)) { Thread.Sleep(200); continue; }
                    using (var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    {
                        // 首次看到文件：起点定在当前末尾 —— 只处理新行，不重放历史（理由见上面 offset 的注释）
                        if (offset < 0)
                        {
                            offset = fs.Length;
                            Emit("{\"type\":\"tail-from-end\",\"bytes\":" + offset.ToString() + "}");
                        }
                        if (fs.Length < offset) { offset = 0; held.Clear(); }   // 文件被重建
                        fs.Seek(offset, SeekOrigin.Begin);
                        var buf = new byte[8192];
                        int n;
                        while ((n = fs.Read(buf, 0, buf.Length)) > 0)
                        {
                            offset += n;
                            pending.Append(Encoding.UTF8.GetString(buf, 0, n));
                        }
                    }
                }
                catch (Exception) { Thread.Sleep(200); continue; }

                int nl;
                while ((nl = pending.ToString().IndexOf('\n')) >= 0)
                {
                    string line = pending.ToString(0, nl).Trim();
                    pending.Remove(0, nl + 1);
                    if (line.Length == 0 || line[0] != '{') continue;
                    HandleReportLine(line, classifier, held);
                }

                /*
                 * 轮询间隔。原来是 20ms —— 按键要等它一轮才能被发现，平均白加 10ms，
                 * 手感上叠在"等双击窗口"上就是更明显的慢。降到 6ms：
                 * 这点 CPU（每秒 160 次 stat + 偶尔读几行）可以忽略，延迟少一截。
                 */
                Thread.Sleep(6);

                /*
                 * 映射热重载：每秒看一次 mapping.json 的修改时间，变了就重读。
                 *
                 * 原来 mapping 只在启动时读一次，面板里改完必须重启引擎才生效
                 * （2026-10-11 用户反馈"更新了几个绑定按键，没有立即生效"）。
                 * mapping 是被下面 ClickClassifier 闭包捕获的局部变量，这里重赋值闭包就能看到新的。
                 */
                if (Environment.TickCount - lastMappingCheck > 1000)
                {
                    lastMappingCheck = Environment.TickCount;
                    try
                    {
                        var mt = File.GetLastWriteTimeUtc(configPath);
                        if (mt > mappingMtime)
                        {
                            string reloadError;
                            var fresh = LoadMapping(configPath, out reloadError);
                            if (fresh != null)
                            {
                                mapping = fresh;
                                mappingMtime = mt;
                                Emit("{\"type\":\"mapping-reloaded\",\"buttons\":" + fresh.Count + "}");
                            }
                        }
                    }
                    catch (Exception) { /* 读不到就下次再试，不影响按键 */ }
                }
            }
        }

        /// <summary>处理采集器写的一行：解析出当前按下的 usage 集合，和上一次比对，发出按下/抬起。</summary>
        private static void HandleReportLine(string line, ClickClassifier classifier, HashSet<ushort> held)
        {
            try
            {
                var obj = MiniJson.Parse(line) as Dictionary<string, object>;
                if (obj == null) return;
                object usagesObj;
                if (!obj.TryGetValue("usages", out usagesObj)) return;
                var list = usagesObj as List<object>;
                if (list == null) return;

                var now = new HashSet<ushort>();
                foreach (object item in list)
                {
                    double d;
                    if (item is double) d = (double)item;
                    else if (item is int) d = (int)item;
                    else continue;
                    var u = (ushort)d;
                    if (u != 0) now.Add(u);
                }

                // 抬起：上次按着、这次没了
                foreach (ushort u in new List<ushort>(held))
                {
                    if (!now.Contains(u))
                    {
                        held.Remove(u);
                        /*
                         * 先看这颗键有没有"按住不放"的动作在生效（语音键长按按住 Alt 那种）：
                         * 有就趁现在放开。这一步必须在 classifier.OnKey 之前做 ——
                         * 判定器在长按已触发时会直接 return，不会给我们回调的机会。
                         */
                        string heldCombo = null;
                        lock (HeldGate)
                        {
                            if (HeldByKey.TryGetValue(u, out heldCombo)) HeldByKey.Remove(u);
                        }
                        if (heldCombo != null)
                        {
                            string upError;
                            bool upOk = Injector.Up(heldCombo, out upError);
                            Emit("{\"type\":\"release\",\"usage\":" + u + ",\"action\":" + Json(heldCombo) +
                                ",\"ok\":" + (upOk ? "true" : "false") + ",\"error\":" + Json(upError ?? "") + "}");
                        }
                        /*
                         * ★ 松手时必须停掉"长按连续移动鼠标"的循环。
                         * 原来 read 模式只启动、没有任何地方停它 —— 表现就是长按方向键之后
                         * 鼠标一直移下去停不下来（用户 2026-10-11 报的）。
                         */
                        bool moving;
                        lock (MoveGate) { moving = MoveRepeatCombo != null && MoveRepeatKey == u; }
                        if (moving)
                        {
                            StopMoveRepeat();
                            Emit("{\"type\":\"move-stop\",\"usage\":" + u + "}");
                        }
                        string name;
                        bool known = UsageToButton.TryGetValue(u, out name);
                        if (_verbose)
                            Emit("{\"type\":\"key\",\"usage\":" + u + ",\"button\":" + Json(known ? name : "") +
                                ",\"down\":false}");
                        classifier.OnKey(u, false);
                    }
                }
                // 按下：这次新出现的
                foreach (ushort u in now)
                {
                    if (!held.Contains(u))
                    {
                        held.Add(u);
                        string name;
                        bool known = UsageToButton.TryGetValue(u, out name);
                        if (_verbose)
                            Emit("{\"type\":\"key\",\"usage\":" + u + ",\"button\":" + Json(known ? name : "") +
                                ",\"down\":true}");
                        classifier.OnKey(u, true);
                    }
                }
            }
            catch (Exception) { /* 半行/坏行忽略 */ }
        }

        private static Dictionary<string, Dictionary<string, ActionSpec>> LoadMapping(string path, out string error)        {
            error = null;
            try
            {
                string text = File.ReadAllText(path, Encoding.UTF8);
                var root = MiniJson.Parse(text) as Dictionary<string, object>;
                if (root == null) { error = "bad-json"; return null; }
                object buttonsObj;
                if (!root.TryGetValue("buttons", out buttonsObj)) { error = "no-buttons"; return null; }
                var buttons = buttonsObj as Dictionary<string, object>;
                if (buttons == null) { error = "bad-buttons"; return null; }
                var result = new Dictionary<string, Dictionary<string, ActionSpec>>(StringComparer.OrdinalIgnoreCase);
                foreach (var pair in buttons)
                {
                    var row = pair.Value as Dictionary<string, object>;
                    if (row == null) continue;
                    var slots = new Dictionary<string, ActionSpec>(StringComparer.OrdinalIgnoreCase);
                    foreach (var slotPair in row)
                    {
                        if (slotPair.Value == null) continue;
                        var spec = slotPair.Value as Dictionary<string, object>;
                        if (spec == null) continue;
                        object comboObj;
                        if (!spec.TryGetValue("combo", out comboObj) || comboObj == null) continue;
                        object typeObj;
                        spec.TryGetValue("type", out typeObj);
                        slots[slotPair.Key] = new ActionSpec
                        {
                            Type = typeObj == null ? "key" : Convert.ToString(typeObj, CultureInfo.InvariantCulture),
                            Combo = Convert.ToString(comboObj, CultureInfo.InvariantCulture),
                        };
                    }
                    result[pair.Key] = slots;
                }
                return result;
            }
            catch (Exception ex) { error = "load-failed:" + ex.Message; return null; }
        }

        private static Dictionary<ushort, string> LoadVKeyTable(string path)
        {
            var table = new Dictionary<ushort, string>();
            try
            {
                var root = MiniJson.Parse(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object>;
                if (root == null) return table;
                object vkeysObj;
                if (!root.TryGetValue("vkeys", out vkeysObj)) return table;
                var vkeys = vkeysObj as Dictionary<string, object>;
                if (vkeys == null) return table;
                foreach (var pair in vkeys)
                {
                    string value = Convert.ToString(pair.Value, CultureInfo.InvariantCulture);
                    ushort code;
                    if (ushort.TryParse(value, out code)) table[code] = pair.Key;
                    else if (value != null && value.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                    {
                        if (ushort.TryParse(value.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                            table[code] = pair.Key;
                    }
                }
            }
            catch { }
            return table;
        }

        private sealed class ActionSpec
        {
            public string Type;
            public string Combo;
        }

        private static string Json(string value)
        {
            if (value == null) return "null";
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    /// <summary>够用就好的 JSON 解析（只吃 mapping.json 的形状：对象/数组/字符串/数字/布尔/null）。</summary>
    internal static class MiniJson
    {
        private static string _text;
        private static int _pos;

        public static object Parse(string text)
        {
            _text = text;
            _pos = 0;
            SkipWhitespace();
            object value = ParseValue();
            return value;
        }

        private static object ParseValue()
        {
            SkipWhitespace();
            if (_pos >= _text.Length) return null;
            char c = _text[_pos];
            if (c == '{') return ParseObject();
            if (c == '[') return ParseArray();
            if (c == '"') return ParseString();
            if (c == 't' && Match("true")) return true;
            if (c == 'f' && Match("false")) return false;
            if (c == 'n' && Match("null")) return null;
            return ParseNumber();
        }

        private static Dictionary<string, object> ParseObject()
        {
            var result = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            _pos++;   // {
            SkipWhitespace();
            if (_pos < _text.Length && _text[_pos] == '}') { _pos++; return result; }
            while (_pos < _text.Length)
            {
                SkipWhitespace();
                string key = ParseString();
                SkipWhitespace();
                if (_pos < _text.Length && _text[_pos] == ':') _pos++;
                object value = ParseValue();
                result[key] = value;
                SkipWhitespace();
                if (_pos < _text.Length && _text[_pos] == ',') { _pos++; continue; }
                if (_pos < _text.Length && _text[_pos] == '}') { _pos++; break; }
                break;
            }
            return result;
        }

        private static List<object> ParseArray()
        {
            var result = new List<object>();
            _pos++;   // [
            SkipWhitespace();
            if (_pos < _text.Length && _text[_pos] == ']') { _pos++; return result; }
            while (_pos < _text.Length)
            {
                result.Add(ParseValue());
                SkipWhitespace();
                if (_pos < _text.Length && _text[_pos] == ',') { _pos++; continue; }
                if (_pos < _text.Length && _text[_pos] == ']') { _pos++; break; }
                break;
            }
            return result;
        }

        private static string ParseString()
        {
            var sb = new StringBuilder();
            _pos++;   // "
            while (_pos < _text.Length)
            {
                char c = _text[_pos++];
                if (c == '"') break;
                if (c == '\\' && _pos < _text.Length)
                {
                    char esc = _text[_pos++];
                    switch (esc)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'u':
                            if (_pos + 4 <= _text.Length)
                            {
                                int code;
                                if (int.TryParse(_text.Substring(_pos, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                                {
                                    sb.Append((char)code);
                                    _pos += 4;
                                }
                            }
                            break;
                        default: sb.Append(esc); break;
                    }
                    continue;
                }
                sb.Append(c);
            }
            return sb.ToString();
        }

        private static object ParseNumber()
        {
            int start = _pos;
            while (_pos < _text.Length && "-+.eE0123456789".IndexOf(_text[_pos]) >= 0) _pos++;
            string raw = _text.Substring(start, _pos - start);
            double number;
            if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out number)) return number;
            return raw;
        }

        private static bool Match(string word)
        {
            if (_pos + word.Length > _text.Length) return false;
            if (string.CompareOrdinal(_text, _pos, word, 0, word.Length) != 0) return false;
            _pos += word.Length;
            return true;
        }

        private static void SkipWhitespace()
        {
            while (_pos < _text.Length && char.IsWhiteSpace(_text[_pos])) _pos++;
        }
    }
}
