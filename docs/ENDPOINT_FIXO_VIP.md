# Endpoint Fixo (VIP) para 2 Notebooks

Objetivo: evitar qualquer troca de firmware/config do ESP32 ao alternar entre dois notebooks na mesma rede.

## Como funciona
- O ESP32 aponta sempre para um unico endpoint: `10.125.237.250:8000`.
- O notebook em uso "assume" esse IP virtual (VIP) na interface de rede.
- O backend FastAPI roda em `0.0.0.0:8000`, entao responde no VIP.

Assim, para o ESP32 o servidor e sempre o mesmo endereco.

## Arquivos adicionados
- `tools/start_with_vip.ps1`: adiciona VIP e inicia o backend.
- `tools/stop_with_vip.ps1`: encerra backend e remove VIP.
- `tools/recover_network_after_vip.ps1`: remove VIP e restaura DHCP/DNS da interface.

## Execucao (Windows)
Abrir PowerShell **como Administrador** no diretorio do projeto:

```powershell
powershell -ExecutionPolicy Bypass -File tools/start_with_vip.ps1 -InterfaceAlias "Wi-Fi"
```

Para parar:

```powershell
powershell -ExecutionPolicy Bypass -File tools/stop_with_vip.ps1
```

Para recuperar rede (quando ficar "conectado sem internet"):

```powershell
powershell -ExecutionPolicy Bypass -File tools/recover_network_after_vip.ps1 -InterfaceAlias "Wi-Fi"
```

Se ainda nao normalizar:

```powershell
powershell -ExecutionPolicy Bypass -File tools/recover_network_after_vip.ps1 -InterfaceAlias "Wi-Fi" -FullReset
```

Depois do `-FullReset`, reinicie o Windows.

## Regras importantes
- Nao rode os dois notebooks com o mesmo VIP ao mesmo tempo (conflito ARP/IP).
- O script `start_with_vip.ps1` aborta se detectar que o VIP ja responde em outro host.
- Informe `-InterfaceAlias "Wi-Fi"` para garantir que o VIP sera aplicado na interface correta.
- Se sua rede nao for `10.125.237.0/24`, ajuste o parametro:

```powershell
powershell -ExecutionPolicy Bypass -File tools/start_with_vip.ps1 -InterfaceAlias "Wi-Fi" -VirtualIp 192.168.0.250
```

Observacao: agora o `PrefixLength` usa automaticamente o prefixo da interface quando nao informado.
