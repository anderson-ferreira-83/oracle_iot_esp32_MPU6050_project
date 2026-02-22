# Setup Oracle XE + VSCode (runtime FastAPI)

Este guia configura o projeto para rodar com backend Python + Oracle XE.

## 1. Oracle XE 21c

Com base no seu ambiente:

1. Host: `localhost`
2. Porta: `1521`
3. Service Name: `xepdb1`
4. EM Express: `https://localhost:5500/em`

Usuario de app recomendado (ja criado por voce):

1. User: `student`
2. Password: `oracle`

## 2. Variaveis de ambiente

Use no shell antes de iniciar o backend:

1. `ORACLE_HOST=localhost`
2. `ORACLE_PORT=1521`
3. `ORACLE_SERVICE_NAME=xepdb1`
4. `ORACLE_USER=student`
5. `ORACLE_PASSWORD=oracle`

## 3. Dependencias Python

Instalar:

```powershell
python -m pip install -r backend/requirements.txt
```

## 4. Subir backend (FastAPI)

```powershell
python backend/run_server.py
```

API sobe em `http://localhost:8000`.

## 5. Testes de conectividade

1. Health check:
```powershell
Invoke-RestMethod http://localhost:8000/health
```

2. Teste Oracle Python:
```powershell
python tools/test_oracle_python_connection.py
```

## 6. Endpoints principais

1. `POST /api/ingest`
2. `GET /api/get_data?mode=latest`
3. `GET|POST /api/set_mode`
4. `POST /api/reset_db`
5. `GET|POST /api/log_transition`
6. `POST /api/save_adapted_model`

## 7. Frontend Web

A pagina principal fica em:

1. `http://localhost:8000/web/index.html`
2. `http://localhost:8000/web/control.html`

Nao e necessario stack legado para o runtime.

