#!/usr/bin/env bash
# =============================================================================
# 02_configure_oci.sh
# Gera chave RSA, cria ~/.oci/config e orienta a adicionar a chave no Console.
#
# Prerequisito: ter os seguintes dados do Oracle Cloud em maos:
#   - Tenancy OCID   (Console → Perfil → Tenancy)
#   - User OCID      (Console → Perfil → Meu perfil)
#   - Region         (ex: sa-saopaulo-1)
# =============================================================================
set -euo pipefail

OCI_DIR="$HOME/.oci"
KEY_PRIV="$OCI_DIR/oci_api_key.pem"
KEY_PUB="$OCI_DIR/oci_api_key_public.pem"
CONFIG="$OCI_DIR/config"

mkdir -p "$OCI_DIR"
chmod 700 "$OCI_DIR"

echo "=== Configurando OCI CLI ==="
echo ""

# Coleta dados do usuario
read -rp "Tenancy OCID (ocid1.tenancy.oc1...) : " TENANCY_OCID
read -rp "User OCID    (ocid1.user.oc1...) ....: " USER_OCID
read -rp "Regiao (ex: sa-saopaulo-1) .........: " REGION

# Gera par de chaves RSA 2048
echo ""
echo "Gerando par de chaves RSA..."
openssl genrsa -out "$KEY_PRIV" 2048
openssl rsa -pubout -in "$KEY_PRIV" -out "$KEY_PUB"
chmod 600 "$KEY_PRIV"

# Fingerprint
FINGERPRINT=$(openssl rsa -pubout -outform DER -in "$KEY_PRIV" 2>/dev/null | openssl md5 -c | awk '{print $2}')

# Escreve ~/.oci/config
cat > "$CONFIG" <<EOF
[DEFAULT]
user=$USER_OCID
fingerprint=$FINGERPRINT
key_file=$KEY_PRIV
tenancy=$TENANCY_OCID
region=$REGION
EOF
chmod 600 "$CONFIG"

echo ""
echo "=== Configuracao salva em $CONFIG ==="
echo ""
echo "AGORA voce precisa adicionar a chave PUBLICA no Oracle Cloud Console:"
echo ""
echo "  1. Acesse: https://cloud.oracle.com"
echo "  2. Menu superior direito → Perfil → Meu perfil"
echo "  3. Recursos → Chaves de API → Adicionar chave de API"
echo "  4. Selecione 'Colar chave publica' e cole o conteudo abaixo:"
echo ""
echo "--------- COPIE A PARTIR DAQUI ---------"
cat "$KEY_PUB"
echo "--------- ATE AQUI ---------------------"
echo ""
echo "Depois de adicionar no Console, teste com:"
echo "  oci iam region list"
echo ""
echo "Se retornar lista de regioes, a configuracao esta correta."
echo "Proximo passo: execute  03_create_adb.sh"
