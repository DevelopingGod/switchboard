"""Long threads (M3a, SPEC §8c "auto-summarize long threads").

After a reply, once the history reaches `summary.start_at` (75%) of `max_context_tokens`, the turns
older than the newest `keep_last` (6) messages are folded into a running summary: the previous summary
plus the turns that aged out since, never from scratch. It is stored on the thread
(`threads.summary_json`) and sent as a "Summary of earlier messages" system note, followed by the
messages it doesn't cover, word for word.

The local tasks model writes it. A private thread never uses a cloud model: without a local answer it
keeps the M2 behaviour (oldest turns trimmed).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

import httpx

from app.chat import aux_llm
from app.models import Message, Thread
from app.routing.engine import tokens

log = logging.getLogger("app.chat.summary")

NOTE = "Summary of earlier messages in this conversation:\n"
MAX_MSG_CHARS = 1500  # per message in the summarizer's input
MAX_SUMMARY_TOKENS = 400
TIMEOUT_S = 90

PROMPT = """You keep a running summary of a conversation between a user and an assistant.
Update the summary with the new messages. Keep facts, decisions, names, numbers, code identifiers,
preferences the user stated and open questions. Drop small talk. Do not add anything that is not in
the text. Write at most 200 words as short bullet points. Reply with the summary only.

Current summary:
{old}

New messages:
{new}

Updated summary:"""


def _sendable(m: Message) -> bool:
    return m.role == "user" or (m.role == "assistant" and m.status in ("done", "stopped") and bool(m.content))


def covered_upto(thread: Thread, before_id: int | None = None) -> int:
    """Id of the last message the summary covers (0 = none). Ignored when it would cover the message
    being answered (after an edit or regenerate)."""
    s = thread.summary_json or {}
    upto = int(s.get("upto_message_id") or 0)
    if before_id is not None and upto >= before_id:
        return 0
    return upto


def build_history(thread: Thread, msgs: list[Message], before_id: int | None = None) -> list[dict[str, str]]:
    """Prompt history: the summary note (if any) then every sendable message it doesn't cover."""
    upto = covered_upto(thread, before_id)
    out: list[dict[str, str]] = []
    if upto and (thread.summary_json or {}).get("text"):
        out.append({"role": "system", "content": NOTE + thread.summary_json["text"]})  # type: ignore[index]
    out += [{"role": m.role, "content": m.content} for m in msgs if m.id > upto and _sendable(m)]
    return out


def needs_summary(
    thread: Thread, msgs: list[Message], max_tokens: int, start_at: float, keep_last: int
) -> bool:
    upto = covered_upto(thread)
    live = [m for m in msgs if m.id > upto and _sendable(m)]
    used = tokens(len((thread.summary_json or {}).get("text") or "")) if upto else 0
    used += sum(tokens(len(m.content)) for m in live)
    return used >= start_at * max_tokens and len(live) > keep_last


async def summarize(
    litellm: httpx.AsyncClient,
    thread: Thread,
    msgs: list[Message],
    *,
    keep_last: int,
    connected: set[str],
) -> dict[str, Any] | None:
    """Fold the aged-out turns into the summary. Returns the new summary_json (not yet committed)."""
    upto = covered_upto(thread)
    live = [m for m in msgs if m.id > upto and _sendable(m)]
    aged = live[:-keep_last]
    if not aged:
        return None
    old = (thread.summary_json or {}).get("text") if upto else None
    new = "\n".join(
        f"{'User' if m.role == 'user' else 'Assistant'}: {m.content[:MAX_MSG_CHARS]}" for m in aged
    )
    text, model = await aux_llm.generate(
        litellm,
        PROMPT.format(old=old or "(none yet)", new=new),
        max_tokens=MAX_SUMMARY_TOKENS,
        timeout=TIMEOUT_S,
        cloud_ok=not thread.private,  # never send a private thread to a cloud model
        connected=connected,
        private=thread.private,
        num_ctx=8192,
    )
    if not text:
        return None
    covers = int((thread.summary_json or {}).get("covers") or 0) if upto else 0
    return {
        "text": text.strip()[:4000],
        "upto_message_id": aged[-1].id,
        "covers": covers + len(aged),
        "model": model,
        "created_at": datetime.now(UTC).isoformat(),
        "incremental": bool(old),
    }
