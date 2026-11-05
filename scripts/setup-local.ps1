$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$local = Join-Path $root '.local'
New-Item -ItemType Directory -Force -Path $local | Out-Null
$pgBin = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:\Program Files\PostgreSQL\16\bin' }
if (!(Test-Path -LiteralPath (Join-Path $pgBin 'initdb.exe'))) { throw 'PostgreSQL 16 tidak ditemukan. Isi PG_BIN dengan folder bin PostgreSQL.' }
function New-Secret { $bytes = New-Object byte[] 32; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose(); return ([BitConverter]::ToString($bytes)).Replace('-','').ToLower() }
$configFile = Join-Path $local 'local-config.json'
if (!(Test-Path -LiteralPath $configFile)) {
  $cfg = @{ dbPassword=(New-Secret); jwtSecret=(New-Secret); adminEmail='admin@prototype.local'; adminPassword=(New-Secret); dbPort=55439 }
  $cfg | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding utf8
}
$cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$pgData = Join-Path $local 'pgdata'
if (!(Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
  $pwFile = Join-Path $local 'pg-password.txt'
  [System.IO.File]::WriteAllText($pwFile,$cfg.dbPassword,[System.Text.UTF8Encoding]::new($false))
  & (Join-Path $pgBin 'initdb.exe') -D $pgData -U prototype --pwfile=$pwFile --auth=scram-sha-256 --encoding=UTF8 --locale=C
  if ($LASTEXITCODE -ne 0) { throw 'initdb gagal.' }
}
& (Join-Path $pgBin 'pg_ctl.exe') -D $pgData status *> $null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l (Join-Path $local 'postgres.log') -o "-p $($cfg.dbPort) -h 127.0.0.1" -w start
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL prototipe gagal dimulai.' }
}
$dbUrl = "postgresql://prototype:$($cfg.dbPassword)@127.0.0.1:$($cfg.dbPort)/postgres"
$envText = @("DATABASE_URL=$dbUrl","DIRECT_URL=$dbUrl","JWT_SECRET=$($cfg.jwtSecret)",'FRONTEND_ORIGINS=http://127.0.0.1:5173,http://localhost:5173','PORT=3001',"SEED_ADMIN_EMAIL=$($cfg.adminEmail)","SEED_ADMIN_PASSWORD=$($cfg.adminPassword)",'') -join [Environment]::NewLine
$backendEnv=Join-Path $root 'backend\.env'
if (!(Test-Path -LiteralPath $backendEnv)) { [System.IO.File]::WriteAllText($backendEnv,$envText,[System.Text.UTF8Encoding]::new($false)) }
$frontendEnv=Join-Path $root 'frontend\.env.local'
if (!(Test-Path -LiteralPath $frontendEnv)) { [System.IO.File]::WriteAllText($frontendEnv,'VITE_API_BASE_URL=http://127.0.0.1:3001/api',[System.Text.UTF8Encoding]::new($false)) }
$access = @('# Akses lokal prototipe','','Alamat: http://127.0.0.1:5173','',"Email: $($cfg.adminEmail)",'',"Kata sandi: $($cfg.adminPassword)",'','Rahasia lokal: jangan commit, unggah, atau gunakan ulang pada production.') -join [Environment]::NewLine
[System.IO.File]::WriteAllText((Join-Path $local 'ACCESS.md'),$access,[System.Text.UTF8Encoding]::new($false))
Write-Output 'PostgreSQL khusus prototipe aktif di 127.0.0.1:55439. Kredensial ada di .local/ACCESS.md.'
