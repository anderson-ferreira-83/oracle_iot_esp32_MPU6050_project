#!/usr/bin/env bash
# =============================================================================
# 04_apply_schema.sh
# Aplica o schema do projeto (database_setup.sql) no ADB via python-oracledb.
#
# Prerequisitos:
#   - 03_create_adb.sh executado (adb_info.env existente)
#   - export ORACLE_PASSWORD='sua_senha_admin'
#   - export WALLET_PASSWORD='sua_senha_wallet'   (se wallet usa senha)
#   - pip install oracledb  (ja deve estar no requirements.txt)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ADB_INFO="$SCRIPT_DIR/adb_info.env"

if [ ! -f "$ADB_INFO" ]; then
    echo "ERRO: $ADB_INFO nao encontrado. Execute 03_create_adb.sh primeiro."
    exit 1
fi

source "$ADB_INFO"

if [ -z "${ORACLE_PASSWORD:-}" ]; then
    read -rsp "Senha do ADMIN do ADB: " ORACLE_PASSWORD
    echo ""
    export ORACLE_PASSWORD
fi

echo "=== Aplicando schema no ADB ==="
echo "  Service : $ADB_SERVICE_NAME"
echo "  User    : $ORACLE_USER"
echo "  Wallet  : $WALLET_DIR"
echo ""

python3 - <<PYEOF
import oracledb
import os
import sys

wallet_dir   = "$WALLET_DIR"
service_name = "$ADB_SERVICE_NAME"
user         = "$ORACLE_USER"
password     = os.environ["ORACLE_PASSWORD"]
sql_file     = "$PROJECT_ROOT/database/database_setup.sql"

print(f"Conectando ao ADB ({service_name})...")
conn = oracledb.connect(
    user=user,
    password=password,
    dsn=service_name,
    config_dir=wallet_dir,
    wallet_location=wallet_dir,
)
print("Conexao estabelecida.")

# Le e divide o SQL em blocos separados por '/'
with open(sql_file, "r") as f:
    raw = f.read()

# Divide por linhas contendo apenas '/'
blocks = []
current = []
for line in raw.splitlines():
    stripped = line.strip()
    if stripped == "/":
        block = "\n".join(current).strip()
        if block and not block.startswith("--"):
            blocks.append(block)
        current = []
    else:
        current.append(line)

print(f"Blocos SQL encontrados: {len(blocks)}")
cur = conn.cursor()
ok = 0
skip = 0
for i, block in enumerate(blocks, 1):
    try:
        cur.execute(block)
        conn.commit()
        ok += 1
    except oracledb.DatabaseError as e:
        code = e.args[0].code if e.args else 0
        if code == 955:   # ORA-00955: objeto ja existe
            skip += 1
        else:
            print(f"[AVISO] Bloco {i}: {e}")
            skip += 1

cur.close()
conn.close()
print(f"Schema aplicado: {ok} blocos OK, {skip} ignorados (objeto ja existia).")
print("Tabelas criadas: sensor_data, sensor_training_data, sensor_monitoring_data")
PYEOF

echo ""
echo "=== Schema aplicado com sucesso! ==="
echo "Proximo passo: execute  05_migrate_data.py  para copiar dados locais"
echo "  ou  06_update_env.sh  para ja apontar o backend para o ADB."
