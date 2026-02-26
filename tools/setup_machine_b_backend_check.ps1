param(
    [string]$InterfaceAlias = "Wi-Fi",
    [int]$Port = 8000,
    [int]$StartupTimeoutSec = 30,
    [switch]$SkipStartBackend,
    [switch]$OpenFirewallRule,
    [switch]$OpenPages
)

$ErrorActionPreference = "Stop"

function Get-WifiIPv4 {
    param([string]$Alias)

    $ip = $null

    try {
        $ip = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $Alias -ErrorAction Stop |
            Where-Object { $_.IPAddress -and $_.IPAddress -notlike "169.254*" } |
            Sort-Object -Property SkipAsSource |
            Select-Object -First 1 -ExpandProperty IPAddress
    } catch {
        $ip = $null
    }

    if (-not $ip) {
        try {
            $netsh = netsh interface ip show addresses "$Alias"
            $joined = ($netsh -join " ")
            $allIps = [regex]::Matches($joined, "([0-9]{1,3}(?:\.[0-9]{1,3}){3})") | ForEach-Object { $_.Groups[1].Value }
            foreach ($candidate in $allIps) {
                if ($candidate -notlike "0.*" -and $candidate -notlike "169.254*") {
                    $ip = $candidate
                    break
                }
            }
        } catch {
            $ip = $null
        }
    }

    if (-not $ip) {
        throw "Nao foi possivel identificar IPv4 valido na interface '$Alias'."
    }
    return $ip
}

function Invoke-Health {
    param([string]$Url)

    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        return [pscustomobject]@{
            ok = ($resp.StatusCode -eq 200)
            status = $resp.StatusCode
            body = $resp.Content
            error = ""
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 0
            body = ""
            error = $_.Exception.Message
        }
    }
}

function Test-IsAdmin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($current)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

$ip = Get-WifiIPv4 -Alias $InterfaceAlias
$localUrl = "http://127.0.0.1:$Port/health"
$lanUrl = "http://$ip`:$Port/health"

Write-Host "[NET] Interface: $InterfaceAlias"
Write-Host "[NET] IPv4: $ip"
Write-Host "[ESP32] server_ip sugerido: $ip`:$Port"

$local = Invoke-Health -Url $localUrl
$startedPid = $null

if (-not $SkipStartBackend -and -not $local.ok) {
    if (-not $env:ORACLE_HOST) { $env:ORACLE_HOST = "localhost" }
    if (-not $env:ORACLE_PORT) { $env:ORACLE_PORT = "1521" }
    if (-not $env:ORACLE_SERVICE_NAME) { $env:ORACLE_SERVICE_NAME = "xepdb1" }
    if (-not $env:ORACLE_USER) { $env:ORACLE_USER = "dersao" }
    if (-not $env:ORACLE_PASSWORD) { $env:ORACLE_PASSWORD = "986960440" }

    $args = "-3.11 -m uvicorn backend.server:app --host 0.0.0.0 --port $Port --no-access-log"
    $proc = Start-Process -FilePath "py" -ArgumentList $args -WorkingDirectory $projectRoot -PassThru
    $startedPid = $proc.Id
    Write-Host "[APP] Uvicorn iniciado (PID $startedPid)."

    $elapsed = 0
    do {
        Start-Sleep -Seconds 1
        $elapsed++
        $local = Invoke-Health -Url $localUrl
    } while (-not $local.ok -and $elapsed -lt $StartupTimeoutSec)
}

$lan = Invoke-Health -Url $lanUrl

Write-Host ""
Write-Host "[CHECK] LOCAL  $localUrl"
if ($local.ok) {
    Write-Host "        OK ($($local.status)) $($local.body)"
} else {
    Write-Host "        FAIL $($local.error)"
}

Write-Host "[CHECK] LAN    $lanUrl"
if ($lan.ok) {
    Write-Host "        OK ($($lan.status)) $($lan.body)"
} else {
    Write-Host "        FAIL $($lan.error)"
}

if ($OpenFirewallRule -and -not $lan.ok) {
    if (Test-IsAdmin) {
        try {
            netsh advfirewall firewall add rule name="ESP32 FastAPI 8000" dir=in action=allow protocol=TCP localport=$Port profile=any | Out-Null
            Write-Host "[FW] Regra de firewall aplicada para porta $Port."
            $lan2 = Invoke-Health -Url $lanUrl
            if ($lan2.ok) {
                Write-Host "[CHECK] LAN apos firewall: OK ($($lan2.status))"
                $lan = $lan2
            } else {
                Write-Host "[CHECK] LAN apos firewall: FAIL $($lan2.error)"
            }
        } catch {
            Write-Host "[FW] Falha ao aplicar regra: $($_.Exception.Message)"
        }
    } else {
        Write-Host "[FW] Execute como Administrador e use -OpenFirewallRule para liberar a porta."
    }
}

Write-Host ""
Write-Host "[RESULT] server_ip para ESP32: $ip`:$Port"
if ($startedPid) {
    Write-Host "[RESULT] Uvicorn iniciou neste script com PID $startedPid."
}

if ($OpenPages -and $local.ok) {
    $indexUrl = "http://127.0.0.1:$Port/web/index.html"
    $controlUrl = "http://127.0.0.1:$Port/web/control.html"
    Start-Process $indexUrl
    Start-Process $controlUrl
    Write-Host "[WEB] Paginas abertas:"
    Write-Host "      $indexUrl"
    Write-Host "      $controlUrl"
}

if (-not $local.ok -or -not $lan.ok) {
    Write-Host "[NEXT] Se LOCAL falhou: backend nao subiu corretamente."
    Write-Host "[NEXT] Se LAN falhou: firewall/rede bloqueando acesso por IP."
    exit 1
}

exit 0
