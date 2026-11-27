"""The routing decision (SPEC §7.1), as a pure function of the request and a context snapshot.

decide() picks the rule and turns its target chain into viable candidates, recording every target it
skips and why (not connected, cooling down, preset, budget, private, agent/media not available yet).
The dispatcher then tries the candidates in order and adds runtime skips (429, timeout, errors).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any

from app.registry import Registry
from app.routing import heuristics, recommend
from app.routing.health import Cooldowns
from app.routing.recommend import Scored, Stat
from app.routing.rules import Rule, RuleSet

if TYPE_CHECKING:
    from app.quota import QuotaView, Usage

SLASH = re.compile(r"^/([a-z][\w-]{0,20})(?:\s+|$)", re.I)
MODEL_TARGET = re.compile(r"^model:[\w.:/@-]{1,200}$")
NON_CHAT_TAGS = {"embedding", "moderation", "audio", "image", "video"}
MIN_OUTPUT_TOKENS = 256


def agent_label(agent_id: str) -> str:
    """The registry's label (config/agents.yaml); the id when the registry can't be read."""
    try:
        from app.agents import load_agents

        a = load_agents().agents.get(agent_id)
        return a.label if a else agent_id
    except (OSError, ValueError):
        return agent_id


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
    p50_ms: int | None = None  # 1-token test ping median (M1a)
    # M3a: model_stats per task type (chat, code, ..., test) for the recommender
    stats: Mapping[str, Stat] | None = field(default=None, compare=False, hash=False)


@dataclass
class Context:
    registry: Registry
    rules: RuleSet
    connected: set[str]  # provider ids that can serve now (keyed api providers, local)
    catalog: list[CatalogEntry]
    cooldowns: Cooldowns
    spent_today: float = 0.0
    exhausted: dict[str, str] = field(default_factory=dict)  # credits used up: provider -> reason
    quota: QuotaView | None = None  # M3a quota guard snapshot
    explore: bool = False  # Settings → Routing → Explore new models
    auto_private: bool = True  # Settings → Privacy → Auto-detect sensitive messages

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
    # M3a: the classifier's answer (app/routing/classifier.py); None -> keyword heuristics here
    classified: heuristics.Intent | None = None
    classifier_info: dict[str, Any] | None = None  # source, route, ms, fallback reason (logged)
    secret_kinds: tuple[str, ...] = ()  # the message contained a secret (already masked)
    no_auto_private: bool = False  # "Not sensitive — use cloud" re-run: skip auto-detection
    # M4a: "Think harder" for this message. Local chat answers with the profile's fast, non-thinking
    # model; this switches the local aliases to `local-think` (the profile's `thinker`, ADR 0006).
    think: bool = False
    # M2.5 attachments (app/attachments): an image needs a model tagged `vision`; a long document prefers
    # `long-context`; a code file makes the request a code request. `attachment_tokens` is the estimate the
    # composer shows; it counts toward the context window, the caps and the quota guard.
    needs_vision: bool = False
    long_document: bool = False
    code_files: bool = False
    attachment_tokens: int = 0


VISION_ALIAS = "local-vision"  # the profile's vision model: images in a private chat (M2.5)
NO_LOCAL_VISION = (
    "This private chat has an image, and no model on this machine can read images. Remove the image, or pull "
    "a vision model in Settings → Local models. Private images are never sent to the cloud."
)


# Local aliases that "Think harder" switches to the thinking model (config/local-models.yaml `thinker`).
THINK_ALIAS = {"local": "local-think", "private": "local-think"}


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
    note: str | None = None  # "best:<cap>" pick, "alias:<name>" (dynamic), "spread:<alias>"
    model_id: str = ""  # the model expected to answer (quota counters)
    scored: Scored | None = None  # recommender result for best:/dynamic picks
    quota_note: str | None = None  # a manual pick near its limit

    def summary(self) -> dict[str, Any]:
        return {"target": self.target, "label": self.label, "provider": self.provider, "local": self.local}


@dataclass
class Skip:
    target: str
    label: str
    code: str  # not_connected | cooldown | agent | paid | budget_request | budget_daily | private
    #            | not_configured | credits | credit_limit | rate_limited | timeout | error | quota
    #            | not_found
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
    classifier: dict[str, Any] | None = None
    explore: bool = False
    weights: dict[str, float] = field(default_factory=dict)  # recommender weights (reasons)
    # M3a: why a request went local without the toggle: {source: classifier | secret, category,
    # overridable, overridden}
    sensitive: dict[str, Any] | None = None
    think: bool = False  # M4a: "Think harder" asked for this message
    # M4a: the rule's agents in order, for a job (POST /jobs). Chat still answers; nothing starts on its own.
    job_agents: list[dict[str, Any]] = field(default_factory=list)
    # M2.5: what the attachments asked for ({vision, long_document, code, tokens}); None without attachments
    attachments: dict[str, Any] | None = None
    # Reroutes decided by our own counter while the provider reported a lower number, as (how many
    # candidates came before, sentence), for "Why this?".
    quota_estimates: list[tuple[int, str]] = field(default_factory=list)

    @property
    def needs_vision(self) -> bool:
        return bool(self.attachments and self.attachments.get("vision"))

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
            "classifier": self.classifier,
            "sensitive": self.sensitive,
            "think": self.think,
            "attachments": self.attachments,
            "job": (
                {"agents": self.job_agents, "autonomy": self.autonomy, "suggested": self.job_suggested}
                if self.job_agents
                else None
            ),
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
    def __init__(self, ctx: Context, dec: Decision, manual: bool, think: bool = False):
        self.ctx, self.dec, self.manual, self.think = ctx, dec, manual, think
        self.reg = ctx.registry
        self.cooled: list[Candidate] = []  # last resort when nothing else is viable
        self.over_quota: set[str] = set()  # targets skipped by the quota guard (for spreading)

    def skip(self, target: str, label: str, code: str, reason: str) -> None:
        self.dec.skipped.append(Skip(target, label, code, reason))

    # --- one target string -> zero or more viable candidates ---------------------------------
    def resolve(self, target: str, position: int) -> list[Candidate]:
        kind, _, name = target.partition(":")
        if kind == "agent":
            # M4a: an agent target is a job. Chat answers with the chat models in the chain; the job is a
            # proposal the owner starts explicitly (POST /jobs, "Run as job" in M4b), never automatically.
            label = agent_label(name)
            if not any(a["id"] == name for a in self.dec.job_agents):
                self.dec.job_agents.append({"id": name, "label": label})
            self.skip(target, label, "agent", f"{label} works as a job: start it with Run as job")
            return []
        if kind == "media":
            return []
        if kind == "best":
            return self._best(target, name, position)
        if kind != "model":
            self.skip(target, target, "not_configured", "Unknown target type")
            return []
        if any(a.alias == name and a.dynamic for a in self.reg.aliases):
            return self._dynamic(target, name, position)
        if name in {a.alias for a in self.reg.aliases}:
            c = self._alias(target, name, position)
            if c and self._viable(c):
                return [c]
            if c and c.target in self.over_quota and not self.manual:  # a manual pick is never swapped
                return self._spread(name, position)
            return []
        elif "/" in name and name.split("/", 1)[0] in self.reg.providers:
            provider, model_id = name.split("/", 1)
            c = self._model(target, provider, model_id, position)
        else:
            self.skip(target, name, "not_configured", f"No model called “{name}” is set up")
            return []
        return [c] if c and self._viable(c) else []

    def _alias(self, target: str, alias: str, position: int) -> Candidate | None:
        if self.think and alias in THINK_ALIAS and self.reg.alias(THINK_ALIAS[alias]):
            alias = THINK_ALIAS[alias]
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
        if alias == VISION_ALIAS and entry is None:
            # The profile names a vision model that isn't pulled (Ollama's catalog doesn't list it).
            self.skip(
                target,
                label,
                "not_configured",
                f"{first.model} isn't downloaded yet (Settings → Local models)",
            )
            return None
        live_first = live[0]
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
            model_id=live_first.model,
        )

    def _model(self, target: str, provider: str, model_id: str, position: int, note=None) -> Candidate | None:
        p = self.reg.providers[provider]
        label = f"{p.name.split(' (')[0]} · {model_id.split('/')[-1]}"
        if p.kind == "cli":
            self.skip(target, label, "agent", f"{p.name} is a CLI agent: it runs jobs, not chat replies")
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
            model_id=model_id,
        )

    # --- recommender-backed targets (SPEC §6.4) ------------------------------------------------
    def _pool(self, tags: tuple[str, ...], providers: set[str] | None = None) -> list[CatalogEntry]:
        """Hard filters that need no candidate: tag, chat-capable, connected, OpenRouter `:free`
        only, privacy, and a context window big enough for this request."""
        need = self.dec.context_tokens + tokens(len(self.dec.prompt)) + MIN_OUTPUT_TOKENS
        out = []
        for e in self.ctx.catalog:
            p = self.reg.providers.get(e.provider)
            if (
                p is None
                or p.kind == "cli"
                or e.provider not in self.ctx.connected
                or (providers is not None and e.provider not in providers)
                or not set(tags) <= set(e.tags)
                or NON_CHAT_TAGS & set(e.tags)
                or (isinstance(p.free_tier, str) and not p.is_free_tier(e.model_id))
                or (e.context is not None and e.context < need)
                or (self.dec.private and p.kind != "local")
            ):
                continue
            out.append(e)
        return out

    def _ranked(self, pool: list[CatalogEntry]) -> list[Scored]:
        cfg = self.ctx.rules.recommender
        q = self.ctx.quota
        return recommend.rank(
            pool,
            task=self.dec.intent,
            weights=cfg.weights,
            min_samples=cfg.min_samples,
            explore=self.ctx.explore,
            is_free=lambda e: self.reg.providers[e.provider].is_free_tier(e.model_id),
            is_local=lambda e: self.reg.providers[e.provider].kind == "local",
            headroom=lambda e: q.headroom(e.provider, e.model_id) if q else 1.0,
        )

    def _from_ranked(self, ranked: list[Scored], position: int, note: str, keep: int) -> list[Candidate]:
        out: list[Candidate] = []
        for sc in ranked:
            e = sc.entry
            c = self._model(f"model:{e.provider}/{e.model_id}", e.provider, e.model_id, position, note=note)
            if c is None:
                continue
            c.scored = sc
            if self._viable(c):
                out.append(c)
            if len(out) == keep:
                break
        return out

    def _best(self, target: str, cap: str, position: int) -> list[Candidate]:
        out = self._from_ranked(self._ranked(self._pool((cap,))), position, target, keep=2)
        if not out:
            self.skip(target, target, "not_configured", f"No connected model is tagged “{cap}”")
        return out

    def _dynamic(self, target: str, alias: str, position: int) -> list[Candidate]:
        """`explore` and other `pick:` aliases: the best available model of the alias's provider,
        chosen per request from the live catalog (a pinned free model kept being retired)."""
        d = next(a for a in self.reg.aliases if a.alias == alias and a.dynamic)
        p = self.reg.providers[d.provider]
        if d.provider not in self.ctx.connected:
            self.skip(target, alias, "not_connected", f"Not connected: add a key for {p.name} in Connections")
            return []
        pool = self._pool(d.tags, {d.provider})
        if d.pick == "best-free":
            pool = [e for e in pool if p.is_free_tier(e.model_id)]
        out = self._from_ranked(self._ranked(pool), position, f"alias:{alias}", keep=1)
        if not out and not pool:
            self.skip(
                target, alias, "not_configured", f"{p.name} lists no available free chat model right now"
            )
        for c in out:
            c.timeout = float(d.timeout or c.timeout)
        return out

    def _spread(self, alias: str, position: int) -> list[Candidate]:
        """The alias is near its free limit: use the listed stand-in with the most headroom."""
        q = self.ctx.quota
        options = []
        for t in self.reg.equivalent.get(alias, []):
            provider, model_id = t.split("/", 1)
            if self.ctx.entry(provider, model_id) is None or provider not in self.ctx.connected:
                continue
            options.append((q.headroom(provider, model_id) if q else 1.0, provider, model_id))
        for _, provider, model_id in sorted(options, key=lambda o: -o[0]):
            c = self._model(
                f"model:{provider}/{model_id}", provider, model_id, position, note=f"spread:{alias}"
            )
            if c and self._viable(c):
                return [c]
        return []

    # --- policy filters ------------------------------------------------------------------------
    def _has_tag(self, c: Candidate, tag: str) -> bool:
        entry = next((e for e in self.ctx.catalog if e.id == c.catalog_id), None)
        if entry is None and c.model_id:
            entry = self.ctx.entry(c.provider, c.model_id)
        return entry is not None and tag in entry.tags

    def _viable(self, c: Candidate) -> bool:
        dec, ctx = self.dec, self.ctx
        if dec.needs_vision and not self._has_tag(c, "vision"):
            self.skip(c.target, c.label, "needs_vision", "Can't read images (this message has an image)")
            return False
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
        if not self._quota(c):
            return False
        return self._budget(c)

    def _quota(self, c: Candidate) -> bool:
        """Quota guard (M3a): automatic routing leaves a model at `reroute_at` (80%) of any window,
        before the provider answers 429; a manual pick may use the rest, up to `block_at`."""
        q = self.ctx.quota
        u = q.usage(c.provider, c.model_id) if q and c.model_id else None
        if u is None:
            return True
        cfg = self.ctx.rules.quota
        manual_pick = self.manual and c.position == 0
        limit = cfg.block_at if manual_pick else cfg.reroute_at
        if u.fraction >= limit:
            why = "at its limit" if u.fraction >= cfg.block_at else "keeping headroom for manual picks"
            # If a limit people can see is over too, describe that one; only our counter may be.
            shown = next((w for w in q.shown(c.provider, c.model_id) if w.fraction >= limit), None)
            note = None if shown else self._estimate_note(c, u)
            if note:
                self.dec.quota_estimates.append((len(self.dec.candidates), note))
            self.skip(c.target, c.label, "quota", f"{note or (shown or u).describe()}; {why}")
            self.over_quota.add(c.target)
            return False
        if manual_pick and u.fraction >= cfg.reroute_at:
            c.quota_note = self._estimate_note(c, u) or f"{c.label} {u.describe()}"
        return self._fits_tokens(c, limit)

    def _estimate_note(self, c: Candidate, u: Usage) -> str | None:
        """Says so when the number routing acted on is our counter and the provider reports a lower one."""
        q = self.ctx.quota
        real = q.overruled(c.provider, c.model_id, u) if q else None
        if real is None:
            return None
        name = self.reg.providers[c.provider].name.split(" (")[0]
        unit = f"per-minute {u.kind}" if u.window == "minute" else f"today's {u.kind}"
        return f"{name}: our estimate {u.fraction:.0%} of {unit}; {name} reports {real.fraction:.0%}"

    def _fits_tokens(self, c: Candidate, limit: float) -> bool:
        """M2.5: a message with large attachments may not fit what is left of a token window, even when the
        window isn't near its limit yet: count this request's estimate before sending."""
        q = self.ctx.quota
        need = (self.dec.attachments or {}).get("tokens") or 0
        if not q or not need or not c.model_id:
            return True
        for w in q.windows(c.provider, c.model_id):
            if (
                w.kind == "tokens"
                and w.limit
                and w.used + need + tokens(len(self.dec.prompt)) > w.limit * limit
            ):
                reason = (
                    f"This message (≈{need:,} tokens with attachments) would go over the {w.window} "
                    f"token limit ({w.used:,} of {w.limit:,} used)"
                )
                if note := self._estimate_note(c, w):
                    self.dec.quota_estimates.append((len(self.dec.candidates), note))
                    reason = f"{reason}; {note}"
                self.skip(c.target, c.label, "quota", reason)
                self.over_quota.add(c.target)
                return False
        return True

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
    intent = req.classified or heuristics.detect(prompt)
    if req.code_files and not req.needs_vision and intent.intent in ("chat", "writing", "research"):
        # M2.5: an attached code file makes it a code question (the code rule), unless an image needs vision.
        intent = replace(intent, intent="code", size="small", cue="code file attached")
    # SPEC §7.1: a manual pick beats a slash command (still stripped; /private still applies).
    manual = req.target not in ("", "auto")

    if manual and not MODEL_TARGET.match(req.target):
        raise ValueError("target must be `auto` or `model:<alias>` / `model:<provider>/<model>`")

    # M3a hard rules: a pasted secret always stays local (no override); a message the classifier
    # finds sensitive stays local while Settings → Privacy → Auto-detect is on (overridable).
    sensitive: dict[str, Any] | None = None
    auto = None
    if req.secret_kinds:
        sensitive = {"source": "secret", "category": "secret", "kinds": list(req.secret_kinds)}
        sensitive["overridable"] = False
        auto = "secret"
    elif intent.sensitive and ctx.auto_private and not req.no_auto_private and not private:
        sensitive = {"source": "classifier", "category": intent.sensitive, "overridable": True}
        auto = "auto_private"
    if auto and not private:
        private = True
    elif auto:  # already private: still note why it would have been
        sensitive = {**(sensitive or {}), "already_private": True}
        auto = None

    if auto and not manual:
        rule, matched_by = rules.get("private") or rules.get("default"), auto
    elif manual:
        rule, matched_by = rules.get("default"), "manual"
    elif command:
        rule, matched_by = rules.get(rules.slash[command]), "slash"
    elif private:
        rule, matched_by = rules.get("private") or rules.get("default"), "private"
    else:
        facts = {"intent": intent.intent, "size": intent.size, "quality": intent.quality, "private": False}
        rule = pick_rule(rules, facts)
        matched_by = "default" if rule.id == "default" else "intent"
        # M2.5 hard rules (SPEC §7.1 step 2): an image needs a vision model, a long document a long context.
        att = _attachment_rule(rules, req)
        if att is not None:
            rule, matched_by = att, "attachment"
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
        context_tokens=(tokens(req.context_chars) if req.context_chars else 0) + req.attachment_tokens,
        classifier=req.classifier_info,
        sensitive=sensitive,
        explore=ctx.explore,
        weights=dict(rules.recommender.weights),
    )
    if req.needs_vision or req.long_document or req.code_files or req.attachment_tokens:
        dec.attachments = {
            "vision": req.needs_vision,
            "long_document": req.long_document,
            "code": req.code_files,
            "tokens": req.attachment_tokens,
        }
    if media_kind and not manual:
        return dec

    dec.think = req.think
    r = _Resolver(ctx, dec, manual, req.think)
    private_chain = (rules.get("private") or rules.get("default")).chain  # type: ignore[union-attr]
    if private and req.needs_vision:
        # M2.5: only the profile's local vision model can read a private image; never the cloud.
        private_chain = [f"model:{VISION_ALIAS}"]
    if manual and private:
        # A local pick is honoured; anything else is skipped (reason: private) and the private
        # rule's local chain answers instead.
        chain = [req.target, *private_chain]
    elif manual:
        chain = [req.target]
    elif private:
        chain = private_chain
    else:
        chain = rule.chain
    if req.needs_vision and not private:
        # Whatever rule matched, models that can read images come next when its own targets can't.
        vision = _attachment_rule(rules, replace(req, long_document=False))
        chain = [*chain, *(vision.chain if vision else ["best:vision"])]

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
        dec.rule_id = "private"
        dec.matched_by = auto or "private"
    return dec


def _attachment_rule(rules: RuleSet, req: RouteRequest) -> Rule | None:
    want = "image" if req.needs_vision else "long" if req.long_document else None
    if want is None:
        return None
    return next((r for r in rules.rules if r.when.get("attachment") == want), None)


def attachment_reason(dec: Decision) -> str | None:
    a = dec.attachments or {}
    if a.get("vision"):
        return "Needs vision: this message has an image"
    if a.get("long_document"):
        return f"Long document (≈{int(a.get('tokens') or 0):,} tokens) → a model with a long context"
    if a.get("code"):
        return "Code file attached → code rule"
    return None


def reasons(dec: Decision, chosen: Candidate, registry: Registry, catalog: list[CatalogEntry]) -> list[str]:
    """Top 3 plain-language reasons for the chip (SPEC §6.4 explainability)."""
    out: list[str] = []
    why = attachment_reason(dec) if dec.matched_by == "attachment" else None
    if why:
        out.append(why)
    elif dec.matched_by == "manual":
        out.append("You picked this model")
    elif dec.matched_by == "slash":
        out.append(f"/{dec.command} command → rule “{dec.rule_id}”")
    elif dec.matched_by == "private":
        out.append("Private is on → stays on this machine")
    elif dec.matched_by == "secret":
        out.append("Contains a secret (masked) → kept on this machine")
    elif dec.matched_by == "auto_private":
        cat = (dec.sensitive or {}).get("category") or "personal"
        out.append(f"Looks sensitive ({cat}) → kept on this machine")
    elif dec.matched_by == "intent":
        cue = f" (“{dec.cue}”)" if dec.cue else ""
        out.append(f"Looks like {dec.intent}{cue} → rule “{dec.rule_id}”")
    else:
        out.append("General chat → default rule")

    # Our counter moved this request while the provider reported less: say so before anything else.
    at = dec.candidates.index(chosen) if chosen in dec.candidates else len(dec.candidates)
    estimate = next((note for before, note in dec.quota_estimates if before <= at), None)
    if estimate and estimate != chosen.quota_note:
        out.append(estimate)

    runtime = [s for s in dec.skipped if s.code in ("rate_limited", "timeout", "error", "cooldown")]
    if chosen.scored is not None:
        sc = chosen.scored
        kind, _, name = (chosen.note or "").partition(":")
        what = f"“{name}”" if kind == "best" else f"the {name} alias"
        lead = f"Best for {what}: score {sc.score:.2f}"
        if not sc.proven:
            lead += (
                f" (exploring: new model, {sc.samples} samples)"
                if dec.explore
                else f" (only {sc.samples} samples; no proven model available)"
            )
        out.append(lead)
        out.extend(sc.factors(dec.weights)[: 3 - len(out)])
        return out[:3]
    if chosen.quota_note:
        out.append(chosen.quota_note)
    if dec.matched_by == "manual" and chosen.position == 0:
        out.append(f"{chosen.label} answered directly (no fallbacks for a manual pick)")
    elif chosen.note and chosen.note.startswith("spread:"):
        alias = chosen.note.split(":", 1)[1]
        q = next((s for s in dec.skipped if s.code == "quota"), None)
        if estimate:
            out.append(f"Spread load: used instead of {q.label if q else alias}")
        else:
            out.append(f"Spread load: {q.label if q else alias} {q.reason.split(';')[0] if q else 'is busy'}")
    elif chosen.note:
        out.append(f"Best connected match for “{chosen.note.split(':', 1)[1]}”")
    elif chosen.position == 0 and not runtime:
        out.append(f"First choice of rule “{dec.rule_id}”")
    elif dec.skipped:
        s = dec.skipped[-1] if runtime else dec.skipped[0]
        why = "near its limit" if estimate and s.code == "quota" else s.reason[:60]
        out.append(f"Fallback: {s.label} skipped ({why})")
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
