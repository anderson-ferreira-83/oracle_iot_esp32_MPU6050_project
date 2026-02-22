from __future__ import annotations

import json
import os
import re
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import oracledb
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


TZ_SP = ZoneInfo("America/Sao_Paulo")
BASE_DIR = Path(__file__).resolve().parents[1]
API_DIR = BASE_DIR / "api"
LOG_DIR = BASE_DIR / "logs"
MODELS_ADAPTED_DIR = BASE_DIR / "models" / "adapted"

AUTH_TOKEN = os.getenv("API_AUTH_TOKEN", "F0xb@m986960440")
DEFAULT_API_PATH = "/api/ingest"

_db_pool: Optional[oracledb.ConnectionPool] = None
_db_pool_lock = threading.Lock()
_column_cache: Dict[str, Dict[str, bool]] = {}


def env(name: str, default: str) -> str:
    v = os.getenv(name)
    return default if v is None or v == "" else v


def now_sp_str() -> str:
    return datetime.now(TZ_SP).strftime("%Y-%m-%d %H:%M:%S")


def now_iso() -> str:
    return datetime.now(TZ_SP).isoformat()


def microtime() -> float:
    return datetime.now().timestamp()


def oracle_dsn() -> str:
    explicit = os.getenv("ORACLE_DSN")
    if explicit:
        return explicit
    host = env("ORACLE_HOST", "localhost")
    port = env("ORACLE_PORT", "1521")
    service = env("ORACLE_SERVICE_NAME", "xepdb1")
    return f"{host}:{port}/{service}"


def get_pool() -> oracledb.ConnectionPool:
    global _db_pool
    if _db_pool is not None:
        return _db_pool
    with _db_pool_lock:
        if _db_pool is None:
            _db_pool = oracledb.create_pool(
                user=env("ORACLE_USER", "student"),
                password=env("ORACLE_PASSWORD", "oracle"),
                dsn=oracle_dsn(),
                min=1,
                max=8,
                increment=1,
            )
    return _db_pool


@contextmanager
def db_conn():
    conn = get_pool().acquire()
    try:
        yield conn
    finally:
        conn.close()


def _serialize_value(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def rows_to_dict(cursor: oracledb.Cursor, rows: List[Tuple[Any, ...]]) -> List[Dict[str, Any]]:
    cols = [d[0].lower() for d in (cursor.description or [])]
    return [{k: _serialize_value(v) for k, v in zip(cols, row)} for row in rows]


def fetch_all(conn: oracledb.Connection, sql: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    cur = conn.cursor()
    try:
        cur.execute(sql, params or {})
        rows = cur.fetchall()
        return rows_to_dict(cur, rows)
    finally:
        cur.close()


def fetch_one(conn: oracledb.Connection, sql: str, params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    cur = conn.cursor()
    try:
        cur.execute(sql, params or {})
        row = cur.fetchone()
        if row is None:
            return None
        return rows_to_dict(cur, [row])[0]
    finally:
        cur.close()


def exec_sql(conn: oracledb.Connection, sql: str, params: Optional[Dict[str, Any]] = None) -> None:
    cur = conn.cursor()
    try:
        cur.execute(sql, params or {})
    finally:
        cur.close()


def oracle_error_code(exc: Exception) -> Optional[int]:
    if getattr(exc, "args", None):
        first = exc.args[0]
        code = getattr(first, "code", None)
        if isinstance(code, int):
            return code
    m = re.search(r"ORA-(\d{5})", str(exc))
    return int(m.group(1)) if m else None


def require_bearer(authorization: Optional[str]) -> None:
    token = None
    if authorization:
        m = re.search(r"Bearer\s+(\S+)", authorization, flags=re.IGNORECASE)
        if m:
            token = m.group(1).strip()
    if token != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="Acesso nao autorizado. Token invalido ou ausente.")


def sanitize_device_id(raw: Any) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    v = re.sub(r"[^A-Za-z0-9_.-]", "_", raw.strip())
    if v == "":
        return None
    if v in {"ESP32_FAN_V7", "ESP32_MPU6050_XAMPP"}:
        v = "ESP32_MPU6050_ORACLE"
    return v[:80]


def sanitize_enum(raw: Any, allowed: set[str], fallback: str) -> str:
    if not isinstance(raw, (str, int, float)):
        return fallback
    v = re.sub(r"[^A-Z0-9_.-]", "_", str(raw).strip().upper())
    if v in allowed:
        return v
    return fallback


def sanitize_bool(raw: Any, fallback: bool = False) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return int(raw) != 0
    if isinstance(raw, str):
        t = raw.strip().lower()
        if t in {"1", "true", "yes", "on"}:
            return True
        if t in {"0", "false", "no", "off"}:
            return False
    return fallback


HOTSPOT_SSID_PATTERNS = {"S20_Ders@0", "Galaxy", "iPhone", "Redmi", "Motorola", "Pixel"}


def _is_hotspot_ssid(ssid: Any) -> bool:
    if not isinstance(ssid, str) or not ssid.strip():
        return False
    s = ssid.strip()
    for pattern in HOTSPOT_SSID_PATTERNS:
        if pattern.lower() in s.lower():
            return True
    return False


def cmd_speed_from_mode(mode: Any) -> str:
    m = sanitize_enum(mode, {"RAW", "PAUSE", "LOW", "MEDIUM", "HIGH", "OFF"}, "UNKNOWN")
    if m in {"LOW", "MEDIUM", "HIGH", "OFF"}:
        return m
    if m == "PAUSE":
        return "OFF"
    return "UNKNOWN"


def default_state(custom: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    base = {
        "mode": "PAUSE",
        "sample_rate": 4,
        "ingest_enabled": True,
        "cmd_speed_label": "UNKNOWN",
        "rot_state_label": "UNKNOWN",
        "use_state_label": "UNKNOWN",
        "vib_profile_label": "UNKNOWN",
        "label_source": "CONTROL",
        "transition_marker": 0,
        "network_revision": 0,
        "network_apply_pending": False,
        "open_portal": False,
        "wifi_profiles": [],
        "server_hostname": "",
        "server_fallback_ip": "",
        "server_fallback_ips": [],
        "api_path": DEFAULT_API_PATH,
        "collection_id": "v5_stream",
    }
    if custom:
        base.update(custom)
    return base


def state_file_path(device_id: Optional[str]) -> Path:
    if not device_id:
        return API_DIR / "control_state.json"
    d = API_DIR / "control_states"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"control_state_{device_id}.json"


def sanitize_state(state: Optional[Dict[str, Any]], defaults: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    base = default_state(defaults)
    src = state if isinstance(state, dict) else {}
    out = dict(base)
    out.update(src)
    out["mode"] = sanitize_enum(out.get("mode"), {"RAW", "PAUSE", "LOW", "MEDIUM", "HIGH", "OFF"}, base["mode"])
    try:
        out["sample_rate"] = max(1, min(100, int(round(float(out.get("sample_rate"))))))
    except Exception:
        out["sample_rate"] = base["sample_rate"]
    out["ingest_enabled"] = sanitize_bool(out.get("ingest_enabled"), base["ingest_enabled"])
    out["cmd_speed_label"] = sanitize_enum(out.get("cmd_speed_label"), {"OFF", "LOW", "MEDIUM", "HIGH", "UNKNOWN"}, cmd_speed_from_mode(out["mode"]))
    out["rot_state_label"] = sanitize_enum(out.get("rot_state_label"), {"ROTATING", "STOPPED", "UNKNOWN"}, "UNKNOWN")
    out["use_state_label"] = sanitize_enum(out.get("use_state_label"), {"IN_USE", "NO_LOAD", "UNKNOWN"}, "UNKNOWN")
    out["vib_profile_label"] = sanitize_enum(out.get("vib_profile_label"), {"NATURAL", "ABNORMAL", "UNKNOWN"}, "UNKNOWN")
    out["label_source"] = sanitize_enum(out.get("label_source"), {"CONTROL", "AUTO", "MANUAL", "DEVICE", "BACKFILL", "UNKNOWN"}, "CONTROL")
    out["transition_marker"] = 1 if sanitize_bool(out.get("transition_marker"), False) else 0
    out["network_apply_pending"] = sanitize_bool(out.get("network_apply_pending"), False)
    out["open_portal"] = sanitize_bool(out.get("open_portal"), False)
    try:
        out["sends_per_sec"] = max(1, min(10, int(round(float(out.get("sends_per_sec", 1))))))
    except Exception:
        out["sends_per_sec"] = 1
    try:
        out["transition_duration_s"] = max(3, min(60, int(round(float(out.get("transition_duration_s", 10))))))
    except Exception:
        out["transition_duration_s"] = 10
    return out


def load_state(device_id: Optional[str], defaults: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    base = default_state(defaults)
    target = state_file_path(device_id)
    legacy = state_file_path(None)
    raw = None
    if target.exists():
        raw = target.read_text(encoding="utf-8")
    elif device_id and legacy.exists():
        raw = legacy.read_text(encoding="utf-8")
    decoded: Dict[str, Any] = {}
    if raw:
        try:
            j = json.loads(raw)
            if isinstance(j, dict):
                decoded = j
        except Exception:
            pass
    merged = dict(base)
    merged.update(decoded)
    return sanitize_state(merged, base)


def save_state(state: Dict[str, Any], device_id: Optional[str]) -> bool:
    try:
        state_file_path(device_id).write_text(json.dumps(sanitize_state(state), indent=2, ensure_ascii=False), encoding="utf-8")
        return True
    except Exception:
        return False


def device_status_path(device_id: Optional[str]) -> Optional[Path]:
    clean = sanitize_device_id(device_id) if device_id else None
    if not clean:
        return None
    d = API_DIR / "device_status"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"device_status_{clean}.json"


def extract_device_status(payload: Any) -> Dict[str, Any]:
    out = {
        "connected": None,
        "ssid": None,
        "ip": None,
        "rssi": None,
        "send_fail_streak": None,
        "network_fail_streak": None,
        "last_send_error": None,
        "last_endpoint": None,
        "learned_server_ip": None,
        "buffer_len": None,
        "flash_queue_len": None,
        "samples_pending": None,
        "dropped_samples": None,
        "persist_enabled": None,
        "fw_ts": None,
    }
    if not isinstance(payload, dict):
        return out
    net = payload.get("net")
    if not isinstance(net, dict):
        return out
    for key in out.keys():
        if key in net:
            out[key] = net[key]
    if "connected" in net:
        out["connected"] = sanitize_bool(net.get("connected"), False)
    if "persist_enabled" in net:
        out["persist_enabled"] = sanitize_bool(net.get("persist_enabled"), False)
    return out


def save_device_status(device_id: Optional[str], status: Dict[str, Any]) -> bool:
    p = device_status_path(device_id)
    if p is None:
        return False
    payload = dict(status)
    payload["device_id"] = sanitize_device_id(device_id)
    payload["updated_at"] = microtime()
    payload["updated_at_iso"] = now_sp_str()
    try:
        p.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        return True
    except Exception:
        return False


def load_device_status(device_id: Optional[str]) -> Optional[Dict[str, Any]]:
    p = device_status_path(device_id)
    if p is None or not p.exists():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(d, dict):
        return None
    age_s = None
    if isinstance(d.get("updated_at"), (int, float)):
        age_s = max(0.0, microtime() - float(d["updated_at"]))
    d["age_s"] = round(age_s, 3) if age_s is not None else None
    if age_s is None:
        d["freshness"] = "no_data"
    elif age_s <= 3:
        d["freshness"] = "live"
    elif age_s <= 10:
        d["freshness"] = "delay"
    else:
        d["freshness"] = "stale"
    return d


def table_columns(conn: oracledb.Connection, table_name: str = "sensor_data") -> Dict[str, bool]:
    key = table_name.lower()
    if key in _column_cache:
        return _column_cache[key]
    rows = fetch_all(conn, "SELECT column_name FROM user_tab_columns WHERE table_name = :t", {"t": table_name.upper()})
    cols = {str(r.get("column_name", "")).lower(): True for r in rows if r.get("column_name")}
    _column_cache[key] = cols
    return cols


def ts_column(conn: oracledb.Connection) -> str:
    cols = table_columns(conn, "sensor_data")
    if "ts_epoch" in cols:
        return "ts_epoch"
    if "timestamp" in cols:
        return "timestamp"
    return "ts_epoch"


def norm_row(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(row, dict):
        return row
    if "timestamp" not in row and "ts_epoch" in row:
        row["timestamp"] = row["ts_epoch"]
    return row


def norm_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [norm_row(r) or {} for r in rows]


def network_targets_from_state(state: Dict[str, Any]) -> Dict[str, Any]:
    target_network_revision = int(state.get("network_revision", 0)) if isinstance(state.get("network_revision"), (int, float)) else 0
    target_pending = sanitize_bool(state.get("network_apply_pending"), False)
    target_wifi_profiles = state.get("wifi_profiles", []) if target_pending and isinstance(state.get("wifi_profiles"), list) else []
    target_server_hostname = str(state.get("server_hostname", "")) if target_pending else ""
    target_server_fallback_ip = str(state.get("server_fallback_ip", "")) if target_pending else ""
    target_server_fallback_ips = state.get("server_fallback_ips", []) if target_pending and isinstance(state.get("server_fallback_ips"), list) else []
    target_api_path = str(state.get("api_path", DEFAULT_API_PATH)) if target_pending else DEFAULT_API_PATH
    target_open_portal = sanitize_bool(state.get("open_portal"), False)
    return {
        "target_network_revision": max(0, target_network_revision),
        "target_network_apply_pending": target_pending,
        "target_wifi_profiles": target_wifi_profiles,
        "target_server_hostname": target_server_hostname,
        "target_server_fallback_ip": target_server_fallback_ip,
        "target_server_fallback_ips": target_server_fallback_ips,
        "target_api_path": target_api_path,
        "target_open_portal": target_open_portal,
    }


def applied_network_revision(payload: Dict[str, Any]) -> int:
    net = payload.get("net")
    if not isinstance(net, dict):
        return 0
    raw = net.get("applied_network_revision")
    return max(0, int(raw)) if isinstance(raw, (int, float)) else 0


app = FastAPI(title="Oracle IoT Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if (BASE_DIR / "web").exists():
    app.mount("/web", StaticFiles(directory=str(BASE_DIR / "web")), name="web")
if (BASE_DIR / "models").exists():
    app.mount("/models", StaticFiles(directory=str(BASE_DIR / "models")), name="models")
if LOG_DIR.exists():
    app.mount("/logs", StaticFiles(directory=str(LOG_DIR)), name="logs")


@app.get("/")
def root():
    return RedirectResponse("/web/index.html")


@app.get("/health")
def health():
    with db_conn() as conn:
        row = fetch_one(conn, "SELECT 'OK' AS status FROM dual")
    return {"status": "ok", "db": row.get("status") if row else None}


@app.post("/api/reset_db")
def reset_db(authorization: Optional[str] = Header(default=None)):
    require_bearer(authorization)
    with db_conn() as conn:
        try:
            conn.autocommit = False
            try:
                exec_sql(conn, "DROP TABLE sensor_data PURGE")
            except Exception as exc:
                if oracle_error_code(exc) != 942:
                    raise

            exec_sql(
                conn,
                """
                CREATE TABLE sensor_data (
                    id                NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    device_id         VARCHAR2(64) NOT NULL,
                    ts_epoch          NUMBER(18,6) NOT NULL,
                    temperature       NUMBER(10,4),
                    vibration         NUMBER(10,4),
                    accel_x_g         NUMBER(10,4),
                    accel_y_g         NUMBER(10,4),
                    accel_z_g         NUMBER(10,4),
                    gyro_x_dps        NUMBER(10,4),
                    gyro_y_dps        NUMBER(10,4),
                    gyro_z_dps        NUMBER(10,4),
                    fan_state         VARCHAR2(20),
                    cmd_speed_label   VARCHAR2(16),
                    rot_state_label   VARCHAR2(16),
                    use_state_label   VARCHAR2(16),
                    vib_profile_label VARCHAR2(16),
                    label_source      VARCHAR2(16) DEFAULT 'CONTROL',
                    transition_marker NUMBER(1) DEFAULT 0,
                    sample_rate       NUMBER(10,3) DEFAULT 10,
                    collection_id     VARCHAR2(64),
                    connection_type   VARCHAR2(16) DEFAULT 'WIFI',
                    ssid              VARCHAR2(64),
                    rssi              NUMBER(6,1),
                    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """,
            )
            indexes = [
                "CREATE INDEX idx_device ON sensor_data(device_id)",
                "CREATE INDEX idx_ts_epoch ON sensor_data(ts_epoch)",
                "CREATE INDEX idx_collection ON sensor_data(collection_id)",
                "CREATE INDEX idx_fan_state ON sensor_data(fan_state)",
                "CREATE INDEX idx_cmd_speed_label ON sensor_data(cmd_speed_label)",
                "CREATE INDEX idx_rot_state_label ON sensor_data(rot_state_label)",
                "CREATE INDEX idx_use_state_label ON sensor_data(use_state_label)",
                "CREATE INDEX idx_vib_profile_label ON sensor_data(vib_profile_label)",
                "CREATE INDEX idx_label_combo ON sensor_data(cmd_speed_label, rot_state_label, use_state_label, vib_profile_label)",
                "CREATE INDEX idx_connection_type ON sensor_data(connection_type)",
                "CREATE INDEX idx_ssid ON sensor_data(ssid)",
            ]
            for sql in indexes:
                exec_sql(conn, sql)

            conn.commit()
            _column_cache.clear()
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            raise HTTPException(status_code=500, detail=f"Erro ao resetar banco: {exc}")

    return JSONResponse(
        {
            "status": "success",
            "message": "Banco resetado com sucesso. Tabela sensor_data recriada.",
            "db_vendor": "ORACLE",
            "script_ref": "../database/reset_database.sql",
        }
    )


# Endpoints are appended below in patches to keep file manageable.


@app.api_route("/api/set_mode", methods=["GET", "POST"])
async def set_mode(request: Request, authorization: Optional[str] = Header(default=None)):
    require_bearer(authorization)

    input_data: Dict[str, Any] = {}
    if request.method == "POST":
        raw = await request.body()
        if raw and raw.strip():
            try:
                input_data = json.loads(raw.decode("utf-8"))
            except Exception:
                raise HTTPException(status_code=400, detail="JSON invalido na requisicao.")
            if not isinstance(input_data, dict):
                raise HTTPException(status_code=400, detail="JSON invalido na requisicao.")

    device_id = sanitize_device_id(request.query_params.get("device_id")) or sanitize_device_id(input_data.get("device_id"))
    current = load_state(device_id, {"mode": "PAUSE", "sample_rate": 4, "ingest_enabled": True})

    if request.method == "POST":
        payload = dict(input_data)
        is_new_collection = payload.get("new_collection") is True
        network_commit = sanitize_bool(payload.get("network_commit"), False)
        for internal_key in ("new_collection", "network_commit", "device_id"):
            payload.pop(internal_key, None)

        allowed = {
            "mode",
            "sample_rate",
            "sends_per_sec",
            "transition_duration_s",
            "ingest_enabled",
            "collection_id",
            "cmd_speed_label",
            "rot_state_label",
            "use_state_label",
            "vib_profile_label",
            "label_source",
            "transition_marker",
            "network_revision",
            "network_apply_pending",
            "wifi_profiles",
            "server_hostname",
            "server_fallback_ip",
            "server_fallback_ips",
            "api_path",
            "open_portal",
        }
        payload = {k: payload[k] for k in allowed if k in payload}

        if any(k in payload for k in ("wifi_profiles", "server_hostname", "server_fallback_ip", "server_fallback_ips", "api_path")) or network_commit:
            payload.setdefault("network_revision", int(round(microtime() * 1000)))
            payload.setdefault("network_apply_pending", True)

        old_mode = current.get("mode")
        current.update(payload)
        if "collection_id" in payload:
            cid = str(payload.get("collection_id", "")).strip()
            cid = re.sub(r"\s+", "_", cid)
            cid = re.sub(r"[^A-Za-z0-9_.-]", "_", cid)
            current["collection_id"] = (cid or current.get("collection_id") or "v5_stream")[:80]

        if "mode" in payload and "cmd_speed_label" not in payload:
            current["cmd_speed_label"] = cmd_speed_from_mode(payload.get("mode"))
            if "label_source" not in payload:
                current["label_source"] = "CONTROL"

        # Auto-transition: ao mudar de modo, marca janela de transição automaticamente
        if "mode" in payload and payload.get("mode") != old_mode and "transition_marker" not in payload:
            transition_secs = int(current.get("transition_duration_s", 10))
            current["transition_marker"] = 1
            current["transition_end_epoch"] = microtime() + transition_secs

        if is_new_collection:
            rate = int(current.get("sample_rate", 4))
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            current["collection_id"] = f"col_{ts}_{rate}hz"

        current = sanitize_state(current, {"mode": "PAUSE", "sample_rate": 4, "ingest_enabled": True})
        if not save_state(current, device_id):
            raise HTTPException(status_code=500, detail="Falha ao salvar estado de controle.")

    response = dict(current)
    if device_id:
        response["device_id"] = device_id

    collection_id = response.get("collection_id", "")
    rate = response.get("sample_rate")
    if collection_id and isinstance(rate, (int, float)):
        m = re.search(r"_([0-9]+)hz(?:\b|_)", collection_id, flags=re.IGNORECASE)
        if m and int(m.group(1)) != int(rate):
            response["collection_id_warning"] = f"collection_id '{collection_id}' nao combina com sample_rate={int(rate)}Hz"

    return JSONResponse(response)


@app.post("/api/ingest")
async def ingest(request: Request, authorization: Optional[str] = Header(default=None)):
    require_bearer(authorization)

    raw = await request.body()
    try:
        data = json.loads(raw.decode("utf-8")) if raw else None
    except Exception:
        data = None
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Dados JSON invalidos")

    device_id = sanitize_device_id(data.get("device_id", "ESP32_Unknown")) or "ESP32_Unknown"
    collection_id = data.get("collection_id", "v5_stream")
    save_device_status(device_id, extract_device_status(data))

    control_state = load_state(device_id)

    # Auto-clear transition_marker quando a janela de transição expira
    transition_end = control_state.get("transition_end_epoch")
    if transition_end is not None:
        try:
            if microtime() >= float(transition_end):
                control_state["transition_marker"] = 0
                control_state.pop("transition_end_epoch", None)
                save_state(control_state, device_id)
        except Exception:
            pass

    target_mode = control_state.get("mode", "PAUSE")
    target_rate = control_state.get("sample_rate", 4)
    target_collection_id = control_state.get("collection_id", "v5_stream")
    target_cmd_speed_label = sanitize_enum(control_state.get("cmd_speed_label"), {"OFF", "LOW", "MEDIUM", "HIGH", "UNKNOWN"}, cmd_speed_from_mode(target_mode))
    target_rot_state_label = sanitize_enum(control_state.get("rot_state_label"), {"ROTATING", "STOPPED", "UNKNOWN"}, "UNKNOWN")
    target_use_state_label = sanitize_enum(control_state.get("use_state_label"), {"IN_USE", "NO_LOAD", "UNKNOWN"}, "UNKNOWN")
    target_vib_profile_label = sanitize_enum(control_state.get("vib_profile_label"), {"NATURAL", "ABNORMAL", "UNKNOWN"}, "UNKNOWN")
    target_label_source = sanitize_enum(control_state.get("label_source"), {"CONTROL", "AUTO", "MANUAL", "DEVICE", "BACKFILL", "UNKNOWN"}, "CONTROL")
    target_transition_marker = 1 if sanitize_bool(control_state.get("transition_marker"), False) else 0
    ingest_enabled = sanitize_bool(control_state.get("ingest_enabled"), True)

    app_rev = applied_network_revision(data)
    if app_rev > 0:
        target_rev = int(control_state.get("network_revision", 0)) if isinstance(control_state.get("network_revision"), (int, float)) else 0
        pending = sanitize_bool(control_state.get("network_apply_pending"), False)
        if pending and target_rev > 0 and app_rev >= target_rev:
            control_state["network_apply_pending"] = False
            save_state(control_state, device_id)
            control_state = load_state(device_id)

    target_network = network_targets_from_state(control_state)
    if sanitize_bool(control_state.get("open_portal"), False):
        control_state["open_portal"] = False
        save_state(control_state, device_id)

    items = data.get("batch") if isinstance(data.get("batch"), list) else [data]
    received_count = len(items)
    sample_rate_used = data.get("sample_rate") or (items[0].get("sr") if items else None) or (items[0].get("sample_rate") if items else None) or 5

    # Connectivity metadata from ESP32 payload
    # ssid/rssi vêm dentro do objeto "net" (main_lite.py) — fallback para raiz por compatibilidade
    _net_meta = data.get("net") if isinstance(data.get("net"), dict) else {}
    payload_ssid = data.get("ssid") or _net_meta.get("ssid")
    payload_rssi = data.get("rssi") if data.get("rssi") is not None else _net_meta.get("rssi")
    payload_connection_type = "HOTSPOT" if _is_hotspot_ssid(payload_ssid) else "WIFI"

    with db_conn() as conn:
        cols = table_columns(conn, "sensor_data")
        label_columns_enabled = {"cmd_speed_label", "rot_state_label", "use_state_label", "vib_profile_label", "label_source", "transition_marker"}.issubset(set(cols.keys()))
        connectivity_columns_enabled = {"connection_type", "ssid", "rssi"}.issubset(set(cols.keys()))
        timestamp_col = ts_column(conn)

        if not ingest_enabled:
            resp = {
                "status": "success",
                "message": "Ingestao pausada - dados nao gravados",
                "device_id": device_id,
                "target_mode": target_mode,
                "target_rate": target_rate,
                "target_collection_id": target_collection_id,
                "target_cmd_speed_label": target_cmd_speed_label,
                "target_rot_state_label": target_rot_state_label,
                "target_use_state_label": target_use_state_label,
                "target_vib_profile_label": target_vib_profile_label,
                "target_label_source": target_label_source,
                "target_transition_marker": target_transition_marker,
                "count": 0,
                "received_count": received_count,
                "collection_id_used": collection_id,
                "sample_rate_used": sample_rate_used,
                "ingest_enabled": False,
                "ingest_paused": True,
                "label_columns_enabled": label_columns_enabled,
                "server_time": microtime(),
            }
            resp.update(target_network)
            return JSONResponse(resp)

        try:
            conn.autocommit = False
            time_offset = 0.0
            max_clock_drift_s = 3600.0
            if items:
                last_item = items[-1]
                last_ts = float(last_item.get("ts", last_item.get("timestamp", 0)) or 0)
                drift = microtime() - last_ts
                if last_ts < 1609459200 or abs(drift) > max_clock_drift_s:
                    time_offset = drift

            try:
                sample_rate = float(data.get("sample_rate", items[0].get("sample_rate", 5)))
            except Exception:
                sample_rate = 5.0
            sample_interval = 1.0 / max(1.0, sample_rate)

            use_synth_ts = False
            ts_values: List[float] = []
            for it in items:
                item_ts = it.get("ts", it.get("timestamp"))
                if not isinstance(item_ts, (int, float)):
                    use_synth_ts = True
                    break
                ts_values.append(float(item_ts))
            if not use_synth_ts and len(ts_values) > 1:
                md = min([abs(ts_values[i] - ts_values[i - 1]) for i in range(1, len(ts_values))] or [float("inf")])
                if md < 0.001:
                    use_synth_ts = True

            base_ts0 = None
            if use_synth_ts and items:
                last_ts_raw = float(items[-1].get("ts", items[-1].get("timestamp", 0)) or 0)
                last_ts_adj = last_ts_raw + time_offset
                if last_ts_adj <= 0:
                    last_ts_adj = microtime()
                base_ts0 = last_ts_adj - max(0, len(items) - 1) * sample_interval

            rows: List[Tuple[Any, ...]] = []
            for idx, item in enumerate(items):
                if base_ts0 is not None:
                    ts = base_ts0 + idx * sample_interval
                else:
                    ts = float(item.get("ts", item.get("timestamp", 0)) or 0) + time_offset

                temp = item.get("t", item.get("temperature", 0))
                ax = item.get("ax", item.get("accel_x_g", 0))
                ay = item.get("ay", item.get("accel_y_g", 0))
                az = item.get("az", item.get("accel_z_g", 0))
                gx = item.get("gx", item.get("gyro_x_dps", 0))
                gy = item.get("gy", item.get("gyro_y_dps", 0))
                gz = item.get("gz", item.get("gyro_z_dps", 0))
                fan_state = item.get("fs", item.get("fan_state", "RAW"))
                item_rate = item.get("sr", item.get("sample_rate", 10))

                cmd_fallback = cmd_speed_from_mode(fan_state)
                cmd_speed_label = sanitize_enum(item.get("cmd_speed_label", data.get("cmd_speed_label", control_state.get("cmd_speed_label", cmd_fallback))), {"OFF", "LOW", "MEDIUM", "HIGH", "UNKNOWN"}, cmd_fallback)
                rot_state_label = sanitize_enum(item.get("rot_state_label", data.get("rot_state_label", control_state.get("rot_state_label", "UNKNOWN"))), {"ROTATING", "STOPPED", "UNKNOWN"}, "UNKNOWN")
                use_state_label = sanitize_enum(item.get("use_state_label", data.get("use_state_label", control_state.get("use_state_label", "UNKNOWN"))), {"IN_USE", "NO_LOAD", "UNKNOWN"}, "UNKNOWN")
                vib_profile_label = sanitize_enum(item.get("vib_profile_label", data.get("vib_profile_label", control_state.get("vib_profile_label", "UNKNOWN"))), {"NATURAL", "ABNORMAL", "UNKNOWN"}, "UNKNOWN")
                label_source = sanitize_enum(item.get("label_source", data.get("label_source", control_state.get("label_source", "CONTROL"))), {"CONTROL", "AUTO", "MANUAL", "DEVICE", "BACKFILL", "UNKNOWN"}, "CONTROL")
                transition_marker = 1 if sanitize_bool(item.get("transition_marker", data.get("transition_marker", control_state.get("transition_marker", 0))), False) else 0

                vib = item.get("v", item.get("vibration"))
                if vib is None:
                    try:
                        vib = (float(gx) ** 2 + float(gy) ** 2 + float(gz) ** 2) ** 0.5
                    except Exception:
                        vib = 0

                if label_columns_enabled and connectivity_columns_enabled:
                    rows.append((device_id, ts, temp, vib, ax, ay, az, gx, gy, gz, fan_state, cmd_speed_label, rot_state_label, use_state_label, vib_profile_label, label_source, transition_marker, item_rate, collection_id, payload_connection_type, payload_ssid, payload_rssi))
                elif label_columns_enabled:
                    rows.append((device_id, ts, temp, vib, ax, ay, az, gx, gy, gz, fan_state, cmd_speed_label, rot_state_label, use_state_label, vib_profile_label, label_source, transition_marker, item_rate, collection_id))
                else:
                    rows.append((device_id, ts, temp, vib, ax, ay, az, gx, gy, gz, fan_state, item_rate, collection_id))

            cur = conn.cursor()
            try:
                if label_columns_enabled and connectivity_columns_enabled:
                    sql = f"INSERT INTO sensor_data (device_id, {timestamp_col}, temperature, vibration, accel_x_g, accel_y_g, accel_z_g, gyro_x_dps, gyro_y_dps, gyro_z_dps, fan_state, cmd_speed_label, rot_state_label, use_state_label, vib_profile_label, label_source, transition_marker, sample_rate, collection_id, connection_type, ssid, rssi) VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13,:14,:15,:16,:17,:18,:19,:20,:21,:22)"
                elif label_columns_enabled:
                    sql = f"INSERT INTO sensor_data (device_id, {timestamp_col}, temperature, vibration, accel_x_g, accel_y_g, accel_z_g, gyro_x_dps, gyro_y_dps, gyro_z_dps, fan_state, cmd_speed_label, rot_state_label, use_state_label, vib_profile_label, label_source, transition_marker, sample_rate, collection_id) VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13,:14,:15,:16,:17,:18,:19)"
                else:
                    sql = f"INSERT INTO sensor_data (device_id, {timestamp_col}, temperature, vibration, accel_x_g, accel_y_g, accel_z_g, gyro_x_dps, gyro_y_dps, gyro_z_dps, fan_state, sample_rate, collection_id) VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13)"
                cur.executemany(sql, rows)
            finally:
                cur.close()
            conn.commit()
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            raise HTTPException(status_code=500, detail=f"Erro ao salvar dados: {exc}")

    control_state = load_state(device_id)
    resp = {
        "target_mode": control_state.get("mode", "PAUSE"),
        "target_rate": control_state.get("sample_rate", 4),
        "target_sends_per_sec": int(control_state.get("sends_per_sec", 1)),
        "target_collection_id": control_state.get("collection_id", "v5_stream"),
    }
    resp.update(network_targets_from_state(control_state))
    return JSONResponse(resp)


def runtime_summary(latest: Optional[Dict[str, Any]], config: Dict[str, Any], requested_device_id: Optional[str]) -> Dict[str, Any]:
    server_time = microtime()
    latest_ts = float(latest.get("timestamp")) if isinstance((latest or {}).get("timestamp"), (int, float)) else None
    age = (server_time - latest_ts) if latest_ts is not None else None
    freshness = "no_data" if age is None else ("live" if age <= 3 else ("delay" if age <= 10 else "stale"))
    return {
        "requested_device_id": requested_device_id,
        "active_device_id": (latest or {}).get("device_id") or requested_device_id,
        "configured": {
            "mode": config.get("mode"),
            "sample_rate_hz": float(config.get("sample_rate")) if isinstance(config.get("sample_rate"), (int, float)) else None,
            "collection_id": config.get("collection_id"),
            "ingest_enabled": sanitize_bool(config.get("ingest_enabled"), True),
            "cmd_speed_label": config.get("cmd_speed_label"),
            "rot_state_label": config.get("rot_state_label"),
            "use_state_label": config.get("use_state_label"),
            "vib_profile_label": config.get("vib_profile_label"),
            "label_source": config.get("label_source"),
            "transition_marker": int(config.get("transition_marker", 0)) if isinstance(config.get("transition_marker"), (int, float, bool)) else None,
        },
        "latest": {
            "id": int((latest or {}).get("id")) if isinstance((latest or {}).get("id"), (int, float)) else None,
            "timestamp": latest_ts,
            "sample_rate_hz": float((latest or {}).get("sample_rate")) if isinstance((latest or {}).get("sample_rate"), (int, float)) else None,
            "fan_state": (latest or {}).get("fan_state"),
            "cmd_speed_label": (latest or {}).get("cmd_speed_label"),
            "rot_state_label": (latest or {}).get("rot_state_label"),
            "use_state_label": (latest or {}).get("use_state_label"),
            "vib_profile_label": (latest or {}).get("vib_profile_label"),
            "label_source": (latest or {}).get("label_source"),
            "transition_marker": int((latest or {}).get("transition_marker")) if isinstance((latest or {}).get("transition_marker"), (int, float, bool)) else None,
            "collection_id": (latest or {}).get("collection_id"),
            "age_s": round(age, 3) if age is not None else None,
            "freshness": freshness,
            "is_fresh": age is not None and age < 30,
        },
        "server_time": server_time,
    }


def sanitize_log_filename(name: str) -> Optional[str]:
    base = os.path.basename(name)
    if re.match(r"^ml_transitions_\d{8}_\d{6}(?:_f_\d+)?\.json$", base):
        return base
    if base == "ml_transitions.json":
        return base
    return None


def current_log_file() -> Optional[Path]:
    pointer = LOG_DIR / "ml_transitions_current.txt"
    if pointer.exists():
        fn = pointer.read_text(encoding="utf-8").strip()
        path = LOG_DIR / fn
        if path.exists():
            return path
    return None


def create_new_log_file() -> Path:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    pointer = LOG_DIR / "ml_transitions_current.txt"
    sample_rate = None
    cfg_file = API_DIR / "control_state.json"
    if cfg_file.exists():
        try:
            cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
            if isinstance(cfg, dict) and isinstance(cfg.get("sample_rate"), (int, float)):
                sample_rate = int(cfg["sample_rate"])
        except Exception:
            sample_rate = None
    suffix = f"_f_{sample_rate}" if sample_rate is not None else ""
    fn = f"ml_transitions_{datetime.now(TZ_SP).strftime('%Y%m%d_%H%M%S')}{suffix}.json"
    path = LOG_DIR / fn
    path.write_text("[]", encoding="utf-8")
    pointer.write_text(fn, encoding="utf-8")
    return path


def slug(v: Any, max_len: int = 80) -> str:
    s = str(v).strip() if isinstance(v, str) else ""
    if not s:
        return ""
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s[:max_len]


def float_or_none(v: Any) -> Optional[float]:
    try:
        return float(v)
    except Exception:
        return None


@app.get("/api/get_data")
def get_data(request: Request):
    device_id = sanitize_device_id(request.query_params.get("device_id"))
    config = load_state(device_id, {"mode": "PAUSE", "sample_rate": 4, "ingest_enabled": True})
    mode = request.query_params.get("mode", "latest")

    with db_conn() as conn:
        tcol = ts_column(conn)
        cols = table_columns(conn, "sensor_data")

        def has_col(c: str) -> bool:
            return c.lower() in cols

        if mode == "latest":
            sql = "SELECT * FROM sensor_data"
            params: Dict[str, Any] = {}
            if device_id:
                sql += " WHERE device_id = :device_id"
                params["device_id"] = device_id
            sql += " ORDER BY id DESC FETCH FIRST 1 ROWS ONLY"
            latest = norm_row(fetch_one(conn, sql, params))
            return JSONResponse(
                {
                    "data": latest or {},
                    "config": config,
                    "device_id": device_id,
                    "runtime": runtime_summary(latest, config, device_id),
                    "device_status": load_device_status(device_id or (latest or {}).get("device_id")),
                }
            )

        if mode == "debug":
            where = ""
            params: Dict[str, Any] = {}
            if device_id:
                where = " WHERE device_id = :device_id"
                params["device_id"] = device_id
            total_row = fetch_one(conn, f"SELECT COUNT(*) as total FROM sensor_data{where}", params) or {"total": 0}
            latest = norm_row(fetch_one(conn, f"SELECT * FROM sensor_data{where} ORDER BY id DESC FETCH FIRST 1 ROWS ONLY", params))
            latest_ts = float(latest.get("timestamp")) if latest and isinstance(latest.get("timestamp"), (int, float)) else 0.0
            age = microtime() - latest_ts if latest_ts > 0 else None
            diagnosis = (
                "Banco vazio - ESP32 nao esta enviando dados ou banco foi resetado"
                if int(total_row.get("total", 0)) == 0
                else (f"Dados antigos (>{round(age)}s) - ESP32 pode estar desconectado" if age and age > 60 else "Sistema funcionando normalmente")
            )
            return JSONResponse(
                {
                    "status": "debug",
                    "device_id": device_id,
                    "server_time": microtime(),
                    "server_time_iso": datetime.now(TZ_SP).isoformat(),
                    "total_records": int(total_row.get("total", 0)),
                    "latest_record": latest,
                    "latest_age_seconds": age,
                    "is_fresh": age is not None and age < 30,
                    "runtime": runtime_summary(latest, config, device_id),
                    "device_status": load_device_status(device_id or (latest or {}).get("device_id")),
                    "config": config,
                    "diagnosis": diagnosis,
                }
            )

        if mode == "history":
            seconds = int(request.query_params.get("seconds", "30"))
            params: Dict[str, Any] = {"start_ts": microtime() - seconds}
            sql = f"SELECT * FROM sensor_data WHERE {tcol} >= :start_ts"
            if device_id:
                sql += " AND device_id = :device_id"
                params["device_id"] = device_id
            if request.query_params.get("fan_state"):
                sql += " AND fan_state = :fan_state"
                params["fan_state"] = request.query_params.get("fan_state")
            if request.query_params.get("collection_id"):
                sql += " AND collection_id = :col_id"
                params["col_id"] = request.query_params.get("collection_id")
            if request.query_params.get("sample_rate"):
                try:
                    params["sample_rate"] = float(request.query_params.get("sample_rate"))
                    sql += " AND sample_rate = :sample_rate"
                except Exception:
                    pass

            enum_filters = [
                ("cmd_speed_label", {"OFF", "LOW", "MEDIUM", "HIGH", "UNKNOWN"}),
                ("rot_state_label", {"ROTATING", "STOPPED", "UNKNOWN"}),
                ("use_state_label", {"IN_USE", "NO_LOAD", "UNKNOWN"}),
                ("vib_profile_label", {"NATURAL", "ABNORMAL", "UNKNOWN"}),
            ]
            for key, allowed in enum_filters:
                if request.query_params.get(key) and has_col(key):
                    params[key] = sanitize_enum(request.query_params.get(key), allowed, "")
                    if params[key]:
                        sql += f" AND {key} = :{key}"

            sql += f" ORDER BY {tcol} ASC"
            rows = norm_rows(fetch_all(conn, sql, params))
            latest = rows[-1] if rows else None
            return JSONResponse(
                {
                    "data": rows,
                    "config": config,
                    "device_id": device_id,
                    "runtime": runtime_summary(latest, config, device_id),
                    "device_status": load_device_status(device_id or (latest or {}).get("device_id")),
                }
            )

        if mode == "stats":
            params: Dict[str, Any] = {}
            where = "WHERE 1=1"
            seconds = request.query_params.get("seconds")
            if seconds and seconds.isdigit():
                params["start_ts"] = microtime() - int(seconds)
                where += f" AND {tcol} >= :start_ts"
            if device_id:
                where += " AND device_id = :device_id"
                params["device_id"] = device_id
            if request.query_params.get("fan_state"):
                where += " AND fan_state = :fan_state"
                params["fan_state"] = request.query_params.get("fan_state")
            if request.query_params.get("collection_id"):
                where += " AND collection_id = :col_id"
                params["col_id"] = request.query_params.get("collection_id")

            overall = fetch_one(conn, f"SELECT COUNT(*) as count, MIN({tcol}) as ts_min, MAX({tcol}) as ts_max FROM sensor_data {where}", params) or {}
            count = int(overall.get("count", 0))
            ts_min = float(overall["ts_min"]) if isinstance(overall.get("ts_min"), (int, float)) else None
            ts_max = float(overall["ts_max"]) if isinstance(overall.get("ts_max"), (int, float)) else None
            duration = (ts_max - ts_min) if ts_min is not None and ts_max is not None else None
            avg_rate = round(count / duration, 2) if duration and duration > 0 else None

            grouped = fetch_all(conn, f"SELECT fan_state, COUNT(*) as count, MIN({tcol}) as ts_min, MAX({tcol}) as ts_max FROM sensor_data {where} GROUP BY fan_state", params)
            by_fan: Dict[str, Any] = {}
            for r in grouped:
                cnt = int(r.get("count", 0))
                gmin = float(r["ts_min"]) if isinstance(r.get("ts_min"), (int, float)) else None
                gmax = float(r["ts_max"]) if isinstance(r.get("ts_max"), (int, float)) else None
                gdur = (gmax - gmin) if gmin is not None and gmax is not None else None
                grate = round(cnt / gdur, 2) if gdur and gdur > 0 else None
                by_fan[str(r.get("fan_state") or "UNKNOWN")] = {"count": cnt, "ts_min": gmin, "ts_max": gmax, "duration_s": gdur, "avg_rate_hz": grate}

            _COMPOSITE_RULES = {
                ("LOW", "ROTATING"):    "LOW_ROT_ON",
                ("MEDIUM", "ROTATING"): "MEDIUM_ROT_ON",
                ("HIGH", "ROTATING"):   "HIGH_ROT_ON",
                ("LOW", "STOPPED"):     "LOW_ROT_OFF",
                ("MEDIUM", "STOPPED"):  "MEDIUM_ROT_OFF",
                ("HIGH", "STOPPED"):    "HIGH_ROT_OFF",
                ("OFF", "STOPPED"):     "FAN_OFF",
            }
            comp_rows = fetch_all(conn, f"""
                SELECT
                    NVL(cmd_speed_label, fan_state) AS speed,
                    NVL(rot_state_label, 'UNKNOWN') AS rot,
                    SUM(CASE WHEN transition_marker = 0 THEN 1 ELSE 0 END) AS valid_count,
                    COUNT(*) AS total_count
                FROM sensor_data {where}
                GROUP BY NVL(cmd_speed_label, fan_state), NVL(rot_state_label, 'UNKNOWN')
            """, params)
            by_composite: Dict[str, Any] = {}
            for r in comp_rows:
                spd = str(r.get("speed") or "UNKNOWN")
                rot = str(r.get("rot") or "UNKNOWN")
                cls = _COMPOSITE_RULES.get((spd, rot), f"{spd}_{rot}")
                valid = int(r.get("valid_count") or 0)
                total = int(r.get("total_count") or 0)
                prev = by_composite.get(cls, {"valid": 0, "total": 0})
                by_composite[cls] = {"valid": prev["valid"] + valid, "total": prev["total"] + total}

            return JSONResponse(
                {
                    "filters": {
                        "device_id": device_id,
                        "seconds": int(seconds) if seconds and seconds.isdigit() else None,
                        "fan_state": request.query_params.get("fan_state"),
                        "collection_id": request.query_params.get("collection_id"),
                        "sample_rate": request.query_params.get("sample_rate"),
                        "cmd_speed_label": request.query_params.get("cmd_speed_label"),
                        "rot_state_label": request.query_params.get("rot_state_label"),
                        "use_state_label": request.query_params.get("use_state_label"),
                        "vib_profile_label": request.query_params.get("vib_profile_label"),
                    },
                    "overall": {"count": count, "ts_min": ts_min, "ts_max": ts_max, "duration_s": duration, "avg_rate_hz": avg_rate},
                    "by_fan_state": by_fan,
                    "by_composite": by_composite,
                    "by_label": {},
                    "device_status": load_device_status(device_id),
                }
            )

        if mode == "collection":
            collection_id = request.query_params.get("collection_id")
            if not collection_id:
                raise HTTPException(status_code=400, detail="Parametro collection_id obrigatorio")
            try:
                limit = int(request.query_params.get("limit", "50000"))
            except Exception:
                limit = 50000
            sql = f"SELECT * FROM (SELECT * FROM sensor_data WHERE collection_id = :col_id"
            params: Dict[str, Any] = {"col_id": collection_id}
            if device_id:
                sql += " AND device_id = :device_id"
                params["device_id"] = device_id
            if request.query_params.get("fan_state"):
                sql += " AND fan_state = :fan_state"
                params["fan_state"] = request.query_params.get("fan_state")
            sql += f" ORDER BY {tcol} ASC) WHERE ROWNUM <= :lim"
            params["lim"] = limit
            rows = norm_rows(fetch_all(conn, sql, params))
            count = len(rows)
            dr = None
            avg_rate = None
            classes: List[str] = []
            if rows:
                fts = rows[0].get("timestamp")
                lts = rows[-1].get("timestamp")
                dr = {"first": fts, "last": lts}
                if isinstance(fts, (int, float)) and isinstance(lts, (int, float)):
                    dur = float(lts) - float(fts)
                    avg_rate = round(count / dur, 2) if dur > 0 else None
                classes = list(dict.fromkeys([str(x.get("fan_state")) for x in rows if x.get("fan_state") is not None]))
            return JSONResponse(
                {
                    "data": rows,
                    "metadata": {
                        "device_id": device_id,
                        "collection_id": collection_id,
                        "count": count,
                        "date_range": dr,
                        "avg_sample_rate_hz": avg_rate,
                        "classes": classes,
                    },
                    "config": config,
                    "device_status": load_device_status(device_id or (rows[-1].get("device_id") if rows else None)),
                }
            )

    raise HTTPException(status_code=400, detail="Modo invalido")


@app.api_route("/api/log_transition", methods=["GET", "POST"])
async def log_transition(request: Request):
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    if request.method == "GET":
        qp = request.query_params
        if qp.get("file"):
            requested = sanitize_log_filename(str(qp.get("file")))
            if not requested:
                raise HTTPException(status_code=400, detail="Arquivo invalido")
            p = LOG_DIR / requested
            if not p.exists():
                raise HTTPException(status_code=404, detail="Arquivo nao encontrado")
            try:
                payload = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                payload = []
            return JSONResponse(payload)

        if qp.get("action") == "new":
            p = create_new_log_file()
            return JSONResponse({"status": "ok", "file": p.name})

        if qp.get("action") == "list":
            files = sorted(LOG_DIR.glob("ml_transitions_2*.json"), key=lambda x: x.name, reverse=True)
            out = []
            for f in files:
                try:
                    entries = len(json.loads(f.read_text(encoding="utf-8")))
                except Exception:
                    entries = 0
                out.append(
                    {
                        "file": f.name,
                        "size": f.stat().st_size,
                        "mtime": int(f.stat().st_mtime),
                        "modified": datetime.fromtimestamp(f.stat().st_mtime, tz=TZ_SP).strftime("%Y-%m-%d %H:%M:%S"),
                        "entries": entries,
                    }
                )
            return JSONResponse(out)

        p = current_log_file()
        if p and p.exists():
            try:
                payload = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                payload = []
            return JSONResponse(payload)
        return JSONResponse([])

    raw = await request.body()
    try:
        entry = json.loads(raw.decode("utf-8")) if raw else None
    except Exception:
        entry = None
    if not isinstance(entry, dict):
        raise HTTPException(status_code=400, detail="JSON invalido")

    p = current_log_file() or create_new_log_file()
    try:
        logs = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(logs, list):
            logs = []
    except Exception:
        logs = []
    entry["server_time"] = now_sp_str()
    logs.append(entry)
    if len(logs) > 500:
        logs = logs[-500:]
    p.write_text(json.dumps(logs, indent=2, ensure_ascii=False), encoding="utf-8")
    return JSONResponse({"status": "ok", "total": len(logs), "file": p.name})


@app.post("/api/save_adapted_model")
async def save_adapted_model(request: Request):
    raw = await request.body()
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else None
    except Exception:
        payload = None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON invalido")

    model = payload.get("model")
    meta = payload.get("meta", {})
    if model is None and isinstance(payload.get("type"), str) and isinstance(payload.get("stats"), dict):
        model = payload
        meta = {}
    if not isinstance(model, dict):
        raise HTTPException(status_code=400, detail="Campo 'model' ausente ou invalido")

    MODELS_ADAPTED_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(TZ_SP).strftime("%Y%m%d_%H%M%S")
    hz = int(round(float_or_none(meta.get("configured_sample_rate_hz")) or 0)) or None
    lam = float_or_none(meta.get("lambda"))
    tag = slug(meta.get("tag"))
    col = slug(meta.get("collection_id"))
    base_ver = slug(meta.get("base_model_version") or meta.get("base_version") or "")
    model_ver = slug(model.get("version"))

    parts = ["adapted", ts]
    if hz:
        parts.append(f"f{hz}hz")
    if lam is not None:
        parts.append(f"lambda{format(lam, '.2f').replace('.', 'p')}")
    if tag:
        parts.append(tag)
    if col:
        parts.append(col)
    if base_ver:
        parts.append(f"base_{base_ver}")
    if model_ver:
        parts.append(f"m_{model_ver}")

    base_name = "_".join(parts)
    fn = f"{base_name}.json"
    p = MODELS_ADAPTED_DIR / fn
    i = 2
    while p.exists() and i < 100:
        fn = f"{base_name}_{i}.json"
        p = MODELS_ADAPTED_DIR / fn
        i += 1

    model["_server_saved_at"] = now_iso()
    model["_server_export"] = {"received_at": now_iso(), "meta": meta}
    content = json.dumps(model, indent=2, ensure_ascii=False)
    p.write_text(content, encoding="utf-8")
    (MODELS_ADAPTED_DIR / "latest.json").write_text(content, encoding="utf-8")

    index_path = MODELS_ADAPTED_DIR / "index.json"
    index: List[Dict[str, Any]] = []
    if index_path.exists():
        try:
            j = json.loads(index_path.read_text(encoding="utf-8"))
            if isinstance(j, list):
                index = j
        except Exception:
            index = []
    entry = {"file": fn, "saved_at": now_iso(), "size": p.stat().st_size, "meta": meta, "model_version": model.get("version")}
    index.insert(0, entry)
    index = index[:200]
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")

    return JSONResponse(
        {
            "status": "ok",
            "file": fn,
            "relative_path": f"models/adapted/{fn}",
            "latest": "models/adapted/latest.json",
            "size": p.stat().st_size,
        }
    )

