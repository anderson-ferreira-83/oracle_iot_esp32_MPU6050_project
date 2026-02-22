#!/usr/bin/env python3
"""
Migra dados historicos de sensor_data (MySQL legado) para Oracle XE.

Uso basico:
  python tools/migrate_mysql_to_oracle.py

Com append no destino:
  python tools/migrate_mysql_to_oracle.py --append

Com limpeza do destino:
  python tools/migrate_mysql_to_oracle.py --truncate-target
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Dict, Iterable, List, Sequence, Tuple

try:
    import mysql.connector
except Exception as exc:  # pragma: no cover
    print(f"[ERRO] mysql-connector-python nao disponivel: {exc}")
    print("Instale com: pip install mysql-connector-python")
    sys.exit(1)

try:
    import oracledb
except Exception as exc:  # pragma: no cover
    print(f"[ERRO] python-oracledb nao disponivel: {exc}")
    print("Instale com: pip install oracledb")
    sys.exit(1)


SOURCE_FIELDS = [
    "device_id",
    "temperature",
    "vibration",
    "accel_x_g",
    "accel_y_g",
    "accel_z_g",
    "gyro_x_dps",
    "gyro_y_dps",
    "gyro_z_dps",
    "fan_state",
    "cmd_speed_label",
    "rot_state_label",
    "use_state_label",
    "vib_profile_label",
    "label_source",
    "transition_marker",
    "sample_rate",
    "collection_id",
]


def env(name: str, default: str = "") -> str:
    value = os.getenv(name)
    if value is None:
        return default
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migrar sensor_data de MySQL legado para Oracle XE."
    )
    parser.add_argument("--batch-size", type=int, default=5000, help="Tamanho do lote.")
    parser.add_argument(
        "--append",
        action="store_true",
        help="Permite inserir em tabela Oracle ja populada.",
    )
    parser.add_argument(
        "--truncate-target",
        action="store_true",
        help="Executa TRUNCATE TABLE sensor_data no destino antes da copia.",
    )
    return parser.parse_args()


def mysql_connect():
    return mysql.connector.connect(
        host=env("MYSQL_HOST", "localhost"),
        port=int(env("MYSQL_PORT", "3306")),
        database=env("MYSQL_DATABASE", "iot_mpu6050"),
        user=env("MYSQL_USER", "root"),
        password=env("MYSQL_PASSWORD", ""),
        autocommit=False,
    )


def oracle_connect():
    user = env("ORACLE_USER", "student")
    password = env("ORACLE_PASSWORD", "oracle")
    dsn = env("ORACLE_DSN", "")
    if not dsn:
        host = env("ORACLE_HOST", "localhost")
        port = int(env("ORACLE_PORT", "1521"))
        service = env("ORACLE_SERVICE_NAME", "xepdb1")
        dsn = oracledb.makedsn(host, port, service_name=service)
    return oracledb.connect(user=user, password=password, dsn=dsn)


def mysql_columns(cursor) -> Dict[str, bool]:
    cursor.execute("SHOW COLUMNS FROM sensor_data")
    cols = {row[0].lower(): True for row in cursor.fetchall()}
    return cols


def source_expr(col: str, cols: Dict[str, bool], alias: str | None = None) -> str:
    out_alias = alias or col
    if col in cols:
        return f"`{col}` AS `{out_alias}`"
    if col == "label_source":
        return f"'CONTROL' AS `{out_alias}`"
    if col == "transition_marker":
        return f"0 AS `{out_alias}`"
    return f"NULL AS `{out_alias}`"


def source_timestamp_expr(cols: Dict[str, bool]) -> str:
    if "timestamp" in cols:
        return "`timestamp` AS `ts_source`"
    if "ts_epoch" in cols:
        return "`ts_epoch` AS `ts_source`"
    raise RuntimeError("Tabela MySQL sem coluna timestamp/ts_epoch.")


def fetch_batch(mysql_cur, cols: Dict[str, bool], last_id: int, batch_size: int):
    select_cols = ["`id` AS `id`", source_timestamp_expr(cols)]
    for col in SOURCE_FIELDS:
        select_cols.append(source_expr(col, cols))

    sql = (
        "SELECT "
        + ", ".join(select_cols)
        + " FROM sensor_data WHERE id > %s ORDER BY id ASC LIMIT %s"
    )
    mysql_cur.execute(sql, (last_id, batch_size))
    return mysql_cur.fetchall()


def normalize_row(row: Dict) -> Tuple:
    ts_value = row.get("ts_source")
    if ts_value is None:
        ts_value = 0.0
    try:
        ts_value = float(ts_value)
    except Exception:
        ts_value = 0.0

    transition = row.get("transition_marker")
    if transition is None:
        transition = 0

    label_source = row.get("label_source")
    if not label_source:
        label_source = "CONTROL"

    return (
        row.get("device_id"),
        ts_value,
        row.get("temperature"),
        row.get("vibration"),
        row.get("accel_x_g"),
        row.get("accel_y_g"),
        row.get("accel_z_g"),
        row.get("gyro_x_dps"),
        row.get("gyro_y_dps"),
        row.get("gyro_z_dps"),
        row.get("fan_state"),
        row.get("cmd_speed_label"),
        row.get("rot_state_label"),
        row.get("use_state_label"),
        row.get("vib_profile_label"),
        label_source,
        int(transition),
        row.get("sample_rate"),
        row.get("collection_id"),
    )


def oracle_target_count(cur) -> int:
    cur.execute("SELECT COUNT(*) FROM sensor_data")
    return int(cur.fetchone()[0])


def truncate_target(cur):
    cur.execute("TRUNCATE TABLE sensor_data")


def insert_batch(oracle_cur, rows: Sequence[Tuple]):
    sql = """
        INSERT INTO sensor_data (
            device_id, ts_epoch, temperature, vibration, accel_x_g, accel_y_g, accel_z_g,
            gyro_x_dps, gyro_y_dps, gyro_z_dps, fan_state,
            cmd_speed_label, rot_state_label, use_state_label, vib_profile_label,
            label_source, transition_marker, sample_rate, collection_id
        ) VALUES (
            :1, :2, :3, :4, :5, :6, :7,
            :8, :9, :10, :11,
            :12, :13, :14, :15,
            :16, :17, :18, :19
        )
    """
    oracle_cur.executemany(sql, rows)


def main():
    args = parse_args()

    mysql_conn = mysql_connect()
    oracle_conn = oracle_connect()

    mysql_cur = mysql_conn.cursor(dictionary=True)
    mysql_meta_cur = mysql_conn.cursor()
    oracle_cur = oracle_conn.cursor()

    try:
        cols = mysql_columns(mysql_meta_cur)
        print(f"[INFO] Colunas MySQL detectadas: {len(cols)}")

        target_before = oracle_target_count(oracle_cur)
        print(f"[INFO] Linhas atuais no Oracle: {target_before}")

        if args.truncate_target:
            print("[INFO] Limpando tabela destino (TRUNCATE TABLE sensor_data)...")
            truncate_target(oracle_cur)
            oracle_conn.commit()
            target_before = 0

        if target_before > 0 and not args.append:
            raise RuntimeError(
                "Destino Oracle ja contem dados. Use --append ou --truncate-target."
            )

        last_id = 0
        total = 0
        batch_idx = 0

        while True:
            batch = fetch_batch(mysql_cur, cols, last_id, args.batch_size)
            if not batch:
                break

            normalized = [normalize_row(row) for row in batch]
            insert_batch(oracle_cur, normalized)
            oracle_conn.commit()

            batch_idx += 1
            total += len(normalized)
            last_id = int(batch[-1]["id"])
            print(
                f"[OK] Lote {batch_idx}: +{len(normalized)} (id ate {last_id}) | total={total}"
            )

        target_after = oracle_target_count(oracle_cur)
        print("[SUCESSO] Migracao concluida.")
        print(f"[RESUMO] Inseridos nesta execucao: {total}")
        print(f"[RESUMO] Total no Oracle apos migracao: {target_after}")
    finally:
        try:
            mysql_cur.close()
            mysql_meta_cur.close()
            oracle_cur.close()
        except Exception:
            pass
        mysql_conn.close()
        oracle_conn.close()


if __name__ == "__main__":
    main()


