#!/usr/bin/env python3
"""Tests every chat-capable Gemini catalog model through the router (POST /models/test) and prints a
reliability table, to pick the model `smart-free` should be pinned to (M1b, docs/m1b.md).

Each model is called ROUNDS times, one call at a time and throttled so the free tier's per-minute
limit is not what is being measured. A model "answers reliably" when every round succeeds.

    python3 scripts/gemini-sweep.py [--rounds 3] [--pause 7] [--only substring | --models a,b,c] [--json out.json]

Needs the stack running and ROUTER_ADMIN_TOKEN (read from deploy/.env). It spends a little of the
Gemini free quota (about rounds x models one-token calls).
"""

import argparse
import json
import statistics
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUTER = "http://127.0.0.1:8100"


def env_value(name: str) -> str:
    for line in (ROOT / "deploy/.env").read_text().splitlines():
        k, _, v = line.partition("=")
        if k.strip() == name:
            return v.strip().strip("\"'")
    raise SystemExit(f"{name} not found in deploy/.env")


def call(method: str, path: str, token: str | None = None, body: dict | None = None, timeout: int = 90):
    req = urllib.request.Request(ROUTER + path, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = None
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data=data, timeout=timeout) as r:  # noqa: S310 - fixed loopback URL
        return json.load(r)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--pause", type=float, default=7.0, help="seconds between calls (free tier ~10 req/min)")
    ap.add_argument("--only", default="", help="only model ids containing this text")
    ap.add_argument("--models", default="", help="comma-separated model ids (skips the catalog filter)")
    ap.add_argument("--json", type=Path, help="also write raw results here")
    args = ap.parse_args()
    token = env_value("ROUTER_ADMIN_TOKEN")

    models = call("GET", "/catalog?provider=gemini")["models"]
    skip = {"image", "audio", "video", "embedding", "moderation"}
    ids = [m["model_id"] for m in models if "chat" in m["tags"] and not skip & set(m["tags"]) and args.only in m["model_id"]]
    if args.models:
        ids = [i for i in args.models.split(",") if i]
    print(f"{len(ids)} chat-capable Gemini models, {args.rounds} rounds each, {args.pause}s apart\n", flush=True)

    results: dict[str, list[dict]] = {}
    for rnd in range(args.rounds):
        for mid in ids:
            t0 = time.monotonic()
            try:
                r = call("POST", "/models/test", token, {"provider": "gemini", "model_id": mid})
            except Exception as e:  # noqa: BLE001 - report and continue
                r = {"ok": False, "latency_ms": None, "error": f"{type(e).__name__}"}
            r["error"] = " ".join(str(r.get("error") or "").split()) or None  # one line per call
            results.setdefault(mid, []).append(r)
            tag = "ok  " if r["ok"] else "FAIL"
            print(f"round {rnd + 1} {tag} {mid:42} {r.get('latency_ms') or '-':>6} ms  {(r.get('error') or '')[:70]}", flush=True)
            time.sleep(max(0.0, args.pause - (time.monotonic() - t0)))

    print("\n| model | ok | p50 ms | max ms | last error |\n|---|---|---|---|---|")
    rows = []
    for mid, rs in results.items():
        oks = [r["latency_ms"] for r in rs if r["ok"] and r["latency_ms"]]
        err = next((r["error"] for r in reversed(rs) if not r["ok"] and r.get("error")), "")
        rows.append((-len(oks), statistics.median(oks) if oks else 9e9, mid, len(oks), max(oks) if oks else None, err))
    for _, p50, mid, n, mx, err in sorted(rows):
        p50s = f"{int(p50)}" if p50 < 9e9 else "-"
        print(f"| `{mid}` | {n}/{args.rounds} | {p50s} | {mx or '-'} | {err[:60]} |")
    if args.json:
        args.json.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
