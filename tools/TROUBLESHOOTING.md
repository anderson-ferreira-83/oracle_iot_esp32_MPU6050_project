# Troubleshooting — ESP32 ESP-NOW USB Bridge

## Problemas resolvidos e causas raiz

---

### 1. Nenhum dado recebido pelo bridge (serial aberta mas vazia)

**Sintoma:**
```
16:09:05  Serial aberta: COM3
(sem mais saida)
```

**Causa:** O Thonny (ou qualquer outra ferramenta serial) estava conectado ao ESP32-RX ao mesmo tempo que o bridge tentava ler. Mesmo que o bridge consiga abrir a porta, o firmware do ESP32 não executa enquanto o Thonny mantém a sessão REPL ativa.

**Solucao:**
1. Feche o Thonny completamente antes de iniciar o `start.ps1`
2. Pressione o botão EN/RESET no ESP32-RX
3. Aguarde ~3s — o bridge deve exibir o boot do firmware seguido dos dados JSON

---

### 2. Taxa real de aquisicao abaixo do configurado (~88 Hz em vez de 100 Hz)

**Sintoma:** Control.html exibia "Real: 86-88.5 Hz" com configuracao em 100 Hz.

**Causa:** `POST_BATCH_SIZE = 100` no RX firmware causava escrita de ~4.6 KB de JSON em uma unica chamada `sys.stdout.write()`, bloqueando o loop principal por ~400ms. Durante esse bloqueio, `en.recv()` nao era chamado e pacotes ESP-NOW eram descartados (`SEQ_DROP:9` por 10 segundos = 11.5% de perda).

**Solucao:** `POST_BATCH_SIZE = 13` (1 pacote ESP-NOW por escrita, ~650 bytes, tempo de escrita << 5ms). Arquivo: `firmware_esp32_rx_usb/main_espnow_rx_usb.py`.

---

### 3. Hz calculado errado no frontend mesmo com dados chegando

**Sintoma:** Hz exibido incorreto ou constante, timestamps identicos nos batches.

**Causa:** O ESP32-RX usa `float32` para o campo `t0` (timestamp do batch). Para valores Unix grandes (~1.77×10⁹), o `float32` perde toda a parte fracionaria → `t0 = 1772899200.0` em todos os pacotes → bridge reconstruia timestamps identicos para batches diferentes → calculo de Hz quebrado.

**Solucao:** `usb_espnow_bridge.py` — `reconstruct_payload()` passou a usar o relogio do PC (`time.time()`, `float64`) em vez do `t0` do ESP32:
```python
# Antes (quebrado):
t0 = float(data["t0"])

# Depois (correto):
t0 = time.time() - (len(raw_batch) - 1) * period
```

---

### 4. MPU6050 com taxa controlada por FIFO hardware

**Motivo da mudanca:** `time.sleep_ms(1)` e `machine.Timer` no MicroPython nao garantem precisao de timing suficiente para 100 Hz (oversleep de 1.5-3ms por ciclo acumulava erro).

**Solucao:** MPU6050 configurado com FIFO interno habilitado via registradores:
- `0x6B = 0x00` — wake up
- `0x1A = 0x01` — DLPF mode 1
- `0x19 = div` — SMPLRT_DIV = (1000/sr) - 1
- `0x23 = 0xF8` — FIFO_EN (accel + gyro + temp)
- `0x6A = 0x44` — USER_CTRL: habilita e reseta FIFO

O loop principal apenas poll o FIFO count e le quando ha >= 13 amostras. Taxa controlada pelo cristal do sensor, independente do Python.

---

### 5. Cabo USB sem dados (apenas carga)

**Sintoma:** Nenhuma porta serial detectada pelo bridge ou pelo PC.

**Causa:** Cabo USB era do tipo "somente carga" (sem fios D+ e D-).

**Solucao:** Substituir por cabo USB com suporte a dados.

---

## Sequencia de inicializacao correta

```
1. Fechar Thonny
2. Ligar ESP32-TX (fonte ou USB em outra maquina)
3. Conectar ESP32-RX via USB ao PC
4. Executar start.ps1
5. Aguardar "Serial aberta: COMx" + boot do firmware + dados JSON
```

## Arquivos relevantes

| Arquivo | Funcao |
|---|---|
| `firmware_esp32_tx/main_espnow_tx.py` | Firmware TX: le MPU6050 via FIFO, envia ESP-NOW |
| `firmware_esp32_tx/device_config.json` | Config TX: MAC do RX, canal, taxa |
| `firmware_esp32_rx_usb/main_espnow_rx_usb.py` | Firmware RX: recebe ESP-NOW, saida USB serial |
| `firmware_esp32_rx_usb/device_config.json` | Config RX: canal, taxa |
| `usb_espnow_bridge.py` | Bridge PC: le serial, reconstroi payload, POST ao backend |
| `device_config_espnow_rx_usb.json` | Config bridge (detectada pelo start.ps1) |
