# Oracle Cloud ADB — Setup via CLI

Migra o projeto de dois Oracle XE locais para um **Autonomous Database Always Free**
centralizado, compartilhado pelas duas maquinas.

## Arquitetura resultante

```
[Maquina A]  FastAPI + bridge ──┐
                                 ├──► ADB Oracle Cloud (Always Free)
[Maquina B]  FastAPI + bridge ──┘         SENSOR_TRAINING_DATA
                                           SENSOR_MONITORING_DATA
                                           SENSOR_DATA
```

## Pre-requisitos

- Conta Oracle Cloud com Free Tier ativo
- Python 3.10+ com `oracledb` instalado (`pip install oracledb`)
- WSL2 ou Linux (scripts `.sh`) ou Git Bash no Windows
- Os seguintes dados do Console Oracle Cloud:
  - **Tenancy OCID** — Menu → Perfil → Tenancy
  - **User OCID** — Menu → Perfil → Meu perfil
  - **Regiao** — ex: `sa-saopaulo-1`

---

## Execucao (uma unica vez, em qualquer maquina)

```bash
cd tools/cloud
chmod +x *.sh

# Passo 1: instala OCI CLI
bash 01_install_oci_cli.sh

# Reabra o terminal, depois:

# Passo 2: configura credenciais OCI (gera chave RSA + ~/.oci/config)
bash 02_configure_oci.sh
# → cole a chave publica no Console Oracle Cloud conforme instrucoes

# Passo 3: cria o ADB e baixa o Wallet
bash 03_create_adb.sh

# Passo 4: aplica o schema no ADB
export ORACLE_PASSWORD='sua_senha_admin'
bash 04_apply_schema.sh

# Passo 5: migra dados locais para o ADB (opcional)
export LOCAL_PASSWORD='oracle'        # senha do Oracle XE local
bash -c 'python3 05_migrate_data.py'

# Passo 6: atualiza .env.oracle para usar o ADB
bash 06_update_env.sh

# Passo 7: keepalive automatico (evita pausa do Free Tier)
bash 07_keepalive_cron.sh
```

---

## Configurar a segunda maquina

Nao e necessario recriar o ADB. Apenas:

1. Copie a pasta `tools/cloud/` para a segunda maquina (inclui `wallet/` e `adb_info.env`)
2. Execute somente o passo 6:
   ```bash
   export ORACLE_PASSWORD='sua_senha_admin'
   bash 06_update_env.sh
   ```
3. Reinicie o backend.

Alternativa sem copiar arquivos: rode o passo 3 na segunda maquina tambem —
o script detecta o ADB existente e apenas baixa o Wallet novamente.

---

## Arquivos gerados

| Arquivo | Descricao |
|---|---|
| `adb_info.env` | OCID, service name, wallet path |
| `wallet/` | Certificados mTLS para conexao ao ADB |
| `keepalive_adb.py` | Script de keepalive (gerado pelo passo 7) |
| `keepalive.log` | Log do keepalive |

> `adb_info.env` nao contem senhas. As senhas ficam apenas no `.env.oracle`
> (modo 600, ignorado pelo git).

---

## Limites Free Tier relevantes

| Recurso | Limite |
|---|---|
| Instancias ADB | 2 |
| OCPU | 1 por instancia |
| Storage | 20 GB por instancia |
| Pausa automatica | Apos 7 dias sem conexao |
| Custo | R$ 0,00 permanente |

Para desativar a pausa automatica via Console:
`ADB → Detalhes → Mais acoes → Gerenciar pausa automatica → Desativar`

---

## Reverter para Oracle XE local

```bash
cp .env.oracle.bak_YYYYMMDD_HHMMSS .env.oracle
# reinicie o backend
```
