param(
    [string]$VirtualIp = "10.125.237.250",
    [int]$PrefixLength = 24,
    [int]$Port = 8000,
    [string]$InterfaceAlias = ""
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($current)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-TargetAdapter {
    param([string]$Alias)
    if ($Alias) {
        $cfg = Get-NetIPConfiguration -InterfaceAlias $Alias -ErrorAction Stop
        if ($cfg.IPv4Address -and $cfg.NetAdapter.Status -eq "Up") {
            return $cfg
        }
        throw "Interface '$Alias' nao esta pronta para IPv4."
    }

    $active = Get-NetIPConfiguration | Where-Object {
        $_.IPv4Address -and $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up"
    } | Select-Object -First 1

    if (-not $active) {
        throw "Nao foi encontrada interface de rede ativa com gateway."
    }
    return $active
}

if (-not (Test-IsAdmin)) {
    throw "Execute este script como Administrador."
}

$adapter = Get-TargetAdapter -Alias $InterfaceAlias
$ifIndex = $adapter.InterfaceIndex
$ifAlias = $adapter.InterfaceAlias

Write-Host "[NET] Interface: $ifAlias (ifIndex=$ifIndex)"

$existingLocalVip = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -eq $VirtualIp }

if (-not $existingLocalVip) {
    $vipInUse = Test-Connection -ComputerName $VirtualIp -Count 1 -Quiet -ErrorAction SilentlyContinue
    if ($vipInUse) {
        throw "O IP virtual $VirtualIp responde na rede e nao esta nesta interface. Outro host ja esta usando."
    }

    New-NetIPAddress -InterfaceIndex $ifIndex -IPAddress $VirtualIp -PrefixLength $PrefixLength -SkipAsSource $true | Out-Null
    Write-Host "[NET] VIP adicionado: $VirtualIp/$PrefixLength"
} else {
    Write-Host "[NET] VIP ja presente nesta interface."
}

$healthUrl = "http://$VirtualIp`:$Port/health"
$serverUp = $false
try {
    $resp = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    if ($resp.StatusCode -eq 200) {
        $serverUp = $true
    }
} catch {
    $serverUp = $false
}

if ($serverUp) {
    Write-Host "[APP] Backend ja esta respondendo em $healthUrl"
    exit 0
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Write-Host "[APP] Iniciando backend pelo start.ps1..."
& (Join-Path $projectRoot "start.ps1")
