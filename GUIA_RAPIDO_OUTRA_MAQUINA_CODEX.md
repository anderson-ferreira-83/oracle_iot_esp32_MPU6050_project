# Guia Rapido - Duas Maquinas + mDNS (Codex)

Objetivo: operar o ESP32 alternando entre duas maquinas sem editar IP manualmente.

---

## 0) PRIMEIRO ACESSO APOS RENOMEACAO DO REPOSITORIO (fazer 1x em cada maquina)

O repositorio foi renomeado em 2026-03-01. Em cada maquina, antes de qualquer push/pull:

```powershell
# Na ScienceMachine (desktop):
cd C:\xampp\htdocs\oracle_fast_api_iot_esp32_MPU6050_project

# No SAMSUNG-900X5T (notebook):
cd C:\Repositorio_Github\2_Projetos\oracle_fast_api_iot_esp32_MPU6050_project

# Em ambas, executar:
git remote set-url origin https://github.com/anderson-ferreira-83/oracle_iot_esp32_MPU6050_project.git
git remote get-url origin   # confirmar a saida
git pull                    # sincronizar com o remoto
```

Novo URL: `https://github.com/anderson-ferreira-83/oracle_iot_esp32_MPU6050_project.git`
A pasta local NAO muda de nome — apenas o remote.

---

## 0.1) SETUP ORACLE XE (fazer 1x em maquina nova ou apos reinstalacao)

Prerequisitos: Oracle XE 21c instalado, servicos `OracleServiceXE` e `OracleTNSListenerXE` rodando.

### Verificar servicos
```powershell
Get-Service | Where-Object { $_.Name -like "Oracle*" } | Select-Object Name, Status
# OracleServiceXE e OracleTNSListenerXE devem estar Running
```

### Criar usuario dersao (substitua SENHA_SYS pela senha definida na instalacao)
```powershell
# sqlplus esta em: C:\app\Anderson\product\21c\dbhomeXE\bin\sqlplus.exe
# Adicione ao PATH ou use o caminho completo

sqlplus sys/SENHA_SYS@localhost:1521/xepdb1 as sysdba `
  @database\create_user_dersao.sql
```

O script `database\create_user_dersao.sql` ja esta no repositorio e cria o usuario com as permissoes corretas.

### Criar tabelas
```powershell
sqlplus dersao/986960440@localhost:1521/xepdb1 `
  @database\database_setup.sql
```

### Testar conexao Python
```powershell
$env:ORACLE_HOST         = "localhost"
$env:ORACLE_PORT         = "1521"
$env:ORACLE_SERVICE_NAME = "xepdb1"
$env:ORACLE_USER         = "dersao"
$env:ORACLE_PASSWORD     = "986960440"
py -3.11 tools\test_oracle_python_connection.py
# Esperado: [OK] Conexao Oracle estabelecida. STATUS=OK
```

### Instalar dependencias Python (se necessario)
```powershell
py -3.11 -m pip install -r backend\requirements.txt
```

---

## 1) Mapa atual (configurado)
- SSID `S20_Ders@0` -> `SAMSUNG-900X5T.local:8000`
- SSID `Dersao83` -> `ScienceMachine.local:8000`
- Endpoint de envio: `/api/ingest`
- Device: `ESP32_MPU6050_ORACLE`

## 2) Fluxo rapido por maquina
### Maquina SAMSUNG-900X5T (rede `S20_Ders@0`)
```powershell
cd C:\Users\Anderson\Downloads\oracle_fast_api_iot_esp32_MPU6050_project
.\start.ps1
Invoke-WebRequest http://127.0.0.1:8000/health
Invoke-WebRequest http://SAMSUNG-900X5T.local:8000/health
```

### Maquina ScienceMachine (rede `Dersao83`)
```powershell
cd C:\xampp\htdocs\oracle_fast_api_iot_esp32_MPU6050_project
.\start.ps1
Invoke-WebRequest http://127.0.0.1:8000/health
Invoke-WebRequest http://ScienceMachine.local:8000/health
```

Resultado esperado:
- ambos health checks com `StatusCode 200`

## 3) Checklist rapido quando mudar de rede
1. Conectar a maquina na rede/hotspot certo.
2. Subir backend com `.\start.ps1`.
3. Validar `/health` local (`127.0.0.1`) e no hostname `.local`.
4. Reiniciar ESP32 (EN/RST) se ele estava em outra rede.
5. Confirmar dashboard online e dados chegando.

## 4) Se nao conectar
### 4.1 Falha no `127.0.0.1:8000/health`
- backend nao subiu (Python/Oracle/porta 8000).

### 4.2 `127.0.0.1` OK e `.local` FAIL
- mDNS/hostname nao resolvendo na rede atual.
- testar:
```powershell
ping -4 SAMSUNG-900X5T.local
ping -4 ScienceMachine.local
```

### 4.3 `.local` resolve mas sem acesso
- liberar firewall da porta 8000:
```powershell
netsh advfirewall firewall add rule name="ESP32 FastAPI 8000" dir=in action=allow protocol=TCP localport=8000 profile=any
```

## 5) Validacao da taxa de aquisicao (100 Hz)
Rodar com backend ativo:

```powershell
$json = Invoke-WebRequest "http://127.0.0.1:8000/api/get_data?mode=history&seconds=20&device_id=ESP32_MPU6050_ORACLE" -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
$data = @($json.data)
$ts = $data | ForEach-Object { [double]($_.timestamp) }
$dts = @()
for ($i=1; $i -lt $ts.Count; $i++) { $dts += ($ts[$i]-$ts[$i-1]) }
$avg = ($dts | Measure-Object -Average).Average
$eff = if($avg -gt 0){ 1.0/$avg } else { 0 }
$p99 = ($dts | Sort-Object)[[int][math]::Floor(0.99*($dts.Count-1))]
"CFG_RATE={0}Hz CFG_SPS={1} EFF_RATE={2:N2}Hz P99_DT={3:N4}s" -f $json.config.sample_rate,$json.config.sends_per_sec,$eff,$p99
```

Criterio pratico de OK:
- `CFG_RATE` perto de `100`
- `EFF_RATE >= 90 Hz`
- `P99_DT < 0.10 s` (ideal; picos esporadicos podem ocorrer em Wi-Fi ruidoso)

## 6) Comandos uteis para retorno rapido
```powershell
# Health local
Invoke-WebRequest http://127.0.0.1:8000/health

# Health por hostname (ajuste conforme maquina)
Invoke-WebRequest http://SAMSUNG-900X5T.local:8000/health
Invoke-WebRequest http://ScienceMachine.local:8000/health
```
