# Remocao do model_reference (AWS)

## Visao geral
Este documento registra as mudancas que substituem o legado do `model_reference/`.
A partir destas alteracoes, o projeto passa a ter pipeline proprio, com
rastreamento de taxa de amostragem ate o modelo final, sem FFT.

## Modificacoes implementadas
- **ESP32**: passou a enviar features agregadas (std/range/rms) para `accel_x_g` e `gyro_y_dps` com janela fixa de 100 amostras, mantendo a taxa variavel intacta.
- **Banco de dados**: novas colunas para features agregadas e `feature_window_samples`.
- **API ingest**: passa a salvar as features agregadas quando presentes.
- **Frontend (ML)**: FFT removido por completo; extracao calcula apenas as features temporais exigidas pelo modelo.
- **Selecao de modelo por taxa**: suporte a `models/MODEL_INDEX.json`, com fallback para o modelo padrao.
- **Treinamento multi-taxa**: script `tools/train_model_from_db.py` gera um modelo por taxa (4/10/20 Hz, etc.) e registra rastreabilidade.
- **Validacao de rastreabilidade**: alerta no dashboard quando `collection_id` nao combina com `sample_rate`; `set_mode` gera `collection_id` automatico ao mudar a taxa.

## Arquivos principais alterados
- `tools/main.py` (features agregadas no ESP32)
- `database/database_setup.sql`
- `database/reset_database.sql`
- `api/ingest`
- `web/js/classifier.js`
- `web/js/dashboard.js`
- `tools/train_model_from_db.py`
- `models/MODEL_INDEX.json`

## Rastreabilidade (taxa -> features -> modelo)
- Cada amostra grava `sample_rate` no banco (`sensor_data.sample_rate`).
- O treino separa dados por taxa, gera CSVs por taxa e calcula hash SHA-256.
- Cada modelo exportado inclui:
  - `sample_rate_hz`
  - `training_info.collection_ids`
  - `traceability.features_csv` e `traceability.features_csv_hash`
- O mapeamento taxa -> modelo fica em `models/MODEL_INDEX.json`.

## Como treinar modelos multi-taxa
1. Instale dependencias:
   - `pip install pandas sqlalchemy mysql-connector-python scikit-learn`
2. Execute:
   - `python tools/train_model_from_db.py`
3. O script gera:
   - Modelos por taxa em `models/`
   - CSVs de features em `artifacts/features_by_rate/`
   - Atualiza `models/MODEL_INDEX.json` e `models/MODEL_REGISTRY.json`

## Remocao do model_reference
Depois de validar as mudancas acima em producao/local, o diretorio
`model_reference/` pode ser removido sem impacto no pipeline atual.

Recomendacao:
- Remover apenas apos confirmar que o novo modelo por taxa esta carregando no dashboard.
- Fazer backup do `model_reference/` antes da exclusao definitiva.
