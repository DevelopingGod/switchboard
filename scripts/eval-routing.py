#!/usr/bin/env python3
"""Routing accuracy on the labelled set (M3a): services/router/tests/routing.jsonl.

Runs inside the router image against the real Ollama (the classifier is live; no cloud model is
called). Three ways of labelling every prompt:
  full        what a chat turn does: secret check -> pre-filter -> Arch-Router -> heuristics fallback
  classifier  Arch-Router alone on every prompt (no pre-filter, no fallback)
  heuristics  the M2 keyword heuristics alone

Reports accuracy on all lines, on the tuning half (odd line numbers, the only ones used to tune the
route descriptions) and on the held-out half (even line numbers), a confusion matrix for `full`, and
classifier latency (cold first call, then p50/p95). Markdown goes to stdout.

    docker compose -f deploy/docker-compose.yml run --rm --no-deps -v "$PWD/scripts:/scripts:ro" \\
      router python /scripts/eval-routing.py [--timeout 1.5] [--overrides]

--saved-rules uses the classifier wording saved in the Rules UI instead of rules.yaml's (tune, save, measure).
--overrides adds a table from the Router DB: how many requests auto-detection kept local and how many
of those you overrode with "Not sensitive — use cloud".
"""

import argparse
import asyncio
import json
import statistics
import sys
import time
from collections import Counter
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, "/srv/router")

from app import local_profile, ollama  # noqa: E402
from app.routing import classifier, heuristics, secrets_detect  # noqa: E402
from app.routing.rules import load_rules  # noqa: E402

LABELS = ["writing", "code-small", "code-large", "research", "image", "video", "private", "chat"]
DATA = Path("/srv/router/tests/routing.jsonl")


def label_of(intent: heuristics.Intent) -> str:
    if intent.sensitive:
        return "private"
    if intent.intent == "code":
        return f"code-{intent.size}"
    return intent.intent if intent.intent in LABELS else "chat"


async def raw_route(text: str, cfg) -> tuple[str | None, int]:
    t0 = time.perf_counter()
    try:
        raw = await ollama.chat(
            local_profile.active().classifier,
            [{"role": "user", "content": classifier.build_prompt(cfg.routes, text[: cfg.max_chars])}],
            timeout=60,
            keep_alive=-1,
            think=None,
            options=classifier.model_options(),
        )
    except ollama.OllamaError:
        return None, int((time.perf_counter() - t0) * 1000)
    return classifier.parse_route(raw, cfg), int((time.perf_counter() - t0) * 1000)


def acc(rows, key, subset=None) -> str:
    rs = [r for r in rows if subset is None or subset(r)]
    ok = sum(r[key] == r["label"] for r in rs)
    return f"{ok}/{len(rs)} = {100 * ok / len(rs):.1f}%"


def matrix(rows, key) -> str:
    c = Counter((r["label"], r[key]) for r in rows)
    out = ["| true \\ predicted | " + " | ".join(LABELS) + " |", "|---|" + "---|" * len(LABELS)]
    for t in LABELS:
        cells = [f"**{c[(t, p)]}**" if t == p else (str(c[(t, p)]) if c[(t, p)] else "·") for p in LABELS]
        out.append(f"| {t} | " + " | ".join(cells) + " |")
    return "\n".join(out)


async def overrides() -> str:
    from sqlalchemy import select

    from app import db
    from app.models import Request

    async with db.sessionmaker()() as s:
        reqs = (await s.execute(select(Request).where(Request.decision_json["sensitive"].isnot(None)))).scalars()
        rows = [r.decision_json.get("sensitive") or {} for r in reqs]
    auto = [r for r in rows if r.get("source") == "classifier" and not r.get("already_private")]
    over = [r for r in auto if r.get("overridden")]
    by_cat = Counter(r.get("category") for r in auto)
    lines = [
        "| auto-detected (kept local) | overridden by you | precision (not overridden) |",
        "|---|---|---|",
        f"| {len(auto)} | {len(over)} | {(100 * (len(auto) - len(over)) / len(auto)) if auto else 0:.0f}% |",
        "",
        "By category: " + (", ".join(f"{k} {v}" for k, v in by_cat.most_common()) or "none yet"),
        f"Secrets kept local: {sum(1 for r in rows if r.get('source') == 'secret')}",
    ]
    return "\n".join(lines)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=float, default=None, help="classifier limit for `full` (default rules.yaml)")
    ap.add_argument("--overrides", action="store_true")
    ap.add_argument("--saved-rules", action="store_true", help="use the Rules UI's saved overrides (Router DB), not just rules.yaml")
    ap.add_argument("--profile", default="small")
    ap.add_argument("--cpu", action="store_true", help="run the classifier on the CPU (num_gpu 0)")
    args = ap.parse_args()
    local_profile.set_active(args.profile)
    if args.cpu:
        base = local_profile.active
        local_profile.active = lambda: replace(base(), classifier_options={"num_gpu": 0})
    cfg = load_rules().classifier
    if args.saved_rules:  # M3b: tune the route descriptions in the Rules UI, then measure the result here
        from app import db, rules_versions

        async with db.sessionmaker()() as s:
            cfg = (await rules_versions.effective_rules(s)).classifier
    if args.timeout:
        cfg = replace(cfg, timeout_s=args.timeout)

    items = [json.loads(line) for line in DATA.read_text().splitlines() if line.strip()]
    for i, it in enumerate(items, 1):
        it["line"] = i

    # classifier alone (first call shows the cold-load time)
    ms: list[int] = []
    for it in items:
        route, t = await raw_route(it["text"], cfg)
        ms.append(t)
        it["classifier"] = "chat" if route in (None, "other") else label_of(classifier.to_intent(route, cfg, it["text"]))
        it["route"] = route
    # the full pipeline, as a chat turn runs it (warm model)
    classifier.reset()
    for it in items:
        masked, kinds = secrets_detect.mask(it["text"])
        if kinds:
            it["full"], it["source"] = "private", "secret"
            continue
        r = await classifier.classify(masked, cfg)
        it["full"], it["source"] = label_of(r.intent), r.info["source"]
        it["fallback"] = r.info.get("fallback_reason")
    for it in items:
        it["heuristics"] = label_of(heuristics.detect(it["text"]))

    odd, even = (lambda r: r["line"] % 2 == 1), (lambda r: r["line"] % 2 == 0)
    warm = ms[1:]
    print(f"Labelled prompts: {len(items)} ({', '.join(f'{k} {v}' for k, v in Counter(i['label'] for i in items).items())})\n")
    print("| method | all | tuning half (odd lines) | held-out half (even lines) |")
    print("|---|---|---|---|")
    for key in ("full", "classifier", "heuristics"):
        print(f"| {key} | {acc(items, key)} | {acc(items, key, odd)} | {acc(items, key, even)} |")
    src = Counter(i["source"] for i in items)
    print(f"\nFull pipeline sources: {', '.join(f'{k} {v}' for k, v in src.most_common())}")
    fb = Counter(i.get("fallback") for i in items if i.get("fallback"))
    if fb:
        print("Fallbacks: " + "; ".join(f"{k} ×{v}" for k, v in fb.items()))
    print(
        f"\nClassifier latency: first call {ms[0]} ms (includes any model load), then p50 "
        f"{int(statistics.median(warm))} ms, p95 {sorted(warm)[int(0.95 * (len(warm) - 1))]} ms, "
        f"max {max(warm)} ms (n={len(warm)})\n"
    )
    print("Confusion matrix (full pipeline):\n")
    print(matrix(items, "full"))
    wrong = [i for i in items if i["full"] != i["label"]]
    if wrong:
        print("\nMisses (full pipeline):\n")
        for i in wrong:
            print(f"- line {i['line']}: {i['label']} → {i['full']} ({i['source']}, route {i.get('route')}): {i['text'][:90]}")
    if args.overrides:
        print("\nAuto-private decisions vs your overrides (Router DB):\n")
        print(await overrides())


if __name__ == "__main__":
    asyncio.run(main())
