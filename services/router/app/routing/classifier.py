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
    """`{"route": "code_small"}` -> a known route or `other`. Arch-Router-1.5B (Q4 GGUF on Ollama)
    answers with Python-style quotes, `{'route': 'code_small'}`, so both are accepted, also wrapped in
    prose or a code fence."""
    name = None
    m = re.search(r"\{[^{}]*\}", raw)
    if m:
        try:
            name = json.loads(m.group(0)).get("route")
        except (ValueError, AttributeError):
            name = None
    if name is None:
        m2 = re.search(r"""["']route["']\s*:\s*["']([\w-]+)["']""", raw)
        name = m2.group(1) if m2 else raw.strip().strip("\"'")
    if name == "other" or (isinstance(name, str) and cfg.route(name)):
        return name
    if isinstance(name, str) and name:
        # Seen live when the model ran (partly) on the CPU: `health` for `sensitive_health`. Accept a
        # shortened name only when exactly one route ends with it.
        hits = [r.name for r in cfg.routes if r.name.endswith(f"_{name}")]
        if len(hits) == 1:
            return hits[0]
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
    video, image = heuristics.VIDEO.search(text), heuristics.IMAGE.search(text)
    if video and image:  # "design a thumbnail for my video": ambiguous, let the classifier decide
        return None
    if video:
        return heuristics.Intent("video", "small", "normal", heuristics._cue(video))
    if image:
        return heuristics.Intent("image", "small", "normal", heuristics._cue(image))
    if heuristics.CODE_FENCE.search(text) or heuristics.TRACE.search(text):
        return heuristics.detect(text)  # code; size from the heuristics (repo words, length)
    return None


def model_options(**extra: object) -> dict[str, object]:
    """Generation options; the profile may add some (e.g. `num_gpu: 0` = run on the CPU). Warm-up must
    use the same ones, or Ollama loads a second copy."""
    return {"temperature": 0, "num_predict": 24, **local_profile.active().classifier_options, **extra}


async def _warm(model: str, only_if_unloaded: bool = False) -> None:
    try:
        if only_if_unloaded:
            loaded = await ollama.ps() or []
            if any((m.get("name") or m.get("model")) == model for m in loaded):
                return
        await ollama.chat(
            model,
            [{"role": "user", "content": "hi"}],
            timeout=WARMUP_TIMEOUT_S,
            keep_alive=-1,
            think=None,
            options=model_options(num_predict=1),
        )
        reset()
        log.info("classifier %s loaded", model)
    except ollama.OllamaError as e:
        log.info("classifier warm-up failed: %s", e)
    finally:
        breaker.warming = False


_tasks: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    try:
        task = asyncio.get_running_loop().create_task(coro)
    except RuntimeError:
        coro.close()
        return
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def warm_up_in_background() -> None:
    model = local_profile.active().classifier
    if model and not breaker.warming:
        breaker.warming = True
        _spawn(_warm(model))


def ensure_resident() -> None:
    """After another local model ran (a title, a summary, a local reply outside a private thread):
    on a small GPU it evicted the classifier, so load it back now, before the next message, instead
    of letting that message wait ~3 s and fall back to the heuristics (measured in docs/m3a.md)."""
    model = local_profile.active().classifier
    if model and not breaker.warming:
        breaker.warming = True
        _spawn(_warm(model, only_if_unloaded=True))


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
    if breaker.warming:
        # Loading (startup, or reloading after another local model evicted it on a small GPU): a call
        # now would queue behind the load and time out, so don't make this message wait 1.5 s.
        return fall("classifier is loading (another local model just ran)")
    prompt = build_prompt(cfg.routes, text[: cfg.max_chars])
    try:
        async with asyncio.timeout(cfg.timeout_s):
            raw = await ollama.chat(
                model,
                [{"role": "user", "content": prompt}],
                timeout=cfg.timeout_s + 1,
                keep_alive=-1,  # resident: the classifier must not be evicted (local-models.yaml)
                think=None,
                options=model_options(),
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
