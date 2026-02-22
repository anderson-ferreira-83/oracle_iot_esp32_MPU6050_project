#!/usr/bin/env python3
"""
Exporta dados Oracle (sensor_data) para CSV consumivel pelos notebooks.

Saida padrao:
  notebooks/output/data/raw_sensor_data_YYYYMMDD_HHMMSS.csv
"""

from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus

import pandas as pd
from sqlalchemy import create_engine, text


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "notebooks" / "output" / "data"


def db_connection_str() -> str:
    explicit = os.getenv("DB_CONNECTION_STR")
    if explicit:
        return explicit

    user = os.getenv("ORACLE_USER", "student")
    password = quote_plus(os.getenv("ORACLE_PASSWORD", "oracle"))
    host = os.getenv("ORACLE_HOST", "localhost")
    port = os.getenv("ORACLE_PORT", "1521")
    service = os.getenv("ORACLE_SERVICE_NAME", "xepdb1")
    return f"oracle+oracledb://{user}:{password}@{host}:{port}/?service_name={service}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Exportar sensor_data Oracle para CSV.")
    parser.add_argument("--device-id", default=None, help="Filtrar por device_id.")
    parser.add_argument("--collection-id", default=None, help="Filtrar por collection_id.")
    parser.add_argument("--limit", type=int, default=0, help="Limite de linhas (0 = sem limite).")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    sql = """
        SELECT
            id,
            ts_epoch AS timestamp,
            temperature,
            vibration,
            accel_x_g,
            accel_y_g,
            accel_z_g,
            gyro_x_dps,
            gyro_y_dps,
            gyro_z_dps,
            sample_rate,
            fan_state,
            collection_id,
            cmd_speed_label,
            rot_state_label,
            use_state_label,
            vib_profile_label,
            label_source,
            transition_marker,
            device_id,
            created_at
        FROM sensor_data
        WHERE 1=1
    """
    params = {}

    if args.device_id:
        sql += " AND device_id = :device_id"
        params["device_id"] = args.device_id
    if args.collection_id:
        sql += " AND collection_id = :collection_id"
        params["collection_id"] = args.collection_id

    sql += " ORDER BY ts_epoch ASC"
    if args.limit and args.limit > 0:
        sql = f"SELECT * FROM ({sql}) WHERE ROWNUM <= :limit_rows"
        params["limit_rows"] = args.limit

    engine = create_engine(db_connection_str())
    with engine.connect() as conn:
        df = pd.read_sql(text(sql), conn, params=params)

    if df.empty:
        print("[INFO] Nenhum registro encontrado para os filtros informados.")
        return

    if "timestamp" in df.columns:
        df["timestamp_iso"] = pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.strftime(
            "%Y-%m-%dT%H:%M:%S.%fZ"
        )

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_path = OUT_DIR / f"raw_sensor_data_{stamp}.csv"
    df.to_csv(out_path, index=False)

    print(f"[OK] CSV exportado: {out_path}")
    print(f"[OK] Linhas: {len(df)}")


if __name__ == "__main__":
    main()


