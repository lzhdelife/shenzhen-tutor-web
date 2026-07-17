@echo off
setlocal
cd /d "%~dp0"
set PATH=%ProgramFiles%\nodejs;%PATH%
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process 'http://localhost:8787'"
node server.js
pause
