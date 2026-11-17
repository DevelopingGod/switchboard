"""The routing decision (SPEC §7.1), as a pure function of the request and a context snapshot.

decide() picks the rule and turns its target chain into viable candidates, recording every target it
skips and why (not connected, cooling down, preset, budget, private, agent/media not available yet).
The dispatcher then tries the candidates in order and adds runtime skips (429, timeout, errors).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.registry import Registry
from app.routing import heuristics
from app.routing.health import Cooldowns
from app.routing.rules import Rule, RuleSet

SLASH = re.compile(r"^/([a-z][\w-]{0,20})(?:\s+|$)", re.I)
MODEL_TARGET = re.compile(r"^model:[\w.:/@-]{1,200}$")
NON_CHAT_TAGS = {"embedding", "moderation", "audio", "image", "video"}
MIN_OUTPUT_TOKENS = 256
AGENT_NAMES = {
    "claude-code": "Claude Code",
    "grok-build": "Grok Build",
    "codex": "Codex",
    "opencode": "OpenCode",
    "hermes": "Hermes",
    "gemini-cli": "Gemini CLI",
}


@dataclass(frozen=True)
class CatalogEntry:
    id: int
    provider: str
    model_id: str
    display_name: str | None
    tags: tuple[str, ...]
    context: int | None
    input_per_1m: float | None
    output_per_1m: float | None
    privacy: str
    p50_ms: int | None = None


@dataclass
class Context:
    registry: Registry
    rules: RuleSet
    connected: set[str]  # provider ids that can serve now (keyed api providers, local)
    catalog: list[CatalogEntry]
    cooldowns: Cooldowns
    spent_today: float = 0.0
    exhausted: dict[str, str] = field(default_factory=dict)  # credits used up: provider -> reason

    def entry(self, provider: str, model_id: str) -> CatalogEntry | None:
        return next((c for c in self.catalog if c.provider == provider and c.model_id == model_id), None)


@dataclass
class RouteRequest:
    text: str
    target: str = "auto"  # "auto" | "model:<alias>" | "model:<provider>/<model>"
    private: bool = False
    temperature: float | None = None
    autonomy: int | None = None
    context_chars: int = 0  # history sent along (cost estimate + chip)


@dataclass
class Candidate:
    target: str  # e.g. model:fast
    litellm_model: str  # what LiteLLM is asked for (alias, or <provider>/<model> wildcard)
    label: str  # "Groq · gpt-oss-120b"
    provider: str  # first-choice provider
    providers: tuple[str, ...]
    local: bool
    free_tier: bool
    privacy: str
    timeout: float
    max_tokens: int
    est_cost_usd: float
    catalog_id: int | None
    position: int  # 0 = rule's first choice
    note: str | None = None  # e.g. "best:reasoning pick"

    def summary(self) -> dict[str, Any]:
        return {"target": self.target, "label": self.label, "provider": self.provider, "local": self.local}


@dataclass
class Skip:
    target: str
    label: str
    code: str  # not_connected | cooldown | agent | paid | budget_request | budget_daily | private
    #            | not_configured | credits | credit_limit | rate_limited | timeout | error
    reason: str

    def as_dict(self) -> dict[str, str]:
        return {"target": self.target, "label": self.label, "code": self.code, "reason": self.reason}


@dataclass
class Decision:
    rule_id: str
    matched_by: str  # manual | slash | private | intent | default
    intent: str
    size: str
    quality: str
    cue: str | None
    command: str | None
    prompt: str  # text with any slash command removed
    private: bool
    temperature: float
    autonomy: int
    max_cost_usd: float
    daily_cap_usd: float
    spent_today: float
    preset: str
    job_suggested: bool
    media: str | None  # "image" | "video" | "audio" when the rule targets Studio (M5)
    candidates: list[Candidate] = field(default_factory=list)
    skipped: list[Skip] = field(default_factory=list)
    context_tokens: int = 0

    @property
    def blocked_by_budget(self) -> bool:
        return not self.candidates and any(s.code.startswith("budget") for s in self.skipped)

    def as_dict(self) -> dict[str, Any]:
        return {
            "rule": self.rule_id,
            "matched_by": self.matched_by,
            "intent": self.intent,
            "size": self.size,
            "quality": self.quality,
            "cue": self.cue,
            "command": self.command,
            "private": self.private,
            "temperature": self.temperature,
            "autonomy": self.autonomy,
            "max_cost_usd": self.max_cost_usd,
            "daily_cap_usd": self.daily_cap_usd,
            "spent_today": round(self.spent_today, 6),
            "preset": self.preset,
            "job_suggested": self.job_suggested,
            "media": self.media,
            "candidates": [c.summary() for c in self.candidates],
            "skipped": [s.as_dict() for s in self.skipped],
            "context_tokens": self.context_tokens,
        }


def tokens(chars: int) -> int:
    return max(1, chars // 4)


def parse_slash(text: str, rules: RuleSet) -> tuple[str | None, str]:
    m = SLASH.match(text)
    if not m or m.group(1).lower() not in rules.slash:
        return None, text
    return m.group(1).lower(), text[m.end() :].strip()


def _match(rule: Rule, facts: dict[str, Any]) -> bool:
    return all(facts.get(k) == v for k, v in rule.when.items())


def pick_rule(rules: RuleSet, facts: dict[str, Any]) -> Rule:
    """Most specific matching rule wins (most `when` keys); ties keep file order."""
    matching = [(len(r.when), -i, r) for i, r in enumerate(rules.rules) if _match(r, facts)]
    if not matching:
        return rules.get("default")  # type: ignore[return-value]
    return max(matching, key=lambda t: (t[0], t[1]))[2]


class _Resolver:
    def __init__(self, ctx: Context, dec: Decision, manual: bool):
        self.ctx, self.dec, self.manual = ctx, dec, manual
        self.reg = ctx.registry
        self.cooled: list[Candidate] = []  # last resort when nothing else is viable

    def skip(self, target: str, label: str, code: str, reason: str) -> None:
        self.dec.skipped.append(Skip(target, label, code, reason))

    # --- one target string -> zero or more viable candidates ---------------------------------
    def resolve(self, target: str, position: int) -> list[Candidate]:
        kind, _, name = target.partition(":")
        if kind == "agent":
            label = AGENT_NAMES.get(name, name)
            self.skip(target, label, "agent", f"{label} runs jobs, which arrive in M4; answering in chat")
            return []
        if kind == "media":
            return []
        if kind == "best":
            return self._best(target, name, position)
        if kind != "model":
            self.skip(target, target, "not_configured", "Unknown target type")
            return []
        if name in {a.alias for a in self.reg.aliases}:
            c = self._alias(target, name, position)
        elif "/" in name and name.split("/", 1)[0] in self.reg.providers:
            provider, model_id = name.split("/", 1)
            c = self._model(target, provider, model_id, position)
        else:
            self.skip(target, name, "not_configured", f"No model called “{name}” is set up")
            return []
        return [c] if c and self._viable(c) else []

    def _alias(self, target: str, alias: str, position: int) -> Candidate | None:
        deps = self.reg.alias(alias)
        live = [d for d in deps if d.provider in self.ctx.connected]
        first = (live or deps)[0]
        p = self.reg.providers[first.provider]
        label = f"{p.name.split(' (')[0]} · {first.model.split('/')[-1]}"
        if not live:
            used_up = next((d.provider for d in deps if d.provider in self.ctx.exhausted), None)
            if used_up:
                self.skip(target, label, "credits", self.ctx.exhausted[used_up])
            else:
                self.skip(
                    target, label, "not_connected", f"Not connected: add a key for {p.name} in Connections"
                )
            return None
        entry = self.ctx.entry(first.provider, first.model)
        return Candidate(
            target=target,
            litellm_model=alias,
            label=label,
            provider=p.id,
            providers=tuple(d.provider for d in deps),
            local=all(self.reg.providers[d.provider].kind == "local" for d in deps),
            free_tier=all(self.reg.providers[d.provider].is_free_tier(d.model) for d in live),
            privacy=p.privacy,
            timeout=float(first.timeout or (300 if p.kind == "local" else 60)),
            max_tokens=self.ctx.rules.defaults.max_output_tokens,
            est_cost_usd=0.0,
            catalog_id=entry.id if entry else None,
            position=position,
        )

    def _model(self, target: str, provider: str, model_id: str, position: int, note=None) -> Candidate | None:
        p = self.reg.providers[provider]
        label = f"{p.name.split(' (')[0]} · {model_id.split('/')[-1]}"
        if p.kind == "cli":
            self.skip(target, label, "agent", f"{p.name} is a CLI agent; jobs arrive in M4")
            return None
        if provider in self.ctx.exhausted:
            self.skip(target, label, "credits", self.ctx.exhausted[provider])
            return None
        if provider not in self.ctx.connected:
            self.skip(target, label, "not_connected", f"Not connected: add a key for {p.name} in Connections")
            return None
        if isinstance(p.free_tier, str) and not p.is_free_tier(model_id) and not self.manual:
            # OpenRouter: only ":free" models are used automatically; a paid one needs a manual pick.
            self.skip(
                target,
                label,
                "paid",
                f"{p.name} paid models are only used when you pick them "
                f"(automatic routing keeps to {p.free_tier} models)",
            )
            return None
        entry = self.ctx.entry(provider, model_id)
        return Candidate(
            target=target,
            litellm_model=f"{provider}/{model_id}",
            label=label,
            provider=provider,
            providers=(provider,),
            local=p.kind == "local",
            free_tier=p.is_free_tier(model_id),
            privacy=p.privacy,
            timeout=300.0 if p.kind == "local" else 60.0,
            max_tokens=self.ctx.rules.defaults.max_output_tokens,
            est_cost_usd=0.0,
            catalog_id=entry.id if entry else None,
            position=position,
            note=note,
        )

    def _best(self, target: str, cap: str, position: int) -> list[Candidate]:
        pool = [
            e
            for e in self.ctx.catalog
            if cap in e.tags
            and not (NON_CHAT_TAGS & set(e.tags))
            and e.provider in self.ctx.connected
            and self.reg.providers.get(e.provider) is not None
            and self.reg.providers[e.provider].kind != "cli"
            # OpenRouter: automatic picks stay on ":free" models
            and (
                not isinstance(self.reg.providers[e.provider].free_tier, str)
                or self.reg.providers[e.provider].is_free_tier(e.model_id)
            )
        ]
        if self.dec.private:
            pool = [e for e in pool if self.reg.providers[e.provider].kind == "local"]

        def key(e: CatalogEntry) -> tuple:
            free = self.reg.providers[e.provider].is_free_tier(e.model_id)
            local = self.reg.providers[e.provider].kind == "local"
            # free first, cloud before local (local is slow on a 4 GB GPU), then fastest, then context
            return (not free, local, e.p50_ms if e.p50_ms is not None else 10**9, -(e.context or 0))

        out: list[Candidate] = []
        for e in sorted(pool, key=key):
            c = self._model(f"model:{e.provider}/{e.model_id}", e.provider, e.model_id, position, note=target)
            if c and self._viable(c):
                out.append(c)
            if len(out) == 2:  # pick + runner-up
                break
        if not out:
            self.skip(target, target, "not_configured", f"No connected model is tagged “{cap}”")
        return out

    # --- policy filters ------------------------------------------------------------------------
    def _viable(self, c: Candidate) -> bool:
        dec, ctx = self.dec, self.ctx
        if dec.private and not c.local:
            why = (
                "your pick was not used" if self.manual and c.position == 0 else "only models on this machine"
            )
            self.skip(c.target, c.label, "private", f"Private is on: {why}")
            return False
        paid = any(ctx.registry.providers[p].paid for p in c.providers if p in ctx.connected)
        if paid and ctx.rules.paid == "never":
            self.skip(c.target, c.label, "paid", "Free only preset: paid models are never used")
            return False
        if paid and ctx.rules.paid == "manual" and not self.manual:
            self.skip(c.target, c.label, "paid", "Balanced preset: paid models only when you pick them")
            return False
        cd = ctx.cooldowns.get(c.target)
        if cd:
            if not self._budget(c):
                return False
            left = ctx.cooldowns.remaining(c.target)
            self.skip(c.target, c.label, "cooldown", f"{cd.reason}; cooling down for {left} s")
            self.cooled.append(c)
            return False
        return self._budget(c)

    def _budget(self, c: Candidate) -> bool:
        """Hard caps (SPEC §13.6). Free-tier and local models cost $0 and are never blocked."""
        dec = self.dec
        if c.free_tier or c.local:
            return True
        entry = next((e for e in self.ctx.catalog if e.id == c.catalog_id), None)
        in_p = (entry.input_per_1m or 0.0) / 1e6 if entry else 0.0
        out_p = (entry.output_per_1m or 0.0) / 1e6 if entry else 0.0
        in_cost = (dec.context_tokens + tokens(len(dec.prompt))) * in_p
        if out_p > 0:
            affordable = int((dec.max_cost_usd - in_cost) / out_p)
            if affordable < MIN_OUTPUT_TOKENS:
                est = in_cost + MIN_OUTPUT_TOKENS * out_p
                self.skip(
                    c.target,
                    c.label,
                    "budget_request",
                    f"Would cost about ${est:.4f}, over the ${dec.max_cost_usd:.2f} per-request cap",
                )
                return False
            c.max_tokens = min(c.max_tokens, affordable)
        c.est_cost_usd = in_cost + MIN_OUTPUT_TOKENS * out_p
        if dec.spent_today + c.est_cost_usd > dec.daily_cap_usd or dec.spent_today >= dec.daily_cap_usd:
            self.skip(
                c.target,
                c.label,
                "budget_daily",
                f"Daily budget ${dec.daily_cap_usd:.2f} reached (${dec.spent_today:.2f} spent today)",
            )
            return False
        return True


def _intent_for(command: str | None, rule: Rule, detected: str) -> str:
    """Task type for logs/model_stats: a slash command names it, otherwise the heuristic does."""
    if command == "chat":
        return "chat"
    if command and rule.when.get("intent"):
        return str(rule.when["intent"])
    if command == "bulk":
        return "bulk"
    return detected


def decide(req: RouteRequest, ctx: Context) -> Decision:
    rules = ctx.rules
    command, prompt = parse_slash(req.text.strip(), rules)
    private = req.private or command == "private"
    intent = heuristics.detect(prompt)
    # SPEC §7.1: a manual pick beats a slash command (still stripped; /private still applies).
    manual = req.target not in ("", "auto")

    if manual and not MODEL_TARGET.match(req.target):
        raise ValueError("target must be `auto` or `model:<alias>` / `model:<provider>/<model>`")

    if manual:
        rule, matched_by = rules.get("default"), "manual"
    elif command:
        rule, matched_by = rules.get(rules.slash[command]), "slash"
    elif private:
        rule, matched_by = rules.get("private") or rules.get("default"), "private"
    else:
        facts = {"intent": intent.intent, "size": intent.size, "quality": intent.quality, "private": False}
        rule = pick_rule(rules, facts)
        matched_by = "default" if rule.id == "default" else "intent"
    assert rule is not None
    # A private request always follows the private rule, whatever the slash command said.
    if private and rule.id != "private" and not manual:
        rule = rules.get("private") or rule
    media = rule.target.split(":", 1)[1] if rule.target.startswith("media:") else None
    media_kind = None
    if media:
        media_kind = "video" if "video" in media else "audio" if "tts" in media else "image"

    d = rules.defaults
    dec = Decision(
        rule_id="manual" if manual else rule.id,
        matched_by=matched_by,
        intent=_intent_for(command, rule, intent.intent),
        size=intent.size,
        quality=intent.quality,
        cue=intent.cue,
        command=command,
        prompt=prompt,
        private=private,
        temperature=req.temperature
        if req.temperature is not None
        else (rule.temperature if rule.temperature is not None else d.temperature),
        autonomy=req.autonomy
        if req.autonomy is not None
        else (rule.autonomy if rule.autonomy is not None else d.autonomy),
        max_cost_usd=rule.max_cost_usd if rule.max_cost_usd is not None else d.max_cost_usd,
        daily_cap_usd=d.daily_cap_usd,
        spent_today=ctx.spent_today,
        preset=rules.preset,
        job_suggested=rule.job and not manual,
        media=media_kind,
        context_tokens=tokens(req.context_chars) if req.context_chars else 0,
    )
    if media_kind and not manual:
        return dec

    r = _Resolver(ctx, dec, manual)
    if manual and private:
        # A local pick is honoured; anything else is skipped (reason: private) and the private
        # rule's local chain answers instead.
        chain = [req.target, *(rules.get("private") or rules.get("default")).chain]  # type: ignore[union-attr]
    elif manual:
        chain = [req.target]
    else:
        chain = rule.chain

    seen: set[str] = set()
    for pos, target in enumerate(chain):
        for c in r.resolve(target, pos):
            if c.target not in seen:
                seen.add(c.target)
                dec.candidates.append(c)
    if not dec.candidates and r.cooled:
        # Better to retry a target that is cooling down than to fail with nothing tried.
        cooled = {c.target for c in r.cooled}
        dec.skipped = [k for k in dec.skipped if not (k.code == "cooldown" and k.target in cooled)]
        dec.candidates = r.cooled
    if dec.private:  # belt and braces: nothing non-local survives
        dec.candidates = [c for c in dec.candidates if c.local]
    if manual and private and (not dec.candidates or dec.candidates[0].target != req.target):
        dec.rule_id, dec.matched_by = "private", "private"
    return dec


def reasons(dec: Decision, chosen: Candidate, registry: Registry, catalog: list[CatalogEntry]) -> list[str]:
    """Top 3 plain-language reasons for the chip (SPEC §6.4 explainability)."""
    out: list[str] = []
    if dec.matched_by == "manual":
        out.append("You picked this model")
    elif dec.matched_by == "slash":
        out.append(f"/{dec.command} command → rule “{dec.rule_id}”")
    elif dec.matched_by == "private":
        out.append("Private is on → stays on this machine")
    elif dec.matched_by == "intent":
        cue = f" (“{dec.cue}”)" if dec.cue else ""
        out.append(f"Looks like {dec.intent}{cue} → rule “{dec.rule_id}”")
    else:
        out.append("General chat → default rule")

    runtime = [s for s in dec.skipped if s.code in ("rate_limited", "timeout", "error", "cooldown")]
    if dec.matched_by == "manual" and chosen.position == 0:
        out.append(f"{chosen.label} answered directly (no fallbacks for a manual pick)")
    elif chosen.note:
        out.append(f"Best connected match for “{chosen.note.split(':', 1)[1]}”")
    elif chosen.position == 0 and not runtime:
        out.append(f"First choice of rule “{dec.rule_id}”")
    elif dec.skipped:
        s = dec.skipped[-1] if runtime else dec.skipped[0]
        out.append(f"Fallback: {s.label} skipped ({s.reason[:60]})")
    else:
        out.append(f"Fallback #{chosen.position} of rule “{dec.rule_id}”")

    p = registry.providers.get(chosen.provider)
    entry = next((e for e in catalog if e.id == chosen.catalog_id), None)
    if chosen.local:
        out.append("Runs on your GPU; nothing leaves the machine")
    elif p and p.privacy == "no-training":
        out.append(
            f"{'Free tier · ' if chosen.free_tier else ''}{p.name.split(' (')[0]} does not train on API data"
        )
    elif entry and entry.p50_ms:
        out.append(f"Measured {entry.p50_ms} ms (median)")
    elif chosen.free_tier:
        out.append("Free tier (may train on your data)" if p and p.privacy == "may-train" else "Free tier")
    return out[:3]
