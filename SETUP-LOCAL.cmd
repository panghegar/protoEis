@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-local.ps1
if errorlevel 1 goto failed
cd frontend
call npm.cmd ci
if errorlevel 1 goto failed
cd ..\backend
call npm.cmd ci
if errorlevel 1 goto failed
call npm.cmd run db:deploy
if errorlevel 1 goto failed
call npm.cmd run seed
if errorlevel 1 goto failed
call npx.cmd tsx scripts\setup-worker.ts
if errorlevel 1 goto failed
echo Setup website selesai. Jalankan SETUP-WORKER.cmd jika lingkungan Python belum tersedia.
pause
exit /b 0
:failed
echo Setup gagal. Periksa pesan di atas.
pause
exit /b 1
