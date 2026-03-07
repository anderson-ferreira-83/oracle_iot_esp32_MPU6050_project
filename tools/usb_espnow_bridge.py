#!/usr/bin/env python3
"""
usb_espnow_bridge.py — Bridge USB Serial (ESP32-RX) → FastAPI backend

Le batches JSON compactos do ESP32 via serial, reconstroi o payload completo
e faz POST ao backend local. Devolve comandos do servidor ao ESP32 via serial.

Uso:
    python usb_espnow_bridge.py
    python usb_espnow_bridge.py --port COM5
    python usb_espnow_bridge.py --port /dev/ttyUSB0 --server http://localhost:8000

Dependencias (instalar uma vez):
    pip install pyserial requests
"""

import argparse
import json
import logging
import sys
import time

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    print("ERRO: pyserial nao instalado. Execute: pip install pyserial")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("ERRO: requests nao instalado. Execute: pip install requests")
    sys.exit(1)

# ---------------------------------------------------------------------------
AUTH_TOKEN  = "F0xb@m986960440"
INGEST_PATH = "/api/ingest"
BAUD_RATE   = 115200

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("bridge")

_session = requests.Session()
_session.headers.update({
    "Authorization": f"Bearer {AUTH_TOKEN}",
    "Content-Type":  "application/json",
})


# ---------------------------------------------------------------------------
# Auto-deteccao de porta serial do ESP32
# ---------------------------------------------------------------------------
ESP32_CHIPS = ["CP210", "CH340", "FTDI", "Silicon Labs", "USB-SERIAL", "USB Serial", "CH9102"]

def find_esp32_port() -> str | None:
    ports = list(serial.tools.list_ports.comports())
    for p in ports:
        desc = (p.description or "") + " " + (p.manufacturer or "")
        if any(chip.lower() in desc.lower() for chip in ESP32_CHIPS):
            return p.device
    # Fallback: se so existe uma porta, usa ela
    if len(ports) == 1:
        return ports[0].device
    return None


# ---------------------------------------------------------------------------
# Reconstrucao do payload a partir do formato compacto do ESP32
# ---------------------------------------------------------------------------
def reconstruct_payload(data: dict) -> dict | None:
    """
    Formato compacto recebido do ESP32:
      {"did":..., "cid":..., "sr":100, "fs":"RAW", "t0":946685000.1, "b":[[ax,ay,az,gx,gy,gz,t],...]}

    Saida: payload completo para /api/ingest com batch de objetos nomeados.
    """
    try:
        device_id     = data["did"]
        collection_id = data["cid"]
        sr            = int(data["sr"])
        fan_state     = str(data.get("fs", "RAW"))
        raw_batch     = data["b"]
    except (KeyError, TypeError, ValueError) as e:
        log.warning(f"Payload invalido: {e}")
        return None

    period = 1.0 / max(1, sr)
    # Usa o relogio do PC (float64) em vez do t0 do ESP32 (float32).
    # float32 perde a parte fracionaria para timestamps grandes (~1.77e9),
    # gerando t0 identico em todos os pacotes e Hz errado no frontend.
    # t0 = instante do primeiro sample do batch = agora - (n-1)*period
    t0 = time.time() - (len(raw_batch) - 1) * period

    batch = []
    for i, s in enumerate(raw_batch):
        if len(s) < 7:
            continue
        batch.append({
            "ts": round(t0 + i * period, 3),
            "ax": s[0], "ay": s[1], "az": s[2],
            "gx": s[3], "gy": s[4], "gz": s[5],
            "t":  s[6],
            "sr": sr,
            "fs": fan_state,
        })

    if not batch:
        return None

    return {
        "device_id":    device_id,
        "collection_id": collection_id,
        "sample_rate":  sr,
        "batch":        batch,
        "net": {
            "connected":       True,
            "connection_type": "USB",
        },
    }


# ---------------------------------------------------------------------------
# POST ao backend
# ---------------------------------------------------------------------------
def post_to_server(server_url: str, payload: dict) -> dict | None:
    try:
        resp = _session.post(f"{server_url}{INGEST_PATH}", json=payload, timeout=5)
        if resp.status_code == 200:
            return resp.json()
        log.warning(f"POST {resp.status_code}: {resp.text[:120]}")
    except requests.exceptions.ConnectionError:
        log.error(f"Sem conexao com {server_url} — backend rodando?")
    except Exception as e:
        log.warning(f"POST falhou: {e}")
    return None


# ---------------------------------------------------------------------------
# Loop principal
# ---------------------------------------------------------------------------
def run_bridge(port: str, server_url: str):
    log.info(f"Porta: {port}  |  Backend: {server_url}  |  Baud: {BAUD_RATE}")
    log.info("Aguardando dados do ESP32... (Ctrl+C para sair)")

    post_ok    = 0
    post_fail  = 0
    samples_total = 0

    while True:
        try:
            with serial.Serial(port, BAUD_RATE, timeout=2) as ser:
                log.info(f"Serial aberta: {port}")

                while True:
                    try:
                        raw = ser.readline()
                    except Exception as e:
                        log.error(f"Erro leitura serial: {e}")
                        break

                    if not raw:
                        continue

                    try:
                        line = raw.decode("utf-8", errors="replace").strip()
                    except Exception:
                        continue

                    # Linhas de status do ESP32 — apenas loga
                    if not line.startswith("{"):
                        if line:
                            log.info(f"[ESP32] {line}")
                        continue

                    # Linha de dados JSON
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        log.warning(f"JSON invalido: {line[:80]}")
                        continue

                    payload = reconstruct_payload(data)
                    if payload is None:
                        continue

                    n = len(payload["batch"])
                    samples_total += n

                    resp = post_to_server(server_url, payload)

                    if resp:
                        post_ok += 1
                        mode = resp.get("target_mode", "?")
                        col  = (resp.get("target_collection_id") or "")[-16:]
                        log.info(
                            f"+{n:>3} amostras  POST_OK={post_ok}  "
                            f"total={samples_total}  mode={mode}  col=...{col}"
                        )

                        # Monta comando para o ESP32 repassar ao TX
                        cmd: dict = {}
                        if resp.get("target_mode"):
                            cmd["target_mode"] = resp["target_mode"]
                        if resp.get("target_rate"):
                            cmd["target_rate"] = resp["target_rate"]
                        if resp.get("target_collection_id"):
                            cmd["target_collection_id"] = resp["target_collection_id"]

                        if cmd:
                            try:
                                ser.write((json.dumps(cmd) + "\n").encode("utf-8"))
                            except Exception as e:
                                log.warning(f"Falha ao enviar cmd ao ESP32: {e}")
                    else:
                        post_fail += 1
                        log.warning(f"+{n} amostras  POST_FAIL={post_fail}")

        except serial.SerialException as e:
            log.error(f"Porta serial indisponivel: {e}")
            log.info("Tentando reconectar em 5s...")
            time.sleep(5)
        except KeyboardInterrupt:
            log.info(f"Bridge encerrado. POST_OK={post_ok} POST_FAIL={post_fail} TOTAL={samples_total}")
            break


# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Bridge USB Serial (ESP32-RX) → FastAPI backend local"
    )
    parser.add_argument(
        "--port", default=None,
        help="Porta serial, ex: COM5 ou /dev/ttyUSB0 (auto-detecta se omitido)",
    )
    parser.add_argument(
        "--server", default="http://localhost:8000",
        help="URL do backend FastAPI (padrao: http://localhost:8000)",
    )
    args = parser.parse_args()

    port = args.port
    if not port:
        port = find_esp32_port()
        if not port:
            log.error("Nenhuma porta serial encontrada. Especifique com --port COM5")
            sys.exit(1)
        log.info(f"Porta auto-detectada: {port}")

    run_bridge(port, args.server)


if __name__ == "__main__":
    main()
