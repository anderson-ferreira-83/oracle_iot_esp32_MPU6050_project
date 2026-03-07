# main_espnow_rx_usb.py - ESP32 Gateway: recebe ESP-NOW do TX, saida via USB serial
# v1.0: sem WiFi, sem HTTP - conecta ao PC diretamente pelo cabo USB
# O PC roda usb_espnow_bridge.py que faz o POST ao backend local.
#
# device_config.json requer:
#   "transport_mode": "espnow_rx_usb"
#
# Formato de saida (uma linha JSON por batch):
#   {"did":"ESP32_MPU6050_ORACLE","cid":"v5_stream","sr":100,"fs":"RAW","t0":946685000.1,"b":[[ax,ay,az,gx,gy,gz,t],...]}
#
# Formato de entrada (comando do bridge, uma linha JSON):
#   {"target_mode":"RAW","target_rate":100,"target_collection_id":"col_..."}

import gc
import struct
import sys
import time

try:
    import ujson as json
except ImportError:
    import json

import machine
import network

try:
    import espnow
except ImportError:
    sys.stdout.write("[ERR] modulo espnow nao disponivel. Atualize o firmware MicroPython.\n")
    raise SystemExit

try:
    import uselect
    _stdin_poll = uselect.poll()
    _stdin_poll.register(sys.stdin, uselect.POLLIN)
    _HAS_POLL = True
except Exception:
    _HAS_POLL = False

# ---------------------------------------------------------------------------
CONFIG_FILE = "/device_config.json"

FAN_STATES = [
    "RAW", "FAN_OFF", "LOW_ROT_OFF", "LOW_ROT_ON",
    "MEDIUM_ROT_OFF", "MEDIUM_ROT_ON", "HIGH_ROT_OFF", "HIGH_ROT_ON",
]

SAMPLE_FMT  = "<Ihhhhhhh"
SAMPLE_SIZE = 18
HEADER_FMT  = "<BBBBBB"
HEADER_SIZE = 6

POST_BATCH_SIZE    = 13    # 1 pacote ESP-NOW por escrita serial: evita bloqueio de ~400ms que causava perda de pacotes
MAX_POST_INTERVAL_MS = 500


# ---------------------------------------------------------------------------
def _load_json(path, default):
    try:
        with open(path, "r") as f:
            return json.loads(f.read())
    except Exception:
        return default


def _cfg_int(value, default):
    try:
        return int(value)
    except Exception:
        return default


def _mac_str(mac_bytes):
    return ":".join("{:02x}".format(b) for b in mac_bytes)


# ---------------------------------------------------------------------------
def _read_cmd_from_bridge():
    """Lê uma linha do stdin sem bloquear. Retorna string ou None."""
    if _HAS_POLL:
        try:
            if not _stdin_poll.poll(0):
                return None
        except Exception:
            return None
    else:
        return None  # sem poll disponivel, nao le stdin
    try:
        line = sys.stdin.readline()
        return line.strip() if line else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
def _unpack_packet(msg):
    """Desempacota pacote ESP-NOW binario. Retorna (samples, sr, fan_state, seq) ou None."""
    if not msg or len(msg) < HEADER_SIZE:
        return None
    try:
        magic0, magic1, n_samples, sr, fs_idx, seq = struct.unpack_from(HEADER_FMT, msg, 0)
    except Exception:
        return None

    if magic0 != 0xE5 or magic1 != 0x32:
        return None
    if n_samples == 0 or sr == 0:
        return None
    if len(msg) < HEADER_SIZE + n_samples * SAMPLE_SIZE:
        return None

    fan_state = FAN_STATES[fs_idx] if fs_idx < len(FAN_STATES) else "RAW"
    period_s  = 1.0 / sr

    # Sem NTP: tempo desde boot + epoch-2000; o servidor corrige o drift automaticamente
    rx_epoch = (time.time() + 946684800) + (time.ticks_ms() % 1000) / 1000.0

    samples = []
    for i in range(n_samples):
        offset = HEADER_SIZE + i * SAMPLE_SIZE
        try:
            _, ax_r, ay_r, az_r, gx_r, gy_r, gz_r, temp_r = struct.unpack_from(
                SAMPLE_FMT, msg, offset
            )
        except Exception:
            break
        # Distribui timestamps: ultimo sample = agora
        ts = rx_epoch - (n_samples - 1 - i) * period_s
        samples.append([
            round(ts, 2),
            round(ax_r / 16384.0, 3),
            round(ay_r / 16384.0, 3),
            round(az_r / 16384.0, 3),
            round(gx_r / 131.0,   2),
            round(gy_r / 131.0,   2),
            round(gz_r / 131.0,   2),
            round(temp_r / 100.0, 1),
        ])

    if not samples:
        return None
    return samples, sr, fan_state, seq


# ---------------------------------------------------------------------------
def _relay_cmd_to_tx(en, tx_mac, cmd_line, state):
    """Processa JSON de comando do bridge e repassa ao TX via ESP-NOW."""
    try:
        cmd = json.loads(cmd_line)
    except Exception:
        return state
    if not isinstance(cmd, dict):
        return state

    state = dict(state)
    relay = {}

    new_mode = str(cmd.get("target_mode", "")).strip()
    if new_mode and new_mode != state.get("fs", ""):
        relay["target_mode"] = new_mode
        state["fs"] = new_mode

    try:
        new_rate = int(cmd.get("target_rate", 0))
    except Exception:
        new_rate = 0
    if new_rate >= 1 and new_rate != state.get("sr", 0):
        relay["target_rate"] = new_rate
        state["sr"] = new_rate

    new_col = str(cmd.get("target_collection_id", "")).strip()
    if new_col and new_col != state.get("cid", ""):
        relay["target_collection_id"] = new_col
        state["cid"] = new_col

    if relay and tx_mac is not None:
        try:
            en.send(tx_mac, json.dumps(relay).encode("utf-8"))
            sys.stdout.write("[CMD->TX] {}\n".format(relay))
        except Exception as e:
            sys.stdout.write("[CMD->TX] Erro: {}\n".format(e))

    return state


# ---------------------------------------------------------------------------
def main():
    cfg = _load_json(CONFIG_FILE, {})
    if not isinstance(cfg, dict):
        cfg = {}

    device_id     = str(cfg.get("device_id", "ESP32_MPU6050_ORACLE")).strip() or "ESP32_MPU6050_ORACLE"
    collection_id = str(cfg.get("collection_id", "v5_stream")).strip() or "v5_stream"
    sample_rate   = _cfg_int(cfg.get("target_sample_rate", 100), 100)
    low_mem_thr   = _cfg_int(cfg.get("low_mem_threshold", 14000), 14000)
    espnow_channel= _cfg_int(cfg.get("espnow_channel", 1), 1)

    sys.stdout.write("=" * 40 + "\n")
    sys.stdout.write("ESP32 MPU6050 v1.2-espnow-rx-usb\n")
    sys.stdout.write("Atualizado: 2026-03-07 15:17 BRT | POST_BATCH_SIZE 100->13: corrige perda de pacotes ESP-NOW por bloqueio do serial write\n")
    sys.stdout.write("Modo: USB Serial (sem WiFi)\n")
    sys.stdout.write("=" * 40 + "\n")

    # ESP-NOW precisa da interface WiFi ativa no mesmo canal do TX
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    try:
        wlan.config(channel=espnow_channel)
        sys.stdout.write("Canal ESP-NOW: {}\n".format(espnow_channel))
    except Exception as e:
        sys.stdout.write("[WARN] canal: {}\n".format(e))
    try:
        own_mac = wlan.config("mac")
        sys.stdout.write("MAC RX: {}\n".format(_mac_str(own_mac)))
        sys.stdout.write("Configure no TX: \"espnow_peer_mac\": {}\n".format(list(own_mac)))
    except Exception:
        pass

    en = espnow.ESPNow()
    en.active(True)

    broadcast_mac = b"\xff\xff\xff\xff\xff\xff"
    try:
        en.add_peer(broadcast_mac)
    except Exception:
        pass

    tx_mac   = None
    recv_ok  = 0
    recv_bad = 0
    sent_ok  = 0
    seq_last = -1
    seq_drop = 0
    last_stat    = time.ticks_ms()
    last_post_ms = time.ticks_ms()
    gc_counter   = 0
    post_batch   = []

    tx_state = {"fs": "RAW", "sr": sample_rate, "cid": collection_id}

    while True:
        now = time.ticks_ms()

        # Comando do bridge via stdin (nao bloqueia)
        cmd_line = _read_cmd_from_bridge()
        if cmd_line and cmd_line.startswith("{"):
            tx_state = _relay_cmd_to_tx(en, tx_mac, cmd_line, tx_state)

        # Recebe pacote ESP-NOW (timeout curto para nao travar o loop)
        try:
            peer_mac, msg = en.recv(100)
        except Exception:
            peer_mac, msg = None, None

        if msg and len(msg) > 0:
            if tx_mac is None and peer_mac and peer_mac != broadcast_mac:
                tx_mac = peer_mac
                try:
                    en.add_peer(tx_mac)
                except Exception:
                    pass
                sys.stdout.write("[ESPNOW-RX] TX detectado: {}\n".format(_mac_str(tx_mac)))

            result = _unpack_packet(msg)
            if result is None:
                recv_bad += 1
            else:
                samples, sr, fs, seq = result
                recv_ok += 1
                if seq_last >= 0 and seq != ((seq_last + 1) & 0xFF):
                    seq_drop += 1
                seq_last = seq
                post_batch.extend(samples)
                tx_state["fs"] = fs
                tx_state["sr"] = sr

        # Envia ao bridge quando buffer cheio ou timeout
        should_send = (
            len(post_batch) >= POST_BATCH_SIZE or
            (len(post_batch) > 0 and time.ticks_diff(now, last_post_ms) >= MAX_POST_INTERVAL_MS)
        )

        if should_send:
            batch_out  = post_batch[:POST_BATCH_SIZE]
            post_batch = post_batch[POST_BATCH_SIZE:]
            last_post_ms = now

            # Formato compacto: arrays em vez de objetos para reduzir tamanho (~4KB/s em vez de 12KB/s)
            # Bridge reconstroi o payload completo com os campos nomeados
            line_obj = {
                "did": device_id,
                "cid": tx_state["cid"],
                "sr":  tx_state["sr"],
                "fs":  tx_state["fs"],
                "t0":  batch_out[0][0] if batch_out else 0,
                "b":   [s[1:] for s in batch_out],  # [ax,ay,az,gx,gy,gz,t] sem ts (ts reconstruido pelo bridge)
            }

            try:
                sys.stdout.write(json.dumps(line_obj) + "\n")
                sent_ok += 1
            except Exception as e:
                sys.stdout.write("[ERR] serial write: {}\n".format(e))

            batch_out = None
            line_obj  = None

        gc_counter += 1
        if gc_counter >= 20 or gc.mem_free() < low_mem_thr:
            gc.collect()
            gc_counter = 0

        if time.ticks_diff(now, last_stat) >= 10000:
            sys.stdout.write("[STAT] RX_OK:{} RX_BAD:{} SEQ_DROP:{} SENT:{} BUF:{} MEM:{}\n".format(
                recv_ok, recv_bad, seq_drop, sent_ok, len(post_batch), gc.mem_free()
            ))
            last_stat = now


main()
