# Melhorias Multi-Device (HTTP + MQTT) e Plano de Testes

## Objetivo
Eliminar a necessidade de reconfigurar firmware quando trocar ambiente/rede e permitir operar dois ESP32+MPU6050 em paralelo:
- um para fluxo HTTP/XAMPP;
- outro para fluxo MQTT.

## Convencao de nomes sugerida
- `ESP32_MPU6050_HTTP_01`: dispositivo dedicado ao projeto XAMPP (API HTTP).
- `ESP32_MPU6050_MQTT_01`: dispositivo dedicado ao projeto MQTT (broker).

Escala futura:
- `ESP32_MPU6050_HTTP_02`, `ESP32_MPU6050_MQTT_02`, etc.

## Melhorias implementadas neste projeto (XAMPP)

### 1) Estado de controle por dispositivo
- Novo helper: `api/control_state_lib.php`.
- Estado agora pode ser salvo por `device_id` em:
  - `api/control_states/control_state_<device_id>.json`
- Fallback legado mantido:
  - se nao houver estado dedicado, usa `api/control_state.json`.

### 2) API de controle (`set_mode.php`)
- Aceita `device_id` via query/body.
- GET/POST passam a operar por dispositivo.
- Mantem compatibilidade quando `device_id` nao e enviado.
- Continua validando token e warning de `collection_id` x `sample_rate`.

### 3) Ingestao (`ingest.php`)
- Le `device_id` do payload e sanitiza.
- Busca comandos/estado (`mode`, `sample_rate`, `ingest_enabled`, `collection_id`) por `device_id`.
- Resposta agora inclui `device_id`.
- Mantem fallback para estado global.

### 4) Consulta de dados (`get_data.php`)
- Novo filtro opcional `device_id` em todos os modos:
  - `latest`, `history`, `stats`, `collection`, `debug`.
- Config retornada passa a ser a do dispositivo quando informado.

### 5) Frontend de controle (`web/control.html`)
- Le `device_id` da URL: `control.html?device_id=ESP32_MPU6050_HTTP_01`.
- Anexa `device_id` em chamadas para:
  - `set_mode.php`
  - `get_data.php`
- Preserva compatibilidade quando sem `device_id`.
- Link para dashboard passa a carregar o mesmo `device_id`.

### 6) Frontend dashboard (`web/js/dashboard.js`)
- Adicionado helper `withDeviceId(...)`.
- Todas as leituras de `get_data.php` agora incluem `device_id` automaticamente quando presente na URL.

## Como operar sem regravar firmware

### Estrategia recomendada
- Deixe cada ESP com identidade fixa no firmware/config:
  - HTTP board: `ESP32_MPU6050_HTTP_01`
  - MQTT board: `ESP32_MPU6050_MQTT_01`
- Abra painel XAMPP com query do HTTP board:
  - `control.html?device_id=ESP32_MPU6050_HTTP_01`
  - `index.html?device_id=ESP32_MPU6050_HTTP_01`
- Projeto MQTT usa apenas o `device_id` MQTT no consumidor/dashboard MQTT.

Resultado:
- voce troca de ambiente sem editar codigo;
- separa claramente telemetria/comando por dispositivo;
- evita conflito de estado entre HTTP e MQTT.

## Testes recomendados (proximos passos)

1. Teste de leitura de estado por device:
- `GET /api/set_mode.php?device_id=ESP32_MPU6050_HTTP_01` (com Authorization)
- confirmar retorno com `device_id`.

2. Teste de escrita por device:
- `POST /api/set_mode.php?device_id=ESP32_MPU6050_HTTP_01` com `{ \"mode\": \"LOW\" }`
- validar criacao/atualizacao de arquivo em `api/control_states/`.

3. Teste de ingestao separada:
- enviar payloads com `device_id` HTTP e MQTT;
- validar no banco e no `get_data.php?mode=latest&device_id=...`.

4. Teste de dashboard/control por URL:
- abrir duas abas com `device_id` diferentes e confirmar isolamento.

5. Teste de regressao legado:
- chamar APIs sem `device_id` e validar funcionamento antigo.

## Possiveis correcoes/evolucoes

1. Index no banco para performance:
- criar indice composto em `sensor_data(device_id, timestamp)`.

2. Limpeza de estados antigos:
- rotina para remover `control_state_<device>.json` obsoletos.

3. Hardening de validacao:
- bloquear `device_id` vazio no frontend e exibir aviso visual.

4. Operacao em rede nova:
- manter WiFiManager + mDNS nos firmwares (ja tratado no fluxo de autonomia).

5. Evolucao opcional (firmware unico):
- criar campo `transport` em config (`http` ou `mqtt`) para um mesmo firmware selecionar destino sem recompilar.

