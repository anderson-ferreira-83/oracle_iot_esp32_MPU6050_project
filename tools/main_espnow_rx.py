# main_espnow_rx.py - ESP32 Gateway: recebe ESP-NOW do TX, encaminha ao backend
# v1.0: desempacota binario, reconstroi JSON, HTTP POST, repassa comandos ao TX
#
# device_config.json requer:
#   "transport_mode": "espnow_rx"
#   (usa os mesmos campos de Wi-Fi de main_lite.py: wifi_profiles.json, etc.)
#
# Ao iniciar, imprime o proprio MAC para configurar o TX:
#   -> copie o MAC exibido para "espnow_peer_mac" no device_config.json do TX

import gc
import struct
import time

try:
    import ujson as json
except ImportError:
    import json

import machine
import network
import usocket as socket

try:
    import espnow
except ImportError:
    print("[ESPNOW-RX] ERRO: modulo espnow nao disponivel.")
    print("[ESPNOW-RX] Atualize o firmware MicroPython para >= v1.19.")
    raise SystemExit


CONFIG_FILE = "/device_config.json"
WIFI_PROFILE_FILE = "/wifi_profiles.json"
MPU_ADDR = 0x68
AUTH_TOKEN_DEFAULT = "F0xb@m986960440"
API_PATH_DEFAULT = "/api/ingest"
MAX_RESPONSE_BYTES = 4096
DNS_CACHE_TTL_MS = 120000
_DNS_CACHE = {}

# Mesma tabela do TX (ordem deve ser identica)
FAN_STATES = [
    "RAW", "FAN_OFF", "LOW_ROT_OFF", "LOW_ROT_ON",
    "MEDIUM_ROT_OFF", "MEDIUM_ROT_ON", "HIGH_ROT_OFF", "HIGH_ROT_ON",
]

# Formato binario por sample: ticks_ms(uint32) + ax,ay,az,gx,gy,gz,temp (7x int16)
SAMPLE_FMT = "<Ihhhhhhh"
SAMPLE_SIZE = 18
HEADER_FMT = "<BBBBBB"
HEADER_SIZE = 6

# Quantos samples acumular antes de fazer o POST (1 segundo a 100 Hz)
POST_BATCH_SIZE = 100
# Intervalo maximo para forcar um POST mesmo com buffer incompleto (ms)
MAX_POST_INTERVAL_MS = 2000


# ---------------------------------------------------------------------------
# Config helpers (mesmo padrao de main_lite.py)
# ---------------------------------------------------------------------------
def _load_json(path, default):
    try:
        with open(path, "r") as f:
            return json.loads(f.read())
    except Exception:
        return default


def _save_json(path, data):
    try:
        with open(path, "w") as f:
            f.write(json.dumps(data))
        return True
    except Exception:
        return False


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


def _sanitize_host(value):
    host = str(value or "").strip()
    for prefix in ("https://", "http://"):
        if host.startswith(prefix):
            host = host[len(prefix):]
    if "/" in host:
        host = host.split("/", 1)[0]
    return host.strip()


def _is_ipv4(host):
    parts = str(host or "").split(".")
    if len(parts) != 4:
        return False
    for p in parts:
        if not p.isdigit() or not (0 <= int(p) <= 255):
            return False
    return True


def _split_host_port(host_entry):
    host = _sanitize_host(host_entry)
    port = 80
    if ":" in host:
        h, p = host.rsplit(":", 1)
        if p.isdigit():
            return h, int(p)
    return host, port


def _mac_str(mac_bytes):
    return ":".join("{:02x}".format(b) for b in mac_bytes)


# ---------------------------------------------------------------------------
# Wi-Fi
# ---------------------------------------------------------------------------
def _load_wifi_profiles(cfg):
    raw = _load_json(WIFI_PROFILE_FILE, [])
    if isinstance(raw, dict):
        raw = raw.get("profiles", [])

    out = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            ssid = str(item.get("ssid", "")).strip()
            if ssid:
                entry = {"ssid": ssid, "password": str(item.get("password", ""))}
                sip = str(item.get("server_ip", "")).strip()
                if sip:
                    entry["server_ip"] = sip
                out.append(entry)

    if out:
        return out

    ssid = str(cfg.get("ssid", "")).strip()
    password = str(cfg.get("password", ""))
    if ssid:
        return [{"ssid": ssid, "password": password}]
    return [{"ssid": "S20_Ders@0", "password": "F0xbam1844"}]


def _connected_ssid(wlan):
    try:
        raw = wlan.config("essid")
        if isinstance(raw, bytes):
            raw = raw.decode()
        return str(raw or "").strip()
    except Exception:
        return ""


def _apply_dns(wlan, dns):
    if not _is_ipv4(dns):
        return
    try:
        ip, mask, gw, cur_dns = wlan.ifconfig()
        if str(cur_dns) != dns:
            wlan.ifconfig((ip, mask, gw, dns))
            print("[DNS] {}".format(dns))
    except Exception:
        pass


def _wifi_connect(wlan, profiles, dns=""):
    wlan.active(True)
    for p in profiles:
        ssid = str(p.get("ssid", "")).strip()
        password = str(p.get("password", ""))
        if not ssid:
            continue
        print("[WIFI] Tentando '{}'".format(ssid))
        try:
            wlan.disconnect()
        except Exception:
            pass
        try:
            wlan.connect(ssid, password)
        except Exception:
            continue
        for _ in range(14):
            if wlan.isconnected():
                _apply_dns(wlan, dns)
                print("[WIFI] Conectado {}".format(wlan.ifconfig()[0]))
                return True
            time.sleep(1)
    return False


def _wifi_recover(wlan, profiles, dns=""):
    try:
        wlan.disconnect()
    except Exception:
        pass
    try:
        wlan.active(False)
        time.sleep_ms(300)
    except Exception:
        pass
    gc.collect()
    try:
        wlan.active(True)
        time.sleep_ms(300)
    except Exception:
        pass
    return _wifi_connect(wlan, profiles, dns=dns)


# ---------------------------------------------------------------------------
# HTTP POST (identico a main_lite.py)
# ---------------------------------------------------------------------------
def _resolve_addr(host, port, force_refresh=False):
    if _is_ipv4(host):
        return (host, port)
    key = "{}:{}".format(host, port)
    now = time.ticks_ms()
    if not force_refresh:
        cached = _DNS_CACHE.get(key)
        if isinstance(cached, dict):
            expires = cached.get("expires_ms")
            addr = cached.get("addr")
            if isinstance(expires, int) and addr and time.ticks_diff(expires, now) > 0:
                return addr
    addr = socket.getaddrinfo(host, port)[0][-1]
    _DNS_CACHE[key] = {
        "addr": addr,
        "expires_ms": time.ticks_add(now, DNS_CACHE_TTL_MS),
    }
    return addr


def _http_post(url, payload_bytes, token, timeout=4):
    u = url[7:] if url.startswith("http://") else url
    host_port, _, path = u.partition("/")
    path = "/" + path if path else "/"
    host, port = _split_host_port(host_port)
    retries = 2 if not _is_ipv4(host) else 1
    last_error = None

    for attempt in range(retries):
        s = None
        try:
            addr = _resolve_addr(host, port, force_refresh=(attempt > 0))
            s = socket.socket()
            s.settimeout(timeout)
            s.connect(addr)

            req = (
                "POST {} HTTP/1.0\r\n"
                "Host: {}\r\n"
                "Connection: close\r\n"
                "Content-Type: application/json\r\n"
                "Authorization: Bearer {}\r\n"
                "Content-Length: {}\r\n"
                "\r\n"
            ).format(path, host_port, token, len(payload_bytes))
            s.send(req.encode())
            s.send(payload_bytes)

            chunks = []
            total = 0
            while total < MAX_RESPONSE_BYTES:
                try:
                    chunk = s.recv(512)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                except Exception:
                    break

            raw = b"".join(chunks)
            chunks = None

            status = 0
            if raw and raw[:5] == b"HTTP/":
                end = raw.find(b"\r\n")
                if end > 0:
                    parts = raw[:end].split()
                    if len(parts) >= 2:
                        try:
                            status = int(parts[1])
                        except Exception:
                            pass

            resp = None
            if status == 200:
                sep = raw.find(b"\r\n\r\n")
                if sep >= 0:
                    body = raw[sep + 4:]
                    raw = None
                    try:
                        body_str = body.decode("utf-8")
                    except Exception:
                        body_str = ""
                    body = None
                    body_str = body_str.lstrip("\ufeff\r\n\t ")
                    if body_str and body_str[0] in "{[":
                        try:
                            resp = json.loads(body_str)
                        except Exception:
                            pass
            else:
                raw = None

            return status == 200, status, resp

        except Exception as e:
            last_error = e
            if not _is_ipv4(host):
                key = "{}:{}".format(host, port)
                try:
                    del _DNS_CACHE[key]
                except Exception:
                    pass
        finally:
            try:
                if s:
                    s.close()
            except Exception:
                pass

    return False, last_error, None


# ---------------------------------------------------------------------------
# Server candidates (identico a main_lite.py)
# ---------------------------------------------------------------------------
def _server_ip_for_ssid(profiles, ssid):
    if not ssid:
        return ""
    for p in profiles:
        if not isinstance(p, dict):
            continue
        if str(p.get("ssid", "")).strip() == ssid:
            ip = _sanitize_host(p.get("server_ip", ""))
            if ip:
                return ip
    return ""


def _server_candidates(cfg, profiles, ssid):
    out = []
    hostname = _sanitize_host(cfg.get("server_hostname", ""))
    prefer_hostname = _cfg_bool(cfg.get("prefer_server_hostname", True), True)
    if hostname.endswith(".trycloudflare.com"):
        prefer_hostname = True
    if hostname and prefer_hostname:
        out.append(hostname)

    profile_ip = _server_ip_for_ssid(profiles, ssid)
    if profile_ip and profile_ip not in out:
        out.append(profile_ip)

    fallback = _sanitize_host(cfg.get("server_fallback_ip", ""))
    if fallback and fallback not in out:
        out.append(fallback)

    raw = cfg.get("server_fallback_ips", [])
    if isinstance(raw, list):
        for item in raw:
            h = _sanitize_host(item)
            if h and h not in out:
                out.append(h)

    if hostname and hostname not in out:
        out.append(hostname)

    if not out:
        out.append("10.125.237.165:8000")
    return out


# ---------------------------------------------------------------------------
# Desempacotamento binario (formato do TX)
# ---------------------------------------------------------------------------
def _unpack_packet(msg):
    """Desempacota pacote ESP-NOW binario. Retorna (samples_list, sr, fs, seq) ou None."""
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
    period_s = 1.0 / sr

    # Ancora o ultimo sample no tempo atual do RX (clock do RX e sincronizado via NTP/Wi-Fi)
    rx_epoch = (time.time() + 946684800) + (time.ticks_ms() % 1000) / 1000.0

    samples = []
    for i in range(n_samples):
        offset = HEADER_SIZE + i * SAMPLE_SIZE
        try:
            ticks_ms, ax_r, ay_r, az_r, gx_r, gy_r, gz_r, temp_r = struct.unpack_from(
                SAMPLE_FMT, msg, offset
            )
        except Exception:
            break

        # Distribui timestamps: ultimo sample = agora, anteriores recuam por period_s
        ts = rx_epoch - (n_samples - 1 - i) * period_s

        samples.append({
            "ts": round(ts, 3),
            "t": round(temp_r / 100.0, 1),
            "ax": round(ax_r / 16384.0, 4),
            "ay": round(ay_r / 16384.0, 4),
            "az": round(az_r / 16384.0, 4),
            "gx": round(gx_r / 131.0, 2),
            "gy": round(gy_r / 131.0, 2),
            "gz": round(gz_r / 131.0, 2),
            "sr": sr,
            "fs": fan_state,
        })

    if not samples:
        return None
    return samples, sr, fan_state, seq


# ---------------------------------------------------------------------------
# Repasse de comandos do servidor para o TX via ESP-NOW
# ---------------------------------------------------------------------------
def _relay_command_to_tx(en, tx_mac, resp, current_state):
    """Extrai comandos da resposta HTTP e envia ao TX via ESP-NOW."""
    if not isinstance(resp, dict) or tx_mac is None:
        return current_state

    cmd = {}
    new_mode = str(resp.get("target_mode", "")).strip()
    if new_mode and new_mode != current_state.get("fan_state", ""):
        cmd["target_mode"] = new_mode
        current_state = dict(current_state)
        current_state["fan_state"] = new_mode

    try:
        new_rate = int(resp.get("target_rate", 0))
    except Exception:
        new_rate = 0
    if new_rate >= 1 and new_rate != current_state.get("sample_rate", 0):
        cmd["target_rate"] = new_rate
        current_state = dict(current_state)
        current_state["sample_rate"] = new_rate

    new_col = str(resp.get("target_collection_id", "")).strip()
    if new_col and new_col != current_state.get("collection_id", ""):
        cmd["target_collection_id"] = new_col
        current_state = dict(current_state)
        current_state["collection_id"] = new_col

    if not cmd:
        return current_state

    try:
        cmd_bytes = json.dumps(cmd).encode("utf-8")
        en.send(tx_mac, cmd_bytes)
        print("[CMD->TX] {}".format(cmd))
    except Exception as e:
        print("[CMD->TX] Erro: {}".format(e))

    return current_state


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    cfg = _load_json(CONFIG_FILE, {})
    if not isinstance(cfg, dict):
        cfg = {}

    device_id = str(cfg.get("device_id", "ESP32_MPU6050_ORACLE")).strip() or "ESP32_MPU6050_ORACLE"
    collection_id = str(cfg.get("collection_id", "v5_stream")).strip() or "v5_stream"
    token = str(cfg.get("auth_token", AUTH_TOKEN_DEFAULT)).strip() or AUTH_TOKEN_DEFAULT
    api_path = str(cfg.get("api_path", API_PATH_DEFAULT)).strip() or API_PATH_DEFAULT
    if not api_path.startswith("/"):
        api_path = "/" + api_path

    dns_server = str(cfg.get("dns_server", "")).strip()
    if not _is_ipv4(dns_server):
        dns_server = ""

    fan_state = str(cfg.get("mode", "RAW")).strip() or "RAW"
    sample_rate = _cfg_int(cfg.get("target_sample_rate", 100), 100)
    if sample_rate < 1:
        sample_rate = 1
    low_mem_threshold = _cfg_int(cfg.get("low_mem_threshold", 14000), 14000)

    profiles = _load_wifi_profiles(cfg)
    wlan = network.WLAN(network.STA_IF)

    # Imprime MAC proprio para o usuario configurar o TX
    wlan.active(True)
    own_mac = b"\x00" * 6
    try:
        own_mac = wlan.config("mac")
    except Exception:
        pass
    print("=" * 40)
    print("ESP32 MPU6050 v1.0-espnow-rx")
    print("*** MAC deste RX: {} ***".format(_mac_str(own_mac)))
    print("*** Configure no TX: \"espnow_peer_mac\": {} ***".format(
        list(own_mac)
    ))
    print("=" * 40)

    if not wlan.isconnected():
        if not _wifi_connect(wlan, profiles, dns=dns_server):
            print("[ERR] Wi-Fi indisponivel")
            time.sleep(2)
            machine.reset()

    ssid = _connected_ssid(wlan)
    server_hosts = _server_candidates(cfg, profiles, ssid)
    server_idx = 0
    host = server_hosts[server_idx]
    url = "http://{}{}".format(host, api_path)

    print("[WIFI] {} ({})".format(wlan.ifconfig()[0], ssid))
    print("[URL] {}".format(url))

    # ESP-NOW receptor
    en = espnow.ESPNow()
    en.active(True)

    # Registra broadcast como peer para conseguir recv de qualquer TX (pode ajustar para peer fixo)
    broadcast_mac = b"\xff\xff\xff\xff\xff\xff"
    try:
        en.add_peer(broadcast_mac)
    except Exception:
        pass

    tx_mac = None  # aprendido do primeiro pacote recebido

    sent_ok = 0
    sent_fail = 0
    fail_streak = 0
    recv_ok = 0
    recv_bad = 0
    last_stat = time.ticks_ms()
    last_post_ms = time.ticks_ms()
    gc_counter = 0
    seq_last = -1
    seq_drop = 0

    post_batch = []

    tx_state = {
        "fan_state": fan_state,
        "sample_rate": sample_rate,
        "collection_id": collection_id,
    }

    while True:
        now = time.ticks_ms()

        # Checa Wi-Fi
        if not wlan.isconnected():
            print("[WIFI] Reconectando...")
            _wifi_recover(wlan, profiles, dns=dns_server)
            ssid = _connected_ssid(wlan)
            server_hosts = _server_candidates(cfg, profiles, ssid)
            server_idx = 0
            host = server_hosts[server_idx]
            url = "http://{}{}".format(host, api_path)

        # Aguarda pacote ESP-NOW (timeout curto para nao bloquear muito)
        try:
            peer_mac, msg = en.recv(150)
        except Exception:
            peer_mac, msg = None, None

        if msg and len(msg) > 0:
            # Aprende MAC do TX na primeira mensagem
            if tx_mac is None and peer_mac and peer_mac != broadcast_mac:
                tx_mac = peer_mac
                try:
                    en.add_peer(tx_mac)
                except Exception:
                    pass
                print("[ESPNOW-RX] TX detectado: {}".format(_mac_str(tx_mac)))

            result = _unpack_packet(msg)
            if result is None:
                recv_bad += 1
            else:
                samples, sr, fs, seq = result
                recv_ok += 1

                # Detecta pacotes perdidos pelo numero de sequencia
                if seq_last >= 0:
                    expected = (seq_last + 1) & 0xFF
                    if seq != expected:
                        seq_drop += 1
                seq_last = seq

                post_batch.extend(samples)
                tx_state = dict(tx_state)
                tx_state["fan_state"] = fs
                tx_state["sample_rate"] = sr

        # POST quando buffer cheio OU tempo maximo expirou
        should_post = (
            len(post_batch) >= POST_BATCH_SIZE or
            (len(post_batch) > 0 and time.ticks_diff(now, last_post_ms) >= MAX_POST_INTERVAL_MS)
        )

        if should_post:
            batch_to_send = post_batch[:POST_BATCH_SIZE]
            post_batch = post_batch[POST_BATCH_SIZE:]
            last_post_ms = now

            sr_send = tx_state.get("sample_rate", sample_rate)
            col_send = tx_state.get("collection_id", collection_id)

            try:
                rssi = wlan.status("rssi")
            except Exception:
                rssi = 0

            payload_obj = {
                "device_id": device_id,
                "collection_id": col_send,
                "sample_rate": sr_send,
                "batch": batch_to_send,
                "net": {
                    "connected": True,
                    "connection_type": "ESPNOW",
                    "ssid": ssid,
                    "ip": wlan.ifconfig()[0] if wlan.isconnected() else "",
                    "rssi": rssi,
                    "last_endpoint": host,
                    "tx_mac": _mac_str(tx_mac) if tx_mac else "",
                },
            }

            try:
                payload = json.dumps(payload_obj).encode("utf-8")
            except Exception as e:
                print("[PAYLOAD] {}".format(e))
                payload = None

            payload_obj = None

            if payload:
                ok, info, resp = _http_post(url, payload, token, timeout=4)
                payload = None

                if ok:
                    sent_ok += 1
                    fail_streak = 0

                    if isinstance(resp, dict):
                        tx_state = _relay_command_to_tx(en, tx_mac, resp, tx_state)

                        # Troca de servidor/modo via resposta (OTA-like)
                        new_mode = str(resp.get("target_mode", "")).strip()
                        if new_mode:
                            fan_state = new_mode

                        new_col = str(resp.get("target_collection_id", "")).strip()
                        if new_col:
                            collection_id = new_col
                            tx_state = dict(tx_state)
                            tx_state["collection_id"] = collection_id

                    resp = None
                else:
                    sent_fail += 1
                    fail_streak += 1
                    if fail_streak <= 3 or (fail_streak % 10) == 0:
                        print("[HTTP] fail {} ({})".format(fail_streak, info))

                    # Rotaciona entre servidores candidatos
                    if len(server_hosts) > 1 and fail_streak in (2, 4, 8, 16):
                        server_idx = (server_idx + 1) % len(server_hosts)
                        host = server_hosts[server_idx]
                        url = "http://{}{}".format(host, api_path)
                        print("[NET] Tentando servidor -> {}".format(host))

                    if fail_streak in (5, 10, 20):
                        print("[WIFI] Recuperando stack...")
                        _wifi_recover(wlan, profiles, dns=dns_server)
                        ssid = _connected_ssid(wlan)
                        server_hosts = _server_candidates(cfg, profiles, ssid)
                        server_idx = 0
                        host = server_hosts[server_idx]
                        url = "http://{}{}".format(host, api_path)

                    if fail_streak >= 30:
                        print("[WIFI] Falha persistente, reiniciando...")
                        time.sleep_ms(200)
                        machine.reset()

        gc_counter += 1
        if gc_counter >= 10 or gc.mem_free() < low_mem_threshold:
            gc.collect()
            gc_counter = 0

        if time.ticks_diff(now, last_stat) >= 10000:
            print("[STAT] RX_OK:{} RX_BAD:{} SEQ_DROP:{} POST_OK:{} POST_FAIL:{} BUF:{} MEM:{}".format(
                recv_ok, recv_bad, seq_drop, sent_ok, sent_fail, len(post_batch), gc.mem_free()
            ))
            last_stat = now


main()
