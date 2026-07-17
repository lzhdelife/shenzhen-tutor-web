@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0TutorOrderWatcher.ps1"
if errorlevel 1 pause
