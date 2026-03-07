#!/usr/bin/env bash
# =============================================================================
# 06_update_env.sh
# Gera/atualiza o .env.oracle do projeto para apontar ao ADB na nuvem.
# Deve ser executado em CADA MAQUINA que vai usar o banco cloud.
#
# Prerequisitos:
#   - tools/cloud/adb_info.env  existente (gerado pelo 03_create_adb.sh)
#   - tools/cloud/wallet/       existente (extraido pelo 03_create_adb.sh)
#
# Em maquinas secundarias: copie a pasta tools/cloud/ inteira para la
# (ou rode 03_create_adb.sh novamente — o ADB ja existe, so baixa o wallet).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ADB_INFO="$SCRIPT_DIR/adb_info.env"
ENV_FILE="$PROJECT_ROOT/.env.oracle"

if [ ! -f "$ADB_INFO" ]; then
    echo "ERRO: $ADB_INFO nao encontrado. Execute 03_create_adb.sh primeiro."
    exit 1
fi

source "$ADB_INFO"

if [ -z "${ORACLE_PASSWORD:-}" ]; then
    read -rsp "Senha do ADMIN do ADB: " ORACLE_PASSWORD
    echo ""
fi

echo "=== Atualizando $ENV_FILE ==="

# Faz backup do .env atual se existir
if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak_$(date +%Y%m%d_%H%M%S)"
    echo "Backup: ${ENV_FILE}.bak_*"
fi

cat > "$ENV_FILE" <<EOF
# Banco Oracle Cloud (ADB Always Free)
# Gerado por tools/cloud/06_update_env.sh em $(date '+%Y-%m-%d %H:%M:%S')
#
# Para voltar ao Oracle XE local, restaure o .env.oracle.bak_*

ORACLE_USER=$ORACLE_USER
ORACLE_PASSWORD=$ORACLE_PASSWORD
ORACLE_DSN=$ADB_SERVICE_NAME

# Wallet mTLS - necessario para conexao ao ADB
ORACLE_WALLET_DIR=$WALLET_DIR

# DB_CONNECTION_STR via SQLAlchemy (para notebooks/tools que usam)
DB_CONNECTION_STR=oracle+oracledb://$ORACLE_USER:$ORACLE_PASSWORD@$ADB_SERVICE_NAME
EOF

chmod 600 "$ENV_FILE"

echo ""
echo "=== .env.oracle atualizado ==="
cat "$ENV_FILE"
echo ""
echo "Teste de conexao:"
python3 - <<PYEOF
import oracledb, os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv("$ENV_FILE")

wallet = "$WALLET_DIR"
dsn    = "$ADB_SERVICE_NAME"
user   = "$ORACLE_USER"
pwd    = "$ORACLE_PASSWORD"

try:
    conn = oracledb.connect(user=user, password=pwd, dsn=dsn,
                            config_dir=wallet, wallet_location=wallet)
    cur  = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM sensor_training_data")
    n = cur.fetchone()[0]
    cur.close(); conn.close()
    print(f"OK — sensor_training_data: {n} linhas")
except Exception as e:
    print(f"ERRO: {e}")
PYEOF

echo ""
echo "Reinicie o backend (start.ps1) para usar o ADB cloud."
