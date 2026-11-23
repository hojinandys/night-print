@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 run_preview.py
) else (
  python run_preview.py
)
pause
