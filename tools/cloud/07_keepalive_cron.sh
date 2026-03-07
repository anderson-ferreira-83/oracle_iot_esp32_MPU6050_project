#!/usr/bin/env bash
# =============================================================================
# 07_keepalive_cron.sh
# Instala um cron job que faz SELECT 1 no ADB a cada 5 dias,
# evitando a pausa automatica do ADB Free Tier (pausa apos 7 dias sem acesso).
#
# Alternativa: no Console Oracle Cloud, desative a pausa automatica em:
#   ADB → Detalhes → Mais acoes → Gerenciar pausa automatica → Desativar
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB_INFO="$SCRIPT_DIR/adb_info.env"

if [ ! -f "$ADB_INFO" ]; then
    echo "ERRO: $ADB_INFO nao encontrado. Execute 03_create_adb.sh primeiro."
    exit 1
fi

source "$ADB_INFO"

KEEPALIVE_SCRIPT="$SCRIPT_DIR/keepalive_adb.py"

# Gera o script Python de keepalive
cat > "$KEEPALIVE_SCRIPT" <<'PYEOF'
#!/usr/bin/env python3
"""Keepalive para ADB Free Tier — executa SELECT 1 e loga resultado."""
import oracledb, os, sys, datetime
from pathlib import Path

script_dir   = Path(__file__).parent
adb_info     = {}
with open(script_dir / "adb_info.env") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            adb_info[k.strip()] = v.strip()

wallet_dir   = adb_info["WALLET_DIR"]
service_name = adb_info["ADB_SERVICE_NAME"]
user         = adb_info.get("ORACLE_USER", "ADMIN")
password     = os.environ.get("ORACLE_PASSWORD", "")

if not password:
    sys.exit("ERRO: ORACLE_PASSWORD nao definido")

try:
    conn = oracledb.connect(user=user, password=password, dsn=service_name,
                            config_dir=wallet_dir, wallet_location=wallet_dir)
    cur  = conn.cursor()
    cur.execute("SELECT 1 FROM DUAL")
    cur.close(); conn.close()
    print(f"{datetime.datetime.now().isoformat()} [OK] ADB keepalive bem-sucedido")
except Exception as e:
    print(f"{datetime.datetime.now().isoformat()} [ERRO] {e}", file=sys.stderr)
    sys.exit(1)
PYEOF

chmod +x "$KEEPALIVE_SCRIPT"

if [ -z "${ORACLE_PASSWORD:-}" ]; then
    read -rsp "Senha do ADMIN (para o cron): " ORACLE_PASSWORD
    echo ""
fi

LOG_FILE="$SCRIPT_DIR/keepalive.log"

# Cron: a cada 5 dias, as 03:00
CRON_LINE="0 3 */5 * * ORACLE_PASSWORD='$ORACLE_PASSWORD' python3 $KEEPALIVE_SCRIPT >> $LOG_FILE 2>&1"

# Adiciona ao crontab sem duplicar
( crontab -l 2>/dev/null | grep -v "keepalive_adb.py" ; echo "$CRON_LINE" ) | crontab -

echo ""
echo "=== Cron instalado ==="
echo "Agenda: a cada 5 dias as 03:00"
echo "Log   : $LOG_FILE"
echo ""
echo "Para verificar: crontab -l"
echo "Teste manual : ORACLE_PASSWORD='$ORACLE_PASSWORD' python3 $KEEPALIVE_SCRIPT"
