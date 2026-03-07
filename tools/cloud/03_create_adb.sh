#!/usr/bin/env bash
# =============================================================================
# 03_create_adb.sh
# Cria o Autonomous Database (Always Free) na Oracle Cloud via OCI CLI,
# aguarda ficar AVAILABLE e baixa o Wallet de conexao.
#
# Prerequisitos:
#   - OCI CLI configurado (02_configure_oci.sh executado)
#   - oci iam region list  funciona sem erro
#
# Saidas geradas:
#   - tools/cloud/adb_info.env   (OCID, service name, wallet path)
#   - tools/cloud/wallet/        (arquivos de conexao mTLS)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB_INFO="$SCRIPT_DIR/adb_info.env"
WALLET_DIR="$SCRIPT_DIR/wallet"
WALLET_ZIP="$SCRIPT_DIR/wallet.zip"

echo "=== Criando Autonomous Database Always Free ==="
echo ""

# Coleta compartimento (raiz = tenancy OCID, ou um compartimento especifico)
TENANCY_OCID=$(oci iam region list --query "data[0]" 2>/dev/null | python3 -c "
import sys,json; oci_cfg=open('$HOME/.oci/config').read()
for line in oci_cfg.splitlines():
    if line.startswith('tenancy='):
        print(line.split('=',1)[1].strip()); break
")
read -rp "Compartment OCID [Enter = raiz da tenancy '$TENANCY_OCID']: " COMPARTMENT_OCID
COMPARTMENT_OCID="${COMPARTMENT_OCID:-$TENANCY_OCID}"

read -rsp "Senha do ADMIN (min 12 chars, 1 maiuscula, 1 numero, 1 especial): " ADB_PASSWORD
echo ""
read -rsp "Senha do Wallet (pode ser a mesma): " WALLET_PASSWORD
echo ""

DB_NAME="MPUIOTDB"
DISPLAY_NAME="MPU6050_IoT_FreeTier"

echo ""
echo "Criando ADB '$DISPLAY_NAME' (Always Free, ATP, 1 OCPU, 20GB)..."

ADB_JSON=$(oci db autonomous-database create \
  --compartment-id "$COMPARTMENT_OCID" \
  --db-name "$DB_NAME" \
  --display-name "$DISPLAY_NAME" \
  --db-workload ATP \
  --is-free-tier true \
  --cpu-core-count 1 \
  --data-storage-size-in-tbs 1 \
  --admin-password "$ADB_PASSWORD" \
  --license-model LICENSE_INCLUDED \
  --wait-for-state AVAILABLE \
  --max-wait-seconds 600 \
  2>&1)

ADB_OCID=$(echo "$ADB_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['id'])" 2>/dev/null || \
           echo "$ADB_JSON" | grep -oP '"id"\s*:\s*"\Kocid1\.autonomousdatabase[^"]+' | head -1)

if [ -z "$ADB_OCID" ]; then
    echo "ERRO: nao foi possivel obter o OCID do ADB."
    echo "Saida do comando:"
    echo "$ADB_JSON"
    exit 1
fi

echo "ADB criado! OCID: $ADB_OCID"

# Service name: <db_name>_tp  (Transaction Processing, baixa latencia)
SERVICE_NAME="${DB_NAME,,}_tp"   # minusculas + _tp

# Baixa o Wallet
echo ""
echo "Baixando Wallet de conexao..."
mkdir -p "$WALLET_DIR"

oci db autonomous-database generate-wallet \
  --autonomous-database-id "$ADB_OCID" \
  --password "$WALLET_PASSWORD" \
  --file "$WALLET_ZIP"

unzip -oq "$WALLET_ZIP" -d "$WALLET_DIR"
rm -f "$WALLET_ZIP"

# Corrige WALLET_LOCATION no sqlnet.ora
SQLNET="$WALLET_DIR/sqlnet.ora"
if [ -f "$SQLNET" ]; then
    sed -i "s|DIRECTORY=\".*\"|DIRECTORY=\"$WALLET_DIR\"|g" "$SQLNET"
fi

# Salva variaveis para os proximos scripts
cat > "$ADB_INFO" <<EOF
ADB_OCID=$ADB_OCID
ADB_DB_NAME=$DB_NAME
ADB_DISPLAY_NAME=$DISPLAY_NAME
ADB_SERVICE_NAME=$SERVICE_NAME
WALLET_DIR=$WALLET_DIR
ORACLE_USER=ADMIN
# ORACLE_PASSWORD e WALLET_PASSWORD nao sao salvas aqui por seguranca.
# Exporte antes de rodar os proximos scripts:
#   export ORACLE_PASSWORD='sua_senha'
#   export WALLET_PASSWORD='sua_senha_wallet'
EOF

echo ""
echo "=== ADB pronto! ==="
echo "  OCID        : $ADB_OCID"
echo "  Service name: $SERVICE_NAME"
echo "  Wallet      : $WALLET_DIR"
echo "  Info salva  : $ADB_INFO"
echo ""
echo "Proximo passo: exporte as senhas e execute  04_apply_schema.sh"
echo "  export ORACLE_PASSWORD='SUA_SENHA'"
echo "  export WALLET_PASSWORD='SUA_SENHA_WALLET'"
