#!/usr/bin/env python3
"""
Teste rapido de conexao Oracle para ambiente Python.

Uso:
  python tools/test_oracle_python_connection.py
"""

from __future__ import annotations

import os
import sys
def env(name: str, default: str) -> str:
    v = os.getenv(name)
    if v is None or v == "":
        return default
    return v


def dsn() -> str:
    explicit = os.getenv("ORACLE_DSN")
    if explicit:
        return explicit
    host = env("ORACLE_HOST", "localhost")
    port = env("ORACLE_PORT", "1521")
    service = env("ORACLE_SERVICE_NAME", "xepdb1")
    return f"{host}:{port}/{service}"


def main() -> int:
    print("== Oracle Python Connectivity Test ==")

    try:
        import oracledb
    except Exception as exc:
        print(f"[ERRO] python-oracledb indisponivel: {exc}")
        print("Instale com: pip install oracledb")
        return 2

    user = env("ORACLE_USER", "student")
    password = env("ORACLE_PASSWORD", "oracle")
    oracle_dsn = dsn()
    print(f"DSN: {oracle_dsn}")
    print(f"User: {user}")

    try:
        conn = oracledb.connect(user=user, password=password, dsn=oracle_dsn)
        try:
            cur = conn.cursor()
            cur.execute("SELECT 'OK' AS status FROM dual")
            row = cur.fetchone()
        finally:
            conn.close()
        print(f"[OK] Conexao Oracle estabelecida. STATUS={row[0] if row else 'N/A'}")
        return 0
    except Exception as exc:
        print(f"[ERRO] Falha ao conectar no Oracle: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())



