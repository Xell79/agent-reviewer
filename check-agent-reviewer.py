#!/usr/bin/env python3
"""Availability checker for agent-reviewer tiers.

Reads agent-reviewer.json (same directory by default) and probes every
configured model: tiers listed in `order` first (in that order), then the
remaining tiers (config file order). For each tier the primary model is
probed, then its fallbackModels (if any).

HTTP probes are asyncio. Lanes are keyed by baseURL: different providers
run in parallel; models that share a baseURL stay sequential (sleep/retry
policy applies inside that lane only).

The request format replicates plugin/agent-reviewer.ts exactly:
  - apiFormat:       "openai" (default when omitted), "cohere-v2", or "anthropic"
  - openai format:   POST {baseURL}/chat/completions (default)
  - cohere-v2:       POST {baseURL}/chat  (thinking budget, no reasoning_effort)
  - anthropic:       POST {baseURL}/messages  (top-level system, x-api-key)
  - groq / cerebras+gpt-oss: max_completion_tokens instead of max_tokens
  - nemotron models: "/no_think" appended to the system message
  - jsonObject tiers: response_format {"type": "json_object"}
  - apiKey resolution: tier.apiKey first, then env(tier.apiKeyEnv)
  - custom headers: tier.headers merged after standard headers (tier wins)

On a TTY the full probe list is drawn first (check order, top → bottom)
and rewritten in place as each target is checked. Ctrl+C is a clean exit.

Exit codes: 0 = all checks OK, 1 = at least one FAIL, 2 = config error,
130 = interrupted.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DESCRIPTION = (
    "Availability checker for agent-reviewer tiers: probes every configured "
    "model (order first, then the rest) and reports which ones answer."
)

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "agent-reviewer.json"

OK, FAIL, SKIP = "OK", "FAIL", "SKIP"
PENDING, CHECKING, RETRY, WAIT, INTERRUPTED = (
    "PENDING",
    "CHECKING",
    "RETRY",
    "WAIT",
    "INTERRUPTED",
)

# ANSI
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
GRAY = "\033[90m"
BOLD = "\033[1m"
RESET = "\033[0m"
HIDE_CURSOR = "\033[?25l"
SHOW_CURSOR = "\033[?25h"
CLEAR_LINE = "\033[2K"

use_color = False
use_live = False
use_unicode = True


def paint(text: str, *codes: str | None) -> str:
    live = [c for c in codes if c]
    if not use_color or not live:
        return text
    return "".join(live) + text + RESET


_CSI = re.compile(r"\033\[[0-9;]*[A-Za-z]")


def one_line(text: str, limit: int = 0) -> str:
    """Collapse CR/LF/tabs so a note cannot wrap or overwrite the board."""
    s = re.sub(r"[\r\n\t]+", " ", text)
    s = re.sub(r" +", " ", s).strip()
    if limit and len(s) > limit:
        return s[: max(0, limit - 1)] + "…"
    return s


def _visible_len(line: str) -> int:
    return len(_CSI.sub("", line))


def clip_line(line: str, width: int) -> str:
    if width <= 0:
        return ""
    if _visible_len(line) <= width:
        return line
    out: list[str] = []
    vis = 0
    i = 0
    n = len(line)
    budget = max(1, width - 1)
    while i < n:
        if line[i] == "\033":
            m = _CSI.match(line, i)
            if m:
                out.append(m.group(0))
                i = m.end()
                continue
        if vis >= budget:
            out.append("…")
            if use_color:
                out.append(RESET)
            break
        out.append(line[i])
        vis += 1
        i += 1
    return "".join(out)


def _utf8_stdout() -> bool:
    enc = (sys.stdout.encoding or "").lower().replace("-", "")
    return enc in {"utf8", "utf"}


def provider_key(tier_cfg: dict[str, Any]) -> str:
    return str(tier_cfg.get("baseURL") or "").rstrip("/").lower()


@dataclass
class CheckResult:
    tier: str
    model: str
    status: str  # OK | FAIL | SKIP | INTERRUPTED
    http: str = ""
    latency_s: float = 0.0
    note: str = ""
    reply: str = ""
    attempts: int = 1
    disabled: bool = False
    fallback: bool = field(default=False)

    @property
    def label(self) -> str:
        parts = [self.tier]
        if self.fallback:
            parts.append("(fallback)")
        if self.disabled:
            parts.append("[disabled]")
        return " ".join(parts)


@dataclass
class ProbeTarget:
    tier: str
    model: str
    tier_cfg: dict[str, Any]
    fallback: bool = False
    disabled: bool = False
    status: str = PENDING
    http: str = ""
    latency_s: float = 0.0
    note: str = ""
    reply: str = ""
    attempts: int = 0

    @property
    def label(self) -> str:
        parts = [self.tier]
        if self.fallback:
            parts.append("(fallback)")
        if self.disabled:
            parts.append("[disabled]")
        return " ".join(parts)

    def apply_result(self, res: CheckResult) -> None:
        self.status = res.status
        self.http = res.http
        self.latency_s = res.latency_s
        self.note = res.note
        self.reply = res.reply
        self.attempts = res.attempts


def load_config(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(paint(f"config error: {path}: {e}", RED), file=sys.stderr)
        sys.exit(2)


def resolve_api_key(tier_cfg: dict[str, Any]) -> str | None:
    """Same order as plugin resolveApiKey(): tier.apiKey, then env."""
    key = tier_cfg.get("apiKey")
    if isinstance(key, str) and key:
        return key
    env_name = tier_cfg.get("apiKeyEnv")
    if isinstance(env_name, str) and env_name:
        val = os.environ.get(env_name)
        if val:
            return val
    return None


def is_nemotron(model: str) -> bool:
    return bool(re.search(r"nemotron", model, re.IGNORECASE))


def build_probe_messages(model: str, json_mode: bool) -> list[dict[str, str]]:
    system = "Availability probe. Reply with JSON " + '{"ok": true}.'
    if is_nemotron(model):
        system = system.rstrip() + "\n/no_think"
    user = "ping"
    if json_mode:  # some providers require the literal word "json" in prompts
        user = 'Reply with json: {"ok": true}'
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def merge_headers(api_key: str, tier_cfg: dict[str, Any]) -> dict[str, str]:
    """Standard plugin headers, then tier.headers (tier value wins on collision)."""
    api_format = tier_cfg.get("apiFormat") or "openai"
    is_anthropic = api_format == "anthropic"
    is_cohere_v2 = api_format == "cohere-v2"
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "User-Agent": "agent-reviewer-check/1.0",
    }
    if is_anthropic:
        headers["x-api-key"] = api_key
    else:
        headers["Authorization"] = f"Bearer {api_key}"
        if is_cohere_v2:
            headers["Accept"] = "application/json"
    extra = tier_cfg.get("headers")
    if isinstance(extra, dict):
        for k, v in extra.items():
            if isinstance(k, str) and isinstance(v, str):
                key, val = k.strip(), v.strip()
                if key and val:
                    headers[key] = val
    return headers


def build_request_parts(
    tier_name: str,
    tier_cfg: dict[str, Any],
    model: str,
    messages: list[dict[str, str]],
    api_key: str,
) -> tuple[str, dict[str, Any], dict[str, str]]:
    """Return (url, body, headers) replicating plugin callReviewerOnce()."""
    base = str(tier_cfg.get("baseURL", "")).rstrip("/")
    api_format = tier_cfg.get("apiFormat") or "openai"
    is_anthropic = api_format == "anthropic"
    is_cohere_v2 = api_format == "cohere-v2"
    if is_anthropic:
        url = f"{base}/messages"
    elif is_cohere_v2:
        url = f"{base}/chat"
    else:
        url = f"{base}/chat/completions"

    max_tokens = tier_cfg.get("maxTokens") or 512
    if is_anthropic:
        system_msg = next(
            (m["content"] for m in messages if m.get("role") == "system"), None,
        )
        user_msgs = [m for m in messages if m.get("role") != "system"]
        body: dict[str, Any] = {
            "model": model,
            "messages": user_msgs,
            "max_tokens": max_tokens,
            "temperature": 0,
        }
        if system_msg:
            body["system"] = system_msg
        return url, body, merge_headers(api_key, tier_cfg)

    is_groq = "api.groq.com" in base or tier_name.startswith("groq")
    is_cerebras_gptoss = (
        "cerebras.ai" in base and re.search(r"gpt-oss", model, re.IGNORECASE)
    )

    body = {"model": model, "messages": messages, "temperature": 0}
    if is_groq or is_cerebras_gptoss:
        body["max_completion_tokens"] = max_tokens
    else:
        body["max_tokens"] = max_tokens

    if (
        is_cohere_v2
        and isinstance(tier_cfg.get("thinkingBudget"), (int, float))
        and tier_cfg["thinkingBudget"] > 0
    ):
        body["thinking"] = {
            "type": "enabled",
            "token_budget": tier_cfg["thinkingBudget"],
        }

    if tier_cfg.get("jsonObject") is True:
        body["response_format"] = {"type": "json_object"}

    reasoning_effort = tier_cfg.get("reasoningEffort") or tier_cfg.get(
        "reasoning_effort",
    )
    if not is_cohere_v2 and isinstance(reasoning_effort, str) and reasoning_effort:
        body["reasoning_effort"] = reasoning_effort

    reasoning_max = tier_cfg.get("reasoningMaxTokens")
    if reasoning_max is None:
        nested = tier_cfg.get("reasoning")
        if isinstance(nested, dict):
            reasoning_max = nested.get("max_tokens")
        else:
            reasoning_max = tier_cfg.get("reasoning_max_tokens")
    if (
        not is_cohere_v2
        and not is_groq
        and isinstance(reasoning_max, (int, float))
        and reasoning_max > 0
    ):
        body["reasoning"] = {"max_tokens": int(reasoning_max)}

    return url, body, merge_headers(api_key, tier_cfg)


def extract_reply(payload: dict[str, Any]) -> tuple[str, str]:
    """Extract assistant text from openai, anthropic, or cohere-v2 response shapes.

    Returns (text, finish_reason); text empty string means unusable reply.
    """
    # Anthropic native shape:
    # { content: [ { type: "text", text: "..." } ], stop_reason: "end_turn" }
    raw_content = payload.get("content")
    if isinstance(raw_content, list):
        parts: list[str] = []
        for p in raw_content:
            if isinstance(p, dict):
                t = p.get("text")
                if isinstance(t, str):
                    parts.append(t)
            elif isinstance(p, str):
                parts.append(p)
        if parts and "".join(parts).strip():
            return "".join(parts).strip(), str(payload.get("stop_reason") or "")

    # OpenAI-compatible shape
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        msg = choices[0].get("message") or {}
        text = msg.get("content")
        if isinstance(text, list):  # some gateways emit content parts
            text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
        return (text or "").strip(), str(choices[0].get("finish_reason", ""))
    # Cohere v2 native shape
    msg = payload.get("message")
    if isinstance(msg, dict):
        content = msg.get("content")
        if isinstance(content, list):
            text = "".join(p.get("text", "") for p in content if isinstance(p, dict))
            return text.strip(), str(payload.get("finish_reason", ""))
        if isinstance(content, str):
            return content.strip(), str(payload.get("finish_reason", ""))
    return "", ""


def http_post_json(
    url: str, body: dict[str, Any], headers: dict[str, str], timeout_s: float,
) -> tuple[int, dict[str, Any] | str]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise _HttpError(e.code, one_line(raw, 160)) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        # socket.timeout lands here as URLError(reason=timeout)
        reason = getattr(e, "reason", None) or e
        raise _HttpError(
            0, one_line(f"{type(reason).__name__}: {reason}", 160),
        ) from None


class _HttpError(Exception):
    def __init__(self, code: int, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def should_retry(code: int) -> bool:
    """Retry only operational errors: network/timeout (0), 429, 5xx."""
    return code == 0 or code == 429 or code >= 500


ProgressFn = Callable[[str, int, str, str], Awaitable[None]]


async def sleep_ticks(
    seconds: float, on_tick: Callable[[float], Awaitable[None]] | None = None,
) -> None:
    """Sleep `seconds`, invoking on_tick(remaining) about once per second."""
    if seconds <= 0:
        return
    deadline = time.monotonic() + seconds
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            break
        if on_tick:
            await on_tick(left)
        await asyncio.sleep(min(1.0, left))


async def probe_model(
    tier_name: str,
    tier_cfg: dict[str, Any],
    model: str,
    *,
    fallback: bool = False,
    retries: int,
    retry_sleep_s: float,
    on_progress: ProgressFn | None = None,
) -> CheckResult:
    disabled = tier_cfg.get("disabled") is True
    res = CheckResult(
        tier=tier_name, model=model, status=SKIP, fallback=fallback, disabled=disabled,
    )

    api_key = resolve_api_key(tier_cfg)
    if not api_key:
        res.note = "no api key (tier.apiKey / env both empty)"
        return res

    timeout_ms = tier_cfg.get("timeoutMs") or 8000
    json_mode = tier_cfg.get("jsonObject") is True
    url, body, headers = build_request_parts(
        tier_name,
        tier_cfg,
        model,
        build_probe_messages(model, json_mode),
        api_key,
    )

    async def progress(
        status: str, attempt: int, note: str = "", http: str = "",
    ) -> None:
        if on_progress:
            await on_progress(status, attempt, note, http)

    for attempt in range(1, retries + 2):
        res.attempts = attempt
        await progress(CHECKING, attempt, f"attempt {attempt}/{retries + 1}", res.http)
        start = time.monotonic()
        try:
            code, payload = await asyncio.to_thread(
                http_post_json, url, body, headers, timeout_ms / 1000.0,
            )
        except _HttpError as e:
            res.status = FAIL
            res.http = str(e.code) if e.code else "ERR"
            res.note = e.detail
            res.latency_s = time.monotonic() - start
            if attempt <= retries and should_retry(e.code):

                async def _tick(
                    left: float, _e: _HttpError = e, _att: int = attempt,
                ) -> None:
                    await progress(
                        RETRY,
                        _att,
                        f"retry {_att}/{retries} in {left:.0f}s — {_e.detail}",
                        str(_e.code) if _e.code else "ERR",
                    )

                await sleep_ticks(retry_sleep_s, _tick)
                continue
            return res

        res.latency_s = time.monotonic() - start
        res.http = str(code)
        if code != 200:
            res.status = FAIL
            res.note = "non-200 response"
            return res
        if not isinstance(payload, dict):
            res.status = FAIL
            res.note = f"non-JSON body: {str(payload)[:120]}"
            return res
        text, finish = extract_reply(payload)
        res.reply = one_line(text, 80)
        if not text:
            res.status = FAIL
            res.note = f"200 but empty content (finish={finish or '?'})"
            return res
        res.status = OK
        res.note = finish
        return res

    res.status = FAIL
    return res


def iter_checks(
    cfg: dict[str, Any], only: set[str] | None,
) -> list[tuple[str, dict[str, Any]]]:
    """Tiers from `order` first (in listed order), then the rest (config order)."""
    tiers: dict[str, Any] = cfg.get("tiers") or {}
    order: list[str] = cfg.get("order") or []
    queue: list[tuple[str, dict[str, Any]]] = []

    for name in order:
        if name not in tiers:
            print(
                paint(f"warning: order lists unknown tier {name!r}", YELLOW),
                file=sys.stderr,
            )
            continue
        if only and name not in only:
            continue
        queue.append((name, tiers[name]))

    for name, tier_cfg in tiers.items():
        if name in order:
            continue
        if only and name not in only:
            continue
        queue.append((name, tier_cfg))
    return queue


def flatten_targets(queue: list[tuple[str, dict[str, Any]]]) -> list[ProbeTarget]:
    targets: list[ProbeTarget] = []
    for name, tier_cfg in queue:
        disabled = tier_cfg.get("disabled") is True
        primary = str(tier_cfg.get("model") or "")
        targets.append(
            ProbeTarget(
                tier=name,
                model=primary or "?",
                tier_cfg=tier_cfg,
                disabled=disabled,
            ),
        )
        for fb in tier_cfg.get("fallbackModels") or []:
            if not fb:
                continue
            targets.append(
                ProbeTarget(
                    tier=name,
                    model=str(fb),
                    tier_cfg=tier_cfg,
                    fallback=True,
                    disabled=disabled,
                ),
            )
    return targets


def group_lanes(rows: list[ProbeTarget]) -> list[tuple[str, list[int]]]:
    """Preserve first-seen provider order; indices keep board check-order."""
    lanes: dict[str, list[int]] = defaultdict(list)
    seen: list[str] = []
    for i, row in enumerate(rows):
        key = provider_key(row.tier_cfg)
        if key not in lanes:
            seen.append(key)
        lanes[key].append(i)
    return [(k, lanes[k]) for k in seen]


def _glyphs() -> dict[str, str]:
    if use_unicode:
        return {
            PENDING: "○",
            WAIT: "○",
            CHECKING: "▶",
            RETRY: "↻",
            OK: "✓",
            FAIL: "✗",
            SKIP: "–",  # noqa: RUF001 — intentional EN DASH glyph
            INTERRUPTED: "■",
        }
    return {
        PENDING: "o",
        WAIT: "o",
        CHECKING: ">",
        RETRY: "R",
        OK: "OK",
        FAIL: "X",
        SKIP: "-",
        INTERRUPTED: "!",
    }


def _status_style(status: str) -> tuple[str, str | None]:
    glyphs = _glyphs()
    colors = {
        PENDING: GRAY,
        WAIT: GRAY,
        CHECKING: CYAN,
        RETRY: YELLOW,
        OK: GREEN,
        FAIL: RED,
        SKIP: YELLOW,
        INTERRUPTED: GRAY,
    }
    return glyphs.get(status, "?"), colors.get(status)


def format_row(row: ProbeTarget, label_w: int, model_w: int) -> str:
    glyph, color = _status_style(row.status)
    glyph_s = paint(
        f"{glyph:<2}", color, BOLD if row.status in {OK, FAIL, CHECKING} else None,
    )
    label = paint(
        f"{row.label:<{label_w}}",
        GRAY if row.status in {PENDING, WAIT, INTERRUPTED} or row.disabled else None,
    )
    model = row.model[:model_w]
    model_s = f"{model:<{model_w}}"
    if row.status in {PENDING, WAIT}:
        model_s = paint(model_s, GRAY)
    http = f"{row.http:<5}" if row.http else "     "
    if row.latency_s:
        latency = f"{row.latency_s:>5.1f}s"
    elif row.status in {CHECKING, RETRY, WAIT}:
        latency = "   … "
    else:
        latency = "      "
    if row.status == OK:  # noqa: SIM108 — ternary hurts readability here
        detail = row.reply or row.note
    else:
        detail = row.note
    extra = (
        f"  x{row.attempts}" if row.attempts > 1 and row.status in {OK, FAIL} else ""
    )
    return f"  {glyph_s} {label} {model_s} {http} {latency}  {one_line(detail)}{extra}"


class Board:
    def __init__(self, rows: list[ProbeTarget]):
        self.rows = rows
        self.label_w = max((len(r.label) for r in rows), default=8)
        self.label_w = max(self.label_w, 12)
        self.model_w = 36
        self._lock = asyncio.Lock()

    def _term_width(self) -> int:
        return shutil.get_terminal_size((120, 24)).columns

    def line(self, row: ProbeTarget) -> str:
        return clip_line(
            format_row(row, self.label_w, self.model_w), self._term_width(),
        )

    def legend(self) -> str:
        g = _glyphs()
        parts = [
            paint(f"{g[PENDING]} pending", GRAY),
            paint(f"{g[CHECKING]} checking", CYAN),
            paint(f"{g[RETRY]} retry", YELLOW),
            paint(f"{g[OK]} ok", GREEN),
            paint(f"{g[FAIL]} fail", RED),
            paint(f"{g[SKIP]} skip", YELLOW),
            paint(f"{g[INTERRUPTED]} interrupted", GRAY),
        ]
        return "  " + "   ".join(parts)

    def draw_initial(self, title: str) -> None:
        width = self._term_width()
        print(clip_line(paint(one_line(title), BOLD), width), flush=True)
        print(clip_line(self.legend(), width), flush=True)
        print(flush=True)
        for row in self.rows:
            print(self.line(row), flush=True)

    def redraw_all(self) -> None:
        """Rewrite the whole list from the top. Never seek to a single row.

        Per-row cursor math breaks as soon as any line wraps (JSON error
        bodies, narrow terminals). Full redraw under the board lock is cheap
        for ~20 rows and stays aligned.
        """
        if not use_live:
            return
        n = len(self.rows)
        if n <= 0:
            return
        sys.stdout.write(f"\033[{n}A")
        for row in self.rows:
            sys.stdout.write(f"\r{CLEAR_LINE}{self.line(row)}\n")
        sys.stdout.flush()

    def refresh(self, idx: int) -> None:
        if not use_live:
            if self.rows[idx].status not in {PENDING, WAIT, CHECKING, RETRY}:
                print(self.line(self.rows[idx]), flush=True)
            return
        self.redraw_all()

    async def apply_progress(
        self, idx: int, status: str, attempt: int, note: str, http: str,
    ) -> None:
        async with self._lock:
            row = self.rows[idx]
            row.status = status
            row.attempts = attempt
            row.note = one_line(note)
            if http:
                row.http = one_line(http, 8)
            self.refresh(idx)

    async def apply_result(self, idx: int, res: CheckResult) -> None:
        async with self._lock:
            self.rows[idx].apply_result(res)
            self.refresh(idx)

    async def set_status(self, idx: int, status: str, note: str = "") -> None:
        async with self._lock:
            row = self.rows[idx]
            row.status = status
            if note or status in {WAIT, CHECKING, SKIP}:
                row.note = one_line(note)
            self.refresh(idx)


def hide_cursor() -> None:
    if use_live:
        sys.stdout.write(HIDE_CURSOR)
        sys.stdout.flush()


def show_cursor() -> None:
    if use_live:
        sys.stdout.write(SHOW_CURSOR)
        sys.stdout.flush()


def mark_interrupted(rows: list[ProbeTarget], board: Board) -> None:
    for row in rows:
        if row.status in {PENDING, WAIT, CHECKING, RETRY}:
            in_flight = row.status in {CHECKING, RETRY, WAIT}
            row.status = INTERRUPTED
            if in_flight:
                row.note = row.note or "interrupted"
            elif not row.note:
                row.note = "not checked"
    if use_live:
        board.redraw_all()
    else:
        for i, row in enumerate(rows):
            if row.status == INTERRUPTED:
                board.refresh(i)


async def run_lane(
    indices: list[int],
    rows: list[ProbeTarget],
    board: Board,
    *,
    sleep_s: float,
    retries: int,
    retry_sleep_s: float,
) -> None:
    first = True
    for i in indices:
        if not first and sleep_s:
            await board.set_status(i, WAIT, f"starts in {sleep_s:.0f}s")

            async def _wait_tick(left: float, _i: int = i) -> None:
                await board.set_status(_i, WAIT, f"starts in {left:.0f}s")

            await sleep_ticks(sleep_s, _wait_tick)
            await board.set_status(i, WAIT, "")
        first = False

        row = rows[i]
        if row.model == "?":
            await board.set_status(i, SKIP, "tier has no model")
            continue

        await board.set_status(i, CHECKING, "checking…")

        async def _prog(
            status: str,
            attempt: int,
            note: str,
            http: str,
            _i: int = i,
        ) -> None:
            await board.apply_progress(_i, status, attempt, note, http)

        res = await probe_model(
            row.tier,
            row.tier_cfg,
            row.model,
            fallback=row.fallback,
            retries=retries,
            retry_sleep_s=retry_sleep_s,
            on_progress=_prog,
        )
        await board.apply_result(i, res)


async def run_all(
    rows: list[ProbeTarget],
    board: Board,
    lanes: list[tuple[str, list[int]]],
    *,
    sleep_s: float,
    retries: int,
    retry_sleep_s: float,
) -> None:
    tasks = [
        asyncio.create_task(
            run_lane(
                indices,
                rows,
                board,
                sleep_s=sleep_s,
                retries=retries,
                retry_sleep_s=retry_sleep_s,
            ),
            name=f"lane:{key or 'empty'}",
        )
        for key, indices in lanes
    ]
    try:
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=DESCRIPTION)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--only", help="comma-separated tier names to check (default: all)",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=12.0,
        help="pause between checks of the same baseURL, seconds (default 12)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=2,
        help="retries per model on operational errors (default 2)",
    )
    parser.add_argument(
        "--retry-sleep",
        type=float,
        default=60.0,
        help="pause before retry, seconds (default 60)",
    )
    parser.add_argument("--no-color", action="store_true")
    parser.add_argument(
        "--no-live",
        action="store_true",
        help="do not rewrite the list in place (print results as they finish)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    global use_color, use_live, use_unicode  # noqa: PLW0603 — CLI entry point
    use_color = sys.stdout.isatty() and not args.no_color
    use_live = sys.stdout.isatty() and not args.no_live
    use_unicode = _utf8_stdout()

    cfg = load_config(args.config)
    only = {s.strip() for s in args.only.split(",")} if args.only else None
    queue = iter_checks(cfg, only)
    if not queue:
        print(paint("no tiers to check", YELLOW), file=sys.stderr)
        return 2

    rows = flatten_targets(queue)
    lanes = group_lanes(rows)
    n_tiers = len(queue)
    n_targets = len(rows)
    n_providers = len(lanes)
    board = Board(rows)
    title = (
        f"📖 {args.config}: {n_tiers} tiers, {n_targets} targets, "
        f"{n_providers} providers in parallel (list = check order ↓)"
    )

    hide_cursor()
    interrupted = False
    try:
        board.draw_initial(title)
        asyncio.run(
            run_all(
                rows,
                board,
                lanes,
                sleep_s=args.sleep,
                retries=args.retries,
                retry_sleep_s=args.retry_sleep,
            ),
        )
    except KeyboardInterrupt:
        interrupted = True
        mark_interrupted(rows, board)
    finally:
        show_cursor()

    ok = [r for r in rows if r.status == OK]
    fails = [r for r in rows if r.status == FAIL]
    skips = [r for r in rows if r.status == SKIP]
    pending = [
        r for r in rows if r.status in {PENDING, WAIT, CHECKING, RETRY, INTERRUPTED}
    ]
    print()
    bits = [paint(f"{len(ok)} OK", GREEN, BOLD), paint(f"{len(fails)} FAIL", RED, BOLD)]
    if skips:
        bits.append(paint(f"{len(skips)} SKIP", YELLOW, BOLD))
    if pending:
        bits.append(paint(f"{len(pending)} interrupted", GRAY, BOLD))
    print("Summary: " + " / ".join(bits) + f" of {len(rows)}", flush=True)
    for r in fails:
        print(paint(f"  ✗ {r.label}: {r.model} — {r.note}", RED))
    if interrupted:
        return 130
    return 0 if not fails and not skips else 1


if __name__ == "__main__":
    sys.exit(main())
