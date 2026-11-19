"""Pasted secrets (M3a): API keys, tokens, private keys, passwords and card numbers.

A message with a secret always stays on this machine (no override) and is stored masked, so the
secret never reaches logs, exports, the "Why this?" data, titles or summaries. Only the current
turn's call to the local model sees the original text.

Deterministic on purpose (no model): it must work when Ollama is down and be testable. Values that
look like code (`os.environ[...]`, `${VAR}`, `getenv(...)`) or placeholders are not secrets.
"""

import re
from dataclasses import dataclass

_KEYS = re.compile(
    r"\b("
    r"sk-(?:proj-|ant-(?:api\d\d-)?|or-v1-)?[A-Za-z0-9_\-]{20,}"  # OpenAI, Anthropic, OpenRouter
    r"|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|csk-[A-Za-z0-9]{20,}"  # Groq, xAI, Cerebras
    r"|AIza[0-9A-Za-z_\-]{30,}"  # Google
    r"|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}"  # AWS access key id
    r"|ghp_[A-Za-z0-9]{30,}|gh[ousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"  # GitHub
    r"|glpat-[A-Za-z0-9_\-]{20,}"  # GitLab
    r"|xox[abposr]-[A-Za-z0-9-]{10,}"  # Slack
    r"|(?:sk|rk)_live_[A-Za-z0-9]{16,}"  # Stripe
    r"|hf_[A-Za-z0-9]{30,}|nvapi-[A-Za-z0-9_\-]{30,}"  # Hugging Face, NVIDIA
    r")\b"
)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")
_BEARER = re.compile(r"\b[Bb]earer\s+([A-Za-z0-9._~+/=-]{20,})")
_PEM = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)")
_URL_PASSWORD = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s:/@]+:([^\s@/]{3,})@")
_PASSWORD = re.compile(
    r"(?i)\b(?:my\s+)?(?:pass(?:word|wd|phrase|code)|pwd|pin|api[_ -]?key|secret[_ -]?key|access[_ -]?token"
    r"|auth[_ -]?token)\s*(?:is|=|:|was)\s*[\"'`]?([^\s\"'`]{4,})"
)
_CARD = re.compile(r"(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])")

PLACEHOLDER = re.compile(
    r"^(?:\*+|x+|\.+|<[^>]*>|\[[^\]]*\]|your[_-]?\w*|changeme|password|secret|example\w*|placeholder"
    r"|required|optional|empty|null|none|true|false|hidden)$",
    re.I,
)
CODEY = re.compile(r"[()\[\]{}$<>]|^(?:os\.|process\.|env\.|self\.|this\.|config\.|settings\.)|getenv")


@dataclass(frozen=True)
class Hit:
    kind: str  # api_key | token | private_key | password | card
    start: int
    end: int


def _luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
        alt = not alt
    return total % 10 == 0


def _value_is_secret(v: str) -> bool:
    v = v.rstrip(".,;:!?")
    return len(v) >= 4 and not PLACEHOLDER.match(v) and not CODEY.search(v) and len(set(v)) > 2


def find(text: str) -> list[Hit]:
    hits: list[Hit] = []
    for m in _PEM.finditer(text):
        hits.append(Hit("private_key", m.start(), m.end()))
    for m in _KEYS.finditer(text):
        hits.append(Hit("api_key", m.start(), m.end()))
    for m in _JWT.finditer(text):
        hits.append(Hit("token", m.start(), m.end()))
    for m in _BEARER.finditer(text):
        hits.append(Hit("token", m.start(1), m.end(1)))
    for m in _URL_PASSWORD.finditer(text):
        if _value_is_secret(m.group(1)):
            hits.append(Hit("password", m.start(1), m.end(1)))
    for m in _PASSWORD.finditer(text):
        v = m.group(1).rstrip(".,;:!?")
        if _value_is_secret(v):
            hits.append(Hit("password", m.start(1), m.start(1) + len(v)))
    for m in _CARD.finditer(text):
        digits = re.sub(r"\D", "", m.group(0))
        if 13 <= len(digits) <= 19 and len(set(digits)) > 1 and _luhn(digits):
            hits.append(Hit("card", m.start(), m.end()))
    # merge overlaps (a bearer JWT is one secret, not two)
    hits.sort(key=lambda h: (h.start, -h.end))
    merged: list[Hit] = []
    for h in hits:
        if merged and h.start < merged[-1].end:
            last = merged[-1]
            merged[-1] = Hit(last.kind, last.start, max(last.end, h.end))
        else:
            merged.append(h)
    return merged


LABEL = {
    "api_key": "API key",
    "token": "token",
    "private_key": "private key",
    "password": "password",
    "card": "card number",
}


def mask(text: str) -> tuple[str, list[str]]:
    """(text with every secret replaced by `[secret masked: …]`, the kinds found, in order)."""
    hits = find(text)
    if not hits:
        return text, []
    out, pos, kinds = [], 0, []
    for h in hits:
        out.append(text[pos : h.start])
        out.append(f"[secret masked: {LABEL[h.kind]}]")
        pos = h.end
        if h.kind not in kinds:
            kinds.append(h.kind)
    out.append(text[pos:])
    return "".join(out), kinds
