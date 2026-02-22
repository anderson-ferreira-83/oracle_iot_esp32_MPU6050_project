# Melhorias de Autonomia - Firmware HTTP (FastAPI)

## O que foi implementado
- Endpoint HTTP autonomo:
  - Tenta primeiro `server_hostname` (`*.local`).
  - Se falhar, usa lista de fallback (`server_fallback_ips` + `server_fallback_ip` legado).
  - Aprende automaticamente IP valido do servidor e reaproveita em reinicios.
- Cooldown de mDNS:
  - Apos falha de hostname, evita retry imediato por `mdns_retry_interval_s`.
  - Reduz latencia e perda de ciclos quando mDNS esta indisponivel.
- Reconexao Wi-Fi por perfis salvos (`wifi_profiles.json`).
- Fila persistente em flash (store-and-forward):
  - Mantem backlog offline em `offline_queue.json`.
  - Restaura backlog apos reboot/queda de energia.
  - Prioriza envio do backlog antes de dados novos.
- Provisionamento estilo WiFiManager no `boot.py`:
  - AP `Config-ESP32` com portal web para cadastrar nova rede.
  - Portal tambem permite ajustar `server_hostname`, fallback(s) e `api_path` pelo celular.
  - Salvamento persistente e reboot automatico.
- Configuracao por `device_config.json`:
  - Hostname/IP/path da API
  - token, device_id, sample rate, timeouts
  - parametros do portal
  - debug
- Robustez adicional:
  - Timestamp monotonicamente crescente em bursts.
  - Parse de status HTTP mais restrito (linha de status).
  - Ajustes de reconexao e fallback sem alterar payload esperado pelo backend.

## Arquivos de apoio
- `device_config.example.json`
- `wifi_profiles.example.json`

Copie os `.example.json` para os nomes reais:
- `device_config.json`
- `wifi_profiles.json`

## Proximos testes recomendados
1. Teste baseline (rede atual):
   - Verificar ingestao normal no `api/ingest`.
   - Confirmar resposta de comando (`target_mode`, `target_rate`, `target_collection_id`).
2. Teste de mDNS:
   - Definir `server_hostname` com o nome real do PC (`SEU-PC.local`).
   - Reiniciar roteador e validar continuidade sem editar firmware.
3. Teste de fallback:
   - Simular indisponibilidade de `*.local` e confirmar envio por IP fallback.
4. Teste de portal AP:
   - Em rede desconhecida, conectar no AP `Config-ESP32`.
   - Salvar nova credencial e confirmar reconexao automatica.
5. Teste de estabilidade:
   - Forcar perda de Wi-Fi por 30-60s.
   - Confirmar retomada de envio e recuperacao de taxa/eficiencia.
   - Reiniciar o ESP32 durante a queda e validar restauracao da fila offline.

## Possiveis correcoes se houver falha
- Falha `endpoint failed` recorrente:
  - Validar path da API em `api_path`.
  - Confirmar token `auth_token` igual ao backend.
- Muitos `TX fail`:
  - Aumentar `HTTP_TIMEOUT`.
  - Reduzir `target_sample_rate`.
- mDNS intermitente:
  - Aumentar `mdns_retry_interval_s`.
  - Manter fallback IP configurado.
- Portal nao abre:
  - Verificar conflito de porta 80 no firmware.
  - Testar outro aparelho para conectar no AP do ESP32.
