#!/usr/bin/env python3
"""
Create a traceability manifest that links:
  raw dataframe export (CSV) -> EDA figures -> feature dataset -> trained model

This is intended to be dependency-free (stdlib only).

Example:
  python tools/trace_make_manifest.py --model models/gnb_model_20260207.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_json(path: Path) -> Any:
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


def _file_meta(path: Path, *, expected_sha256: str | None = None) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "path": str(path),
        "exists": path.exists(),
        "expected_sha256": expected_sha256,
        "sha256": None,
        "size": None,
        "mtime": None,
    }
    if path.exists() and path.is_file():
        st = path.stat()
        entry["size"] = st.st_size
        entry["mtime"] = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        entry["sha256"] = _sha256_file(path)
    return entry


def main() -> int:
    ap = argparse.ArgumentParser(description="Create a traceability manifest (model -> data -> figures).")
    ap.add_argument("--model", required=True, help="Path to model JSON (e.g. models/gnb_model_20260207.json)")
    ap.add_argument(
        "--out",
        default=None,
        help="Output manifest path. Default: notebooks/output/metrics/runs/<eda_id>/trace_manifest.json",
    )
    ap.add_argument("--no-figures", action="store_true", help="Do not include figure file hashes.")
    ap.add_argument(
        "--transition-logs",
        nargs="*",
        default=None,
        help="Optional path(s) to runtime transition logs (logs/ml_transitions_*.json) to analyze and embed.",
    )
    ap.add_argument("--backtrack-s", type=float, default=5.0, help="Backtrack window in seconds for transition log analysis.")
    ap.add_argument("--low-to-medium-gate", type=float, default=None, help="Simulate blocking LOW->MEDIUM transitions under this confidence gate.")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    model_path = (repo_root / args.model).resolve() if not Path(args.model).is_absolute() else Path(args.model)

    if not model_path.exists():
        raise SystemExit(f"Model not found: {model_path}")

    model = _load_json(model_path)
    model_sha = _sha256_file(model_path)
    eda_trace = model.get("eda_traceability") if isinstance(model, dict) else None
    eda_trace = eda_trace if isinstance(eda_trace, dict) else {}
    eda_id = eda_trace.get("eda_id") if isinstance(eda_trace.get("eda_id"), str) else None

    metrics_dir = repo_root / "notebooks" / "output" / "metrics"
    data_dir = repo_root / "notebooks" / "output" / "data"
    figures_dir = repo_root / "notebooks" / "output" / "figures"

    # Load best-effort run configs (these are "latest" pointers).
    data_source_cfg_path = metrics_dir / "data_source_config.json"
    eda_run_cfg_path = metrics_dir / "eda_run_config.json"
    fe_run_cfg_path = metrics_dir / "feature_engineering_run.json"
    pipeline_registry_path = metrics_dir / "pipeline_registry.json"

    def safe_load(path: Path) -> Any:
        try:
            return _load_json(path) if path.exists() else None
        except Exception:
            return None

    data_source_cfg = safe_load(data_source_cfg_path) or {}
    eda_run_cfg = safe_load(eda_run_cfg_path) or {}
    fe_run_cfg = safe_load(fe_run_cfg_path) or {}
    pipeline_registry = safe_load(pipeline_registry_path) or {}

    if not args.out:
        runs_dir = metrics_dir / "runs"
        if eda_id:
            out_path = runs_dir / eda_id / "trace_manifest.json"
        else:
            out_path = runs_dir / f"trace_manifest_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    else:
        out_path = (repo_root / args.out).resolve() if not Path(args.out).is_absolute() else Path(args.out)

    out_path.parent.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, Any] = {
        "schema_version": "1.0",
        "created_at": _utc_now_iso(),
        "repo_root": str(repo_root),
        "eda_id": eda_id,
        "fe_id": eda_trace.get("fe_id"),
        "model": {
            "path": str(model_path),
            "sha256": model_sha,
            "version": model.get("version"),
            "generated_at": model.get("generated_at"),
            "generated_by": model.get("generated_by"),
            "feature_count": len(model.get("features") or []),
            "labels": model.get("labels"),
            "eda_traceability": eda_trace,
        },
        "metrics": {
            "data_source_config": _file_meta(data_source_cfg_path),
            "eda_run_config": _file_meta(eda_run_cfg_path),
            "feature_engineering_run": _file_meta(fe_run_cfg_path),
            "pipeline_registry": _file_meta(pipeline_registry_path),
            "data_source_config_content": data_source_cfg,
            "eda_run_config_content": eda_run_cfg,
            "feature_engineering_run_content": fe_run_cfg,
        },
        "data": {},
        "figures": {
            "dir": str(figures_dir),
            "count": 0,
            "files": [],
        },
        "runtime": {
            "transition_logs": {
                "analysis_params": {
                    "backtrack_s": args.backtrack_s,
                    "low_to_medium_gate": args.low_to_medium_gate,
                },
                "files": [],
                "analysis": [],
            }
        },
    }

    # Data files referenced by latest configs (best-effort).
    raw_csv_path = _coerce_path(eda_run_cfg.get("raw_csv_path"), root=repo_root)
    if raw_csv_path:
        manifest["data"]["raw_csv"] = _file_meta(raw_csv_path)

    feat_csv_path = _coerce_path(fe_run_cfg.get("features_csv_path"), root=repo_root)
    if feat_csv_path:
        expected = eda_trace.get("features_csv_hash") if isinstance(eda_trace.get("features_csv_hash"), str) else None
        manifest["data"]["features_csv"] = _file_meta(feat_csv_path, expected_sha256=expected)

    latest_feat = data_dir / "features_latest.csv"
    if latest_feat.exists():
        manifest["data"]["features_latest_csv"] = _file_meta(latest_feat)

    # Figure hashing (optional)
    if not args.no_figures and figures_dir.exists():
        files: list[dict[str, Any]] = []
        for p in sorted(figures_dir.rglob("*")):
            if not p.is_file():
                continue
            # Skip any future "runs/" folder to avoid mixing snapshot + latest.
            if "runs" in {part.lower() for part in p.parts}:
                continue
            if p.suffix.lower() not in {".png", ".html"}:
                continue
            files.append(_file_meta(p))
        manifest["figures"]["files"] = files
        manifest["figures"]["count"] = len(files)

    # Runtime transition log analysis (optional)
    if args.transition_logs:
        try:
            # Keep stdlib-only by importing our own tool module.
            import analyze_transition_logs as atl  # type: ignore

            for p in args.transition_logs:
                lp = (repo_root / p).resolve() if not Path(p).is_absolute() else Path(p)
                manifest["runtime"]["transition_logs"]["files"].append(_file_meta(lp))
                if lp.exists() and lp.is_file():
                    events = atl.load_events(lp)
                    report = atl.analyze_log(
                        events,
                        backtrack_s=float(args.backtrack_s),
                        low_to_medium_gate=args.low_to_medium_gate,
                    )
                    report["file"] = lp.name
                    manifest["runtime"]["transition_logs"]["analysis"].append(report)
        except Exception as e:
            manifest["runtime"]["transition_logs"]["error"] = str(e)

    out_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=True), encoding="utf-8")
    print(str(out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
