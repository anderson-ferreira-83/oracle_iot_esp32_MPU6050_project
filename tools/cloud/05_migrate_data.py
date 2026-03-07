#!/usr/bin/env python3
"""
05_migrate_data.py
Exporta dados do Oracle XE local e importa no ADB (Oracle Cloud).

Uso:
    python 05_migrate_data.py

Variaveis de ambiente necessarias:
    LOCAL_USER      (padrao: student)
    LOCAL_PASSWORD  (padrao: oracle)
    LOCAL_DSN       (padrao: localhost:1521/xepdb1)
    ORACLE_PASSWORD (senha do ADMIN no ADB)

O script le adb_info.env do mesmo diretorio para obter wallet e service name.
"""

import os
import sys
import time
from pathlib import Path

try:
    import oracledb
except ImportError:
    print("ERRO: pip install oracledb")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Configuracao
# ---------------------------------------------------------------------------
SCRIPT_DIR   = Path(__file__).parent
ADB_INFO     = SCRIPT_DIR / "adb_info.env"
BATCH_SIZE   = 500   # linhas por INSERT batch

TABLES = [
    "sensor_data",
    "sensor_training_data",
    "sensor_monitoring_data",
]

# Colunas de cada tabela (exclui id e created_at — regenerados no destino)
COLUMNS = {
    "sensor_data": [
        "device_id", "ts_epoch", "temperature", "vibration",
        "accel_x_g", "accel_y_g", "accel_z_g",
        "gyro_x_dps", "gyro_y_dps", "gyro_z_dps",
        "fan_state", "cmd_speed_label", "rot_state_label",
        "use_state_label", "vib_profile_label", "label_source",
        "transition_marker", "sample_rate", "collection_id",
        "connection_type", "ssid", "rssi",
    ],
    "sensor_training_data": [
        "device_id", "ts_epoch", "temperature", "vibration",
        "accel_x_g", "accel_y_g", "accel_z_g",
        "gyro_x_dps", "gyro_y_dps", "gyro_z_dps",
        "fan_state", "cmd_speed_label", "rot_state_label",
        "use_state_label", "vib_profile_label", "label_source",
        "transition_marker", "sample_rate", "collection_id",
        "connection_type", "ssid", "rssi",
    ],
    "sensor_monitoring_data": [
        "device_id", "ts_epoch", "temperature", "vibration",
        "accel_x_g", "accel_y_g", "accel_z_g",
        "gyro_x_dps", "gyro_y_dps", "gyro_z_dps",
        "sample_rate", "predicted_class", "confidence",
        "model_id", "window_id", "collection_id",
    ],
}


# ---------------------------------------------------------------------------
def load_adb_info():
    info = {}
    with open(ADB_INFO) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                info[k.strip()] = v.strip()
    return info


def connect_local():
    user     = os.environ.get("LOCAL_USER",     "student")
    password = os.environ.get("LOCAL_PASSWORD", "oracle")
    dsn      = os.environ.get("LOCAL_DSN",      "localhost:1521/xepdb1")
    print(f"Local : oracledb thin → {dsn} (user={user})")
    return oracledb.connect(user=user, password=password, dsn=dsn)


def connect_cloud(info):
    password    = os.environ.get("ORACLE_PASSWORD")
    if not password:
        import getpass
        password = getpass.getpass("Senha ADMIN do ADB: ")

    wallet_dir   = info["WALLET_DIR"]
    service_name = info["ADB_SERVICE_NAME"]
    user         = info.get("ORACLE_USER", "ADMIN")
    print(f"Cloud : oracledb wallet → {service_name} (user={user})")
    return oracledb.connect(
        user=user,
        password=password,
        dsn=service_name,
        config_dir=wallet_dir,
        wallet_location=wallet_dir,
    )


def migrate_table(src_conn, dst_conn, table):
    cols = COLUMNS.get(table)
    if not cols:
        print(f"  [SKIP] {table}: colunas nao mapeadas")
        return

    col_list   = ", ".join(cols)
    bind_list  = ", ".join(f":{i+1}" for i in range(len(cols)))
    select_sql = f"SELECT {col_list} FROM {table} ORDER BY ts_epoch"
    insert_sql = f"INSERT INTO {table} ({col_list}) VALUES ({bind_list})"

    src_cur = src_conn.cursor()
    dst_cur = dst_conn.cursor()

    # Conta total
    src_cur.execute(f"SELECT COUNT(*) FROM {table}")
    total = src_cur.fetchone()[0]
    print(f"  {table}: {total} linhas encontradas")

    if total == 0:
        print(f"  {table}: vazia, pulando.")
        src_cur.close()
        dst_cur.close()
        return

    src_cur.execute(select_sql)
    inserted = 0
    t0 = time.time()

    while True:
        rows = src_cur.fetchmany(BATCH_SIZE)
        if not rows:
            break
        dst_cur.executemany(insert_sql, rows)
        dst_conn.commit()
        inserted += len(rows)
        pct = inserted / total * 100
        elapsed = time.time() - t0
        print(f"    {inserted}/{total} ({pct:.1f}%)  {elapsed:.1f}s", end="\r", flush=True)

    print(f"    {inserted}/{total} linhas migradas em {time.time()-t0:.1f}s         ")
    src_cur.close()
    dst_cur.close()


# ---------------------------------------------------------------------------
def main():
    if not ADB_INFO.exists():
        print(f"ERRO: {ADB_INFO} nao encontrado. Execute 03_create_adb.sh primeiro.")
        sys.exit(1)

    info = load_adb_info()

    print("=== Migracao Oracle XE → ADB Cloud ===")
    print()

    src = connect_local()
    dst = connect_cloud(info)

    print()
    for table in TABLES:
        migrate_table(src, dst, table)
        print()

    src.close()
    dst.close()

    print("=== Migracao concluida! ===")
    print()
    print("Proximo passo: execute  06_update_env.sh  para apontar o backend ao ADB.")


if __name__ == "__main__":
    main()
