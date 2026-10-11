@echo off
rem Manual launch test -- ASCII only, because cmd reads this file as GBK and
rem Chinese text written as UTF-8 turns into garbage that breaks the script.
rem Purpose: verify whether a process started by YOU (interactive user) can
rem receive remote-control keys while the focus is on ANOTHER window.
cd /d "%~dp0"
echo.
echo  KeyTap started (manual / interactive launch).
echo  Now click another window, then press the remote keys.
echo  Output file: %~dp0..\..\tmp\_keytap-manual.jsonl
echo  This window stays for 300 seconds.
echo.
"%~dp0keytap.exe" --out "%~dp0..\..\tmp\_keytap-manual.jsonl" --seconds 300
echo.
echo  Finished. Press any key to close.
pause >nul
