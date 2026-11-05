@echo off
cd /d "%~dp0worker"
if not exist ".venv\Scripts\python.exe" (echo Jalankan SETUP-WORKER.cmd dahulu. & pause & exit /b 1)
if not exist "worker.json" (echo Daftarkan perangkat di website dan simpan konfigurasi sebagai worker\worker.json. & pause & exit /b 1)
".venv\Scripts\python.exe" worker.py
pause
