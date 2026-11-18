"""Intent classifier (SPEC §7.1 step 3, M3a): Arch-Router-1.5B on Ollama.

Order:
1. Pre-filter: strong keyword signals decide directly, with no model call: a code fence or stack
   trace, an explicit "make an image/video", a slash command (handled by the engine).
2. Arch-Router with the route descriptions from rules.yaml `classifier.routes`.
3. Fallback to the keyword heuristics when the active local profile has no classifier, Ollama is
   down, the answer takes longer than `timeout_s` (1.5 s) or isn't a known route. After a failure
   the classifier is skipped for `breaker_s` so an Ollama outage doesn't add 1.5 s to every request;
   a timeout also starts a background warm-up (cold model load), which closes the breaker early.

The result is passed into `engine.decide()`, which stays a pure function. Every decision records
where the intent came from (`source`, `route`, `ms`, `fallback_reason`).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

from app import local_profile, ollama
from app.routing import heuristics
from app.routing.heuristics import Intent
from app.routing.rules import ClassifierCfg, Route

log = logging.getLogger("app.classifier")

# From the Arch-Router-1.5B model card (katanemo/Arch-Router-1.5B): routes and conversation as JSON
# inside XML tags, the whole prompt in one user message, answer {"route": "<name>"} or "other".
TASK_INSTRUCTION = """
You are a helpful assistant designed to find the best suited route.
You are provided with route description within <routes></routes> XML tags:
<routes>

{routes}

</routes>

<conversation>

{conversation}

</conversation>
"""

FORMAT_PROMPT = """
Your task is to decide which route is best suit with user intent on the conversation in <conversation></conversation> XML tags.  Follow the instruction:
1. If the latest intent from user is irrelevant or user intent is full filled, response with other route {"route": "other"}.
2. You must analyze the route descriptions and find the best match route for user latest intent.
3. You only response the name of the route that best matches the user's request, use the exact name in the <routes></routes>.

Based on your analysis, provide your response in the following JSON formats if you decide to match any route:
{"route": "route_name"}
"""  # noqa: E501

WARMUP_TIMEOUT_S = 90


@dataclass
class Result:
    intent: Intent
    info: dict[str, Any] = field(default_factory=dict)


@dataclass
class _Breaker:
    until: float = 0.0
    reason: str | None = None
    warming: bool = False


breaker = _Breaker()


def reset() -> None:
    breaker.until, breaker.reason, breaker.warming = 0.0, None, False


def build_prompt(routes: tuple[Route, ...], text: str) -> str:
    route_cfg = [{"name": r.name, "description": r.description} for r in routes]
    conversation = [{"role": "user", "content": text}]
    return (
        TASK_INSTRUCTION.format(routes=json.dumps(route_cfg), conversation=json.dumps(conversation))
        + FORMAT_PROMPT
    )


def parse_route(raw: str, cfg: ClassifierCfg) -> str | None:
    """`{"route": "code_small"}` (possibly wrapped in prose or a code fence) -> a known route or other."""
    m = re.search(r"\{[^{}]*\}", raw)
    name = None
    if m:
        try:
            name = json.loads(m.group(0)).get("route")
        except (ValueError, AttributeError):
            name = None
    if name is None:
        m2 = re.search(r'"route"\s*:\s*"([\w-]+)"', raw)
        name = m2.group(1) if m2 else raw.strip().strip('"')
    if name == "other" or (isinstance(name, str) and cfg.route(name)):
        return name
    return None


def to_intent(route: str, cfg: ClassifierCfg, text: str) -> Intent:
    h = heuristics.detect(text)
    if route == "other":
        return Intent("chat", h.size, h.quality, None)
    facts = cfg.route(route).facts  # type: ignore[union-attr]
    intent = str(facts.get("intent") or ("chat" if "sensitive" in facts else h.intent))
    size = str(facts.get("size") or h.size)
    quality = str(facts.get("quality") or h.quality)
    return Intent(intent, size, quality, f"classifier: {route}", facts.get("sensitive"))


def prefilter(text: str) -> Intent | None:
    """Strong signals that need no model: media requests, code fences, stack traces."""
    if m := heuristics.VIDEO.search(text):
        return heuristics.Intent("video", "small", "normal", heuristics._cue(m))
    if m := heuristics.IMAGE.search(text):
        return heuristics.Intent("image", "small", "normal", heuristics._cue(m))
    if heuristics.CODE_FENCE.search(text) or heuristics.TRACE.search(text):
        return heuristics.detect(text)  # code; size from the heuristics (repo words, length)
    return None


async def _warm(model: str) -> None:
    try:
        await ollama.chat(
            model, [{"role": "user", "content": "hi"}], timeout=WARMUP_TIMEOUT_S, keep_alive=-1, think=None
        )
        reset()
        log.info("classifier %s warmed up", model)
    except ollama.OllamaError as e:
        log.info("classifier warm-up failed: %s", e)
    finally:
        breaker.warming = False


def warm_up_in_background() -> None:
    model = local_profile.active().classifier
    if model and not breaker.warming:
        breaker.warming = True
        asyncio.get_running_loop().create_task(_warm(model))


async def classify(text: str, cfg: ClassifierCfg) -> Result:
    """Never raises: any failure returns the heuristics with the reason."""
    t0 = time.perf_counter()

    def ms() -> int:
        return int((time.perf_counter() - t0) * 1000)

    pre = prefilter(text)
    if pre is not None:
        return Result(pre, {"source": "prefilter", "route": pre.intent, "ms": ms()})
    fallback = heuristics.detect(text)

    def fall(reason: str) -> Result:
        return Result(fallback, {"source": "heuristic", "route": None, "ms": ms(), "fallback_reason": reason})

    model = local_profile.active().classifier
    if not model or not cfg.routes:
        return fall("no classifier in this local-model profile")
    if breaker.until > time.monotonic():
        return fall(breaker.reason or "classifier paused after an error")
    prompt = build_prompt(cfg.routes, text[: cfg.max_chars])
    try:
        async with asyncio.timeout(cfg.timeout_s):
            raw = await ollama.chat(
                model,
                [{"role": "user", "content": prompt}],
                timeout=cfg.timeout_s + 1,
                keep_alive=-1,  # resident: the classifier must not be evicted (local-models.yaml)
                think=None,
                options={"temperature": 0, "num_predict": 24},
            )
    except TimeoutError:
        breaker.until, breaker.reason = (
            time.monotonic() + cfg.breaker_s,
            f"classifier slower than {cfg.timeout_s:g} s",
        )
        warm_up_in_background()
        return fall(f"classifier slower than {cfg.timeout_s:g} s")
    except ollama.OllamaError as e:
        breaker.until, breaker.reason = time.monotonic() + cfg.breaker_s, f"classifier unavailable ({e})"
        return fall(f"classifier unavailable ({e})")
    route = parse_route(raw, cfg)
    if route is None:
        return fall("classifier answered an unknown route")
    return Result(to_intent(route, cfg, text), {"source": "arch-router", "route": route, "ms": ms()})
