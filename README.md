# oracle_iot_esp32_MPU6050_project

Projeto IoT para aquisição de vibração com ESP32 + MPU-6050, backend FastAPI e banco Oracle XE 21c.
Inclui pipeline completo de Machine Learning — **Random Forest 7 classes, 97.34% CV** — com inferência em tempo real no browser, sem servidor ML dedicado.

---

## Índice

1. [Arquitetura Completa](#1-arquitetura-completa)
2. [Sequência de Boot do ESP32](#2-sequência-de-boot-do-esp32)
3. [Fluxo de Dados Ponta a Ponta](#3-fluxo-de-dados-ponta-a-ponta)
4. [Pipeline de Machine Learning](#4-pipeline-de-machine-learning)
5. [Troca de Rede Wi-Fi — Guia Completo](#5-troca-de-rede-wi-fi--guia-completo)
6. [Banco Oracle](#6-banco-oracle)
7. [Pré-requisitos e Backend](#7-pré-requisitos-e-backend)
8. [API Principal](#8-api-principal)
9. [Firmware ESP32](#9-firmware-esp32)
10. [Notebooks](#10-notebooks)
11. [Estrutura de Diretórios](#11-estrutura-de-diretórios)
12. [Rastreabilidade ML](#12-rastreabilidade-ml)
13. [Smoke Test](#13-smoke-test)

---

## 1. Arquitetura Completa

O sistema tem três camadas: hardware de campo (ESP32), servidor local (FastAPI + Oracle) e interface web com ML no browser.

```
╔══════════════════════════════════════════════════════════════════════╗
║                       HARDWARE (Campo)                              ║
║                                                                      ║
║   ┌──────────────┐   I2C    ┌────────────────────────────────────┐  ║
║   │  MPU-6050    │─────────►│           ESP32                    │  ║
║   │              │          │  MicroPython — main_lite.py        │  ║
║   │  Accel X/Y/Z │          │  • Lê sensor a 20 Hz               │  ║
║   │  Gyro  X/Y/Z │          │  • Envia HTTP POST a cada leitura  │  ║
║   │  Temp        │          │  • Recebe config (mode, rate)      │  ║
║   └──────────────┘          └──────────────────┬───────────────┘  ║
║                                                │  Wi-Fi           ║
╚════════════════════════════════════════════════╪═════════════════════╝
                                                 │ HTTP POST :8000/api/ingest
                                                 │
╔════════════════════════════════════════════════▼═════════════════════╗
║                    SERVIDOR LOCAL (PC)                               ║
║                                                                      ║
║   ┌──────────────────────────────────────────────────────────────┐  ║
║   │                FastAPI  (backend/server.py)                  │  ║
║   │                                                              │  ║
║   │  POST /api/ingest   ──────────────────────────────────────►  │  ║
║   │  GET  /api/get_data ◄──────────────────────────────────────  │  ║
║   │  POST /api/set_mode ──► atualiza mode / sample_rate         │  ║
║   │  GET  /web/*        ──► serve o frontend estático           │  ║
║   └────────────────────────────┬─────────────────────────────────┘  ║
║                                │ SQL (python-oracledb)              ║
║   ┌────────────────────────────▼─────────────────────────────────┐  ║
║   │              Oracle XE 21c  — xepdb1                        │  ║
║   │  tabela: sensor_data  (id, timestamp, ax, ay, az,           │  ║
║   │                         gx, gy, gz, temp, mode,             │  ║
║   │                         sample_rate, collection_id, ...)    │  ║
║   └──────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════════╝
                                 │
                    GET /api/get_data  (browser polling)
                                 │
╔════════════════════════════════▼═════════════════════════════════════╗
║                    INTERFACE WEB (Browser)                           ║
║                                                                      ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────────┐  ║
║   │  index.html     │  │  control.html   │  │  doc-ml.html      │  ║
║   │  Dashboard      │  │  Controle       │  │  Documentação ML  │  ║
║   │  • Gráficos     │  │  • Mode/Rate    │  │                   │  ║
║   │  • Classe ML    │  │  • Wi-Fi        │  └───────────────────┘  ║
║   │  • Confiança    │  │  • DB on/off    │                         ║
║   └────────┬────────┘  └─────────────────┘                         ║
║            │                                                         ║
║   ┌────────▼──────────────────────────────────────────────────────┐ ║
║   │  classifier.js v6.0  (ML 100% no browser, sem servidor ML)  │ ║
║   │  Buffer 100pts ──► 16 features ──► Random Forest ──► Classe │ ║
║   └────────────────────────────────────────────────────────────────┘ ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## 2. Sequência de Boot do ESP32

Ao ligar o ESP32, o firmware executa em duas fases: `boot.py` (conexão de rede) e `main_lite.py` (loop de dados).

```
┌──────────────────────────────────────────────────────────────────┐
│                    [ESP32 LIGADO / REINICIADO]                   │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  boot.py — Fase 1: Conexão Wi-Fi                                │
│                                                                  │
│  Lê:  /device_config.json  (SSID, senha, IPs, token)            │
│  Lê:  /wifi_profiles.json  (perfis alternativos de rede)        │
│                                                                  │
│  Tentativa 1 ── SSID principal (device_config.ssid)            │
│       │ falhou?                                                  │
│       ▼                                                          │
│  Tentativa 2 ── Percorre wifi_profiles.json                     │
│       │ todos falharam?                                          │
│       ▼                                                          │
│  Tentativa 3 ── Abre portal Wi-Fi "Config-ESP32"               │
│                 (aguarda 180s — conecte ao AP e configure)      │
└──────────────────────────────┬───────────────────────────────────┘
                               │ Conectado ao Wi-Fi
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  main_lite.py — Fase 2: Descoberta do Servidor                  │
│                                                                  │
│  Tenta encontrar o IP do backend FastAPI (porta 8000):          │
│                                                                  │
│  Passo 1 ── Lê /last_server_ip.txt (IP aprendido em sessão     │
│             anterior — cache automático do firmware)             │
│  Passo 2 ── Usa server_fallback_ip de device_config.json        │
│  Passo 3 ── Testa cada IP em server_fallback_ips[]             │
│  Passo 4 ── Usa server_ip do perfil Wi-Fi ativo                 │
│                                                                  │
│  ✔ Servidor encontrado → salva IP em /last_server_ip.txt        │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  main_lite.py — Fase 3: Loop Principal (∞)                      │
│                                                                  │
│  A cada 50 ms (20 Hz):                                           │
│  1. Lê MPU-6050 via I2C → ax, ay, az, gx, gy, gz, temp         │
│  2. Monta payload JSON com mode, sample_rate, collection_id     │
│  3. HTTP POST → /api/ingest no servidor                         │
│  4. Recebe resposta → atualiza mode/rate se servidor mandou     │
│                                                                  │
│  Em caso de falha HTTP:                                          │
│  • Back-off exponencial (500ms → 8s)                            │
│  • Fila offline (até 160 amostras) gravada em flash             │
│  • Reenvio automático ao reconectar                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Fluxo de Dados Ponta a Ponta

```
ESP32 (campo)              FastAPI (PC :8000)         Oracle XE
──────────────             ─────────────────          ──────────
      │                           │                        │
      │  POST /api/ingest         │                        │
      │  {                        │                        │
      │    "ax": -0.012,          │                        │
      │    "ay":  0.003,          │   INSERT INTO          │
      │    "az":  1.001,          │   sensor_data          │
      │    "gx": 12.4,   ────────►│   (timestamp,    ─────►│
      │    "gy": -3.1,            │    ax,ay,az,           │
      │    "gz":  0.8,            │    gx,gy,gz,           │
      │    "mode": "LOW",         │    mode,rate,          │
      │    "sample_rate": 20,     │    collection_id)      │
      │    "collection_id":       │                        │
      │      "v5_stream"          │                        │
      │  }                        │                        │
      │                           │                        │
      │◄──────────────────────────│  { "status": "ok",     │
      │  atualiza config local    │    "mode": "LOW",      │
      │                           │    "ingest_enabled":   │
      │                           │      true }            │
      │                           │                        │
                                  │                        │
Browser (polling 200ms)           │                        │
──────────────────────            │                        │
      │                           │                        │
      │  GET /api/get_data        │   SELECT * FROM        │
      │  ?mode=latest    ────────►│   sensor_data    ─────►│
      │                           │   ORDER BY ts DESC     │
      │◄──────────────────────────│   FETCH FIRST 200 ROWS│◄│
      │  [{ ax, ay, az,           │                        │
      │     gx, gy, gz, ... }]    │                        │
      │                           │                        │
      │  classifier.js:           │                        │
      │  1. Acumula 100 pts       │                        │
      │  2. Calcula 16 features   │                        │
      │     (FFT + percentis)     │                        │
      │  3. RF.predict() → Classe │                        │
      │  4. Exibe no dashboard    │                        │
```

---

## 4. Pipeline de Machine Learning

```
╔══════════════════════════════════════════════════════════════════════╗
║  FASE 1 — COLETA DE DADOS ROTULADOS                                 ║
║                                                                      ║
║  Operador usa control.html para definir o rótulo:                   ║
║  LOW / MEDIUM / HIGH × ventilador ON/OFF                            ║
║                                                                      ║
║  ESP32 ──► /api/ingest ──► Oracle XE (campo "mode" = rótulo)       ║
║  Taxa: 20 Hz | Duração: ~5 min por classe | 7 classes              ║
╚══════════════════════════════════════════════════════════════════════╝
                               │
                               ▼
╔══════════════════════════════════════════════════════════════════════╗
║  FASE 2 — FEATURE ENGINEERING  (02_Feature_Engineering.ipynb)       ║
║                                                                      ║
║  Oracle XE ──► DataFrame ──► Janela deslizante                     ║
║                                                                      ║
║  Parâmetros da janela:                                               ║
║  ┌─────────────────────────────────────────────────────────┐        ║
║  │  window_size = 100 amostras  (5 segundos a 20 Hz)       │        ║
║  │  step        =  20 amostras  (1 segundo — 80% overlap)  │        ║
║  │  Total de janelas geradas: 2.255                        │        ║
║  └─────────────────────────────────────────────────────────┘        ║
║                                                                      ║
║  Para cada janela:  8 eixos × 13 métricas = 104 features           ║
║                                                                      ║
║  ┌──────────────┬────────────────────────────────────────────────┐  ║
║  │ Temporais    │  std  ·  range  ·  rms                        │  ║
║  │ Forma        │  skew  ·  kurtosis                            │  ║
║  │ Percentis    │  P10  · P25 · P75 · P90 · P95                │  ║
║  │ FFT (bandas) │  0–5 Hz  ·  5–10 Hz  ·  10–20 Hz             │  ║
║  └──────────────┴────────────────────────────────────────────────┘  ║
║                                                                      ║
║  8 eixos: accel_x/y/z_g · gyro_x/y/z_dps · vibration_dps · accel_mag_g ║
╚══════════════════════════════════════════════════════════════════════╝
                               │
                               ▼
╔══════════════════════════════════════════════════════════════════════╗
║  FASE 3 — SELEÇÃO DE FEATURES  (02_Feature_Engineering.ipynb)       ║
║                                                                      ║
║   104 candidatas                                                     ║
║       │                                                              ║
║       │  Cohen's d ≥ 0.30                                            ║
║       │  (pior separação entre os 21 pares de classes)              ║
║       ▼                                                              ║
║   ~14 features aprovadas                                             ║
║       │                                                              ║
║       │  Filtro de correlação classwise  (r < 0.85)                 ║
║       │  Score composto: d_min_all                                   ║
║       ▼                                                              ║
║   TOP-16 features finais  ──►  config/feature_config.json (v5.16)  ║
║                                                                      ║
║  Ranking das 3 mais importantes (por importância RF):               ║
║  1. vibration_dps_range   14.4%  (amplitude da vibração)            ║
║  2. accel_y_g_fft_low     10.0%  (energia 0–5 Hz eixo Y)           ║
║  3. vibration_dps_p90      9.7%  (P90 da vibração)                 ║
╚══════════════════════════════════════════════════════════════════════╝
                               │
                               ▼
╔══════════════════════════════════════════════════════════════════════╗
║  FASE 4 — TREINAMENTO  (03_Model_Training_Evaluation.ipynb)         ║
║                                                                      ║
║  Entrada: dataset_features_final.csv  (2.255 linhas × 16 features)  ║
║                                                                      ║
║  ┌───────────────────┬─────────────────┬────────────────────────┐   ║
║  │ Modelo            │ Acurácia CV     │ Papel                  │   ║
║  ├───────────────────┼─────────────────┼────────────────────────┤   ║
║  │ Random Forest     │ 97.34% ±0.63%   │ ✔ Primário (deployado) │   ║
║  │ (200 árvores)     │                 │                        │   ║
║  ├───────────────────┼─────────────────┼────────────────────────┤   ║
║  │ Gaussian NB       │ 93.70% ±0.89%   │ Fallback no browser    │   ║
║  ├───────────────────┼─────────────────┼────────────────────────┤   ║
║  │ Logistic Reg.     │ ~93.97%         │ Referência             │   ║
║  └───────────────────┴─────────────────┴────────────────────────┘   ║
║                                                                      ║
║  Export → models/rf_model_20260222.json  (985 KB, arrays planos)   ║
╚══════════════════════════════════════════════════════════════════════╝
                               │
                               ▼
╔══════════════════════════════════════════════════════════════════════╗
║  FASE 5 — INFERÊNCIA NO BROWSER  (web/js/classifier.js v6.0)        ║
║                                                                      ║
║  Buffer circular                                                     ║
║  100 pontos  ──►  FeatureExtractor  ──►  RF.predict()  ──►  Classe  ║
║  (5 segundos)      16 features           200 árvores                ║
║                                                                      ║
║  Funções-chave:                                                      ║
║  • Stats.percentile(arr, p)     → P10…P95 (≡ numpy.percentile)      ║
║  • Stats.fftBandRms(arr, f1,f2) → energia FFT em banda (Hz)         ║
║  • RF._predictTree(tree, feat)  → traversal por arrays planos       ║
║  • Histerese: 3 votos iguais   → evita flickering entre classes     ║
║                                                                      ║
║  Resultado: { classe, confiança, buffer_fill% }  a cada 250ms       ║
╚══════════════════════════════════════════════════════════════════════╝
```

### As 7 Classes do Modelo

| Classe | Significado | Condição física |
|--------|-------------|-----------------|
| `LOW_ROT_ON` | Velocidade baixa — eixo **girando** | Motor em LOW, hélice em rotação |
| `MEDIUM_ROT_ON` | Velocidade média — eixo **girando** | Motor em MEDIUM, hélice em rotação |
| `HIGH_ROT_ON` | Velocidade alta — eixo **girando** | Motor em HIGH, hélice em rotação |
| `LOW_ROT_OFF` | Velocidade baixa — eixo **parado** | Motor em LOW, hélice travada |
| `MEDIUM_ROT_OFF` | Velocidade média — eixo **parado** | Motor em MEDIUM, hélice travada |
| `HIGH_ROT_OFF` | Velocidade alta — eixo **parado** | Motor em HIGH, hélice travada |
| `FAN_OFF` | Ventilador **desligado** | Sem alimentação |

---

## 5. Troca de Rede Wi-Fi — Guia Completo

> **Por que isso importa?** O ESP32 precisa saber o IP do PC para enviar dados via HTTP.
> Esse IP **muda toda vez que você muda de rede** (casa → hotspot do celular → escritório).
> A seguir, o fluxo completo de onde os IPs aparecem e como atualizar.

### 5.1 Onde o IP do Servidor é Armazenado

```
tools/device_config.json
├── "server_fallback_ip": "10.x.x.x:8000"    ← IP principal (1 entrada)
├── "server_fallback_ips": [                  ← lista de fallbacks (tenta em ordem)
│     "192.168.0.108:8000",
│     "192.168.43.100:8000"
│   ]
└── "default_wifi_profiles": [               ← IP por rede (mais preciso)
      { "ssid": "MinhaRedeWifi",
        "password": "...",
        "server_ip": "192.168.0.108:8000" }, ← IP quando conectado a esta rede
      { "ssid": "HotspotCelular",
        "password": "...",
        "server_ip": "10.125.237.85:8000" }  ← IP quando conectado a este hotspot
    ]

/last_server_ip.txt  (arquivo no flash do ESP32)
└── IP aprendido na última sessão bem-sucedida (cache automático)
    Limpo ao trocar de rede — não precisa apagar manualmente.
```

### 5.2 Como o ESP32 Descobre o Servidor (ordem de prioridade)

```
┌─────────────────────────────────────────────────────────────┐
│  ESP32 conectou ao Wi-Fi. Qual IP usar para o servidor?     │
└──────────────────────────────┬──────────────────────────────┘
                               │
               ┌───────────────▼───────────────────┐
               │  1. /last_server_ip.txt existe?    │
               │     (IP da última sessão)          │
               └───────┬───────────────────┬────────┘
                   SIM │                   │ NÃO
                       ▼                   ▼
              Tenta esse IP        ┌────────────────────────┐
                   │               │  2. server_fallback_ip  │
              responde?            │     de device_config    │
              ┌────┴────┐         └───────────┬────────────┘
              │   SIM   │                     │ falhou?
              ▼         ▼                     ▼
           Usa este   Próximo       ┌──────────────────────┐
           IP ✔       passo →      │  3. server_fallback_  │
                                   │     ips[] (lista)     │
                                   └───────────┬───────────┘
                                               │ todos falharam?
                                               ▼
                                   ┌──────────────────────────┐
                                   │  4. default_wifi_profiles│
                                   │     server_ip do SSID    │
                                   │     atual                │
                                   └──────────────────────────┘
```

### 5.3 Passo a Passo: Trocar de Rede

#### Passo 1 — Descobrir o novo IP do PC

Abra o **PowerShell** no Windows:

```powershell
# Mostra todos os IPs IPv4 ativos (ignore Loopback 127.x e VPN)
ipconfig | findstr "IPv4"
```

Exemplo de saída:
```
   Endereço IPv4. . . . . . . .  . . . . . : 10.125.237.85   ← hotspot celular
   Endereço IPv4. . . . . . . .  . . . . . : 192.168.0.108   ← Wi-Fi doméstico
```

> **Regra prática:**
> - Hotspot Android: IP começa com `192.168.43.x` ou `10.x.x.x`
> - Hotspot Samsung: IP começa com `192.168.x.x` ou `10.125.x.x`
> - Wi-Fi doméstico: IP começa com `192.168.0.x` ou `192.168.1.x`

#### Passo 2 — Atualizar `tools/device_config.json`

Edite o arquivo e atualize os campos com o **IP correto + porta 8000**:

```json
{
  "ssid": "NomeDaSuaRede",
  "password": "SenhaDaSuaRede",

  "server_fallback_ip": "10.125.237.85:8000",

  "server_fallback_ips": [
    "10.125.237.85:8000",
    "192.168.0.108:8000"
  ],

  "default_wifi_profiles": [
    {
      "ssid": "HotspotCelular",
      "password": "SenhaHotspot",
      "server_ip": "10.125.237.85:8000"
    },
    {
      "ssid": "WifiDeCasa",
      "password": "SenhaCasa",
      "server_ip": "192.168.0.108:8000"
    }
  ]
}
```

> ⚠️ **Atenção:** inclua sempre a porta `:8000` no IP. Sem ela, o ESP32 tenta a porta 80 padrão e falha silenciosamente.

#### Passo 3 — Fazer Upload para o ESP32 (via Thonny)

```
Thonny IDE:
  1. Conecte o ESP32 via USB
  2. Abra: tools/device_config.json  (no seu PC)
  3. Menu → File → Save as...
  4. Selecione "MicroPython device"
  5. Nome do arquivo: device_config.json  (raiz do ESP32)
  6. Clique Save
  7. Reinicie o ESP32 (botão EN ou RST)
```

#### Passo 4 — Verificar Conexão

Depois que o ESP32 reiniciar, abra o **Dashboard** e veja se os dados estão chegando:

```
http://localhost:8000/web/index.html
```

Se após ~30 segundos não houver dados, veja o console do Thonny para mensagens de erro do firmware.

---

### 5.4 Cenários Comuns e Soluções

```
┌─────────────────────────────────────────────────────────────────┐
│  CENÁRIO 1: Mudei do Wi-Fi de casa para o hotspot do celular    │
└────────────────────────────────┬────────────────────────────────┘
                                 │
  1. Conecte o PC ao hotspot     │
  2. Execute ipconfig            │ → anote o IP (ex: 10.125.237.85)
  3. Edite device_config.json    │ → server_fallback_ip + perfil do hotspot
  4. Upload via Thonny           │
  5. Reinicie o ESP32            │


┌─────────────────────────────────────────────────────────────────┐
│  CENÁRIO 2: Voltei para o Wi-Fi de casa, ESP32 não conecta      │
└────────────────────────────────┬────────────────────────────────┘
                                 │
  O ESP32 pode estar tentando    │
  o IP antigo do hotspot.        │
                                 │
  Solução A: Espere ~30s         │ → firmware tenta fallbacks automaticamente
  Solução B: Reinicie o ESP32    │ → limpa o IP do cache e tenta a lista
  Solução C: Via Thonny, apague  │ → /last_server_ip.txt no ESP32
             o arquivo de cache  │


┌─────────────────────────────────────────────────────────────────┐
│  CENÁRIO 3: Rede nova (nunca usada antes)                       │
└────────────────────────────────┬────────────────────────────────┘
                                 │
  1. Adicione a rede em          │ → wifi_profiles.json (ssid + password)
     tools/wifi_profiles.json    │
  2. Adicione em device_config   │ → default_wifi_profiles[].server_ip
  3. Upload ambos os arquivos    │
  4. Reinicie o ESP32            │


┌─────────────────────────────────────────────────────────────────┐
│  CENÁRIO 4: Sem cabo USB — ESP32 já está em campo               │
└────────────────────────────────┬────────────────────────────────┘
                                 │
  Use o Painel de Controle web:  │
  http://localhost:8000/web/control.html
                                 │
  Seção "Gestão de Rede":        │
  • Edite o perfil Wi-Fi         │
  • Clique "Aplicar no ESP32"    │ → envia config no próximo POST
  • ESP32 reinicia e reconecta   │


┌─────────────────────────────────────────────────────────────────┐
│  CENÁRIO 5: Troco de rede frequentemente (hotspot ↔ Wi-Fi casa) │
└────────────────────────────────┬────────────────────────────────┘
                                 │
  PROBLEMA: server_fallback_ip   │ → fixo para UMA rede. Na outra
  é o IP de uma rede específica. │   rede o ESP32 tenta o IP errado
                                 │   e falha até reiniciar.
                                 │
  SOLUÇÃO PERMANENTE: use mDNS   │ → veja seção 5.6 abaixo
  (meu-notebook.local)           │   funciona em QUALQUER rede
```

### 5.5 Referência Rápida de IPs por Rede

| Rede | Intervalo típico de IP | Adaptador (ipconfig) |
|------|------------------------|----------------------|
| Wi-Fi doméstico | `192.168.0.x` / `192.168.1.x` | Wi-Fi |
| Hotspot Android padrão | `192.168.43.x` | Ethernet (adaptador virtual) |
| Hotspot Samsung | `10.125.x.x` ou `192.168.x.x` | Wi-Fi |
| Hotspot iPhone | `172.20.10.x` | Wi-Fi |
| Rede corporativa | varia — pergunte ao TI | Ethernet ou Wi-Fi |

> **Atenção:** `server_fallback_ip` só funciona em UMA rede por vez.
> Se você troca de rede com frequência, use a solução mDNS (seção 5.6).

---

### 5.6 Solução Permanente: mDNS com `meu-notebook.local`

> **Quando usar:** você usa o ESP32 em mais de uma rede (ex: hotspot do celular em campo + Wi-Fi de casa).
> Com mDNS, o ESP32 descobre o IP do PC automaticamente em **qualquer rede**, sem precisar de USB.

#### Pré-requisito

- **Bonjour** instalado no Windows (necessário para o PC anunciar `meu-notebook.local` via mDNS).
  Download: https://support.apple.com/downloads/bonjour-for-windows
- Reinicie o PC após instalar.

#### Verificação (PowerShell)

```powershell
ping meu-notebook.local
```
Se resolver → mDNS está funcionando. Se não resolver → verifique se o Bonjour está ativo nos serviços do Windows.

#### Configuração — uma única vez via Thonny (USB)

Edite `tools/device_config.json` no PC, zerando os campos de IP fixo e mantendo apenas o hostname:

```json
{
  "server_hostname":    "meu-notebook.local:8000",
  "server_fallback_ip": "",
  "server_fallback_ips": []
}
```

Faça upload via Thonny (igual ao passo de troca de IP):
```
File → Open → device_config.json (PC)
File → Save As → MicroPython device → device_config.json
Reinicie o ESP32 (EN/RST)
```

O firmware agora resolve `meu-notebook.local` via DNS/mDNS em cada conexão.
Funciona em hotspot Samsung, Wi-Fi doméstico e qualquer outra rede — **sem precisar de USB novamente**.

#### Limitação

Se o roteador/hotspot bloquear pacotes multicast mDNS (raro), o ESP32 não conseguirá resolver o hostname.
Sintoma: `[HTTP] fail` repetido no console até reboot. Solução: volte ao IP fixo para aquela rede específica.

#### IP fixo como reserva no Samsung S20 (complementar ao mDNS)

No celular:
```
Configurações → Conexões → Roteador Wi-Fi Móvel
→ Dispositivos conectados → selecione o PC
→ Ativar "Sempre atribuir mesmo endereço IP"
```
Isso garante que o PC sempre recebe o mesmo IP no hotspot — útil como plano B caso mDNS falhe.

---

## 6. Banco Oracle

Parâmetros validados:

| Parâmetro | Valor |
|-----------|-------|
| Host | `localhost` |
| Porta | `1521` |
| Service Name | `xepdb1` |
| Usuário padrão | `student` |
| Senha padrão | `oracle` |

Serviços Windows necessários (ambos `Running`):
- `OracleServiceXE`
- `OracleOraDB21Home1TNSListener`

> **Criar usuário em nova instalação** (sqlplus como SYSDBA):
> ```sql
> ALTER SESSION SET CONTAINER = XEPDB1;
> CREATE USER student IDENTIFIED BY oracle;
> GRANT CONNECT, RESOURCE, UNLIMITED TABLESPACE TO student;
> ```

> **Se aparecer `ORA-12638`**, ajuste em:
> `C:\app\<usuario>\product\21c\homes\OraDB21Home1\network\admin\sqlnet.ora`
> ```ini
> SQLNET.AUTHENTICATION_SERVICES= (NONE)
> NAMES.DIRECTORY_PATH= (TNSNAMES, EZCONNECT)
> ```

---

## 7. Pré-requisitos e Backend

**Pré-requisitos:**
1. Python 3.11 (recomendado; 3.14 pode falhar para dependências atuais)
2. Oracle XE 21c ativo com usuário criado
3. `py -3.11 -m pip install -r backend/requirements.txt`

**Subir o backend** (PowerShell, na pasta do projeto):

```powershell
$env:ORACLE_HOST='localhost'; $env:ORACLE_PORT='1521'; $env:ORACLE_SERVICE_NAME='xepdb1'
$env:ORACLE_USER='student'; $env:ORACLE_PASSWORD='oracle'

py -3.11 -m uvicorn backend.server:app --host 0.0.0.0 --port 8000 --no-access-log
```

**URLs após subir:**

| URL | Descrição |
|-----|-----------|
| `http://localhost:8000/health` | Health check |
| `http://localhost:8000/web/index.html` | Dashboard |
| `http://localhost:8000/web/control.html` | Painel de Controle |
| `http://localhost:8000/web/documentacao.html` | Documentação operacional |
| `http://localhost:8000/web/doc-ml.html` | Documentação do pipeline ML |

---

## 8. API Principal

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/api/ingest` | POST | Recebe dados do ESP32 |
| `/api/get_data?mode=latest` | GET | Últimas leituras |
| `/api/set_mode` | GET \| POST | Modo, taxa e sessão |
| `/api/reset_db` | POST | Limpa tabela Oracle |
| `/api/log_transition` | GET \| POST | Logs de testes de transição |
| `/api/save_adapted_model` | POST | Salva modelo adaptado online |

```
Authorization: Bearer F0xb@m986960440
```

---

## 9. Firmware ESP32

Arquivos em `tools/` — upload via **Thonny** para o ESP32:

| Arquivo local | Destino no ESP32 | Descrição |
|---------------|-----------------|-----------|
| `tools/boot.py` | `/boot.py` | Conexão Wi-Fi e fallback de rede |
| `tools/main_lite.py` | `/main_lite.py` | Loop principal de leitura e envio HTTP |
| `tools/mpu6050.py` | `/mpu6050.py` | Driver I2C para MPU-6050 |
| `tools/device_config.json` | `/device_config.json` | Config de rede, IPs, token, taxa |
| `tools/wifi_profiles.json` | `/wifi_profiles.json` | Perfis Wi-Fi (ssid + password) |

> **`main_lite.py` é obrigatório** — `main.py` causa `MemoryError` no ESP32.
>
> **`force_main_lite: true`** em `device_config.json` garante que o `boot.py` chame sempre `main_lite`.

---

## 10. Notebooks

| Notebook | Função |
|----------|--------|
| `00_Monitor.ipynb` | Monitor Oracle em tempo real (auto-refresh, filtro por coleção) |
| `01_EDA.ipynb` | Análise exploratória: boxplots, Kruskal-Wallis, distribuição de classes |
| `02_Feature_Engineering.ipynb` | Janela deslizante, 104 features, Cohen's d, seleção TOP-16 |
| `03_Model_Training_Evaluation.ipynb` | Treino GNB/LogReg/RF, validação cruzada, export JSON |
| `03_Transition_Asymmetry_Analysis.ipynb` | Análise de assimetria em transições de classe |
| `04_Spectral_Feature_Analysis.ipynb` | Análise espectral e bandas de frequência por classe |
| `05_Robust_Ensemble_Model.ipynb` | Experimento com Soft Voting ensemble (referência) |

> Credenciais para notebooks: usar usuário `dersao` (admin local) para evitar `ORA-00942` em acessos cross-schema.

---

## 11. Estrutura de Diretórios

```
oracle_iot_esp32_MPU6050_project/
│
├── backend/              # FastAPI server + requirements
│   ├── server.py         # Endpoints /api/* e /web/*
│   └── requirements.txt  # Dependências Python
│
├── config/               # Configurações geradas pelo pipeline ML
│   ├── feature_config.json     # 16 features selecionadas, critérios, hashes
│   ├── eda_baselines_per_class.json
│   └── device_mode.json
│
├── database/             # Scripts Oracle (DDL, reset, bootstrap)
│
├── docs/                 # Guias operacionais e de migração
│
├── logs/
│   └── ml_transitions.json     # Log ativo de transições de classe (testes)
│
├── models/               # Modelos exportados (JSON)
│   ├── rf_model_20260222.json  # Random Forest primário (97.34% CV, 985 KB)
│   ├── gnb_model_20260222.json # GNB fallback (93.70% CV)
│   ├── MODEL_REGISTRY.json     # Histórico de todos os modelos
│   ├── MODEL_INDEX.json        # Índice por taxa de amostragem
│   └── adapted/                # Snapshots de Bayesian Online Learning
│
├── notebooks/            # Jupyter — análise, feature eng., treinamento
│   ├── shared/           # Módulos Python reutilizáveis entre notebooks
│   ├── output/
│   │   ├── data/         # CSVs de features extraídas
│   │   ├── figures/      # Gráficos gerados pelos notebooks
│   │   ├── metrics/      # pipeline_registry.json, model_data_config.json
│   │   └── models/       # Cópias dos modelos gerados nos notebooks
│   └── dataset_features_final.csv  # Dataset final usado no treinamento
│
├── tools/                # Firmware ESP32 (MicroPython) + utilitários
│   ├── boot.py           # Boot: Wi-Fi + descoberta de servidor
│   ├── main_lite.py      # Loop principal (use este, não main.py)
│   ├── mpu6050.py        # Driver I2C MPU-6050
│   ├── device_config.example.json  # Template de configuração
│   └── wifi_profiles.example.json  # Template de perfis Wi-Fi
│
└── web/                  # Frontend servido pelo FastAPI
    ├── index.html        # Dashboard principal
    ├── control.html      # Painel de controle e Wi-Fi
    ├── documentacao.html # Documentação operacional
    ├── doc-ml.html       # Documentação do pipeline ML
    ├── css/style.css
    └── js/
        ├── classifier.js # ML inference (RF + GNB + LogReg) no browser
        └── dashboard.js  # Lógica do dashboard e gráficos
```

---

## 12. Rastreabilidade ML

| Arquivo | Conteúdo |
|---------|----------|
| `config/feature_config.json` | Features selecionadas, hashes SHA-256 do CSV, critérios de seleção |
| `notebooks/output/metrics/pipeline_registry.json` | Histórico de runs de FE + treino com hashes |
| `models/MODEL_REGISTRY.json` | Histórico de modelos exportados (versão, acurácia, status) |

---

## 13. Smoke Test

```powershell
# 1. Verificar Oracle
powershell -ExecutionPolicy Bypass -File tools/smoke_oracle_sqlplus.ps1

# 2. Verificar backend
Invoke-RestMethod http://localhost:8000/health

# 3. Limpar banco (opcional)
Invoke-RestMethod -Method Post `
  -Uri http://localhost:8000/api/reset_db `
  -Headers @{ Authorization = 'Bearer F0xb@m986960440' }

# 4. Últimas leituras
Invoke-RestMethod "http://localhost:8000/api/get_data?mode=latest"

# 5. Verificar IP do PC (para configurar o ESP32)
ipconfig | findstr "IPv4"
```
