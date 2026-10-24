$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$pgRoot = Join-Path $projectRoot 'data\postgres'
$pgBin = Join-Path $pgRoot 'runtime\pgsql\bin'
$cluster = Join-Path $pgRoot 'cluster'
$envFile = Join-Path $projectRoot '.env.postgres.local'
if (!(Test-Path (Join-Path $pgBin 'initdb.exe'))) { throw 'Extraia o pacote oficial PostgreSQL em data/postgres/runtime primeiro.' }
if (!(Test-Path (Join-Path $cluster 'PG_VERSION'))) {
  if (Test-Path $envFile) { throw 'Já existe configuração PostgreSQL. Verifique antes de criar outro banco.' }
  $randomBytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
  $password = [BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()
  $passwordFile = Join-Path $pgRoot 'init-password.private'
  try {
    [IO.File]::WriteAllText($passwordFile, $password, [Text.UTF8Encoding]::new($false))
    & (Join-Path $pgBin 'initdb.exe') -D $cluster -U mdl --pwfile=$passwordFile --auth=scram-sha-256 --encoding=UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao inicializar PostgreSQL.' }
    [IO.File]::AppendAllText((Join-Path $cluster 'postgresql.conf'), "`nlisten_addresses = '127.0.0.1'`nport = 54329`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($envFile, "DATABASE_PROVIDER=postgres`nDATABASE_URL=postgresql://mdl:$password@127.0.0.1:54329/mestredoslanches`nHOST=127.0.0.1`nPORT=43080`n", [Text.UTF8Encoding]::new($false))
  } finally { if (Test-Path $passwordFile) { Remove-Item -LiteralPath $passwordFile } }
}
& (Join-Path $pgBin 'pg_ctl.exe') -D $cluster status *> $null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $pgBin 'pg_ctl.exe') -D $cluster -l (Join-Path $pgRoot 'postgres.log') -w start
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao iniciar PostgreSQL. Consulte data/postgres/postgres.log.' }
}
& node.exe "--env-file=$envFile" (Join-Path $PSScriptRoot 'ensure-postgres-db.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar/verificar o banco local.' }
Write-Host 'PostgreSQL local ativo em 127.0.0.1:54329. A senha está somente em .env.postgres.local.'
