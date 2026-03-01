# boot.py - lightweight startup with optional on-demand config portal

import gc
import time

try:
    import ujson as json
except ImportError:
    import json

import machine
import network
import usocket as socket

try:
    import micropython
except Exception:
    micropython = None


# ---------------------------------------------------------------------------
# Paths and defaults
# ---------------------------------------------------------------------------
def _fs_path(path_value, fallback):
    path = str(path_value or "").strip()
    if not path:
        path = fallback
    if not path.startswith("/"):
        path = "/" + path
    return path


CONFIG_FILE = _fs_path("device_config.json", "/device_config.json")
DEFAULT_WIFI_PROFILE_FILE = "/wifi_profiles.json"
DEFAULT_API_PATH = "/api/ingest"

FALLBACK_WIFI_PROFILES = [
    {"ssid": "S20_Ders@0", "password": "F0xbam1844"},
]


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------
def _load_json_file(path, default):
    try:
        with open(path, "r") as f:
            data = json.loads(f.read())
        return data
    except Exception:
        return default


def _load_boot_cfg():
    data = _load_json_file(CONFIG_FILE, {})
    if isinstance(data, dict):
        return data
    return {}


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


def _transport_mode(cfg):
    mode = str(cfg.get("transport_mode", "wifi")).strip().lower()
    if mode == "ble":
        return "ble"
    if mode == "usb":
        return "usb"
    if mode == "espnow":
        return "espnow"
    if mode == "espnow_rx":
        return "espnow_rx"
    if mode == "espnow_rx_usb":
        return "espnow_rx_usb"
    return "wifi"


def _is_ipv4_literal(value):
    parts = str(value or "").split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not part.isdigit():
            return False
        n = int(part)
        if n < 0 or n > 255:
            return False
    return True


def _cfg_dns_server(cfg):
    dns = str(cfg.get("dns_server", "")).strip()
    if _is_ipv4_literal(dns):
        return dns

    raw = cfg.get("dns_servers", [])
    if isinstance(raw, str):
        raw = raw.replace(";", ",").replace("\n", ",").split(",")
    if isinstance(raw, list):
        for item in raw:
            cand = str(item or "").strip()
            if _is_ipv4_literal(cand):
                return cand
    return ""


def _apply_dns_override(sta_if, dns_server):
    dns = str(dns_server or "").strip()
    if not _is_ipv4_literal(dns):
        return

    try:
        ip, mask, gw, current_dns = sta_if.ifconfig()
    except Exception:
        return

    if str(current_dns) == dns:
        return

    try:
        sta_if.ifconfig((ip, mask, gw, dns))
        print("DNS override aplicado: {}".format(dns))
    except Exception as e:
        print("Falha ao aplicar DNS override: {}".format(e))


def _retry_delay_s(cfg, failure_count):
    base = _cfg_int(cfg.get("boot_retry_delay_s", 15), 15)
    step = _cfg_int(cfg.get("boot_retry_step_s", 15), 15)
    max_delay = _cfg_int(cfg.get("boot_retry_max_delay_s", 120), 120)

    if base < 3:
        base = 3
    if step < 0:
        step = 0
    if max_delay < base:
        max_delay = base
    if failure_count < 1:
        failure_count = 1

    delay = base + (failure_count - 1) * step
    if delay > max_delay:
        delay = max_delay
    return delay


def _should_open_portal(cfg, failure_count):
    every = _cfg_int(cfg.get("boot_open_portal_every_failures", 4), 4)
    if every <= 0:
        return False
    if failure_count <= 0:
        return False
    return (failure_count % every) == 0


def _boot_grace_ms(cfg):
    delay_ms = _cfg_int(cfg.get("boot_grace_ms", 1200), 1200)
    if delay_ms < 0:
        delay_ms = 0
    if delay_ms > 10000:
        delay_ms = 10000
    return delay_ms


def _safe_boot_requested(cfg):
    pin_num = _cfg_int(cfg.get("boot_safe_pin", 0), 0)
    active_low = _cfg_bool(cfg.get("boot_safe_pin_active_low", True), True)
    if pin_num < 0:
        return False

    pull = None
    if active_low and hasattr(machine.Pin, "PULL_UP"):
        pull = machine.Pin.PULL_UP
    elif (not active_low) and hasattr(machine.Pin, "PULL_DOWN"):
        pull = machine.Pin.PULL_DOWN

    try:
        if pull is None:
            pin = machine.Pin(pin_num, machine.Pin.IN)
        else:
            pin = machine.Pin(pin_num, machine.Pin.IN, pull)
        value = pin.value()
    except Exception:
        return False

    if active_low:
        return value == 0
    return value == 1


def _sanitize_host_entry(value):
    host = str(value or "").strip()
    if host.startswith("http://"):
        host = host[7:]
    elif host.startswith("https://"):
        host = host[8:]
    if "/" in host:
        host = host.split("/", 1)[0]
    return host.strip()


def _normalize_hosts(raw_hosts, fallback_single=""):
    values = []
    if isinstance(raw_hosts, list):
        values = raw_hosts
    elif isinstance(raw_hosts, str):
        values = raw_hosts.replace("\n", ",").replace(";", ",").split(",")

    out = []
    for item in values:
        host = _sanitize_host_entry(item)
        if host and host not in out:
            out.append(host)

    single = _sanitize_host_entry(fallback_single)
    if single and single not in out:
        out.insert(0, single)
    return out


def _ensure_api_path(path_value, default_value):
    path = str(path_value or "").strip()
    if not path:
        path = default_value
    if not path.startswith("/"):
        path = "/" + path
    return path


def _normalize_profiles(raw_profiles, fallback_profiles):
    out = []
    if isinstance(raw_profiles, list):
        for item in raw_profiles:
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
    return list(fallback_profiles)


def _wifi_profile_file(cfg):
    return _fs_path(cfg.get("wifi_profile_file", DEFAULT_WIFI_PROFILE_FILE), DEFAULT_WIFI_PROFILE_FILE)


def _load_profiles(cfg):
    profile_file = _wifi_profile_file(cfg)
    raw = _load_json_file(profile_file, [])
    if isinstance(raw, dict):
        raw = raw.get("profiles", [])

    defaults = _normalize_profiles(cfg.get("default_wifi_profiles", FALLBACK_WIFI_PROFILES), FALLBACK_WIFI_PROFILES)
    return _normalize_profiles(raw, defaults)


def _server_cfg(cfg):
    host_default = _sanitize_host_entry(cfg.get("server_hostname", ""))
    ip_default = _sanitize_host_entry(cfg.get("server_fallback_ip", "10.125.237.165:8000"))
    api_path = _ensure_api_path(cfg.get("api_path", DEFAULT_API_PATH), DEFAULT_API_PATH)
    ip_list = _normalize_hosts(cfg.get("server_fallback_ips", []), ip_default)

    return {
        "server_hostname": host_default,
        "server_fallback_ip": ip_default,
        "server_fallback_ips": ip_list,
        "api_path": api_path,
    }


# ---------------------------------------------------------------------------
# Connectivity checks
# ---------------------------------------------------------------------------
def _connected_ssid(sta_if):
    try:
        raw = sta_if.config("essid")
        if isinstance(raw, bytes):
            raw = raw.decode()
        return str(raw or "").strip()
    except Exception:
        return ""


def _split_host_port(host_entry):
    host = _sanitize_host_entry(host_entry)
    port = 80
    if ":" in host:
        maybe_host, maybe_port = host.rsplit(":", 1)
        if maybe_port.isdigit():
            host = maybe_host
            port = int(maybe_port)
    return host, port


def _server_candidates(server_cfg):
    out = []
    host = _sanitize_host_entry(server_cfg.get("server_hostname", ""))
    if host:
        out.append(host)

    ip = _sanitize_host_entry(server_cfg.get("server_fallback_ip", ""))
    if ip and ip not in out:
        out.append(ip)

    for item in server_cfg.get("server_fallback_ips", []):
        h = _sanitize_host_entry(item)
        if h and h not in out:
            out.append(h)

    return out


def _tcp_probe(host_entry, timeout_s=1):
    host, port = _split_host_port(host_entry)
    if not host:
        return False

    sock = None
    try:
        parts = host.split(".")
        is_ipv4 = (
            len(parts) == 4 and
            all(part.isdigit() and 0 <= int(part) <= 255 for part in parts)
        )
        if is_ipv4:
            addr = (host, port)
        else:
            addr = socket.getaddrinfo(host, port)[0][-1]
        sock = socket.socket()
        sock.settimeout(timeout_s)
        sock.connect(addr)
        return True
    except Exception:
        return False
    finally:
        try:
            if sock:
                sock.close()
        except Exception:
            pass


def _server_reachable(sta_if, server_cfg, timeout_s=1):
    if not sta_if.isconnected():
        return False

    candidates = _server_candidates(server_cfg)
    if not candidates:
        return True

    for host in candidates:
        if _tcp_probe(host, timeout_s):
            print("Servidor alcancavel via '{}'".format(host))
            return True

    print("Servidor indisponivel em: {}".format(", ".join(candidates)))
    return False


def _profile_server_cfg(profile, base_cfg):
    sip = str(profile.get("server_ip", "")).strip()
    if not sip:
        return base_cfg
    cfg = dict(base_cfg)
    candidates = list(cfg.get("server_fallback_ips", []))
    if sip not in candidates:
        candidates.insert(0, sip)
    cfg["server_fallback_ips"] = candidates
    if not cfg.get("server_fallback_ip"):
        cfg["server_fallback_ip"] = sip
    return cfg


def _try_connect_profiles(
    sta_if,
    profiles,
    server_cfg,
    timeout_s=1,
    require_server_probe=False,
    dns_server="",
):
    for profile in profiles:
        ssid = str(profile.get("ssid", "")).strip()
        password = str(profile.get("password", ""))
        if not ssid:
            continue

        print("Tentando Wi-Fi '{}'".format(ssid))
        try:
            sta_if.disconnect()
        except Exception:
            pass

        try:
            sta_if.connect(ssid, password)
        except Exception:
            continue

        for _ in range(12):
            if sta_if.isconnected():
                print("Wi-Fi conectado: {}".format(sta_if.ifconfig()[0]))
                _apply_dns_override(sta_if, dns_server)
                if not require_server_probe:
                    return True

                probe_cfg = _profile_server_cfg(profile, server_cfg)
                if _server_reachable(sta_if, probe_cfg, timeout_s):
                    return True

                print("Sem rota para servidor em '{}'".format(ssid))
                try:
                    sta_if.disconnect()
                except Exception:
                    pass
                time.sleep(1)
                break
            time.sleep(1)

    return False


def connect_wifi_and_server():
    cfg = _load_boot_cfg()
    profiles = _load_profiles(cfg)
    srv_cfg = _server_cfg(cfg)
    dns_server = _cfg_dns_server(cfg)
    strict_probe = _cfg_bool(
        cfg.get("boot_require_server_probe", cfg.get("require_server_on_boot", False)),
        False,
    )
    timeout_s = _cfg_int(cfg.get("server_probe_timeout_s", 1), 1)
    if timeout_s < 1:
        timeout_s = 1
    if timeout_s > 3:
        timeout_s = 3

    ap_if = network.WLAN(network.AP_IF)
    ap_if.active(False)

    sta_if = network.WLAN(network.STA_IF)
    sta_if.active(True)

    if sta_if.isconnected():
        _apply_dns_override(sta_if, dns_server)
        current_ssid = _connected_ssid(sta_if)
        if current_ssid:
            print("Wi-Fi ja conectado '{}' : {}".format(current_ssid, sta_if.ifconfig()))
        else:
            print("Wi-Fi ja conectado: {}".format(sta_if.ifconfig()))

        # Use per-profile server_ip if available for the connected SSID
        probe_cfg = srv_cfg
        for p in profiles:
            if str(p.get("ssid", "")).strip() == current_ssid:
                probe_cfg = _profile_server_cfg(p, srv_cfg)
                break

        if strict_probe:
            if _server_reachable(sta_if, probe_cfg, timeout_s):
                return True, cfg

            print("Wi-Fi conectado, mas servidor inacessivel. Tentando outros perfis...")
            try:
                sta_if.disconnect()
            except Exception:
                pass
            time.sleep(1)
        else:
            if not _server_reachable(sta_if, probe_cfg, timeout_s):
                print("Wi-Fi OK; servidor ainda indisponivel no boot. Seguindo para main_lite.")
            return True, cfg

    if _try_connect_profiles(
        sta_if,
        profiles,
        srv_cfg,
        timeout_s,
        require_server_probe=strict_probe,
        dns_server=dns_server,
    ):
        return True, cfg

    return False, cfg


def _start_config_portal(cfg):
    try:
        import boot_portal
    except Exception as e:
        print("Portal indisponivel: {}".format(e))
        return False

    defaults = {
        "portal_ssid": cfg.get("portal_ssid", "Config-ESP32"),
        "portal_password": cfg.get("portal_password", "senha123"),
        "portal_timeout_s": cfg.get("portal_timeout_s", 180),
        "server_hostname": cfg.get("server_hostname", ""),
        "server_fallback_ip": cfg.get("server_fallback_ip", ""),
        "server_fallback_ips": cfg.get("server_fallback_ips", []),
        "api_path": cfg.get("api_path", DEFAULT_API_PATH),
        "default_wifi_profiles": _normalize_profiles(
            cfg.get("default_wifi_profiles", FALLBACK_WIFI_PROFILES),
            FALLBACK_WIFI_PROFILES,
        ),
    }

    print("Iniciando portal de configuracao Wi-Fi...")
    return bool(
        boot_portal.start_config_portal(
            config_file=CONFIG_FILE,
            wifi_profile_file=_wifi_profile_file(cfg),
            defaults=defaults,
        )
    )


def _prepare_for_main_import():
    try:
        gc.collect()
    except Exception:
        pass

    try:
        if micropython is not None:
            micropython.opt_level(3)
    except Exception:
        pass

    keep = {
        "__name__",
        "__file__",
        "__builtins__",
        "gc",
        "machine",
        "micropython",
        "time",
    }

    for key in list(globals().keys()):
        if key in keep:
            continue
        if key.startswith("__"):
            continue
        try:
            del globals()[key]
        except Exception:
            pass

    try:
        gc.collect()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Boot execution
# ---------------------------------------------------------------------------
boot_failures = 0
cfg = _load_boot_cfg()
transport_mode = _transport_mode(cfg)
ok = False
safe_boot = False

grace_ms = _boot_grace_ms(cfg)
if grace_ms > 0:
    print("Boot grace {} ms (Ctrl+C / BOOT para modo seguro)...".format(grace_ms))
    try:
        time.sleep_ms(grace_ms)
    except Exception:
        time.sleep(grace_ms / 1000.0)

safe_boot = _safe_boot_requested(cfg)
if safe_boot:
    print("Modo seguro solicitado no boot; nao iniciando main automaticamente.")

if (not safe_boot) and transport_mode in ("ble", "usb", "espnow", "espnow_rx_usb"):
    ok = True
    if transport_mode == "ble":
        print("Modo BLE selecionado. Ignorando etapa de Wi-Fi no boot.")
    elif transport_mode in ("espnow", "espnow_rx_usb"):
        print("Modo ESP-NOW TX / RX-USB selecionado. Ignorando etapa de Wi-Fi no boot.")
    else:
        print("Modo USB selecionado. Ignorando etapa de Wi-Fi no boot.")
elif not safe_boot:
    while True:
        ok, cfg = connect_wifi_and_server()
        if ok:
            break

        boot_failures += 1
        if _should_open_portal(cfg, boot_failures):
            _start_config_portal(cfg)

        if not _cfg_bool(cfg.get("boot_retry_enabled", True), True):
            print("Sem conexao Wi-Fi. Retry automatico desativado.")
            break

        delay_s = _retry_delay_s(cfg, boot_failures)
        print(
            "Sem conexao Wi-Fi/servidor. Nova tentativa em {}s (falha #{})".format(
                delay_s,
                boot_failures,
            )
        )
        time.sleep(delay_s)

if ok:
    if transport_mode == "ble":
        print("Executando main_ble.py a partir do boot.py...")
        try:
            _prepare_for_main_import()
            import main_ble
        except MemoryError:
            print("MemoryError em main_ble; reiniciando...")
            try:
                time.sleep(1)
            except Exception:
                pass
            machine.reset()
        except Exception as e:
            print("Falha ao iniciar main_ble: {}".format(e))
            try:
                time.sleep(1)
            except Exception:
                pass
            machine.reset()
    elif transport_mode == "usb":
        print("Executando main_usb.py a partir do boot.py...")
        try:
            _prepare_for_main_import()
            import main_usb
        except MemoryError:
            print("MemoryError em main_usb; reiniciando...")
            try:
                time.sleep(1)
            except Exception:
                pass
            machine.reset()
        except Exception as e:
            print("Falha ao iniciar main_usb: {}".format(e))
            try:
                time.sleep(1)
            except Exception:
                pass
            machine.reset()
    elif transport_mode == "espnow":
        print("Executando main_espnow_tx.py a partir do boot.py...")
        try:
            _prepare_for_main_import()
            import main_espnow_tx
        except MemoryError:
            print("MemoryError em main_espnow_tx; reiniciando...")
            try:
                time.sleep(1)
            except Exception:
                pass
            machine.reset()
        except Exception as e:
            print("Falha ao iniciar main_espnow_tx: {}".format(e))
            try:
                time.sleep(1)
            except Exception:
                pass
            machine.reset()
    elif transport_mode == "espnow_rx":
        print("Executando main_espnow_rx.py a partir do boot.py...")
        try:
            _prepare_for_main_import()
            import main_espnow_rx
        except MemoryError:
            print("MemoryError em main_espnow_rx; reiniciando...")
            try:
                time.sleep(1)
            except Exception:
                pass
            machine.reset()
        except Exception as e:
            print("Falha ao iniciar main_espnow_rx: {}".format(e))
            try:
                time.sleep(1)
            except Exception:
                pass
            machine.reset()
    elif transport_mode == "espnow_rx_usb":
        print("Executando main_espnow_rx_usb.py a partir do boot.py...")
        try:
            _prepare_for_main_import()
            import main_espnow_rx_usb
        except MemoryError:
            print("MemoryError em main_espnow_rx_usb; reiniciando...")
            try:
                time.sleep(1)
            except Exception:
                pass
            machine.reset()
        except Exception as e:
            print("Falha ao iniciar main_espnow_rx_usb: {}".format(e))
            try:
                time.sleep(1)
            except Exception:
                pass
            machine.reset()
    else:
        use_lite = bool(cfg.get("force_main_lite", True))
        if use_lite:
            print("Executando main_lite.py a partir do boot.py...")
            try:
                _prepare_for_main_import()
                import main_lite
            except MemoryError:
                print("MemoryError em main_lite; reiniciando...")
                try:
                    time.sleep(1)
                except Exception:
                    pass
                machine.reset()
            except Exception as e:
                print("Falha ao iniciar main_lite: {}".format(e))
                try:
                    time.sleep(1)
                except Exception:
                    pass
                machine.reset()
        else:
            print("Executando main.py a partir do boot.py...")
            try:
                _prepare_for_main_import()
                import main
            except MemoryError:
                print("MemoryError em main.py; tentando main_lite.py...")
                try:
                    gc.collect()
                except Exception:
                    pass
                try:
                    import main_lite
                except Exception as e2:
                    print("Falha em main_lite.py: {}".format(e2))
                    print("Reiniciando...")
                    try:
                        time.sleep(1)
                    except Exception:
                        pass
                    machine.reset()
            except Exception as e:
                print("Falha ao iniciar main.py: {}".format(e))
                try:
                    time.sleep(1)
                except Exception:
                    pass
                machine.reset()
else:
    if safe_boot:
        print("Boot finalizado em modo seguro.")
    else:
        print("Sem conexao Wi-Fi. Boot finalizado sem iniciar main.")

