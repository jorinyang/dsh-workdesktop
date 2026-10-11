' run-hidden.vbs —— 隐藏启动一个程序（窗口样式 0），不等待它结束。
'
' 为什么需要它：DSH 用 Node 的 spawn(..., { windowsHide: true }) 起引擎，那等价于加了
' CREATE_NO_WINDOW 标志，而实测**带这个标志的进程收不到全局键盘钩子**（对照实验：
' Start-Process -WindowStyle Hidden 能收到、CreateNoWindow=true 收不到）。
' 用 wscript 走 WshShell.Run(cmd, 0, False)：同样不弹窗，但不带那个标志。
'
' 用法: wscript.exe //nologo run-hidden.vbs "<可执行文件>" [参数...]
Option Explicit

Dim shell, args, cmd, i
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count = 0 Then
  WScript.Quit 1
End If

cmd = """" & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " " & WScript.Arguments(i)
Next

' 0 = 隐藏窗口, False = 不等待
shell.Run cmd, 0, False
