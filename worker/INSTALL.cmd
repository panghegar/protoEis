@echo off
cd /d "%~dp0"
where py >nul 2>&1
if not errorlevel 1 (
  py -3.12 -c "import tkinter" >nul 2>&1
  if not errorlevel 1 (
    py -3.12 install_launcher.py
    exit /b
  )
)
python -c "import sys,tkinter; assert sys.version_info[:2]==(3,12)" >nul 2>&1
if errorlevel 1 (
  echo Python 3.12 dengan Tcl/Tk belum ditemukan.
  echo Pasang Python 3.12 dari https://www.python.org/downloads/windows/ lalu buka INSTALL.cmd lagi.
  pause
  exit /b 1
)
python install_launcher.py
