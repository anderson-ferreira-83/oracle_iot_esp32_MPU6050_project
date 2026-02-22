#!/usr/bin/env python3
"""
Analyze ML transition logs (logs/ml_transitions_*.json).

This script is intentionally dependency-free (stdlib only) so it can run in
minimal Python environments.
"""

from __future__ import annotations

import argparse
import json
import statistics as stats
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def _as_float(v: Any) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    return None


def load_events(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"Expected list in {path}, got {type(data).__name__}")

    ev: list[dict[str, Any]] = []
    for x in data:
        if not isinstance(x, dict):
            continue
        if not x.get("from") or not x.get("to"):
            continue
        ts = x.get("timestamp")
        if not isinstance(ts, (int, float)):
            continue
        ev.append(x)

    ev.sort(key=lambda x: float(x["timestamp"]))
    return ev


def analyze_log(
    events: list[dict[str, Any]],
    *,
    backtrack_s: float = 5.0,
    low_to_medium_gate: float | None = None,
) -> dict[str, Any]:
    if not events:
        return {
            "n_transitions": 0,
            "span_s": None,
        }

    # Backtrack pairs: A->B then B->A within backtrack_s (seconds)
    backtrack_pairs: list[dict[str, Any]] = []
    backtrack_idx: set[int] = set()
    for i in range(1, len(events)):
        a = events[i - 1]
        b = events[i]
        if a.get("from") == b.get("to") and a.get("to") == b.get("from"):
            dt_s = (float(b["timestamp"]) - float(a["timestamp"])) / 1000.0
            if dt_s <= backtrack_s:
                backtrack_pairs.append(
                    {
                        "i": i - 1,
                        "j": i,
                        "pair": f"{a.get('from')}<->{a.get('to')}",
                        "dt_s": round(dt_s, 3),
                        "conf_i": _as_float(a.get("confidence")),
                        "conf_j": _as_float(b.get("confidence")),
                    }
                )
                backtrack_idx.add(i - 1)
                backtrack_idx.add(i)

    ts0 = float(events[0]["timestamp"]) / 1000.0
    ts1 = float(events[-1]["timestamp"]) / 1000.0
    span_s = max(0.0, ts1 - ts0)
    transitions_per_min = (len(events) / (span_s / 60.0)) if span_s > 0 else None

    conf = [_as_float(x.get("confidence")) for x in events]
    conf = [c for c in conf if c is not None]

    dirs = Counter((x.get("from"), x.get("to")) for x in events)

    # LOW->MEDIUM analysis (stable vs backtrack)
    l2m = []
    for idx, x in enumerate(events):
        if x.get("from") == "LOW" and x.get("to") == "MEDIUM":
            l2m.append(
                {
                    "idx": idx,
                    "is_backtrack": idx in backtrack_idx,
                    "confidence": _as_float(x.get("confidence")),
                    "best": (x.get("featureAgreement") or {}).get("best")
                    if isinstance(x.get("featureAgreement"), dict)
                    else None,
                    "bestCount": (x.get("featureAgreement") or {}).get("bestCount")
                    if isinstance(x.get("featureAgreement"), dict)
                    else None,
                    "total": (x.get("featureAgreement") or {}).get("total")
                    if isinstance(x.get("featureAgreement"), dict)
                    else None,
                }
            )

    def _l2m_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
        cs = [it["confidence"] for it in items if isinstance(it.get("confidence"), (int, float))]
        bcs = [it["bestCount"] for it in items if isinstance(it.get("bestCount"), (int, float))]
        best_eq = sum(1 for it in items if it.get("best") == "MEDIUM")
        return {
            "n": len(items),
            "confidence": {
                "mean": round(stats.fmean(cs), 3) if cs else None,
                "min": round(min(cs), 3) if cs else None,
                "max": round(max(cs), 3) if cs else None,
            },
            "best_eq_to_pct": round(best_eq / len(items) * 100.0, 1) if items else None,
            "bestCount_counts": dict(Counter(bcs)) if bcs else {},
        }

    l2m_back = [it for it in l2m if it["is_backtrack"]]
    l2m_stable = [it for it in l2m if not it["is_backtrack"]]

    out: dict[str, Any] = {
        "n_transitions": len(events),
        "span_s": round(span_s, 3),
        "transitions_per_min": round(transitions_per_min, 3) if transitions_per_min is not None else None,
        "confidence": {
            "mean": round(stats.fmean(conf), 3) if conf else None,
            "min": round(min(conf), 3) if conf else None,
            "max": round(max(conf), 3) if conf else None,
        },
        "dirs_top": [
            {"from": a, "to": b, "count": c}
            for (a, b), c in dirs.most_common(10)
        ],
        "backtracks": {
            "window_s": backtrack_s,
            "pair_count": len(backtrack_pairs),
            "transition_count": len(backtrack_idx),
            "pair_types": dict(Counter(p["pair"] for p in backtrack_pairs)),
            "examples": backtrack_pairs[:10],
        },
        "low_to_medium": {
            "all": _l2m_summary(l2m),
            "backtrack": _l2m_summary(l2m_back),
            "stable": _l2m_summary(l2m_stable),
        },
    }

    if low_to_medium_gate is not None:
        def _blocked(items: list[dict[str, Any]]) -> int:
            return sum(
                1
                for it in items
                if isinstance(it.get("confidence"), (int, float))
                and float(it["confidence"]) < low_to_medium_gate
            )

        # Simple (approx) estimate: how many LOW->MEDIUM transitions would be blocked by a gate.
        out["low_to_medium_gate_sim"] = {
            "gate": low_to_medium_gate,
            "blocked_backtrack": _blocked(l2m_back),
            "blocked_stable": _blocked(l2m_stable),
            "blocked_total": _blocked(l2m),
        }

        # Backtrack pair reduction estimate if we blocked LOW->MEDIUM transitions under this gate.
        blocked_pairs = 0
        for p in backtrack_pairs:
            i = p["i"]
            j = p["j"]
            a = events[i]
            b = events[j]
            a_block = (
                a.get("from") == "LOW"
                and a.get("to") == "MEDIUM"
                and (_as_float(a.get("confidence")) is not None)
                and float(a["confidence"]) < low_to_medium_gate
            )
            b_block = (
                b.get("from") == "LOW"
                and b.get("to") == "MEDIUM"
                and (_as_float(b.get("confidence")) is not None)
                and float(b["confidence"]) < low_to_medium_gate
            )
            if a_block or b_block:
                blocked_pairs += 1
        out["backtrack_pair_gate_sim"] = {
            "gate": low_to_medium_gate,
            "blocked_pairs": blocked_pairs,
            "total_pairs": len(backtrack_pairs),
            "blocked_pct": round(blocked_pairs / len(backtrack_pairs) * 100.0, 1) if backtrack_pairs else None,
        }

    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Analyze ML transition logs.")
    ap.add_argument("logs", nargs="+", help="Path(s) to logs/ml_transitions_*.json")
    ap.add_argument("--backtrack-s", type=float, default=5.0, help="Backtrack window in seconds (default: 5)")
    ap.add_argument("--low-to-medium-gate", type=float, default=None, help="Simulate blocking LOW->MEDIUM transitions under this confidence gate")
    ap.add_argument("--out", default=None, help="Optional output JSON path. If multiple logs are provided, writes a JSON list.")
    args = ap.parse_args()

    all_reports: list[dict[str, Any]] = []
    for i, p in enumerate(args.logs):
        path = Path(p)
        events = load_events(path)
        report = analyze_log(
            events,
            backtrack_s=args.backtrack_s,
            low_to_medium_gate=args.low_to_medium_gate,
        )
        report["file"] = path.name
        all_reports.append(report)

        if args.out is None:
            if i:
                print()
            print(json.dumps(report, indent=2, ensure_ascii=True))

    if args.out is not None:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload: Any = all_reports[0] if len(all_reports) == 1 else all_reports
        out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8")
        print(str(out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
