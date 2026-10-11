# build.ps1 — 编译 DSH 侧的小米遥控器按键桥
#
# 不需要 dotnet SDK：用 Roslyn 的 csc（VS BuildTools 自带）编成 .NET Framework 4.8 的
# 独立 exe —— Win11 内置 4.8，所以 KeyBridge.exe 拷到别的机器也能直接跑，零依赖。
#
# 用法：  pwsh -File build.ps1        （或 Windows PowerShell 一样）

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'KeyBridge.cs'
$output = Join-Path $here 'KeyBridge.exe'

if (-not (Test-Path $source)) { throw "找不到源码：$source" }

# 依次找 Roslyn csc（新→旧），最后退回 .NET Framework 自带的 csc（C# 5，够用）
$candidates = @(
  'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe',
  'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe',
  'C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe',
  'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
)
$csc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw '没找到 csc.exe（装 VS BuildTools 或 .NET Framework 均可）' }

Write-Host "编译器：$csc"
& $csc /nologo /target:exe /platform:x64 /optimize+ /out:$output $source
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }

$size = (Get-Item $output).Length
Write-Host "已生成：$output（$size 字节）"
Write-Host ""
Write-Host "自检（不打扰你的方式）："
Write-Host "  .\KeyBridge.exe list                       # 列出系统里的键盘类 HID 设备"
Write-Host "  .\KeyBridge.exe tap F24                    # 注入一个 F24（普通键盘没有这个键）"
Write-Host "  .\KeyBridge.exe learn --seconds 8 --any    # 学习模式：按下任意键看它报什么"
