#!/usr/bin/env python3
"""
Verify traceability links for a trained model JSON.

This script is intentionally dependency-free (stdlib only).

Example:
  python tools/trace_verify.py models/gnb_model_20260207.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


def _sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _coerce_path(p: Any, *, root: Path | None = None) -> Path | None:
    if not isinstance(p, str) or not p.strip():
        return None
    path = Path(p)
    if path.is_absolute():
        return path
    if root is None:
        return path
    return (root / path).resolve()


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify model traceability links (files + hashes).")
    ap.add_argument("model", help="Path to model JSON (e.g. models/gnb_model_20260207.json)")
    ap.add_argument(
        "--repo-root",
        default=None,
        help="Optional repo root. Defaults to parent of this script (recommended).",
    )
    args = ap.parse_args()

    repo_root = Path(args.repo_root).resolve() if args.repo_root else Path(__file__).resolve().parents[1]
    model_path = (repo_root / args.model).resolve() if not Path(args.model).is_absolute() else Path(args.model)

    report: dict[str, Any] = {
        "repo_root": str(repo_root),
        "model_path": str(model_path),
        "checks": [],
        "files": [],
    }

    def add_check(name: str, ok: bool, detail: str | None = None) -> None:
        report["checks"].append({"name": name, "ok": ok, "detail": detail})

    def add_file(
        name: str,
        path: Path | None,
        *,
        expected_sha256: str | None = None,
        required: bool = False,
    ) -> None:
        entry: dict[str, Any] = {"name": name, "path": str(path) if path else None}
        if path is None:
            entry["exists"] = False
            entry["sha256"] = None
            entry["expected_sha256"] = expected_sha256
            report["files"].append(entry)
            if required:
                add_check(f"file:{name}:exists", False, "missing path")
            return

        entry["exists"] = path.exists()
        entry["expected_sha256"] = expected_sha256
        if path.exists() and path.is_file():
            sha = _sha256_file(path)
            entry["sha256"] = sha
            if expected_sha256:
                add_check(
                    f"file:{name}:sha256",
                    sha == expected_sha256,
                    f"expected={expected_sha256} actual={sha}",
                )
        else:
            entry["sha256"] = None
            if required:
                add_check(f"file:{name}:exists", False, "file not found")
        report["files"].append(entry)

    if not model_path.exists():
        add_check("model:exists", False, "model file not found")
        print(json.dumps(report, indent=2, ensure_ascii=True))
        return 2

    add_check("model:exists", True)
    model_sha256 = _sha256_file(model_path)
    report["model_sha256"] = model_sha256

    try:
        model = _load_json(model_path)
    except Exception as e:
        add_check("model:json_parse", False, str(e))
        print(json.dumps(report, indent=2, ensure_ascii=True))
        return 2

    add_check("model:json_parse", True)

    report["model_version"] = model.get("version")
    report["model_generated_at"] = model.get("generated_at")
    report["model_generated_by"] = model.get("generated_by")
    report["model_feature_count"] = len(model.get("features") or [])

    eda_trace = model.get("eda_traceability")
    add_check("eda_traceability:present", isinstance(eda_trace, dict) and bool(eda_trace))
    eda_trace = eda_trace if isinstance(eda_trace, dict) else {}

    eda_id = eda_trace.get("eda_id")
    fe_id = eda_trace.get("fe_id")
    report["eda_id"] = eda_id
    report["fe_id"] = fe_id
    report["training_sample_rate_hz"] = eda_trace.get("sample_rate_hz")
    report["feature_config_version"] = eda_trace.get("feature_config_version")

    # --- Metrics registry checks ---
    metrics_dir = repo_root / "notebooks" / "output" / "metrics"
    pipeline_registry_path = metrics_dir / "pipeline_registry.json"
    if pipeline_registry_path.exists():
        try:
            registry = _load_json(pipeline_registry_path)
            add_check("pipeline_registry:json_parse", True)
        except Exception as e:
            add_check("pipeline_registry:json_parse", False, str(e))
            registry = {}
    else:
        add_check("pipeline_registry:exists", False, "notebooks/output/metrics/pipeline_registry.json not found")
        registry = {}

    # If registry has a matching model_training entry, validate model hash.
    if isinstance(registry, dict):
        runs = registry.get("runs")
        match = None
        if isinstance(runs, list):
            for r in runs:
                if not isinstance(r, dict):
                    continue
                if r.get("type") != "model_training":
                    continue
                if r.get("model_filename") == model_path.name:
                    match = r
        if match:
            expected = match.get("model_hash")
            add_check("pipeline_registry:model_entry_found", True, f"timestamp={match.get('timestamp')}")
            if isinstance(expected, str) and expected:
                add_check(
                    "pipeline_registry:model_hash_matches",
                    expected == model_sha256,
                    f"expected={expected} actual={model_sha256}",
                )
        else:
            add_check("pipeline_registry:model_entry_found", False, f"no entry for {model_path.name}")

    # --- Run config checks ---
    eda_run_cfg_path = metrics_dir / "eda_run_config.json"
    fe_run_cfg_path = metrics_dir / "feature_engineering_run.json"

    eda_run_cfg = None
    fe_run_cfg = None

    if eda_run_cfg_path.exists():
        try:
            eda_run_cfg = _load_json(eda_run_cfg_path)
            add_check("eda_run_config:json_parse", True)
        except Exception as e:
            add_check("eda_run_config:json_parse", False, str(e))
    else:
        add_check("eda_run_config:exists", False, "notebooks/output/metrics/eda_run_config.json not found")

    if fe_run_cfg_path.exists():
        try:
            fe_run_cfg = _load_json(fe_run_cfg_path)
            add_check("feature_engineering_run:json_parse", True)
        except Exception as e:
            add_check("feature_engineering_run:json_parse", False, str(e))
    else:
        add_check("feature_engineering_run:exists", False, "notebooks/output/metrics/feature_engineering_run.json not found")

    # Cross-check IDs with latest run configs (best-effort; may not match if not "latest").
    if isinstance(eda_run_cfg, dict) and isinstance(eda_id, str):
        if eda_run_cfg.get("eda_id"):
            add_check(
                "eda_run_config:eda_id_matches_model",
                eda_run_cfg.get("eda_id") == eda_id,
                f"eda_run_config={eda_run_cfg.get('eda_id')} model={eda_id}",
            )

    if isinstance(fe_run_cfg, dict) and isinstance(fe_id, str):
        if fe_run_cfg.get("fe_id"):
            add_check(
                "feature_engineering_run:fe_id_matches_model",
                fe_run_cfg.get("fe_id") == fe_id,
                f"feature_engineering_run={fe_run_cfg.get('fe_id')} model={fe_id}",
            )

    # Verify feature CSV hash using the stable per-run features_extracted file if available.
    expected_features_hash = eda_trace.get("features_csv_hash")
    if isinstance(fe_run_cfg, dict):
        features_csv_path = _coerce_path(fe_run_cfg.get("features_csv_path"), root=repo_root)
        add_file("features_csv_path", features_csv_path, expected_sha256=expected_features_hash, required=False)
    else:
        add_file("features_csv_path", None, expected_sha256=expected_features_hash, required=False)

    # Verify "features_latest.csv" hash if present (can change over time; treat as informational).
    features_latest_path = (repo_root / "notebooks" / "output" / "data" / "features_latest.csv").resolve()
    add_file("features_latest_csv", features_latest_path, expected_sha256=None, required=False)

    # Verify raw CSV (if present in eda_run_config).
    if isinstance(eda_run_cfg, dict):
        raw_csv_path = _coerce_path(eda_run_cfg.get("raw_csv_path"), root=repo_root)
        add_file("raw_csv_path", raw_csv_path, expected_sha256=None, required=False)

    # Show auxiliary files for convenience.
    add_file("pipeline_registry", pipeline_registry_path, required=False)
    add_file("eda_run_config", eda_run_cfg_path, required=False)
    add_file("feature_engineering_run", fe_run_cfg_path, required=False)

    ok = all(bool(c.get("ok")) for c in report["checks"])
    report["ok"] = ok
    print(json.dumps(report, indent=2, ensure_ascii=True))
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())

