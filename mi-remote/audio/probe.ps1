# probe.ps1 - Xiaomi remote link probe for dsh-mi-remote.
# Detects: remote pairing (VID_2717), SayAll install/process, WeType process.
# Contract mirrors audio-device.ps1: stdout's LAST "RESULT_JSON=" line is the result,
# written as raw UTF-8 bytes (PS 5.1 pipes non-ASCII as OEM otherwise).
# This file contains non-ASCII (device names) => MUST keep its UTF-8 BOM; run fix-bom.mjs after edits.

$ErrorActionPreference = 'Stop'

function Write-ResultLine([string]$Text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text + "`n")
  $stdout = [System.Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

try {
  $remoteDevices = @()
  try {
    $all = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue
    foreach ($d in $all) {
      # ⚠️ 不能只按 VID_2717 认：USB 插着的小米键鼠/接收器同样是 VID_2717（实测 11 个误报）。
      # 遥控器 RC001/RC003 走蓝牙：HardwareID 由 BTHENUM/BTHLE 枚举，或名字带遥控器特征。
      $hit = $false
      $transport = ''
      try {
        foreach ($hw in $d.HardwareID) {
          if ($hw -like 'BTHENUM\VID_2717*' -or $hw -like 'BTHLE\VID_2717*') { $hit = $true; $transport = 'bluetooth'; break }
        }
      } catch { }
      if (-not $hit) {
        try {
          if ($d.FriendlyName -match 'MI RC|Xiaomi Bluetooth Remote|小米蓝牙.*遥控|蓝牙遥控器') { $hit = $true; $transport = 'name' }
        } catch { }
      }
      if ($hit) {
        $remoteDevices += [ordered]@{
          name   = [string]$d.FriendlyName
          status = [string]$d.Status
          class  = [string]$d.Class
          transport = $transport
          present = ($d.Status -ne 'Unknown')
        }
      }
    }
  } catch { }

  $sayallProcess = @()
  try {
    $sayallProcess = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'sayall|RemoteMic' } | ForEach-Object { $_.ProcessName })
  } catch { }

  $sayallUninstall = $null
  try {
    $found = $null
    foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')) {
      Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
        $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        if ($null -ne $p.DisplayName -and $p.DisplayName -match 'SayAll|Remote Mic') {
          if ($null -eq $found) { $found = [ordered]@{ name = [string]$p.DisplayName; version = [string]$p.DisplayVersion; location = [string]$p.InstallLocation } }
        }
      }
    }
    $sayallUninstall = $found
  } catch { }

  $sayallConfigDir = Test-Path (Join-Path $env:APPDATA 'app.getsayall.remote-mic.windows')

  $wetype = @()
  try {
    $wetype = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^wetype' } | ForEach-Object { $_.ProcessName } | Select-Object -Unique)
  } catch { }

  $result = [ordered]@{
    ok             = $true
    command        = 'probe'
    remotePaired   = ($remoteDevices.Count -gt 0)
    remotes        = $remoteDevices
    sayallRunning  = ($sayallProcess.Count -gt 0)
    sayallProcess  = $sayallProcess
    sayallInstall  = $sayallUninstall
    sayallConfig   = $sayallConfigDir
    wetypeRunning  = ($wetype.Count -gt 0)
    wetypeProcess  = $wetype
    platform       = 'win32'
  }
  Write-ResultLine ('RESULT_JSON=' + ($result | ConvertTo-Json -Depth 6 -Compress))
  exit 0
} catch {
  $err = [ordered]@{ ok = $false; command = 'probe'; error = 'exception'; message = [string]$_.Exception.Message }
  Write-ResultLine ('RESULT_JSON=' + ($err | ConvertTo-Json -Compress))
  exit 2
}
