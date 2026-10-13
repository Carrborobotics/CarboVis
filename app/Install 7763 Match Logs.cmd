@echo off
rem Double-click to install (or update) 7763 Match Logs for this Windows user.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 pause
