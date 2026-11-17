"""Keyword/heuristic intent detection — temporary until the M3 classifier (Arch-Router).

Deliberately simple and explainable: each result carries the cue that triggered it, which the
"Why this?" chip shows. Order: media > code > research > writing > chat.
"""

import re
from dataclasses import dataclass

_MAKE = r"(make|generate|create|draw|design|render|produce|give me|paint|sketch)"
IMAGE = re.compile(
    rf"\b{_MAKE}\b[^.?!\n]{{0,60}}\b(image|picture|photo|logo|illustration|drawing|icon|wallpaper|"
    r"thumbnail|poster|banner|avatar|sticker)s?\b",
    re.I,
)
VIDEO = re.compile(rf"\b{_MAKE}\b[^.?!\n]{{0,60}}\b(video|clip|animation|reel|footage)s?\b", re.I)
CODE_FENCE = re.compile(r"```|^\s{4}\S", re.M)
TRACE = re.compile(r"Traceback \(most recent call last\)|^\s+at \S+\(.*:\d+\)|\bError: |Exception\b", re.M)
CODE_WORDS = re.compile(
    r"\b(code|function|method|class|bug|debug|compile|compiler|refactor|unit tests?|failing tests?|"
    r"test suite|regex|sql|python|javascript|typescript|rust|golang|java|kotlin|swift|c\+\+|c#|bash|"
    r"script|endpoint|api|stack trace|segfault|null pointer|npm|pip|dockerfile|git|repo|repository|"
    r"codebase|pull request|merge conflict)\b",
    re.I,
)
CODE_LARGE = re.compile(
    r"\b(repo|repository|codebase|across (the )?files|whole project|test suite|failing tests|"
    r"the tests|migrate the|end[- ]to[- ]end)\b",
    re.I,
)
RESEARCH = re.compile(
    r"\b(research|investigate|competitors?|competitive analysis|market (size|analysis)|literature|"
    r"sources|deep dive|survey of|state of the art|find (papers|studies))\b",
    re.I,
)
WRITING = re.compile(
    r"\b(write|draft|compose|rewrite|polish|edit)\b[^.?!\n]{0,60}\b(post|email|e-mail|blog|article|"
    r"newsletter|thread|tweet|caption|cover letter|essay|script|bio|announcement|press release|"
    r"product description|landing page copy)s?\b|\blinkedin\b",
    re.I,
)
QUALITY_HIGH = re.compile(
    r"\b(polished|premium|high[- ]quality|best possible|publication[- ]ready|flawless)\b", re.I
)
LARGE_CHARS = 1500


@dataclass(frozen=True)
class Intent:
    intent: str  # chat | code | research | writing | image | video
    size: str  # small | large
    quality: str  # normal | high
    cue: str | None  # the words that triggered it (shown in "Why this?")


def _cue(m: re.Match[str] | None) -> str | None:
    return m.group(0).strip()[:40] if m else None


def detect(text: str) -> Intent:
    size = "large" if len(text) > LARGE_CHARS else "small"
    quality = "high" if QUALITY_HIGH.search(text) else "normal"
    if m := VIDEO.search(text):
        return Intent("video", size, quality, _cue(m))
    if m := IMAGE.search(text):
        return Intent("image", size, quality, _cue(m))
    code = CODE_FENCE.search(text) or TRACE.search(text) or CODE_WORDS.search(text)
    if code:
        large = CODE_LARGE.search(text)
        return Intent("code", "large" if large or size == "large" else "small", quality, _cue(large or code))
    if m := RESEARCH.search(text):
        return Intent("research", size, quality, _cue(m))
    if m := WRITING.search(text):
        return Intent("writing", size, quality, _cue(m))
    return Intent("chat", size, quality, None)
