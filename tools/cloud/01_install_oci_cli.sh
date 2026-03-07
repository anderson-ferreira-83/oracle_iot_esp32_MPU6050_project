#!/usr/bin/env bash
# =============================================================================
# 01_install_oci_cli.sh
# Instala o OCI CLI no WSL2/Linux e verifica a instalacao.
# Execute uma unica vez na maquina onde vai gerenciar a infra.
# =============================================================================
set -euo pipefail

echo "=== Instalando OCI CLI ==="

# Instala via instalador oficial (nao requer sudo para o binario)
bash -c "$(curl -fsSL https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)" \
  -- --accept-all-defaults

# Recarrega PATH da sessao atual
export PATH="$HOME/bin:$HOME/.local/bin:$PATH"

# Verifica
if command -v oci &>/dev/null; then
    echo ""
    echo "OCI CLI instalado com sucesso: $(oci --version)"
    echo ""
    echo "Proximo passo: execute  02_configure_oci.sh"
else
    echo ""
    echo "AVISO: oci nao encontrado no PATH atual."
    echo "Feche e reabra o terminal, depois execute: oci --version"
fi
