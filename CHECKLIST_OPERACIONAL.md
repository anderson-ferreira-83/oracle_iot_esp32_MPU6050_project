# Checklist Operacional - IoT Fan Monitor

## Status Atual
- [x] Código ESP32 v7.1 atualizado (timestamps com milissegundos)
- [x] API ingest.php atualizado
- [x] Dashboard.js suporta chaves compactas
- [ ] Upload do main.py v7.1 para ESP32
- [ ] Verificar XAMPP rodando
- [ ] Testar conexão

## Passo 1: Verificar XAMPP no Windows
1. Abrir XAMPP Control Panel
2. Verificar se Apache está **Running** (verde)
3. Verificar se MySQL está **Running** (verde)

## Passo 2: Descobrir IP do Windows (para WSL2)
No **PowerShell do Windows**, executar:
```powershell
ipconfig | findstr "IPv4"
```
Procure o IP da interface WiFi/Ethernet (ex: 192.168.0.105)

## Passo 3: Testar API via curl (WSL2)
Substitua `192.168.0.105` pelo seu IP:
```bash
curl "http://192.168.0.105/xampp_iot_esp32_MPU6050_project/api/get_data.php?mode=latest"
```

Resposta esperada:
```json
{"data":{"id":"878","device_id":"ESP32_FAN_V7",...},"config":{"sample_rate":10}}
```

## Passo 4: Upload main.py v7.1 para ESP32
1. Abrir Thonny
2. Conectar ao ESP32
3. Abrir `tools/main.py`
4. Salvar no dispositivo: **Ctrl+Shift+S** → "main.py"
5. Resetar ESP32: **Ctrl+D**

## Passo 5: Verificar Saída do ESP32 no Thonny
Saída esperada:
```
WiFi OK: 192.168.0.xxx
========================================
ESP32 MPU6050 v7.1 - Timestamps MS
========================================
[TIMER] 10 Hz (periodo: 100 ms)
Rate: 10 Hz | Batch: 20
```

Após 10 segundos:
```
[STAT] 10.0/10 Hz (100% OK) | TX:5/0 | Buf:0 | Pend:0
```

## Passo 6: Verificar Dashboard
1. Abrir no navegador: `http://localhost/xampp_iot_esp32_MPU6050_project/web/index.html`
2. Status deve mudar para **Online** (verde)
3. Gráficos devem começar a mostrar dados

## Passo 7: Verificar control.html
1. Abrir: `http://localhost/xampp_iot_esp32_MPU6050_project/web/control.html`
2. Seção "Validação da Taxa" deve mostrar:
   - Taxa Esperada: 10.00 Hz
   - Taxa Real: ~10.xx Hz
   - Eficiência: ~95-100%
   - Amostras: crescendo

---

## Diagnóstico de Problemas

### Dashboard mostra "Offline"
1. Verificar se ESP32 está enviando dados (ver Thonny)
2. Verificar se XAMPP está rodando
3. Verificar se o IP do SERVER_IP no main.py está correto

### Taxa Real muito baixa
1. Verificar se o WiFi do ESP32 está estável
2. Reduzir TARGET_SAMPLE_RATE para 5 Hz
3. Verificar TX:ok/fail no [STAT] - se muitos fail, problema de rede

### Colunas NULL no banco (accel_x_g_std, etc.)
Isso é **normal** no modo atual. As features agregadas (std, rms, range) são calculadas:
- No servidor durante a análise de janelas deslizantes
- Nos notebooks de feature engineering
- O ESP32 envia apenas dados brutos para economizar memória

---

## Arquitetura do Sistema

```
ESP32 (main.py v7.1)
    ↓ HTTP POST (batch de 10-20 amostras)
    ↓ JSON: {"batch":[{"ts":1770473973.456,"ax":0.2,...},...]}
    ↓
XAMPP Apache + PHP (ingest.php)
    ↓ INSERT INTO sensor_data
    ↓
MySQL (iot_mpu6050.sensor_data)
    ↓
    ↓ get_data.php?mode=latest
    ↓
Dashboard (index.html + dashboard.js)
    - Gráficos em tempo real
    - Classificador ML no browser
```

## Features Agregadas (calculadas nos notebooks)

O modelo de ML usa as seguintes features calculadas em janelas de 150 amostras (~5s):
- `accel_x_g_std` - Desvio padrão do acelerômetro X
- `accel_x_g_range` - Range (max-min) do acelerômetro X
- `accel_x_g_rms` - RMS do acelerômetro X
- `gyro_y_dps_std` - Desvio padrão do giroscópio Y
- `gyro_y_dps_rms` - RMS do giroscópio Y
- `gyro_y_dps_range` - Range do giroscópio Y

Estas são calculadas no notebook `03_Model_Training_Evaluation.ipynb` durante o treinamento.
