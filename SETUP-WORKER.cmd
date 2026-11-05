@echo off
cd /d "%~dp0worker"
python -m venv --without-pip .venv
if errorlevel 1 goto failed
python -m pip --python .venv\Scripts\python.exe install torch==2.9.1 --index-url https://download.pytorch.org/whl/cu126
if errorlevel 1 goto failed
python -m pip --python .venv\Scripts\python.exe install -r requirements.txt
if errorlevel 1 goto failed
echo Worker siap. Daftarkan perangkat pada website lalu jalankan START-WORKER.cmd.
pause
exit /b 0
:failed
echo Instalasi gagal. Periksa Python 3.12, pip, koneksi, dan ruang disk.
pause
exit /b 1
