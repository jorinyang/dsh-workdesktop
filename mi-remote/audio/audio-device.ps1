# audio-device.ps1 — 远程麦克风插件用的「录音设备路由」执行器
#
# 为什么是 PowerShell 而不是第三方 exe：
#   设置 Windows 默认录音设备只有 Core Audio 的 IPolicyConfig 这一条路（未公开文档但被
#   所有同类工具使用）。这里用 Add-Type 现场编译一段 C#，直接调 COM —— 不装模块、
#   不下载二进制、不需要管理员。首次调用要编译（约 0.6~1.2s），宿主侧缓存结果即可。
#
# 调用契约（给宿主 node 半段用，stdout 只认最后一行 RESULT_JSON=）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File audio-device.ps1 list
#   powershell ... -File audio-device.ps1 status
#   powershell ... -File audio-device.ps1 apply  -Query "<设备名或 id 片段>"
#   powershell ... -File audio-device.ps1 restore
#
# 退出码：0 = 成功（含"没找到设备"这类可预期结果，ok:false 写在 JSON 里）
#         2 = 参数错 / 未预期异常

param(
  [Parameter(Position = 0)][string]$Command = 'status',
  [string]$Query = '',
  [string]$StateDir = ''
)

$ErrorActionPreference = 'Stop'

# ⚠️ 本文件**必须**存成「UTF-8 带 BOM」（EF BB BF）。实测（2026-10-08）：
#   Windows PowerShell 5.1 读 .ps1 时，没有 BOM 就按 ANSI(GBK) 解 —— 里面的中文注释被撕碎，
#   解析器一路吞到代码，报 Unexpected token '}'，整个脚本跑不起来。加 BOM 即好。
#   selftest.mjs 的第 [0] 组会断言这 3 个字节，改文件时别把它弄丢。
#   本机没有 pwsh 7（只有 5.1），所以 BOM 不是可选项。
#
# ⚠️ 编码陷阱二号：PS 5.1 往「管道」写非 ASCII 时按 OEM 码页编码，而调用方（node）按 UTF-8 解
#   —— 中文设备名会烂成问号方块。对策：结果不走 PowerShell 的文本输出，直接用 .NET 把
#   UTF-8 字节写进 stdout 流（见下面的 Write-ResultLine）。
#
# ⚠️ 编码陷阱三号：PS 5.1 连注释里的反引号都当转义字符解析 —— 本文件注释里不许出现反引号。
function Write-ResultLine([string]$Text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text + "`n")
  $stdout = [System.Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

if ([string]::IsNullOrWhiteSpace($StateDir)) {
  $StateDir = Join-Path $env:LOCALAPPDATA 'dsh-remote-mic'
}

$CSharpSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace DshRemoteMic
{
    public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
    public enum DEVICE_STATE { ACTIVE = 0x1, DISABLED = 0x2, NOTPRESENT = 0x4, UNPLUGGED = 0x8, ALL = 0xF }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT
    {
        public ushort vt; public ushort r1; public ushort r2; public ushort r3;
        public IntPtr p; public IntPtr p2;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow dataFlow, DEVICE_STATE dwStateMask, out IMMDeviceCollection ppDevices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
        int GetDevice(string pwstrId, out IMMDevice ppDevice);
        int RegisterEndpointNotificationCallback(IntPtr pClient);
        int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceCollection
    {
        int GetCount(out uint pcDevices);
        int Item(uint nDevice, out IMMDevice ppDevice);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams,
                     [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int OpenPropertyStore(uint stgmAccess, out IPropertyStore ppProperties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        int GetState(out uint pdwState);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore
    {
        int GetCount(out uint cProps);
        int GetAt(uint iProp, out PROPERTYKEY pkey);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        int Commit();
    }

    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPolicyConfig
    {
        int GetMixFormat(string pszDeviceName, IntPtr ppFormat);
        int GetDeviceFormat(string pszDeviceName, bool bDefault, IntPtr ppFormat);
        int ResetDeviceFormat(string pszDeviceName);
        int SetDeviceFormat(string pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
        int GetProcessingPeriod(string pszDeviceName, bool bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
        int SetProcessingPeriod(string pszDeviceName, IntPtr pmftPeriod);
        int GetShareMode(string pszDeviceName, IntPtr pMode);
        int SetShareMode(string pszDeviceName, IntPtr mode);
        int GetPropertyValue(string pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
        int SetPropertyValue(string pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
        int SetDefaultEndpoint(string pszDeviceName, ERole role);
        int SetEndpointVisibility(string pszDeviceName, bool bVisible);
    }

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    public class CPolicyConfigClient { }

    public class AudioInfo
    {
        public int Index;
        public string Id = "";
        public string Name = "";
        public string Flow = "";
        public string State = "";
        public bool IsDefault;
    }

    public static class CoreAudio
    {
        static readonly PROPERTYKEY PKEY_Device_FriendlyName =
            new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };

        static IMMDeviceEnumerator Enumerator()
        {
            return (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        }

        static string DeviceId(IMMDevice dev)
        {
            string id;
            Marshal.ThrowExceptionForHR(dev.GetId(out id));
            return id;
        }

        static string FriendlyName(IMMDevice dev)
        {
            IPropertyStore store;
            Marshal.ThrowExceptionForHR(dev.OpenPropertyStore(0, out store));
            var key = PKEY_Device_FriendlyName;
            PROPVARIANT pv;
            Marshal.ThrowExceptionForHR(store.GetValue(ref key, out pv));
            try
            {
                if (pv.vt == 31 && pv.p != IntPtr.Zero) return Marshal.PtrToStringUni(pv.p) ?? "";
                return "";
            }
            finally { PropVariantClear(ref pv); }
        }

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PROPVARIANT pv);

        static string StateName(uint state)
        {
            if ((state & 0x1) != 0) return "active";
            if ((state & 0x2) != 0) return "disabled";
            if ((state & 0x4) != 0) return "notpresent";
            if ((state & 0x8) != 0) return "unplugged";
            return "unknown";
        }

        public static List<AudioInfo> All()
        {
            var list = new List<AudioInfo>();
            var en = Enumerator();
            var defaults = DefaultIds();
            for (int pass = 0; pass < 2; pass++)
            {
                EDataFlow flow = pass == 0 ? EDataFlow.eCapture : EDataFlow.eRender;
                string flowName = pass == 0 ? "capture" : "render";
                IMMDeviceCollection col;
                Marshal.ThrowExceptionForHR(en.EnumAudioEndpoints(flow, DEVICE_STATE.ALL, out col));
                uint count;
                Marshal.ThrowExceptionForHR(col.GetCount(out count));
                for (uint i = 0; i < count; i++)
                {
                    IMMDevice dev;
                    Marshal.ThrowExceptionForHR(col.Item(i, out dev));
                    uint st;
                    Marshal.ThrowExceptionForHR(dev.GetState(out st));
                    string id = DeviceId(dev);
                    var info = new AudioInfo();
                    info.Index = list.Count;
                    info.Id = id;
                    info.Name = FriendlyName(dev);
                    info.Flow = flowName;
                    info.State = StateName(st);
                    info.IsDefault = (flowName == "capture" && id == defaults[0]);
                    list.Add(info);
                }
            }
            return list;
        }

        /// <summary>三个角色的默认录音端点 id（Console / Multimedia / Communications）。</summary>
        public static string[] DefaultIds()
        {
            var en = Enumerator();
            var ids = new string[3];
            for (int role = 0; role < 3; role++)
            {
                IMMDevice dev;
                int hr = en.GetDefaultAudioEndpoint(EDataFlow.eCapture, (ERole)role, out dev);
                ids[role] = hr == 0 && dev != null ? DeviceId(dev) : "";
            }
            return ids;
        }

        public static AudioInfo DefaultCapture()
        {
            var en = Enumerator();
            IMMDevice dev;
            if (en.GetDefaultAudioEndpoint(EDataFlow.eCapture, ERole.eConsole, out dev) != 0 || dev == null) return null;
            uint st;
            dev.GetState(out st);
            var info = new AudioInfo();
            info.Id = DeviceId(dev);
            info.Name = FriendlyName(dev);
            info.Flow = "capture";
            info.State = StateName(st);
            info.IsDefault = true;
            return info;
        }

        public static AudioInfo Find(string query)
        {
            if (string.IsNullOrEmpty(query)) return null;
            string want = query.Trim();
            string wantLower = want.ToLowerInvariant();
            var all = All();
            // ① 设备 id 精确相等
            foreach (var d in all) if (string.Equals(d.Id, want, StringComparison.OrdinalIgnoreCase)) return d;
            // ② 名字精确相等
            foreach (var d in all) if (string.Equals(d.Name, want, StringComparison.OrdinalIgnoreCase)) return d;
            // ③ 名字含片段
            foreach (var d in all) if (d.Name.ToLowerInvariant().Contains(wantLower)) return d;
            // ④ 设备 id 含片段
            foreach (var d in all) if (d.Id.ToLowerInvariant().Contains(wantLower)) return d;
            return null;
        }

        /// <summary>把某个端点设为三个角色的默认设备。返回 0 表示成功。</summary>
        public static int SetDefault(string deviceId)
        {
            var policy = (IPolicyConfig)(new CPolicyConfigClient());
            int last = 0;
            for (int role = 0; role < 3; role++)
            {
                int hr = policy.SetDefaultEndpoint(deviceId, (ERole)role);
                if (hr != 0) last = hr;
            }
            return last;
        }
    }
}
'@

Add-Type -TypeDefinition $CSharpSource -Language CSharp | Out-Null

function New-StateDir {
  if (-not (Test-Path -LiteralPath $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
  }
}

function Get-StateFile { Join-Path $StateDir 'route-state.json' }

function Read-State {
  $f = Get-StateFile
  if (-not (Test-Path -LiteralPath $f)) { return $null }
  try { return (Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Write-State($obj) {
  New-StateDir
  $f = Get-StateFile
  $json = $obj | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($f, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Device-ToHash($d) {
  if ($null -eq $d) { return $null }
  return [ordered]@{ id = $d.Id; name = $d.Name; flow = $d.Flow; state = $d.State; index = $d.Index }
}

try {
  $result = $null

  switch ($Command.ToLowerInvariant()) {
    'list' {
      $devices = @()
      foreach ($d in [DshRemoteMic.CoreAudio]::All()) { $devices += (Device-ToHash $d) }
      $result = [ordered]@{ ok = $true; command = 'list'; devices = $devices }
    }

    'status' {
      $ids = [DshRemoteMic.CoreAudio]::DefaultIds()
      $def = [DshRemoteMic.CoreAudio]::DefaultCapture()
      $state = Read-State
      $devices = @()
      foreach ($d in [DshRemoteMic.CoreAudio]::All()) { $devices += (Device-ToHash $d) }
      $result = [ordered]@{
        ok            = $true
        command       = 'status'
        defaultName   = if ($def) { $def.Name } else { '' }
        defaultId     = if ($def) { $def.Id } else { '' }
        defaultState  = if ($def) { $def.State } else { '' }
        roles         = [ordered]@{ console = $ids[0]; multimedia = $ids[1]; communications = $ids[2] }
        savedTargetId = if ($state) { [string]$state.targetId } else { '' }
        savedTargetName = if ($state) { [string]$state.targetName } else { '' }
        savedPreviousId = if ($state) { [string]$state.previousId } else { '' }
        savedPreviousName = if ($state) { [string]$state.previousName } else { '' }
        stateDir      = $StateDir
        devices       = $devices
      }
    }

    'apply' {
      $target = [DshRemoteMic.CoreAudio]::Find($Query)
      if ($null -eq $target) {
        $result = [ordered]@{ ok = $false; command = 'apply'; error = 'device-not-found'; query = $Query }
      } else {
        $before = [DshRemoteMic.CoreAudio]::DefaultCapture()
        $hr = [DshRemoteMic.CoreAudio]::SetDefault($target.Id)
        $after = [DshRemoteMic.CoreAudio]::DefaultCapture()
        if ($hr -ne 0) {
          $result = [ordered]@{
            ok = $false; command = 'apply'; error = 'set-default-failed'; hresult = ('0x{0:X8}' -f $hr)
            target = (Device-ToHash $target); before = (Device-ToHash $before); after = (Device-ToHash $after)
          }
        } else {
          if ($before -and $before.Id -ne $target.Id) {
            Write-State ([ordered]@{
              targetId = $target.Id; targetName = $target.Name
              previousId = $before.Id; previousName = $before.Name
              appliedAt = (Get-Date).ToString('o')
            })
          } elseif (-not (Test-Path -LiteralPath (Get-StateFile))) {
            Write-State ([ordered]@{
              targetId = $target.Id; targetName = $target.Name
              previousId = ''; previousName = ''
              appliedAt = (Get-Date).ToString('o')
            })
          }
          $result = [ordered]@{
            ok = $true; command = 'apply'
            target = (Device-ToHash $target)
            before = (Device-ToHash $before)
            after  = (Device-ToHash $after)
            changed = ($null -eq $before) -or ($before.Id -ne $after.Id)
          }
        }
      }
    }

    'restore' {
      $state = Read-State
      if (-not $state -or [string]::IsNullOrWhiteSpace([string]$state.previousId)) {
        $result = [ordered]@{ ok = $false; command = 'restore'; error = 'nothing-to-restore' }
      } else {
        $prev = [DshRemoteMic.CoreAudio]::Find([string]$state.previousId)
        if ($null -eq $prev) {
          $result = [ordered]@{ ok = $false; command = 'restore'; error = 'previous-device-gone'; previousName = [string]$state.previousName }
        } else {
          $hr = [DshRemoteMic.CoreAudio]::SetDefault($prev.Id)
          $after = [DshRemoteMic.CoreAudio]::DefaultCapture()
          if ($hr -ne 0) {
            $result = [ordered]@{ ok = $false; command = 'restore'; error = 'set-default-failed'; hresult = ('0x{0:X8}' -f $hr) }
          } else {
            Write-State ([ordered]@{
              targetId = ''; targetName = ''
              previousId = ''; previousName = ''
              restoredAt = (Get-Date).ToString('o')
            })
            $result = [ordered]@{ ok = $true; command = 'restore'; restored = (Device-ToHash $prev); after = (Device-ToHash $after) }
          }
        }
      }
    }

    default {
      $result = [ordered]@{ ok = $false; command = $Command; error = 'unknown-command' }
    }
  }

  $json = $result | ConvertTo-Json -Depth 8 -Compress
  Write-ResultLine ('RESULT_JSON=' + $json)
  exit 0
} catch {
  $err = [ordered]@{ ok = $false; command = $Command; error = 'exception'; message = [string]$_.Exception.Message }
  Write-ResultLine ('RESULT_JSON=' + ($err | ConvertTo-Json -Compress))
  exit 2
}
