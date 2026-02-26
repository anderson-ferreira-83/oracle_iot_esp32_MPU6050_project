# main_lite.py - lightweight sender for ESP32 + MPU6050
# v7.4-lite: OTA network config, per-profile server IP, portal on-demand,
#             command processing (mode/rate/collection), net diagnostics.

import gc
import time

try:
    import ujson as json
except ImportError:
    import json

import machine
import network
import usocket as socket


CONFIG_FILE = "/device_config.json"
WIFI_PROFILE_FILE = "/wifi_profiles.json"
NETWORK_REV_FILE = "/network_revision.txt"

MPU_ADDR = 0x68
AUTH_TOKEN_DEFAULT = "F0xb@m986960440"
API_PATH_DEFAULT = "/api/ingest"
MAX_RESPONSE_BYTES = 4096


def _load_json(path, default):
    try:
        with open(path, "r") as f:
            data = json.loads(f.read())
        return data
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


def _sanitize_host_entry(value):
    host = str(value or "").strip()
    if host.startswith("http://"):
        host = host[7:]
    elif host.startswith("https://"):
        host = host[8:]
    if "/" in host:
        host = host.split("/", 1)[0]
    return host.strip()


def _is_ipv4_literal(host):
    parts = str(host or "").split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not part.isdigit():
            return False
        n = int(part)
        if n < 0 or n > 255:
            return False
    return True


def _connected_ssid(wlan):
    try:
        raw = wlan.config("essid")
        if isinstance(raw, bytes):
            raw = raw.decode()
        return str(raw or "").strip()
    except Exception:
        return ""


def _server_ip_for_ssid(profiles, ssid):
    if not ssid:
        return ""
    for p in profiles:
        if not isinstance(p, dict):
            continue
        if str(p.get("ssid", "")).strip() == ssid:
            ip = _sanitize_host_entry(p.get("server_ip", ""))
            if ip:
                return ip
    return ""


def _first_server_host(cfg):
    ip = _sanitize_host_entry(cfg.get("server_fallback_ip", ""))
    if ip:
        return ip

    ips = cfg.get("server_fallback_ips", [])
    if isinstance(ips, list):
        for item in ips:
            h = _sanitize_host_entry(item)
            if h:
                return h

    host = _sanitize_host_entry(cfg.get("server_hostname", ""))
    if host:
        return host

    return "10.125.237.165:8000"


def _resolve_server_host(cfg, profiles, connected_ssid):
    profile_ip = _server_ip_for_ssid(profiles, connected_ssid)
    if profile_ip:
        return profile_ip
    return _first_server_host(cfg)


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
            password = str(item.get("password", ""))
            if ssid:
                entry = {"ssid": ssid, "password": password}
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

    return [{"ssid": "S20_Ders@0", "password": "F0xbam1844", "server_ip": "10.125.237.165:8000"}]


def _wifi_connect_profiles(wlan, profiles):
    wlan.active(True)

    for profile in profiles:
        ssid = str(profile.get("ssid", "")).strip()
        password = str(profile.get("password", ""))
        if not ssid:
            continue

        print("[WIFI] Trying '{}'".format(ssid))
        try:
            wlan.disconnect()
        except Exception:
            pass

        try:
            wlan.connect(ssid, password)
        except Exception:
            continue

        for _ in range(12):
            if wlan.isconnected():
                print("[WIFI] Connected {}".format(wlan.ifconfig()[0]))
                return True
            time.sleep(1)

    return False


def _wifi_recover(wlan, profiles):
    try:
        wlan.disconnect()
    except Exception:
        pass

    try:
        wlan.active(False)
        time.sleep_ms(250)
    except Exception:
        pass

    gc.collect()

    try:
        wlan.active(True)
        time.sleep_ms(250)
    except Exception:
        pass

    return _wifi_connect_profiles(wlan, profiles)


def _bytes_to_int(h, l):
    v = (h << 8) | l
    if v & 0x8000:
        v = -((65535 - v) + 1)
    return v


def _ts():
    return (time.time() + 946684800) + ((time.ticks_ms() % 1000) / 1000.0)


def _read_mpu(i2c, sample_rate):
    raw = i2c.readfrom_mem(MPU_ADDR, 0x3B, 14)
    ax = _bytes_to_int(raw[0], raw[1]) / 16384.0
    ay = _bytes_to_int(raw[2], raw[3]) / 16384.0
    az = _bytes_to_int(raw[4], raw[5]) / 16384.0
    temp = _bytes_to_int(raw[6], raw[7]) / 340.0 + 36.53
    gx = _bytes_to_int(raw[8], raw[9]) / 131.0
    gy = _bytes_to_int(raw[10], raw[11]) / 131.0
    gz = _bytes_to_int(raw[12], raw[13]) / 131.0

    return {
        "ts": _ts(),
        "t": round(temp, 1),
        "ax": round(ax, 4),
        "ay": round(ay, 4),
        "az": round(az, 4),
        "gx": round(gx, 2),
        "gy": round(gy, 2),
        "gz": round(gz, 2),
        "sr": sample_rate,
    }


def _parse_url(url):
    u = url[7:] if url.startswith("http://") else url
    host_port, _, path = u.partition("/")
    path = "/" + path if path else "/"

    host = host_port
    port = 80
    if ":" in host_port:
        h, p = host_port.rsplit(":", 1)
        if p.isdigit():
            host = h
            port = int(p)
    return host_port, host, port, path


def _http_post(url, payload_bytes, token, timeout=3):
    s = None
    try:
        host_port, host, port, path = _parse_url(url)

        if _is_ipv4_literal(host):
            addr = (host, port)
        else:
            addr = socket.getaddrinfo(host, port)[0][-1]

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

        # Read full response (HTTP/1.0 â€” server closes after body)
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
                body_str = None
            else:
                raw = None
        else:
            raw = None

        return status == 200, status, resp
    except Exception as e:
        return False, e, None
    finally:
        try:
            if s:
                s.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# OTA network config
# ---------------------------------------------------------------------------
def _load_network_revision():
    try:
        with open(NETWORK_REV_FILE, "r") as f:
            return int(f.read().strip())
    except Exception:
        return 0


def _apply_network_config(resp, cfg):
    pending = resp.get("target_network_apply_pending", False)
    revision = 0
    try:
        revision = int(resp.get("target_network_revision", 0))
    except Exception:
        pass
    if not pending or revision <= 0:
        return False
    if revision == _load_network_revision():
        return False

    profiles = resp.get("target_wifi_profiles", [])
    if not isinstance(profiles, list) or not profiles:
        return False

    clean = []
    for p in profiles:
        if not isinstance(p, dict):
            continue
        ssid = str(p.get("ssid", "")).strip()
        if not ssid:
            continue
        entry = {"ssid": ssid, "password": str(p.get("password", ""))}
        sip = str(p.get("server_ip", "")).strip()
        if sip:
            entry["server_ip"] = sip
        clean.append(entry)

    if not clean:
        return False

    _save_json(WIFI_PROFILE_FILE, clean)

    hostname = str(resp.get("target_server_hostname", "")).strip()
    fallback_ip = str(resp.get("target_server_fallback_ip", "")).strip()
    fallback_ips = resp.get("target_server_fallback_ips", [])
    api_path = str(resp.get("target_api_path", "")).strip()

    if hostname:
        cfg["server_hostname"] = hostname
    if fallback_ip:
        cfg["server_fallback_ip"] = fallback_ip
    if isinstance(fallback_ips, list) and fallback_ips:
        cfg["server_fallback_ips"] = fallback_ips
    if api_path:
        cfg["api_path"] = api_path
    cfg["ssid"] = clean[0]["ssid"]
    cfg["password"] = clean[0].get("password", "")

    _save_json(CONFIG_FILE, cfg)

    try:
        with open(NETWORK_REV_FILE, "w") as f:
            f.write(str(revision))
    except Exception:
        pass

    try:
        import os
        os.remove("/last_server_ip.txt")
    except Exception:
        pass

    print("[NETCFG] Applied rev {} ({} profiles); rebooting".format(revision, len(clean)))
    time.sleep_ms(500)
    machine.reset()
    return True


def _open_portal(cfg):
    print("[PORTAL] Opening config portal on demand...")
    try:
        import boot_portal
        profiles_raw = _load_json(WIFI_PROFILE_FILE, [])
        if isinstance(profiles_raw, dict):
            profiles_raw = profiles_raw.get("profiles", [])
        defaults = {
            "portal_ssid": cfg.get("portal_ssid", "Config-ESP32"),
            "portal_password": cfg.get("portal_password", "senha123"),
            "portal_timeout_s": cfg.get("portal_timeout_s", 300),
            "server_hostname": cfg.get("server_hostname", ""),
            "server_fallback_ip": cfg.get("server_fallback_ip", ""),
            "server_fallback_ips": cfg.get("server_fallback_ips", []),
            "api_path": cfg.get("api_path", API_PATH_DEFAULT),
            "default_wifi_profiles": profiles_raw if isinstance(profiles_raw, list) else [],
        }
        boot_portal.start_config_portal(
            config_file=CONFIG_FILE,
            wifi_profile_file=WIFI_PROFILE_FILE,
            defaults=defaults,
        )
    except Exception as e:
        print("[PORTAL] Error: {}".format(e))
    time.sleep_ms(500)
    machine.reset()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
MAX_SAMPLE_RATE = 150
MIN_BATCH_SIZE = 1
TARGET_SENDS_PER_SEC = 1  # 1 HTTP request/s → batch = sample_rate amostras


def main():
    cfg = _load_json(CONFIG_FILE, {})
    if not isinstance(cfg, dict):
        cfg = {}

    device_id = str(cfg.get("device_id", "ESP32_MPU6050_ORACLE")).strip() or "ESP32_MPU6050_ORACLE"
    if device_id in ("ESP32_FAN_V7", "ESP32_MPU6050_XAMPP"):
        device_id = "ESP32_MPU6050_ORACLE"
    collection_id = str(cfg.get("collection_id", "v5_stream")).strip() or "v5_stream"
    token = str(cfg.get("auth_token", AUTH_TOKEN_DEFAULT)).strip() or AUTH_TOKEN_DEFAULT
    api_path = str(cfg.get("api_path", API_PATH_DEFAULT)).strip() or API_PATH_DEFAULT
    if not api_path.startswith("/"):
        api_path = "/" + api_path

    sample_rate = _cfg_int(cfg.get("target_sample_rate", 15), 15)
    if sample_rate < 1:
        sample_rate = 1
    if sample_rate > MAX_SAMPLE_RATE:
        sample_rate = MAX_SAMPLE_RATE

    sends_per_sec = _cfg_int(cfg.get("target_sends_per_sec", TARGET_SENDS_PER_SEC), TARGET_SENDS_PER_SEC)
    if sends_per_sec < 1:
        sends_per_sec = 1
    if sends_per_sec > 10:
        sends_per_sec = 10

    # Batch size: sample_rate / sends_per_sec (e.g. 20Hz / 1 = 20 amostras/req)
    batch_size = max(MIN_BATCH_SIZE, sample_rate // sends_per_sec)

    profiles = _load_wifi_profiles(cfg)
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)

    if not wlan.isconnected():
        if not _wifi_connect_profiles(wlan, profiles):
            print("[ERR] Wi-Fi unavailable")
            time.sleep(2)
            machine.reset()

    ssid = _connected_ssid(wlan)
    host = _resolve_server_host(cfg, profiles, ssid)
    url = "http://{}{}".format(host, api_path)
    fan_state = str(cfg.get("mode", "RAW")).strip() or "RAW"

    print("=" * 40)
    print("ESP32 MPU6050 v7.4-lite")
    print("WiFi: {} ({})".format(wlan.ifconfig()[0], ssid))
    print("URL: {}".format(url))
    print("Rate: {} Hz | Batch: {}".format(sample_rate, batch_size))
    print("=" * 40)

    i2c = machine.I2C(0, scl=machine.Pin(22), sda=machine.Pin(21))
    i2c.writeto(MPU_ADDR, b"\x6B\x00")

    period_ms = int(1000 / sample_rate)
    next_sample = time.ticks_ms()

    sent_ok = 0
    sent_fail = 0
    fail_streak = 0
    last_stat = time.ticks_ms()
    sample_buffer = []
    gc_counter = 0
    low_mem_threshold = _cfg_int(cfg.get("low_mem_threshold", 14000), 14000)

    while True:
        now = time.ticks_ms()
        if time.ticks_diff(now, next_sample) < 0:
            time.sleep_ms(1)
            continue
        next_sample = time.ticks_add(next_sample, period_ms)

        try:
            sample = _read_mpu(i2c, sample_rate)
        except Exception as e:
            print("[SENSOR] {}".format(e))
            gc.collect()
            continue

        sample["fs"] = fan_state
        sample_buffer.append(sample)

        # Only send when batch is full
        if len(sample_buffer) < batch_size:
            continue

        payload_obj = {
            "device_id": device_id,
            "collection_id": collection_id,
            "sample_rate": sample_rate,
            "batch": sample_buffer,
        }

        # Include net diagnostics once per batch
        if wlan.isconnected():
            try:
                rssi = wlan.status('rssi')
            except Exception:
                rssi = 0
            payload_obj["net"] = {
                "connected": True,
                "ssid": ssid,
                "ip": wlan.ifconfig()[0],
                "rssi": rssi,
            }

        try:
            payload = json.dumps(payload_obj).encode("utf-8")
        except Exception as e:
            print("[PAYLOAD] {}".format(e))
            sample_buffer = []
            gc.collect()
            continue

        sample_buffer = []

        ok, info, resp = _http_post(url, payload, token, timeout=4)

        if ok:
            sent_ok += 1
            fail_streak = 0

            if isinstance(resp, dict):
                # OTA network config (triggers reboot if applied)
                _apply_network_config(resp, cfg)

                # Portal on demand (triggers reboot)
                if resp.get("target_open_portal", False):
                    _open_portal(cfg)

                # Mode change
                new_mode = str(resp.get("target_mode", "")).strip()
                if new_mode and new_mode != fan_state:
                    fan_state = new_mode
                    print("[MODE] {}".format(fan_state))

                # Collection ID change
                new_col = str(resp.get("target_collection_id", "")).strip()
                if new_col and new_col != collection_id:
                    collection_id = new_col
                    print("[COL] {}".format(collection_id))

                # Rate change
                try:
                    new_rate = int(resp.get("target_rate", 0))
                except Exception:
                    new_rate = 0
                if 1 <= new_rate <= MAX_SAMPLE_RATE and new_rate != sample_rate:
                    sample_rate = new_rate
                    period_ms = int(1000 / sample_rate)
                    batch_size = max(MIN_BATCH_SIZE, sample_rate // sends_per_sec)
                    print("[RATE] {} Hz | Batch: {}".format(sample_rate, batch_size))

                # Sends-per-sec change (batch size tuning)
                try:
                    new_sps = int(resp.get("target_sends_per_sec", 0))
                except Exception:
                    new_sps = 0
                if 1 <= new_sps <= 10 and new_sps != sends_per_sec:
                    sends_per_sec = new_sps
                    batch_size = max(MIN_BATCH_SIZE, sample_rate // sends_per_sec)
                    print("[SPS] {} sends/s | Batch: {}".format(sends_per_sec, batch_size))

            resp = None
        else:
            sent_fail += 1
            fail_streak += 1
            if fail_streak <= 3 or (fail_streak % 10) == 0:
                print("[HTTP] fail {} ({})".format(fail_streak, info))

            if fail_streak in (3, 6, 12):
                print("[WIFI] Recovering stack...")
                if _wifi_recover(wlan, profiles):
                    new_ssid = _connected_ssid(wlan)
                    ssid = new_ssid
                    new_host = _resolve_server_host(cfg, profiles, new_ssid)
                    if new_host != host:
                        host = new_host
                        url = "http://{}{}".format(host, api_path)
                        print("[NET] Server -> {}".format(host))

            if fail_streak >= 20:
                print("[WIFI] Persistent failure, rebooting...")
                time.sleep_ms(200)
                machine.reset()

        # Keep heap healthy: nulifica referências grandes sempre,
        # mas gc.collect() apenas a cada 5 batches ou se memória estiver baixa.
        payload = None
        payload_obj = None
        sample = None
        resp = None
        gc_counter += 1
        if gc_counter >= 5 or gc.mem_free() < low_mem_threshold:
            gc.collect()
            gc_counter = 0

        if time.ticks_diff(now, last_stat) >= 10000:
            mem = gc.mem_free()
            print("[STAT] OK:{} FAIL:{} STREAK:{} MEM:{}".format(sent_ok, sent_fail, fail_streak, mem))
            last_stat = now


main()

