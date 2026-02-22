param(
    [string]$User = "student",
    [string]$Password = "oracle",
    [string]$DbHost = "localhost",
    [int]$Port = 1521,
    [string]$Service = "xepdb1"
)

$connect = "$User/$Password@//$DbHost`:$Port/$Service"

$sql = @"
set heading off
set feedback off
set pagesize 0
set verify off
set echo off
select 'CONN_OK' from dual;
select count(*) from user_tables where table_name='SENSOR_DATA';
select count(*) from sensor_data;
exit
"@

$raw = $sql | sqlplus -s $connect

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERRO] Falha ao conectar no Oracle com SQL*Plus." -ForegroundColor Red
    Write-Host $raw
    exit 1
}

$lines = $raw -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }

if ($lines.Count -lt 3 -or $lines[0] -ne "CONN_OK") {
    Write-Host "[ERRO] Resultado inesperado no smoke test Oracle." -ForegroundColor Red
    Write-Host $raw
    exit 1
}

$tableExists = 0
$rows = 0
try {
    $tableExists = [int]$lines[1]
    $rows = [int]$lines[2]
} catch {
    Write-Host "[ERRO] Nao foi possivel interpretar a resposta do SQL*Plus." -ForegroundColor Red
    Write-Host $raw
    exit 1
}

Write-Host "[OK] Conexao Oracle: $DbHost`:$Port/$Service" -ForegroundColor Green
Write-Host "Schema user: $User"
Write-Host "Tabela SENSOR_DATA existe: $tableExists"
Write-Host "Total de registros em SENSOR_DATA: $rows"

if ($tableExists -eq 0) {
    Write-Host ""
    Write-Host "Para criar a tabela, execute:" -ForegroundColor Yellow
    Write-Host "sqlplus $connect @database/database_setup.sql"
}
