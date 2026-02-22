# =============================================================================
# start.ps1 - Inicia o backend Oracle IoT e abre as paginas no navegador
# Uso: clique duplo em start.ps1 ou execute no PowerShell:
#      .\start.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

# --- Configuracao ---
$PYTHON       = "py"
$PYTHON_VER   = "-3.11"
$HOST_ADDR    = "0.0.0.0"
$PORT         = 8000
$HEALTH_URL   = "http://127.0.0.1:$PORT/health"
$PAGES        = @(
    "http://127.0.0.1:$PORT/web/index.html",
    "http://127.0.0.1:$PORT/web/control.html"
)
$MAX_WAIT_SEC = 30   # tempo maximo aguardando o servidor subir

# --- Variaveis de ambiente Oracle ---
$env:ORACLE_HOST         = "localhost"
$env:ORACLE_PORT         = "1521"
$env:ORACLE_SERVICE_NAME = "xepdb1"
$env:ORACLE_USER         = "dersao"
$env:ORACLE_PASSWORD     = "986960440"

# --- Caminho do projeto ---
$PROJECT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $PROJECT_DIR

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Oracle IoT ESP32 MPU6050 - Backend Start  " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Projeto: $PROJECT_DIR"
Write-Host "  Oracle:  $($env:ORACLE_USER)@$($env:ORACLE_HOST):$($env:ORACLE_PORT)/$($env:ORACLE_SERVICE_NAME)"
Write-Host "  Porta:   $PORT"
Write-Host ""

# --- Verifica se porta ja esta em uso ---
$portInUse = $false
try {
    $response = Invoke-WebRequest -Uri $HEALTH_URL -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        $portInUse = $true
    }
} catch {}

if ($portInUse) {
    Write-Host "[OK] Servidor ja esta rodando em http://127.0.0.1:$PORT" -ForegroundColor Green
} else {
    # --- Inicia uvicorn em nova janela ---
    Write-Host "[...] Iniciando uvicorn..." -ForegroundColor Yellow
    $uvicornArgs = "$PYTHON_VER -m uvicorn backend.server:app --host $HOST_ADDR --port $PORT --no-access-log"
    Start-Process -FilePath $PYTHON -ArgumentList $uvicornArgs `
        -WorkingDirectory $PROJECT_DIR `
        -WindowStyle Normal

    # --- Aguarda o servidor responder ---
    Write-Host "[...] Aguardando servidor (max ${MAX_WAIT_SEC}s)..." -ForegroundColor Yellow
    $elapsed = 0
    $ready   = $false
    while ($elapsed -lt $MAX_WAIT_SEC) {
        Start-Sleep -Seconds 1
        $elapsed++
        try {
            $r = Invoke-WebRequest -Uri $HEALTH_URL -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
            if ($r.StatusCode -eq 200) {
                $ready = $true
                break
            }
        } catch {}
        Write-Host "  ...${elapsed}s" -NoNewline -ForegroundColor DarkGray
    }
    Write-Host ""

    if (-not $ready) {
        Write-Host "[ERRO] Servidor nao respondeu em ${MAX_WAIT_SEC}s." -ForegroundColor Red
        Write-Host "  Verifique se o Oracle esta rodando (OracleServiceXE + TNSListener)."
        Write-Host "  Pressione Enter para sair..."
        Read-Host
        exit 1
    }

    Write-Host "[OK] Servidor pronto em http://127.0.0.1:$PORT" -ForegroundColor Green
}

# --- Abre as paginas no navegador padrao ---
Write-Host ""
Write-Host "[...] Abrindo paginas no navegador..." -ForegroundColor Yellow
foreach ($url in $PAGES) {
    Start-Process $url
    Write-Host "  -> $url"
}

Write-Host ""
Write-Host "[OK] Pronto! O servidor continua rodando na outra janela." -ForegroundColor Green
Write-Host "     Para encerrar, feche a janela do uvicorn ou pressione Ctrl+C nela."
Write-Host ""
