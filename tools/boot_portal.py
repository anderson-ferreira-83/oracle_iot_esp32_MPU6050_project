# boot_portal.py - on-demand Wi-Fi/server config portal for ESP32

import time

try:
    import ujson as json
except ImportError:
    import json

import machine
import network
import usocket as socket


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


def _load_json(path, default):
    try:
        with open(path, "r") as f:
            data = json.loads(f.read())
        return data
    except Exception:
        return default


def _save_json(path, value):
    try:
        with open(path, "w") as f:
            f.write(json.dumps(value))
        return True
    except Exception:
        return False


def _load_profiles(path, fallback_profiles):
    raw = _load_json(path, [])
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
                out.append({"ssid": ssid, "password": password})

    if out:
        return out
    return list(fallback_profiles)


def _save_profiles(path, profiles):
    clean = []
    for item in profiles:
        if not isinstance(item, dict):
            continue
        ssid = str(item.get("ssid", "")).strip()
        password = str(item.get("password", ""))
        if not ssid:
            continue
        if any(ssid == p.get("ssid") for p in clean):
            continue
        clean.append({"ssid": ssid, "password": password})
        if len(clean) >= 8:
            break

    if not clean:
        return False
    return _save_json(path, clean)


def _load_cfg(path):
    data = _load_json(path, {})
    if isinstance(data, dict):
        return data
    return {}


def _save_cfg(path, cfg):
    if not isinstance(cfg, dict):
        return False
    return _save_json(path, cfg)


def _scan_ssids(sta_if):
    names = []
    try:
        sta_if.active(True)
        for net in sta_if.scan():
            raw = net[0]
            try:
                ssid = raw.decode()
            except Exception:
                ssid = str(raw)
            if ssid and ssid not in names:
                names.append(ssid)
    except Exception:
        pass
    return names


def _url_decode(text):
    text = text.replace("+", " ")
    out = ""
    i = 0
    ln = len(text)
    while i < ln:
        ch = text[i]
        if ch == "%" and i + 2 < ln:
            try:
                out += chr(int(text[i + 1:i + 3], 16))
                i += 3
                continue
            except Exception:
                pass
        out += ch
        i += 1
    return out


def _html_escape(text):
    txt = str(text or "")
    txt = txt.replace("&", "&amp;")
    txt = txt.replace("<", "&lt;")
    txt = txt.replace(">", "&gt;")
    txt = txt.replace('"', "&quot;")
    return txt


def _csv_hosts(hosts):
    if not isinstance(hosts, list):
        return ""
    return ",".join(hosts)


def _send_http(conn, body, status="200 OK"):
    payload = body.encode()
    header = (
        "HTTP/1.1 {}\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        "Content-Length: {}\r\n"
        "Connection: close\r\n\r\n"
    ).format(status, len(payload))
    conn.send(header.encode() + payload)


def _portal_html(ssids, server_cfg, api_path_default, message=""):
    options = []
    for ssid in ssids:
        esc = _html_escape(ssid)
        options.append("<option value=\"{}\">{}</option>".format(esc, esc))
    options_html = "".join(options)
    msg_html = "<p>{}</p>".format(message) if message else ""

    host_val = _html_escape(server_cfg.get("server_hostname", ""))
    fallback_ip_val = _html_escape(server_cfg.get("server_fallback_ip", ""))
    fallback_ips_val = _html_escape(_csv_hosts(server_cfg.get("server_fallback_ips", [])))
    api_path_val = _html_escape(server_cfg.get("api_path", api_path_default))

    return (
        "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>Config-ESP32</title></head><body>"
        "<h3>Configurar Wi-Fi e Servidor</h3>"
        + msg_html +
        "<form method='POST' action='/save'>"
        "<label>SSID:</label><br>"
        "<input name='ssid' list='ssids' required><br>"
        "<datalist id='ssids'>" + options_html + "</datalist>"
        "<label>Senha:</label><br>"
        "<input name='password' type='password'><br><br>"
        "<hr>"
        "<label>Servidor (.local opcional):</label><br>"
        "<input name='server_hostname' value='" + host_val + "' placeholder='meu-notebook.local'><br>"
        "<label>Fallback principal (IP):</label><br>"
        "<input name='server_fallback_ip' value='" + fallback_ip_val + "' placeholder='192.168.0.108'><br>"
        "<label>Fallbacks extras (IPs por virgula):</label><br>"
        "<input name='server_fallback_ips' value='" + fallback_ips_val + "' placeholder='192.168.0.108'><br>"
        "<label>API path:</label><br>"
        "<input name='api_path' value='" + api_path_val + "' placeholder='/api/ingest'><br><br>"
        "<button type='submit'>Salvar</button>"
        "</form>"
        "<p>Depois de salvar, o ESP32 reinicia automaticamente.</p>"
        "</body></html>"
    )


def start_config_portal(config_file="/device_config.json", wifi_profile_file="/wifi_profiles.json", defaults=None):
    defaults = defaults or {}

    portal_ssid = str(defaults.get("portal_ssid", "Config-ESP32")).strip() or "Config-ESP32"
    portal_password = str(defaults.get("portal_password", "senha123"))
    timeout_s = _cfg_int(defaults.get("portal_timeout_s", 180), 180)
    if timeout_s < 30:
        timeout_s = 30

    default_profiles = defaults.get("default_wifi_profiles", [{"ssid": "Dersao83", "password": "986960440"}])
    api_path_default = _ensure_api_path(
        defaults.get("api_path", "/api/ingest"),
        "/api/ingest",
    )

    cfg = _load_cfg(config_file)
    server_hostname_default = _sanitize_host_entry(cfg.get("server_hostname", defaults.get("server_hostname", "")))
    server_fallback_ip_default = _sanitize_host_entry(cfg.get("server_fallback_ip", defaults.get("server_fallback_ip", "")))
    server_fallback_ips_default = _normalize_hosts(
        cfg.get("server_fallback_ips", defaults.get("server_fallback_ips", [])),
        server_fallback_ip_default,
    )

    ap_if = network.WLAN(network.AP_IF)
    ap_if.active(True)
    try:
        ap_if.config(essid=portal_ssid, password=portal_password, authmode=3)
    except Exception:
        ap_if.config(essid=portal_ssid)

    sta_if = network.WLAN(network.STA_IF)
    sta_if.active(True)

    portal_ip = ap_if.ifconfig()[0]
    print("Conecte em '{}' e abra http://{}".format(portal_ssid, portal_ip))

    srv = socket.socket()
    srv.settimeout(1)
    try:
        srv.bind(("0.0.0.0", 80))
        srv.listen(1)
    except Exception as e:
        print("Falha ao abrir portal: {}".format(e))
        try:
            srv.close()
        except Exception:
            pass
        ap_if.active(False)
        return False

    started = time.time()
    while time.time() - started < timeout_s:
        try:
            conn, _ = srv.accept()
        except OSError:
            continue
        except Exception:
            break

        try:
            req = conn.recv(2048)
            req_txt = req.decode()
            line = req_txt.split("\r\n", 1)[0]
            parts = line.split(" ")
            method = parts[0] if len(parts) > 0 else "GET"
            path = parts[1] if len(parts) > 1 else "/"

            current_cfg = _load_cfg(config_file)
            current_server = {
                "server_hostname": _sanitize_host_entry(current_cfg.get("server_hostname", server_hostname_default)),
                "server_fallback_ip": _sanitize_host_entry(current_cfg.get("server_fallback_ip", server_fallback_ip_default)),
                "server_fallback_ips": _normalize_hosts(
                    current_cfg.get("server_fallback_ips", server_fallback_ips_default),
                    _sanitize_host_entry(current_cfg.get("server_fallback_ip", server_fallback_ip_default)),
                ),
                "api_path": _ensure_api_path(current_cfg.get("api_path", api_path_default), api_path_default),
            }

            if method == "POST" and path.startswith("/save"):
                body = ""
                if "\r\n\r\n" in req_txt:
                    body = req_txt.split("\r\n\r\n", 1)[1]

                params = {}
                for item in body.split("&"):
                    if "=" in item:
                        k, v = item.split("=", 1)
                        params[k] = _url_decode(v)

                ssid = str(params.get("ssid", "")).strip()
                password = str(params.get("password", ""))
                host = _sanitize_host_entry(params.get("server_hostname", ""))
                fallback_ip = _sanitize_host_entry(params.get("server_fallback_ip", ""))
                fallback_ips_raw = str(params.get("server_fallback_ips", "")).strip()
                api_path = _ensure_api_path(params.get("api_path", api_path_default), api_path_default)

                if not ssid:
                    _send_http(conn, _portal_html(_scan_ssids(sta_if), current_server, api_path_default, "SSID obrigatorio."))
                    continue

                if host:
                    current_cfg["server_hostname"] = host
                else:
                    current_cfg["server_hostname"] = ""

                if fallback_ip:
                    current_cfg["server_fallback_ip"] = fallback_ip

                if fallback_ips_raw:
                    current_cfg["server_fallback_ips"] = _normalize_hosts(
                        fallback_ips_raw,
                        current_cfg.get("server_fallback_ip", fallback_ip),
                    )
                else:
                    current_cfg["server_fallback_ips"] = _normalize_hosts(
                        current_cfg.get("server_fallback_ips", []),
                        current_cfg.get("server_fallback_ip", fallback_ip),
                    )

                current_cfg["api_path"] = api_path
                current_cfg["ssid"] = ssid
                current_cfg["password"] = password
                current_cfg["wifi_profile_file"] = wifi_profile_file

                profiles = _load_profiles(wifi_profile_file, default_profiles)
                merged = [{"ssid": ssid, "password": password}]
                for p in profiles:
                    if p.get("ssid") != ssid:
                        merged.append(p)

                ok_cfg = _save_cfg(config_file, current_cfg)
                ok_profiles = _save_profiles(wifi_profile_file, merged)

                if ok_cfg and ok_profiles:
                    _send_http(conn, "<html><body><h3>Salvo com sucesso.</h3><p>Reiniciando ESP32...</p></body></html>")
                    conn.close()
                    time.sleep(1)
                    machine.reset()
                else:
                    _send_http(
                        conn,
                        _portal_html(_scan_ssids(sta_if), current_server, api_path_default, "Falha ao salvar configuracoes."),
                        "500 Internal Server Error",
                    )
            else:
                _send_http(conn, _portal_html(_scan_ssids(sta_if), current_server, api_path_default))
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    try:
        srv.close()
    except Exception:
        pass
    ap_if.active(False)
    print("Portal expirou sem configuracao.")
    return False

