# Oracle Full Migration - Fases de Entrega

Status atual: runtime web migrado para backend Python (FastAPI) com Oracle XE.

## Fase 1 - Remocao de stack legado

Concluido:

1. Novo backend em `backend/server.py`.
2. Endpoints REST nativos (`/api/ingest`, `/api/get_data`, `/api/set_mode`, `/api/reset_db`).
3. Firmware e painel atualizados para endpoints REST nativos.

## Fase 2 - Runtime Oracle-only

Concluido:

1. Conexao Oracle via `python-oracledb`.
2. Endpoints de ingestao/consulta/reset apontando para `sensor_data` no Oracle.
3. `docker-compose.yml` sem servico legado.

## Fase 3 - Dados legado

Concluido:

1. `tools/migrate_mysql_to_oracle.py` para migracao historica em lotes.
2. Mapeamento `timestamp` -> `ts_epoch`.

## Fase 4 - Treino e dados para notebooks

Concluido:

1. `tools/train_model_from_db.py` Oracle-first.
2. `tools/export_oracle_sensor_data.py` para Oracle -> CSV.
3. `notebooks/shared/data_sources.py` com loader Oracle.

## Fase 5 - Operacao local

Concluido:

1. `backend/requirements.txt`
2. `backend/run_server.py`
3. Guia atualizado: `docs/ORACLE_XE_SETUP_VSCODE.md`

## Fase 6 - Validacao

Validado localmente:

1. Parse sintatico Python do backend e scripts.
2. Porta Oracle ativa em `localhost:1521`.

Pendente no ambiente:

1. Instalar dependencias Python (`fastapi`, `uvicorn`, `oracledb`).
2. Rodar smoke tests com backend iniciado.

