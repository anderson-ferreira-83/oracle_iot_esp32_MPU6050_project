# oracle_iot_esp32_MPU6050_project

Projeto IoT para aquisição de vibração com ESP32 + MPU6050, backend FastAPI e banco Oracle XE 21c.
Inclui pipeline completo de Machine Learning (Random Forest 7 classes, 97.34% CV) com inferência em tempo real no browser.

## Arquitetura

```
ESP32/MPU6050 → HTTP POST → FastAPI (/api/*) → Oracle XE (sensor_data) → Web UI + ML (browser)
```

Componentes:

1. Firmware ESP32 em `tools/` (MicroPython) com envio HTTP e controle remoto.
2. Backend Python em `backend/server.py` (FastAPI + python-oracledb).
3. Frontend em `web/` servido pelo próprio backend (dashboard, controle, documentação).
4. Pipeline ML em `notebooks/` (Feature Engineering → Random Forest → JSON export).

## Banco Oracle

Parâmetros validados:

| Parâmetro    | Valor                   |
|--------------|-------------------------|
| Host         | `localhost`             |
| Porta        | `1521`                  |
| Service Name | `xepdb1`                |
| Usuário      | `student`               |
| Senha        | `oracle`                |

> Para criar o usuário em nova instalação Oracle XE 21c (via sqlplus como SYSDBA):
> ```sql
> ALTER SESSION SET CONTAINER = XEPDB1;
> CREATE USER student IDENTIFIED BY oracle;
> GRANT CONNECT, RESOURCE, UNLIMITED TABLESPACE TO student;
> ```

Se aparecer `ORA-12638`, ajuste em:

`C:\app\<usuario>\product\21c\homes\OraDB21Home1\network\admin\sqlnet.ora`

```ini
SQLNET.AUTHENTICATION_SERVICES= (NONE)
NAMES.DIRECTORY_PATH= (TNSNAMES, EZCONNECT)
```

Serviços Windows necessários: `OracleServiceXE` + `OracleOraDB21Home1TNSListener` (ambos Running).

## Pré-requisitos

1. Python 3.11 (recomendado; 3.14 pode falhar para dependências atuais).
2. Oracle XE 21c ativo.
3. `py -3.11 -m pip install -r backend/requirements.txt`

## Subir o Backend

```powershell
# PowerShell — definir variáveis e subir servidor
$env:ORACLE_HOST='localhost'; $env:ORACLE_PORT='1521'; $env:ORACLE_SERVICE_NAME='xepdb1'
$env:ORACLE_USER='student'; $env:ORACLE_PASSWORD='oracle'

py -3.11 -m uvicorn backend.server:app --host 0.0.0.0 --port 8000 --no-access-log
```

URLs principais após subir:

| URL | Descrição |
|-----|-----------|
| `http://localhost:8000/health` | Health check |
| `http://localhost:8000/web/index.html` | Dashboard |
| `http://localhost:8000/web/control.html` | Painel de Controle |
| `http://localhost:8000/web/documentacao.html` | Documentação operacional |
| `http://localhost:8000/web/doc-ml.html` | Documentação do pipeline ML |

## API Principal

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/api/ingest` | POST | Recebe dados do ESP32 |
| `/api/get_data?mode=latest` | GET | Últimas leituras |
| `/api/set_mode` | GET \| POST | Modo, taxa e sessão |
| `/api/reset_db` | POST | Limpa tabela Oracle |
| `/api/log_transition` | GET \| POST | Logs de testes de transição |
| `/api/save_adapted_model` | POST | Salva modelo adaptado online |

Token padrão para endpoints protegidos:

```
Authorization: Bearer F0xb@m986960440
```

## Classificação ML — 7 Classes

O modelo classifica o estado real do ventilador combinando **velocidade** e **estado do eixo**:

| Classe | Descrição |
|--------|-----------|
| `LOW_ROT_ON` | Velocidade baixa — eixo girando |
| `MEDIUM_ROT_ON` | Velocidade média — eixo girando |
| `HIGH_ROT_ON` | Velocidade alta — eixo girando |
| `LOW_ROT_OFF` | Velocidade baixa — eixo parado |
| `MEDIUM_ROT_OFF` | Velocidade média — eixo parado |
| `HIGH_ROT_OFF` | Velocidade alta — eixo parado |
| `FAN_OFF` | Ventilador desligado |

Modelos exportados (em `models/`):

| Arquivo | Tipo | Acurácia CV |
|---------|------|-------------|
| `rf_model_20260222.json` | Random Forest (200 árvores) | **97.34%** |
| `gnb_model_20260222.json` | Gaussian Naive Bayes | 93.70% (fallback) |

Inferência rodando no browser via `web/js/classifier.js` — sem servidor ML dedicado.

## Feature Engineering

Pipeline: `Oracle XE → Janela Deslizante → 104 Features → Cohen's d → TOP-16 → RF`

- **8 eixos:** `accel_x/y/z_g`, `gyro_x/y/z_dps`, `vibration_dps` (magnitude giroscópio), `accel_mag_g`
- **13 métricas/eixo:** std, range, rms, skew, kurtosis, P10/P25/P75/P90/P95, fft\_low (0–5 Hz), fft\_mid (5–10 Hz), fft\_high
- **Janela:** 100 amostras (5 s a 20 Hz), passo de 20 amostras (1 s) → 2.255 janelas de treino
- **Seleção:** Cohen's d ≥ 0.30 (d\_min\_all entre os 21 pares) + filtro de correlação (r < 0.85) + TOP-K=16

Configuração completa em `config/feature_config.json` (versão 5.16).

## Notebooks

| Notebook | Função |
|----------|--------|
| `00_Monitor.ipynb` | Monitor Oracle em tempo real (auto-refresh, filtro por coleção) |
| `01_EDA.ipynb` | Análise exploratória: boxplots, Kruskal-Wallis, distribuição de classes |
| `02_Feature_Engineering.ipynb` | Janela deslizante, 104 features, Cohen's d, seleção TOP-16 |
| `03_Model_Training_Evaluation.ipynb` | Treino GNB/LogReg/RF, validação cruzada, export JSON |
| `03_Transition_Asymmetry_Analysis.ipynb` | Análise de assimetria em transições de classe |
| `04_Spectral_Feature_Analysis.ipynb` | Análise espectral e bandas de frequência por classe |
| `05_Robust_Ensemble_Model.ipynb` | Experimento com Soft Voting ensemble (referência) |

## Firmware ESP32

Arquivos em `tools/` (upload via Thonny para o ESP32):

| Arquivo local | Destino no ESP32 | Descrição |
|---------------|-----------------|-----------|
| `tools/boot.py` | `boot.py` | Conexão Wi-Fi e fallback de rede |
| `tools/main_lite.py` | `main_lite.py` | Loop principal de leitura e envio HTTP |
| `tools/mpu6050.py` | `mpu6050.py` | Driver I2C para MPU-6050 |
| `tools/device_config.json` | `device_config.json` | Configuração de rede e servidor |
| `tools/wifi_profiles.json` | `wifi_profiles.json` | Perfis Wi-Fi (hotspot/doméstica) |

> `main_lite.py` é obrigatório — `main.py` causa `MemoryError` no ESP32.
>
> `device_config.json` deve conter o IP do PC com porta: `"server_fallback_ip": "10.x.x.x:8000"`.

## Estrutura de Diretórios

```
├── backend/         # FastAPI server, requirements
├── config/          # feature_config.json, device_mode.json, eda_baselines
├── database/        # Scripts Oracle (DDL, procedures)
├── docs/            # Documentação adicional
├── logs/            # ml_transitions.json (log ativo de transições)
├── models/          # Modelos exportados JSON + MODEL_REGISTRY.json
│   └── adapted/     # Snapshots de Bayesian Online Learning
├── notebooks/       # Jupyter notebooks de análise e treino
│   ├── output/      # Figuras, CSVs e métricas gerados pelos notebooks
│   └── shared/      # Módulos Python compartilhados entre notebooks
├── tools/           # Firmware ESP32 (MicroPython) e scripts utilitários
└── web/             # Frontend: dashboard, controle, documentação
    ├── css/         # Folhas de estilo
    └── js/          # classifier.js, dashboard.js
```

## Rastreabilidade ML

| Arquivo | Conteúdo |
|---------|----------|
| `config/feature_config.json` | Features selecionadas, hashes SHA-256, critérios de seleção |
| `models/pipeline_registry.json` | Histórico de runs de FE + treino com hashes |
| `models/MODEL_REGISTRY.json` | Histórico de modelos exportados (versão, acurácia, status) |

## Smoke Test

```powershell
# Verificar Oracle
powershell -ExecutionPolicy Bypass -File tools/smoke_oracle_sqlplus.ps1

# Verificar backend
Invoke-RestMethod http://localhost:8000/health

# Limpar banco
Invoke-RestMethod -Method Post `
  -Uri http://localhost:8000/api/reset_db `
  -Headers @{ Authorization = 'Bearer F0xb@m986960440' }

# Últimas leituras
Invoke-RestMethod "http://localhost:8000/api/get_data?mode=latest"
```
