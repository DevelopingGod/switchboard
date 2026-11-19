#!/usr/bin/env python3
"""Local-model residency and classifier latency under load (M3b, ADR 0002).

Runs inside the router image against the real Ollama, with the active local-model profile from
config/local-models.yaml, so the same script measures any profile before and after a change:

  A  classifier alone: every prompt of the labelled set through the real `classify()` (p50/p95, and
     how many fell back to the keyword heuristics, which is the privacy-relevant number)
  B  classifier while a title/summary job runs: rounds of "start a task-model generation, then
     classify a few prompts at once" (the case that used to push the classifier over its timeout or
     evict it from a small GPU)
  C  `ollama ps` after each phase: what is loaded, how much of it in GPU memory

    docker compose -f deploy/docker-compose.yml run --rm --no-deps -v "$PWD/scripts:/scripts:ro" \\
      router python /scripts/measure-local.py [--rounds 8] [--profile small]

Markdown goes to stdout. No cloud model is called.
"""

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, "/srv/router")

from app import local_profile, ollama  # noqa: E402
from app.chat import aux_llm  # noqa: E402
from app.routing import classifier, secrets_detect  # noqa: E402
from app.routing.rules import load_rules  # noqa: E402

DATA = Path("/srv/router/tests/routing.jsonl")
TITLE_PROMPT = (
    "Write a title of at most six words for this conversation. Reply with the title only.\n\n"
    "User: Can you plan a ten day trip around Japan for two people who like food, small towns and hiking, "
    "with a budget of about three thousand dollars each, leaving in April?\n"
    "Assistant: Sure. Start in Tokyo for three days, then Kanazawa, the Kiso valley and Kyoto."
)


def pct(xs: list[int], p: float) -> int:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else 0


async def ps_table(label: str) -> str:
    loaded = await ollama.ps() or []
    rows = [
        f"| {m.get('name')} | {round(m.get('size', 0) / 2**20)} | {round(m.get('size_vram', 0) / 2**20)} |"
        for m in loaded
    ]
    body = "\n".join(rows) or "| (nothing loaded) | | |"
    return f"**`ollama ps` {label}**\n\n| model | MiB total | MiB in GPU |\n|---|---|---|\n{body}\n"


def summarize(name: str, rows: list[dict]) -> str:
    ms = [r["ms"] for r in rows]
    fb = [r for r in rows if r["source"] == "heuristic"]
    reasons = sorted({r.get("why") or "?" for r in fb})
    return (
        f"| {name} | {len(rows)} | {statistics.median(ms):.0f} | {pct(ms, 0.95)} | {max(ms)} | "
        f"{len(fb)} ({100 * len(fb) / len(rows):.0f}%) | {'; '.join(reasons) or '·'} |"
    )


async def classify_all(texts: list[str], cfg) -> list[dict]:
    out = []
    for text in texts:
        masked, kinds = secrets_detect.mask(text)
        if kinds:
            continue
        r = await classifier.classify(masked, cfg)
        out.append({"ms": r.info["ms"], "source": r.info["source"], "why": r.info.get("fallback_reason")})
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=None, help="default: the profile in system_meta, else `small`")
    ap.add_argument("--rounds", type=int, default=8)
    args = ap.parse_args()
    local_profile.set_active(args.profile or "small")
    prof = local_profile.active()
    cfg = load_rules().classifier
    texts = [json.loads(line)["text"] for line in DATA.read_text().splitlines() if line.strip()]
    # prefilter-decided prompts never reach the model; only those measure the classifier
    texts = [t for t in texts if classifier.prefilter(t) is None]

    print(f"profile `{prof.name}`: classifier {prof.classifier} {prof.classifier_options or ''}, "
          f"tasks {prof.tasks} {getattr(prof, 'tasks_options', '') or ''}, general {prof.general}\n"
          f"classifier timeout {cfg.timeout_s:g} s, {len(texts)} model-bound prompts\n")

    # Warm up the way a session does: the chat model answers, the classifier is loaded. Then settle:
    # the first classifier call after a (re)load can be slow, and a timeout opens the 60 s breaker, so
    # it is measured on its own and the breaker is reset before the measured phases.
    await ollama.chat(prof.general, [{"role": "user", "content": "hi"}], timeout=120, keep_alive="10m",
                      think=False, options={"num_predict": 1})
    classifier.reset()
    await ollama.chat(prof.classifier, [{"role": "user", "content": "hi"}], timeout=120, keep_alive=-1,
                      think=None, options=classifier.model_options(num_predict=1))
    print(await ps_table("after loading the chat model, then the classifier"))
    first = await classify_all(texts[:1], cfg)
    print(f"first classification after warm-up: {first[0]['ms']} ms via {first[0]['source']}\n")
    classifier.reset()

    a = await classify_all(texts, cfg)

    classifier.reset()
    b: list[dict] = []
    titles: list[float] = []

    async def title() -> None:
        t0 = time.perf_counter()
        text, _ = await aux_llm.generate(
            None, TITLE_PROMPT, max_tokens=24, timeout=90, cloud_ok=False, connected={"ollama"}
        )
        titles.append(time.perf_counter() - t0)
        if not text:
            print("(title job returned nothing)", file=sys.stderr)

    for i in range(args.rounds):
        task = asyncio.create_task(title())
        await asyncio.sleep(0.3)  # the title job is running when the next message arrives
        b += await classify_all(texts[i * 3 : i * 3 + 3], cfg)
        await task
    print(await ps_table("after the title jobs"))

    print("| phase | calls | p50 ms | p95 ms | max ms | heuristic fallbacks | reasons |")
    print("|---|---|---|---|---|---|---|")
    print(summarize("A classifier alone", a))
    print(summarize("B while a title job runs", b))
    print(f"\ntitle job: median {statistics.median(titles):.1f} s, max {max(titles):.1f} s over {len(titles)}")


asyncio.run(main())
