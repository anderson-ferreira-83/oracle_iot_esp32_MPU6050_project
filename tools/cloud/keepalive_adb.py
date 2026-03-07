#!/usr/bin/env python3
"""Keepalive ADB Free Tier — executa SELECT 1 para evitar pausa automatica."""
import oracledb, os, sys, datetime
from pathlib import Path

script_dir = Path(__file__).parent
adb_info   = {}
with open(script_dir / "adb_info.env") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            adb_info[k.strip()] = v.strip()

wallet_dir   = adb_info["WALLET_DIR"]
service_name = adb_info["ADB_SERVICE_NAME"].replace(".adb.oraclecloud.com","")
service_name = "mpuiotdb_tp"
user         = adb_info.get("ORACLE_USER", "ADMIN")
password     = os.environ.get("ORACLE_PASSWORD", "")
wallet_pwd   = os.environ.get("ORACLE_WALLET_PASSWORD", password)

if not password:
    sys.exit("ERRO: ORACLE_PASSWORD nao definido")

try:
    conn = oracledb.connect(user=user, password=password, dsn=service_name,
                            config_dir=wallet_dir, wallet_location=wallet_dir,
                            wallet_password=wallet_pwd)
    cur  = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM sensor_training_data")
    n = cur.fetchone()[0]
    cur.close(); conn.close()
    print(f"{datetime.datetime.now().isoformat()} [OK] ADB keepalive OK — sensor_training_data: {n} linhas")
except Exception as e:
    print(f"{datetime.datetime.now().isoformat()} [ERRO] {e}", file=sys.stderr)
    sys.exit(1)
