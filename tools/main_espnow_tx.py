# main_espnow_tx.py - ESP32 MPU6050 transmissor via ESP-NOW (sem Wi-Fi)
# v1.0: formato binario compacto, 100 Hz, canal de comandos bidirecional
#
# device_config.json requer:
#   "transport_mode":  "espnow"
#   "espnow_peer_mac": [0xbc, 0xdd, 0xc2, 0x12, 0x34, 0x56]  <- MAC do ESP32-RX
#   "espnow_channel":  6                                        <- canal Wi-Fi do RX
#
# Para obter o MAC do RX, execute no ESP32-RX via Thonny:
#   import network; w = network.WLAN(0); w.active(True)
#   print(':'.join('{:02x}'.format(b) for b in w.config('mac')))

import gc
import struct
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
    print("[ESPNOW-TX] ERRO: modulo espnow nao disponivel.")
    print("[ESPNOW-TX] Atualize o firmware MicroPython para >= v1.19.")
    raise SystemExit


CONFIG_FILE = "/device_config.json"
MPU_ADDR = 0x68
MAX_SAMPLE_RATE = 150

# Tabela de fan_states compartilhada com o RX (a ordem importa)
FAN_STATES = [
    "RAW", "FAN_OFF", "LOW_ROT_OFF", "LOW_ROT_ON",
    "MEDIUM_ROT_OFF", "MEDIUM_ROT_ON", "HIGH_ROT_OFF", "HIGH_ROT_ON",
]

# Formato binario por sample: ticks_ms(uint32) + ax,ay,az,gx,gy,gz,temp (7x int16)
# Total = 4 + 14 = 18 bytes/sample
SAMPLE_FMT = "<Ihhhhhhh"
SAMPLE_SIZE = 18

# Cabecalho do pacote: magic(2B) + n_samples(1B) + sr(1B) + fs_idx(1B) + seq(1B) = 6 bytes
HEADER_FMT = "<BBBBBB"
HEADER_SIZE = 6

# Maximos por pacote ESP-NOW (limite 250 bytes)
MAX_SAMPLES_PER_PKT = (250 - HEADER_SIZE) // SAMPLE_SIZE  # = 13


# ---------------------------------------------------------------------------
# Helpers de config
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


def _cfg_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return int(value) != 0
    if isinstance(value, str):
        t = value.strip().lower()
        if t in ("1", "true", "yes", "on"):
            return True
        if t in ("0", "false", "no", "off"):
            return False
    return default


# ---------------------------------------------------------------------------
# MAC address
# ---------------------------------------------------------------------------
def _parse_mac(raw):
    """Converte lista de ints [0xBC,0xDD,...] ou string 'bc:dd:...' em bytes."""
    if isinstance(raw, (list, tuple)) and len(raw) == 6:
        try:
            return bytes([int(b) & 0xFF for b in raw])
        except Exception:
            return None
    if isinstance(raw, str):
        parts = raw.strip().replace("-", ":").split(":")
        if len(parts) == 6:
            try:
                return bytes([int(x, 16) for x in parts])
            except Exception:
                pass
    return None


def _mac_str(mac_bytes):
    return ":".join("{:02x}".format(b) for b in mac_bytes)


# ---------------------------------------------------------------------------
# Sensor MPU6050
# ---------------------------------------------------------------------------
def _bytes_to_int(h, l):
    v = (h << 8) | l
    if v & 0x8000:
        v = -((65535 - v) + 1)
    return v


def _read_mpu(i2c):
    raw = i2c.readfrom_mem(MPU_ADDR, 0x3B, 14)
    ax = _bytes_to_int(raw[0], raw[1]) / 16384.0
    ay = _bytes_to_int(raw[2], raw[3]) / 16384.0
    az = _bytes_to_int(raw[4], raw[5]) / 16384.0
    temp = _bytes_to_int(raw[6], raw[7]) / 340.0 + 36.53
    gx = _bytes_to_int(raw[8], raw[9]) / 131.0
    gy = _bytes_to_int(raw[10], raw[11]) / 131.0
    gz = _bytes_to_int(raw[12], raw[13]) / 131.0
    return ax, ay, az, gx, gy, gz, temp


# ---------------------------------------------------------------------------
# Empacotamento binario
# ---------------------------------------------------------------------------
def _clamp16(v):
    if v > 32767:
        return 32767
    if v < -32768:
        return -32768
    return v


def _fs_idx(fan_state):
    fs = str(fan_state).strip()
    if fs in FAN_STATES:
        return FAN_STATES.index(fs)
    return 0


def _pack_sample(ticks_ms, ax, ay, az, gx, gy, gz, temp):
    return struct.pack(
        SAMPLE_FMT,
        ticks_ms & 0xFFFFFFFF,
        _clamp16(int(ax * 16384)),
        _clamp16(int(ay * 16384)),
        _clamp16(int(az * 16384)),
        _clamp16(int(gx * 131)),
        _clamp16(int(gy * 131)),
        _clamp16(int(gz * 131)),
        _clamp16(int(temp * 100)),
    )


def _build_packet(sample_buf, sr, fan_state, seq):
    n = len(sample_buf)
    header = struct.pack(
        HEADER_FMT, 0xE5, 0x32, n, sr & 0xFF, _fs_idx(fan_state), seq & 0xFF
    )
    pkt = bytearray(header)
    for s in sample_buf:
        pkt.extend(s)
    return bytes(pkt)


# ---------------------------------------------------------------------------
# Canal de comandos: RX -> TX
# ---------------------------------------------------------------------------
def _apply_rx_command(msg_bytes, state):
    """Processa comando JSON recebido do gateway RX."""
    try:
        cmd = json.loads(msg_bytes.decode("utf-8"))
    except Exception:
        return state, False
    if not isinstance(cmd, dict):
        return state, False

    fan_state = state["fan_state"]
    sample_rate = state["sample_rate"]
    changed = False

    new_mode = str(cmd.get("target_mode", "")).strip()
    if new_mode and new_mode != fan_state and new_mode in FAN_STATES:
        fan_state = new_mode
        print("[MODE] {}".format(fan_state))
        changed = True

    try:
        new_rate = int(cmd.get("target_rate", 0))
    except Exception:
        new_rate = 0
    if 1 <= new_rate <= MAX_SAMPLE_RATE and new_rate != sample_rate:
        sample_rate = new_rate
        print("[RATE] {} Hz".format(sample_rate))
        changed = True

    new_col = str(cmd.get("target_collection_id", "")).strip()
    if new_col and new_col != state.get("collection_id", ""):
        print("[COL] {}".format(new_col))
        state = dict(state)
        state["collection_id"] = new_col
        changed = True

    if not changed:
        return state, False

    new_state = dict(state)
    new_state["fan_state"] = fan_state
    new_state["sample_rate"] = sample_rate
    return new_state, True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    cfg = _load_json(CONFIG_FILE, {})
    if not isinstance(cfg, dict):
        cfg = {}

    sample_rate = _cfg_int(cfg.get("target_sample_rate", 100), 100)
    if sample_rate < 1:
        sample_rate = 1
    if sample_rate > MAX_SAMPLE_RATE:
        sample_rate = MAX_SAMPLE_RATE

    fan_state = str(cfg.get("mode", "RAW")).strip() or "RAW"
    collection_id = str(cfg.get("collection_id", "v5_stream")).strip() or "v5_stream"
    low_mem_threshold = _cfg_int(cfg.get("low_mem_threshold", 14000), 14000)

    peer_mac = _parse_mac(cfg.get("espnow_peer_mac"))
    if not peer_mac:
        print("[ESPNOW-TX] ERRO: 'espnow_peer_mac' ausente ou invalido em device_config.json")
        print("[ESPNOW-TX] Exemplo: \"espnow_peer_mac\": [0xBC, 0xDD, 0xC2, 0x12, 0x34, 0x56]")
        print("[ESPNOW-TX] Execute no RX: import network; w=network.WLAN(0); w.active(True)")
        print("[ESPNOW-TX] print(':'.join('{:02x}'.format(b) for b in w.config('mac')))")
        return

    channel = _cfg_int(cfg.get("espnow_channel", 1), 1)
    if channel < 1 or channel > 13:
        channel = 1

    # Interface Wi-Fi deve estar ativa para ESP-NOW (nao conectada)
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)

    # Tenta definir canal manualmente (suportado em firmwares recentes)
    try:
        wlan.config(channel=channel)
    except Exception:
        pass

    en = espnow.ESPNow()
    en.active(True)

    try:
        en.add_peer(peer_mac, channel=channel)
    except Exception as e:
        print("[ESPNOW-TX] Erro ao adicionar peer: {}".format(e))
        # Tenta sem especificar canal
        try:
            en.add_peer(peer_mac)
        except Exception as e2:
            print("[ESPNOW-TX] Falha fatal ao adicionar peer: {}".format(e2))
            return

    print("=" * 40)
    print("ESP32 MPU6050 v1.0-espnow-tx")
    print("Peer RX: {}".format(_mac_str(peer_mac)))
    print("Canal: {} | Taxa: {} Hz".format(channel, sample_rate))
    print("Samples/pkt: {} | ~{:.1f} pkts/s".format(
        MAX_SAMPLES_PER_PKT,
        sample_rate / MAX_SAMPLES_PER_PKT
    ))
    print("=" * 40)

    i2c = machine.I2C(0, scl=machine.Pin(22), sda=machine.Pin(21), freq=400000)
    i2c.writeto(MPU_ADDR, b"\x6B\x00")

    # Timing em microsegundos para precisao maxima
    period_us   = 1_000_000 // sample_rate
    next_sample = time.ticks_us()

    sent_ok = 0
    sent_fail = 0
    fail_streak = 0
    sensor_fail = 0
    last_stat = time.ticks_ms()
    sample_buf = []
    gc_counter = 0
    gc_pending = False
    seq = 0

    state = {
        "fan_state": fan_state,
        "sample_rate": sample_rate,
        "collection_id": collection_id,
    }

    while True:
        # Fase 1: aguarda o proximo deadline
        #   - sleep_ms(1) enquanto faltam >1500 us (economiza CPU)
        #   - GC roda aqui (periodo ocioso) para nao interromper amostragem
        #   - spin-wait nos ultimos 1500 us (precisao microsegundos)
        remaining = time.ticks_diff(next_sample, time.ticks_us())
        if remaining > 1500:
            if gc_pending:
                gc.collect()
                gc_pending = False
            time.sleep_ms(1)
            continue
        while time.ticks_diff(next_sample, time.ticks_us()) > 0:
            pass

        next_sample = time.ticks_add(next_sample, period_us)

        # Fase 2: verifica comandos do RX uma vez por amostra (nao no loop de espera)
        try:
            host, msg = en.recv(0)
            if msg and len(msg) > 0:
                new_state, changed = _apply_rx_command(msg, state)
                if changed:
                    state = new_state
                    if state["sample_rate"] != sample_rate:
                        sample_rate = state["sample_rate"]
                        period_us   = 1_000_000 // sample_rate
                        sample_buf  = []
                    fan_state = state["fan_state"]
        except Exception:
            pass

        # Fase 3: le sensor e acumula
        try:
            ax, ay, az, gx, gy, gz, temp = _read_mpu(i2c)
        except Exception as e:
            sensor_fail += 1
            if sensor_fail <= 3 or (sensor_fail % 20) == 0:
                print("[SENSOR] {}".format(e))
            gc_pending = True
            continue

        sample_buf.append(_pack_sample(time.ticks_ms(), ax, ay, az, gx, gy, gz, temp))

        if len(sample_buf) < MAX_SAMPLES_PER_PKT:
            continue

        pkt = _build_packet(sample_buf, sample_rate, fan_state, seq)
        seq = (seq + 1) & 0xFF
        sample_buf = []

        try:
            en.send(peer_mac, pkt, False)  # sync=False: nao espera ACK (nao bloqueia)
            sent_ok += 1
            fail_streak = 0
        except Exception as e:
            sent_fail += 1
            fail_streak += 1
            if fail_streak <= 3 or (fail_streak % 20) == 0:
                print("[ESPNOW] fail {} ({})".format(fail_streak, e))

        # Agenda GC para o proximo periodo ocioso (nao bloqueia aqui)
        gc_counter += 1
        if gc_counter >= 20:
            gc_pending = True
            gc_counter = 0

        now_ms = time.ticks_ms()
        if time.ticks_diff(now_ms, last_stat) >= 10000:
            mem = gc.mem_free()
            if mem < low_mem_threshold:
                gc_pending = True
            print("[STAT] OK:{} FAIL:{} SENSOR_FAIL:{} STREAK:{} MEM:{}".format(
                sent_ok, sent_fail, sensor_fail, fail_streak, mem
            ))
            last_stat = now_ms


main()
