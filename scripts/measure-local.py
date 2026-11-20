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

  --chat (M4a, ADR 0006): private chat speed instead. Each candidate answers the same short private
  questions with the chat system prompt and streaming, after one warm-up call: time to the first answer
  token, time spent thinking, total time, answer tokens, and whether the answer starts with reasoning
  ("Okay, the user ..."). A candidate is `model` (thinking on, the model's default), `model@nothink`
  (Ollama `think: false`) or `litellm:<alias>[@nothink]` (the real chat path through LiteLLM; @nothink
  sends `reasoning_effort: "none"`, which LiteLLM maps to `think: false`).

    ... router python /scripts/measure-local.py --chat litellm:local qwen3:4b@nothink llama3.2:3b

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


CHAT_QUESTIONS = [
    "I've had a headache and a mild fever since yesterday. What should I do?",
    "How do I tell my manager I need a week off for personal reasons?",
    "What's a reasonable monthly budget split for a salary of 60,000 rupees?",
    "Explain what a credit score is in two sentences.",
    "My landlord kept my deposit. What are my options?",
    "Give me three tips to sleep better.",
    "What's the difference between a will and a trust?",
    "Is it normal to feel anxious before a job interview?",
    "Summarise the pros and cons of paying off a loan early.",
    "How much water should I drink in a day?",
]
REASONING_START = ("okay, the user", "okay, so the user", "alright, the user", "the user is asking",
                   "the user wants", "let me think", "hmm,")


async def stream_ollama(model: str, think: bool | None, q: str) -> dict:
    import httpx

    from app.chat.service import SYSTEM_PROMPT

    body = {"model": model, "stream": True, "keep_alive": "10m",
            "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": q}],
            "options": {"temperature": 0.4, "num_predict": 1024}}
    if think is not None:
        body["think"] = think
    t0 = time.perf_counter()
    first = None
    thought = False
    text = []
    tokens = 0
    async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=5)) as c, \
            c.stream("POST", f"{ollama.base()}/api/chat", json=body) as r:
        async for line in r.aiter_lines():
            if not line:
                continue
            o = json.loads(line)
            msg = o.get("message") or {}
            if msg.get("thinking"):
                thought = True
            if msg.get("content"):
                text.append(msg["content"])
                if first is None:
                    first = time.perf_counter()
            if o.get("done"):
                tokens = o.get("eval_count") or 0
    end = time.perf_counter()
    return finish(t0, first, end, "".join(text), tokens, thought)


async def stream_litellm(alias: str, nothink: bool, q: str) -> dict:
    import httpx

    from app.chat.service import SYSTEM_PROMPT
    from app.config import get_settings

    st = get_settings()
    body = {"model": alias, "stream": True, "stream_options": {"include_usage": True},
            "temperature": 0.4, "max_tokens": 4096,
            "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": q}]}
    if nothink:
        body["reasoning_effort"] = "none"
    headers = {"Authorization": f"Bearer {st.litellm_master_key.get_secret_value()}"}
    t0 = time.perf_counter()
    first = None
    thought = False
    text = []
    tokens = 0
    async with httpx.AsyncClient(base_url=st.litellm_url, timeout=httpx.Timeout(300, connect=5)) as c, \
            c.stream("POST", "/v1/chat/completions", json=body, headers=headers) as r:
        async for line in r.aiter_lines():
            if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                continue
            o = json.loads(line[5:])
            if o.get("usage"):
                tokens = o["usage"].get("completion_tokens") or 0
            for ch in o.get("choices") or []:
                d = ch.get("delta") or {}
                if d.get("reasoning_content"):
                    thought = True
                if d.get("content"):
                    text.append(d["content"])
                    if first is None and "<think>" not in d["content"]:
                        first = time.perf_counter()
    end = time.perf_counter()
    return finish(t0, first, end, "".join(text), tokens, thought)


def finish(t0, first, end, text, tokens, thought) -> dict:
    body = ollama.THINK.sub("", text).strip()
    return {
        "first_s": (first or end) - t0,
        "total_s": end - t0,
        "tokens": tokens,
        "thought": thought or "<think>" in text,
        "leak": body.lower().startswith(REASONING_START),
        "chars": len(body),
    }


async def chat_bench(candidates: list[str]) -> None:
    print(f"{len(CHAT_QUESTIONS)} short private questions per candidate, after one warm-up call; "
          "times are wall-clock from the request to the first answer token and to the end.\n")
    rows = []
    for cand in candidates:
        name, _, flag = cand.partition("@")
        nothink = flag == "nothink"
        if name.startswith("litellm:"):
            alias = name.split(":", 1)[1]
            run = lambda q, a=alias, n=nothink: stream_litellm(a, n, q)  # noqa: E731
        else:
            run = lambda q, m=name, n=nothink: stream_ollama(m, False if n else None, q)  # noqa: E731
        await run("hi")  # load the model; not measured
        res = [await run(q) for q in CHAT_QUESTIONS]
        loaded = await ollama.ps() or []
        gpu = "; ".join(
            f"{m.get('name')} {100 * m.get('size_vram', 0) / max(1, m.get('size', 1)):.0f}% of "
            f"{m.get('size', 0) / 2**30:.1f} GB" for m in loaded
        ) or "?"
        first = [r["first_s"] for r in res]
        total = [r["total_s"] for r in res]
        rows.append(
            f"| `{cand}` | {statistics.median(first):.1f} | {max(first):.1f} | {statistics.median(total):.1f} | "
            f"{max(total):.1f} | {statistics.median([r['tokens'] for r in res]):.0f} | "
            f"{sum(r['thought'] for r in res)} | {sum(r['leak'] for r in res)} | "
            f"{statistics.median([r['chars'] for r in res]):.0f} | {gpu} |"
        )
        print(rows[-1], file=sys.stderr, flush=True)
    print("| candidate | first token p50 s | max s | total p50 s | max s | tokens p50 | thought | "
          "reasoning in answer | answer chars p50 | loaded (share in GPU) |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    print("\n".join(rows))


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=None, help="default: the profile in system_meta, else `small`")
    ap.add_argument("--rounds", type=int, default=8)
    ap.add_argument("--chat", nargs="+", metavar="CANDIDATE", help="measure private chat speed instead")
    args = ap.parse_args()
    if args.chat:
        await chat_bench(args.chat)
        return
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
