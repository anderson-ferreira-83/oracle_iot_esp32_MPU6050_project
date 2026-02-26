param(
    [string]$VirtualIp = "10.125.237.250",
    [string]$InterfaceAlias = "",
    [switch]$FullReset
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
        if ($cfg.NetAdapter.Status -eq "Up") {
            return $cfg
        }
        throw "Interface '$Alias' nao esta ativa."
    }

    $active = Get-NetIPConfiguration | Where-Object {
        $_.NetAdapter.Status -eq "Up" -and $_.IPv4Address
    }

    if (-not $active) {
        throw "Nao foi encontrada interface ativa com IPv4."
    }

    $wifi = $active | Where-Object {
        $_.InterfaceAlias -match "(?i)wi-?fi|wlan|wireless" -or
        $_.NetAdapter.InterfaceDescription -match "(?i)wi-?fi|wireless|802\.11"
    } | Select-Object -First 1

    if ($wifi) {
        return $wifi
    }

    $withGateway = $active | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1
    if ($withGateway) {
        return $withGateway
    }

    return ($active | Select-Object -First 1)
}

if (-not (Test-IsAdmin)) {
    throw "Execute este script como Administrador."
}

$adapter = Get-TargetAdapter -Alias $InterfaceAlias
$ifIndex = $adapter.InterfaceIndex
$ifAlias = $adapter.InterfaceAlias

Write-Host "[NET] Interface alvo: $ifAlias (ifIndex=$ifIndex)"

$vipEntries = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $VirtualIp -ErrorAction SilentlyContinue
foreach ($vip in $vipEntries) {
    try {
        Remove-NetIPAddress -InterfaceIndex $vip.InterfaceIndex -IPAddress $vip.IPAddress -Confirm:$false -ErrorAction Stop
        Write-Host "[NET] VIP removido: $($vip.IPAddress) em ifIndex=$($vip.InterfaceIndex)"
    } catch {
        Write-Host "[NET] Falha ao remover VIP em ifIndex=$($vip.InterfaceIndex): $($_.Exception.Message)"
    }
}

$manualIps = Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.PrefixOrigin -eq "Manual" }

foreach ($ip in $manualIps) {
    try {
        Remove-NetIPAddress -InterfaceIndex $ifIndex -IPAddress $ip.IPAddress -Confirm:$false -ErrorAction Stop
        Write-Host "[NET] IPv4 manual removido: $($ip.IPAddress)/$($ip.PrefixLength)"
    } catch {
        Write-Host "[NET] Falha ao remover IPv4 manual $($ip.IPAddress): $($_.Exception.Message)"
    }
}

Set-NetIPInterface -InterfaceIndex $ifIndex -AddressFamily IPv4 -Dhcp Enabled | Out-Null
Set-DnsClientServerAddress -InterfaceIndex $ifIndex -ResetServerAddresses
Write-Host "[NET] DHCP e DNS automatico reativados em '$ifAlias'."

try {
    ipconfig /release | Out-Null
    Start-Sleep -Seconds 2
    ipconfig /renew | Out-Null
    ipconfig /flushdns | Out-Null
    Write-Host "[NET] Lease DHCP renovado e cache DNS limpo."
} catch {
    Write-Host "[NET] Aviso ao renovar DHCP/DNS: $($_.Exception.Message)"
}

if ($FullReset) {
    netsh winsock reset | Out-Null
    netsh int ip reset | Out-Null
    Write-Host "[NET] Winsock/IP resetados. Reinicie o Windows para concluir."
}

$probeIp = Test-NetConnection -ComputerName "1.1.1.1" -Port 53 -InformationLevel Quiet -WarningAction SilentlyContinue
$probeDns = $false
try {
    Resolve-DnsName "example.com" -Type A -ErrorAction Stop | Out-Null
    $probeDns = $true
} catch {
    $probeDns = $false
}

Write-Host "[CHECK] Conexao IP (1.1.1.1:53): $probeIp"
Write-Host "[CHECK] Resolucao DNS: $probeDns"

if (-not $probeIp -or -not $probeDns) {
    Write-Host "[NEXT] Se continuar sem internet, rode novamente com -FullReset e reinicie o Windows."
}
