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
# FIFO do MPU6050 — amostragem por hardware (cristal do sensor, sem timing Python)
#   0x1A CONFIG     : DLPF mode 1 → saida giroscopio = 1 kHz
#   0x19 SMPLRT_DIV : taxa = 1000 / (div + 1)  ex: div=9 → 100 Hz
#   0x23 FIFO_EN    : 0xF8 = accel + temp + gyro (14 bytes/amostra)
#   0x6A USER_CTRL  : bit6=FIFO_EN, bit2=FIFO_RESET
#   0x72/73 FIFO_COUNT, 0x74 FIFO_R_W
# ---------------------------------------------------------------------------
FIFO_SAMPLE_SIZE = 14  # ax,ay,az,temp,gx,gy,gz  (2 bytes cada)


def _init_mpu_fifo(i2c, sample_rate):
    i2c.writeto(MPU_ADDR, b"\x6B\x00")                              # acorda sensor
    i2c.writeto(MPU_ADDR, b"\x1A\x01")                              # DLPF mode 1
    div = max(0, min(255, 1000 // max(1, sample_rate) - 1))
    i2c.writeto(MPU_ADDR, bytes([0x19, div]))                        # SMPLRT_DIV
    i2c.writeto(MPU_ADDR, b"\x23\xF8")                              # FIFO_EN
    i2c.writeto(MPU_ADDR, b"\x6A\x44")                              # habilita+reseta FIFO


def _reset_fifo(i2c):
    i2c.writeto(MPU_ADDR, b"\x6A\x44")


def _read_fifo_count(i2c):
    raw = i2c.readfrom_mem(MPU_ADDR, 0x72, 2)
    return ((raw[0] & 0x1F) << 8) | raw[1]


def _read_fifo_samples(i2c, n):
    raw = i2c.readfrom_mem(MPU_ADDR, 0x74, n * FIFO_SAMPLE_SIZE)
    out = []
    for i in range(n):
        o = i * FIFO_SAMPLE_SIZE
        ax   = _bytes_to_int(raw[o],    raw[o+1])  / 16384.0
        ay   = _bytes_to_int(raw[o+2],  raw[o+3])  / 16384.0
        az   = _bytes_to_int(raw[o+4],  raw[o+5])  / 16384.0
        temp = _bytes_to_int(raw[o+6],  raw[o+7])  / 340.0 + 36.53
        gx   = _bytes_to_int(raw[o+8],  raw[o+9])  / 131.0
        gy   = _bytes_to_int(raw[o+10], raw[o+11]) / 131.0
        gz   = _bytes_to_int(raw[o+12], raw[o+13]) / 131.0
        out.append((ax, ay, az, gx, gy, gz, temp))
    return out


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
    print("ESP32 MPU6050 v1.3-espnow-tx")
    print("Atualizado: 2026-03-07 15:17 BRT | MPU6050 FIFO hardware: taxa controlada por cristal do sensor (SMPLRT_DIV), elimina timing Python")
    print("Peer RX: {}".format(_mac_str(peer_mac)))
    print("Canal: {} | Taxa: {} Hz".format(channel, sample_rate))
    print("Samples/pkt: {} | ~{:.1f} pkts/s".format(
        MAX_SAMPLES_PER_PKT,
        sample_rate / MAX_SAMPLES_PER_PKT
    ))
    print("=" * 40)

    i2c = machine.I2C(0, scl=machine.Pin(22), sda=machine.Pin(21), freq=400000)
    _init_mpu_fifo(i2c, sample_rate)

    sent_ok = 0
    sent_fail = 0
    fail_streak = 0
    sensor_fail = 0
    fifo_overflow = 0
    last_stat = time.ticks_ms()
    gc_counter = 0
    seq = 0

    state = {
        "fan_state": fan_state,
        "sample_rate": sample_rate,
        "collection_id": collection_id,
    }

    while True:
        # Le contagem de bytes disponiveis no FIFO
        try:
            count = _read_fifo_count(i2c)
        except Exception as e:
            sensor_fail += 1
            if sensor_fail <= 3 or (sensor_fail % 20) == 0:
                print("[SENSOR] fifo_count: {}".format(e))
            continue

        # Detecta overflow (FIFO = 1024 bytes): reseta e descarta
        if count >= 1024 - FIFO_SAMPLE_SIZE:
            fifo_overflow += 1
            try:
                _reset_fifo(i2c)
            except Exception:
                pass
            continue

        # Aguarda acumular amostras suficientes para um pacote ESP-NOW
        if count < MAX_SAMPLES_PER_PKT * FIFO_SAMPLE_SIZE:
            continue

        # --- Pacote pronto ---

        # Verifica comandos do RX (uma vez por pacote, nao bloqueia)
        try:
            host, msg = en.recv(0)
            if msg and len(msg) > 0:
                new_state, changed = _apply_rx_command(msg, state)
                if changed:
                    state = new_state
                    if state["sample_rate"] != sample_rate:
                        sample_rate = state["sample_rate"]
                        div = max(0, min(255, 1000 // max(1, sample_rate) - 1))
                        try:
                            i2c.writeto(MPU_ADDR, bytes([0x19, div]))
                            _reset_fifo(i2c)
                        except Exception:
                            pass
                    fan_state = state["fan_state"]
        except Exception:
            pass

        # Le exatamente um pacote do FIFO
        try:
            samples = _read_fifo_samples(i2c, MAX_SAMPLES_PER_PKT)
        except Exception as e:
            sensor_fail += 1
            if sensor_fail <= 3 or (sensor_fail % 20) == 0:
                print("[SENSOR] fifo_read: {}".format(e))
            try:
                _reset_fifo(i2c)
            except Exception:
                pass
            continue

        # Empacota e envia
        now_ms = time.ticks_ms()
        packed = [_pack_sample(now_ms, ax, ay, az, gx, gy, gz, temp)
                  for ax, ay, az, gx, gy, gz, temp in samples]
        pkt = _build_packet(packed, sample_rate, fan_state, seq)
        seq = (seq + 1) & 0xFF

        try:
            en.send(peer_mac, pkt, False)
            sent_ok += 1
            fail_streak = 0
        except Exception as e:
            sent_fail += 1
            fail_streak += 1
            if fail_streak <= 3 or (fail_streak % 20) == 0:
                print("[ESPNOW] fail {} ({})".format(fail_streak, e))

        # GC apos envio
        gc_counter += 1
        if gc_counter >= 10 or gc.mem_free() < low_mem_threshold:
            gc.collect()
            gc_counter = 0

        now_ms = time.ticks_ms()
        if time.ticks_diff(now_ms, last_stat) >= 10000:
            print("[STAT] OK:{} FAIL:{} SENSOR_FAIL:{} FIFO_OVF:{} STREAK:{} MEM:{}".format(
                sent_ok, sent_fail, sensor_fail, fifo_overflow, fail_streak, gc.mem_free()
            ))
            last_stat = now_ms


main()
