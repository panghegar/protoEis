@echo off
cd /d "%~dp0"
py -3.12 -c "import tkinter" >nul 2>&1
if not errorlevel 1 (
  py -3.12 launcher.py
  exit /b
)
python launcher.py
