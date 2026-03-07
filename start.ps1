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
    "http://127.0.0.1:$PORT/web/control.html",
    "http://127.0.0.1:$PORT/web/index.html"
)
$MAX_WAIT_SEC = 90   # tempo maximo aguardando o servidor subir (ADB cloud pode demorar mais)

# --- Caminho do projeto ---
$PROJECT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $PROJECT_DIR

# --- Variaveis de ambiente Oracle (lidas do .env.oracle) ---
$envFile = Join-Path $PROJECT_DIR ".env.oracle"
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        $line = $line.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { continue }
        $parts = $line -split "=", 2
        if ($parts.Count -eq 2) {
            $key = $parts[0].Trim()
            $val = $parts[1].Trim()
            [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
        }
    }
    Write-Host "  .env.oracle carregado." -ForegroundColor DarkGray
} else {
    Write-Host "[AVISO] .env.oracle nao encontrado, usando variaveis do ambiente." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Oracle IoT ESP32 MPU6050 - Backend Start  " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Projeto: $PROJECT_DIR"
Write-Host "  Oracle:  $($env:ORACLE_USER)@$($env:ORACLE_DSN)"
Write-Host "  Porta:   $PORT"
Write-Host ""

# --- Detecta modo de transporte via configs do ESP32 ---
$transportMode = ""
$configCandidates = @(
    "tools\device_config.json",
    "tools\device_config_espnow_rx_usb.json",
    "tools\device_config_espnow_rx.json"
)
foreach ($cfg in $configCandidates) {
    if (Test-Path $cfg) {
        try {
            $parsed = Get-Content $cfg -Raw | ConvertFrom-Json
            if ($parsed.transport_mode) {
                $transportMode = $parsed.transport_mode
                Write-Host "  Transporte: $transportMode (lido de $cfg)"
                break
            }
        } catch {}
    }
}
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
    Start-Sleep -Seconds 5   # pausa inicial: evita TIME_WAIT no bind da porta
    $elapsed = 5
    $ready   = $false
    while ($elapsed -lt $MAX_WAIT_SEC) {
        Start-Sleep -Seconds 2
        $elapsed += 2
        try {
            $r = Invoke-WebRequest -Uri $HEALTH_URL -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
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

# --- Inicia bridge USB se modo espnow_rx_usb ---
if ($transportMode -eq "espnow_rx_usb") {
    Write-Host ""
    Write-Host "[...] Iniciando bridge USB (ESP32-RX -> backend)..." -ForegroundColor Yellow
    $bridgeArgs = "$PYTHON_VER tools\usb_espnow_bridge.py"
    Start-Process -FilePath $PYTHON -ArgumentList $bridgeArgs `
        -WorkingDirectory $PROJECT_DIR `
        -WindowStyle Normal
    Write-Host "[OK] Bridge USB iniciada em nova janela." -ForegroundColor Green
    Write-Host "     Certifique-se de que o ESP32-RX esta conectado via USB antes de coletar dados."
}

# --- Abre as paginas no navegador padrao ---
Write-Host ""
Write-Host "[...] Abrindo paginas no navegador..." -ForegroundColor Yellow
foreach ($url in $PAGES) {
    Start-Process $url
    Write-Host "  -> $url"
}

Write-Host ""
Write-Host "[OK] Pronto! Processos rodando em janelas separadas:" -ForegroundColor Green
Write-Host "     - Janela uvicorn: backend FastAPI"
if ($transportMode -eq "espnow_rx_usb") {
    Write-Host "     - Janela bridge:   USB Serial ESP32-RX -> localhost:$PORT"
}
Write-Host "     Para encerrar, feche as janelas ou pressione Ctrl+C nelas."
Write-Host ""
