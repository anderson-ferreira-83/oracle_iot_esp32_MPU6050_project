param(
    [string]$VirtualIp = "10.125.237.250",
    [int]$PrefixLength = 0,
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
    }

    if (-not $active) {
        throw "Nao foi encontrada interface de rede ativa com gateway."
    }

    $wifi = $active | Where-Object {
        $_.InterfaceAlias -match "(?i)wi-?fi|wlan|wireless" -or
        $_.NetAdapter.InterfaceDescription -match "(?i)wi-?fi|wireless|802\.11"
    } | Select-Object -First 1

    if ($wifi) {
        return $wifi
    }

    return ($active | Select-Object -First 1)
}

function Test-InSameSubnet {
    param(
        [string]$IpA,
        [string]$IpB,
        [int]$Prefix
    )

    if ($Prefix -lt 0 -or $Prefix -gt 32) {
        throw "PrefixLength invalido: $Prefix"
    }

    $bytesA = [System.Net.IPAddress]::Parse($IpA).GetAddressBytes()
    $bytesB = [System.Net.IPAddress]::Parse($IpB).GetAddressBytes()
    $bits = $Prefix

    for ($i = 0; $i -lt 4; $i++) {
        if ($bits -ge 8) {
            $mask = [byte]255
            $bits -= 8
        } elseif ($bits -gt 0) {
            $mask = [byte](256 - [Math]::Pow(2, 8 - $bits))
            $bits = 0
        } else {
            $mask = [byte]0
        }

        if (($bytesA[$i] -band $mask) -ne ($bytesB[$i] -band $mask)) {
            return $false
        }
    }

    return $true
}

if (-not (Test-IsAdmin)) {
    throw "Execute este script como Administrador."
}

$adapter = Get-TargetAdapter -Alias $InterfaceAlias
$ifIndex = $adapter.InterfaceIndex
$ifAlias = $adapter.InterfaceAlias
$primary = $adapter.IPv4Address | Select-Object -First 1

if (-not $primary) {
    throw "Nao foi possivel identificar IPv4 principal da interface '$ifAlias'."
}

$effectivePrefixLength = if ($PrefixLength -gt 0) { $PrefixLength } else { [int]$primary.PrefixLength }

if ($effectivePrefixLength -lt 1 -or $effectivePrefixLength -gt 32) {
    throw "PrefixLength invalido: $effectivePrefixLength"
}

$gatewayIp = $null
if ($adapter.IPv4DefaultGateway) {
    $gatewayIp = $adapter.IPv4DefaultGateway.NextHop
}

Write-Host "[NET] Interface: $ifAlias (ifIndex=$ifIndex)"
Write-Host "[NET] IPv4 principal: $($primary.IPAddress)/$($primary.PrefixLength)"
Write-Host "[NET] Prefix usado no VIP: /$effectivePrefixLength"

if ($VirtualIp -eq $primary.IPAddress) {
    throw "VirtualIp $VirtualIp e igual ao IP principal da interface."
}

if ($gatewayIp -and $VirtualIp -eq $gatewayIp) {
    throw "VirtualIp $VirtualIp e igual ao gateway da rede ($gatewayIp)."
}

if (-not (Test-InSameSubnet -IpA $primary.IPAddress -IpB $VirtualIp -Prefix $effectivePrefixLength)) {
    throw "VirtualIp $VirtualIp/$effectivePrefixLength nao esta na mesma sub-rede da interface ($($primary.IPAddress)/$($primary.PrefixLength))."
}

$existingLocalVip = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -eq $VirtualIp }

if (-not $existingLocalVip) {
    $neighborConflict = Get-NetNeighbor -AddressFamily IPv4 -IPAddress $VirtualIp -ErrorAction SilentlyContinue |
        Where-Object { $_.State -ne "Unreachable" -and $_.State -ne "Invalid" } |
        Select-Object -First 1
    if ($neighborConflict) {
        throw "O IP virtual $VirtualIp ja aparece na tabela ARP desta rede (estado: $($neighborConflict.State))."
    }

    $vipInUse = Test-Connection -TargetName $VirtualIp -Count 1 -Quiet -ErrorAction SilentlyContinue
    if ($vipInUse) {
        throw "O IP virtual $VirtualIp responde na rede e nao esta nesta interface. Outro host ja esta usando."
    }

    New-NetIPAddress -InterfaceIndex $ifIndex -IPAddress $VirtualIp -PrefixLength $effectivePrefixLength -SkipAsSource $true | Out-Null
    Write-Host "[NET] VIP adicionado: $VirtualIp/$effectivePrefixLength"
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
