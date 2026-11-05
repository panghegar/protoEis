$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
& "$PSScriptRoot\setup-local.ps1"
$running=@()
try {
  $api=Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm.cmd run dev' -WorkingDirectory (Join-Path $root 'backend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root '.local\api.log') -RedirectStandardError (Join-Path $root '.local\api-error.log')
  $running += $api
  $front=Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm.cmd run dev' -WorkingDirectory (Join-Path $root 'frontend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root '.local\frontend.log') -RedirectStandardError (Join-Path $root '.local\frontend-error.log')
  $running += $front
  Write-Output 'Buka http://127.0.0.1:5173. Login tersedia di .local/ACCESS.md.'
  Write-Output 'Buka Perangkat lokal, lalu klik Jalankan worker setelah launcher dipasang. Alternatif terminal: START-WORKER.cmd.'
  Write-Output 'Biarkan terminal ini terbuka. Tekan Enter untuk menghentikan frontend dan API.'
  Read-Host | Out-Null
} finally {
  foreach ($process in $running) { if (!$process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null } }
}
