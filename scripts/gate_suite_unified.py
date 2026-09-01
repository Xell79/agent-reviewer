#!/usr/bin/env python3
"""Unified agent-reviewer gate-suite.

Tests one or more models against the current SYSTEM_PROMPT from the plugin.

Multi-model mode (default when multiple providers selected):
  For each case, requests are fired asynchronously to ALL models in parallel.
  The next case starts only after every model has responded for the current case.

Usage:
  # list available providers with 1-based indices
  python3 gate_suite_unified.py --list

  # single model by name or index
  python3 gate_suite_unified.py --providers 1
  python3 gate_suite_unified.py --providers ollama-gemma4-31b --suite hard10

  # multiple models by name, index, or index range
  python3 gate_suite_unified.py --providers 1,2,5 --suite extended
  python3 gate_suite_unified.py --providers 1-3 --suite hard10
  python3 gate_suite_unified.py --providers groq-qwen36-27b,together-bonsai-27b --suite balanced18
  python3 gate_suite_unified.py --all-providers --suite hard10

  # start testing from a specific case (continue after interruption)
  python3 gate_suite_unified.py --providers 1 --from-case 45
  python3 gate_suite_unified.py --providers 1 --from-case dp-07

  # logging options (default writes to /tmp/gate-unified.log)
  python3 gate_suite_unified.py --providers 1 --log /tmp/my_test.log
  python3 gate_suite_unified.py --providers 1 --overwrite
  python3 gate_suite_unified.py --providers 1 --append
  python3 gate_suite_unified.py --providers 1 --no-log
  python3 gate_suite_unified.py --providers kilo-minimax-m2_7 --reasoning-max-tokens 32

  # suite choices: extended | balanced18 | hard10 | all

Rate limits:
  Default --sleep 12s after each case barrier (Cerebras free tier = 5 RPM → 12s/req).
  Applies uniformly to all models. Override: --sleep 0 (no delay) or --sleep N.

Key reading from ~/.config/kilo/agent-reviewer.json unless --key given (single target only).
Output: /tmp/gate_unified_multi_<names>_<suite>_<timestamp>.json (multi) or
        /tmp/gate_unified_<provider>_<model>_<suite>_<timestamp>.json (single)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Logging / stdout tee
# ---------------------------------------------------------------------------

class TeeStream:
    """Mirrors stream writes to both the original stream and a log file."""

    def __init__(self, original: Any, log_file: Any) -> None:
        self.original = original
        self.log_file = log_file

    def write(self, s: str) -> int:
        res = self.original.write(s)
        if self.log_file:
            try:
                self.log_file.write(s)
                self.log_file.flush()
            except Exception:
                pass
        return res

    def flush(self) -> None:
        self.original.flush()
        if self.log_file:
            try:
                self.log_file.flush()
            except Exception:
                pass

    def isatty(self) -> bool:
        return getattr(self.original, "isatty", lambda: False)()

    def fileno(self) -> int:
        return self.original.fileno()

    def __getattr__(self, name: str) -> Any:
        return getattr(self.original, name)


def setup_log_file(log_path_str: str, overwrite: bool = False, append: bool = False) -> Any:
    """Open log file with user conflict resolution if file exists."""
    log_path = Path(log_path_str).expanduser().resolve()
    log_path.parent.mkdir(parents=True, exist_ok=True)

    mode = "w"
    if log_path.exists() and log_path.stat().st_size > 0:
        if overwrite:
            mode = "w"
        elif append:
            mode = "a"
        else:
            print(f"\n[!] Log file already exists: {log_path}", flush=True)
            while True:
                print("Choose action:", flush=True)
                print("  [1] Overwrite / replace existing file", flush=True)
                print("  [2] Append to existing file", flush=True)
                print("  [3] Abort / cancel test", flush=True)
                try:
                    choice = input("Enter choice [1/2/3] (or o/a/c): ").strip().lower()
                except (EOFError, KeyboardInterrupt):
                    print("\nAborted.")
                    sys.exit(0)

                if choice in ("1", "o", "overwrite", "replace", "w", "з", "заменить", "delete", "d"):
                    mode = "w"
                    break
                elif choice in ("2", "a", "append", "д", "добавить"):
                    mode = "a"
                    break
                elif choice in ("3", "c", "cancel", "abort", "q", "quit", "n", "no", "п", "прервать", ""):
                    print("Test aborted by user.")
                    sys.exit(0)
                else:
                    print(f"Invalid choice '{choice}'. Please enter 1, 2, or 3.")

    f = open(log_path, mode, encoding="utf-8", buffering=1)
    if mode == "a":
        f.write(f"\n--- Resumed at {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
        f.flush()
    return f


# ---------------------------------------------------------------------------
# Config / keys
# ---------------------------------------------------------------------------

_cfg_path = Path(os.environ.get("AGENT_REVIEWER_CONFIG",
                                os.path.expanduser("~/.config/kilo/agent-reviewer.json")))
SCRIPT_DIR = Path(__file__).resolve().parent
HARD10_GOLD = SCRIPT_DIR / "gate_hard10_gold.json"
BALANCED18_GOLD = SCRIPT_DIR / "gate_balanced18_gold.json"
EXTENDED_GOLD = SCRIPT_DIR / "gate_cases_extended.json"

# Cerebras free tier: 5 RPM → min 12s between requests. Applied to ALL models
# (uniform post-case barrier sleep; no per-provider special-case).
DEFAULT_CASE_SLEEP_S = 12.0
# Pause before retry after timeout/HTTP/network errors (override with --retry-sleep).
DEFAULT_RETRY_SLEEP_S = 12.0
# Max retries per case after first attempt (override with --max-retries).
# Total attempts = 1 + _max_retries.
DEFAULT_MAX_RETRIES = 3
# Runtime overrides set from CLI in main().
_retry_sleep_s = DEFAULT_RETRY_SLEEP_S
_max_retries = DEFAULT_MAX_RETRIES

_providers: dict[str, dict[str, Any]] = {}  # all tier defs (name → config)
_order: list[str] = []  # enabled chain from config.order (empty = all defs)
_provider_index: list[str] = []  # 1-based numbered list of all defined providers


def load_providers() -> None:
    """Load tier defs from agent-reviewer.json.

    New format:
      tiers: { name: { baseURL, model, ... }, ... }
      order: [name, ...]   # enabled chain; omit = disabled
    Legacy:
      tiers: [ { name, ..., disabled? }, ... ]
    """
    raw = json.loads(_cfg_path.read_text())
    tiers_raw = raw.get("tiers", {})
    order = raw.get("order")

    defs: dict[str, dict[str, Any]] = {}
    if isinstance(tiers_raw, dict):
        for name, t in tiers_raw.items():
            if not isinstance(t, dict):
                continue
            # Skip disabled tiers (daily limits / overloaded models).
            if t.get("disabled") is True:
                continue
            entry = dict(t)
            entry["name"] = name
            defs[name] = entry
    elif isinstance(tiers_raw, list):
        legacy_order: list[str] = []
        for t in tiers_raw:
            if not isinstance(t, dict) or not t.get("name"):
                continue
            if t.get("disabled") is True:
                continue
            defs[t["name"]] = t
            legacy_order.append(t["name"])
        if not isinstance(order, list) or not order:
            order = legacy_order

    _providers.clear()
    _providers.update(defs)

    if isinstance(order, list) and order:
        _order[:] = [n for n in order if n in defs]
    else:
        _order[:] = list(defs.keys())

    # Build stable 1-based provider list: tiers in active order first, then remaining defined tiers
    seen: set[str] = set()
    _provider_index.clear()
    for name in _order:
        if name in _providers and name not in seen:
            _provider_index.append(name)
            seen.add(name)
    for name in _providers:
        if name not in seen:
            _provider_index.append(name)
            seen.add(name)


def print_providers_list() -> None:
    """Print numbered list of all available providers from config."""
    print(f"\nAvailable tiers in {_cfg_path}:")
    for idx, name in enumerate(_provider_index, start=1):
        t = _providers[name]
        model = t.get("model", "unknown")
        in_order = f"(active order #{_order.index(name) + 1})" if name in _order else "(research / not in active order)"
        print(f"  [{idx:2d}] {name:<26} [model: {model}] {in_order}")
    print()


def resolve_provider_names(raw_spec: str) -> list[str]:
    """Parse comma-separated provider names, numbers, or ranges (e.g. '1,3', '1-4', 'groq-qwen36-27b')."""
    tokens = [t.strip() for t in raw_spec.split(",") if t.strip()]
    resolved: list[str] = []
    seen: set[str] = set()

    def add_name(name: str) -> None:
        if name not in seen:
            resolved.append(name)
            seen.add(name)

    for tok in tokens:
        # Check range: e.g. "1-3"
        m_range = re.match(r"^(\d+)\s*-\s*(\d+)$", tok)
        if m_range:
            start, end = int(m_range.group(1)), int(m_range.group(2))
            if start < 1 or end > len(_provider_index) or start > end:
                sys.exit(
                    f"invalid provider range '{tok}'. Valid range: 1..{len(_provider_index)}. "
                    f"Use --list to view all providers."
                )
            for i in range(start, end + 1):
                add_name(_provider_index[i - 1])
            continue

        # Check single integer: e.g. "2"
        if tok.isdigit():
            idx = int(tok)
            if 1 <= idx <= len(_provider_index):
                add_name(_provider_index[idx - 1])
                continue
            else:
                sys.exit(
                    f"invalid provider number '{tok}'. Valid numbers: 1..{len(_provider_index)}. "
                    f"Use --list to view all providers."
                )

        # Check name
        if tok in _providers:
            add_name(tok)
        else:
            sys.exit(
                f"unknown provider '{tok}'. Use --list to view all available providers."
            )

    return resolved


def get_key(provider: str, explicit: str | None) -> str:
    if explicit:
        return explicit
    tier = _providers.get(provider)
    if not tier:
        sys.exit(f"unknown provider '{provider}'; known: {sorted(_providers)}")
    k = tier.get("apiKey") or os.environ.get(tier.get("apiKeyEnv", ""), "")
    if not k:
        sys.exit(f"no key for provider '{provider}' (apiKey / {tier.get('apiKeyEnv')})")
    return k


# ---------------------------------------------------------------------------
# Prompt extraction
# ---------------------------------------------------------------------------

def extract_system_prompt() -> str:
    """Read systemPrompt strictly from agent-reviewer.json. Exit if missing or empty."""
    if not _cfg_path.is_file():
        sys.exit(f"ERROR: config file not found at {_cfg_path}")
    try:
        raw = json.loads(_cfg_path.read_text())
    except Exception as e:
        sys.exit(f"ERROR: failed to parse config {_cfg_path}: {e}")
    sp = raw.get("systemPrompt")
    if not isinstance(sp, str) or not sp.strip():
        sys.exit(
            f"ERROR: 'systemPrompt' is missing or empty in {_cfg_path}.\n"
            "The safety gate requires a non-empty systemPrompt in agent-reviewer.json."
        )
    return sp.strip()


# ---------------------------------------------------------------------------
# Parser (bug-fixed, no `escale` typo)
# ---------------------------------------------------------------------------

def strip_fences(t: str) -> str:
    t = t.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t, flags=re.I)
        t = re.sub(r"\s*```$", "", t, flags=re.I)
    return t.strip()


def extract_json_obj(text: str) -> str | None:
    c = strip_fences(text)
    s = c.find("{")
    if s < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    end = -1
    for k in range(s, len(c)):
        ch = c[k]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = k
                break
    if end < 0:
        return None
    return c[s:end + 1]


def normalize(v: object) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip().lower()
    if s in ("approve", "allow", "yes", "ok", "safe"):
        return "approve"
    if s in ("escalate", "deny", "no", "block", "reject", "unsafe", "review", "ask", "human"):
        return "escalate"
    return None


def parse(text: str):
    """Return (decision, reason, method)."""
    obj = extract_json_obj(text)
    if obj:
        try:
            rec = json.loads(obj)
        except Exception:
            rec = {}
        d = normalize(rec.get("decision"))
        if d:
            return d, rec.get("reason", ""), "json"
    m = re.search(r'"decision"\s*:\s*"(approve|escalate)"', text, re.I)
    if m:
        return m.group(1).lower(), "", "regex"
    tail = text[-400:]
    # NOTE: fixed bug — was `escale` (missing 'at'); caused false heuristic approve
    if re.search(r"\b(decision\s*[:=]\s*)?escalate\b", tail) and \
       not re.search(r"\bapprove\b", tail[-80:]):
        return "escalate", "heuristic", "heuristic"
    if re.search(r"\b(decision\s*[:=]\s*)?approve\b", tail) and \
       not re.search(r"\bescalate\b", tail[-80:]):
        return "approve", "heuristic", "heuristic"
    return None, None, "none"


def extract_text(data: dict[str, Any]) -> str:
    """OpenAI chat/completions, Anthropic /messages, OR Cohere v2 /chat response → assistant text."""
    # Anthropic native: data["content"] list
    ac = data.get("content")
    if isinstance(ac, list):
        parts = [
            str(item["text"])
            for item in ac
            if isinstance(item, dict) and item.get("type") in (None, "text") and item.get("text")
        ]
        if parts:
            return "".join(parts)

    # OpenAI-compatible
    ch = (data.get("choices") or [{}])[0]
    msg = ch.get("message") or {}
    c = msg.get("content")
    if isinstance(c, str) and c.strip():
        return c
    if isinstance(c, list):
        joined = "".join(
            (x.get("text") or "" if isinstance(x, dict) else str(x)) for x in c
        )
        if joined.strip():
            return joined
    for f in ("reasoning", "reasoning_content"):
        v = msg.get(f)
        if isinstance(v, str) and v.strip():
            return v
    if data.get("text"):
        return str(data["text"])

    # Cohere v2: { message: { content: [ {type, text}, ... ], tool_calls? } }
    cmsg = data.get("message") or {}
    content = cmsg.get("content")
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") in (None, "text") and item.get("text"):
                    parts.append(str(item["text"]))
                elif item.get("text"):
                    parts.append(str(item["text"]))
            elif isinstance(item, str):
                parts.append(item)
        if parts:
            return "".join(parts)
    if isinstance(content, str) and content.strip():
        return content
    return ""


# ---------------------------------------------------------------------------
# Target model descriptor
# ---------------------------------------------------------------------------

@dataclass
class ModelTarget:
    name: str                 # provider/tier name
    model: str
    base_url: str
    key: str
    max_tokens: int
    timeout: int              # seconds
    api_format: str = "openai"  # "openai" | "cohere-v2" | "anthropic"
    thinking_budget: int | None = None
    reasoning_effort: str | None = None
    reasoning_max_tokens: int | None = None
    sleep: float = DEFAULT_CASE_SLEEP_S  # post-case barrier sleep (rate limits)
    json_object: bool = False  # response_format json_object when supported
    headers: dict[str, str] | None = None
    label: str = ""

    def __post_init__(self) -> None:
        if not self.label:
            self.label = f"{self.name}/{self.model}"


def is_nemotron_model(model: str) -> bool:
    """NVIDIA Nemotron thinking models (any provider: NIM, Ollama, …)."""
    return "nemotron" in (model or "").lower()


def nemotron_disable_thinking_kwargs(model: str) -> dict[str, Any] | None:
    """Nemotron 3 Super / 3.5 Lightning ignore /no_think; official off-switch."""
    if not is_nemotron_model(model):
        return None
    return {"enable_thinking": False}


def messages_for_model(model: str, msgs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Append /no_think to system message for Nemotron (disable CoT). Idempotent."""
    if not is_nemotron_model(model):
        return msgs
    out: list[dict[str, Any]] = []
    for m in msgs:
        if m.get("role") != "system":
            out.append(m)
            continue
        content = m.get("content") or ""
        if re.search(r"(?:^|\n)\s*/no_think\s*(?:\n|$)", content, flags=re.I):
            out.append(m)
            continue
        out.append({**m, "content": content.rstrip() + "\n/no_think"})
    return out


# ---------------------------------------------------------------------------
# API call
# ---------------------------------------------------------------------------

def call_model(target: ModelTarget, msgs: list[dict[str, Any]], retries: int | None = None) -> dict[str, Any]:
    """Call one model. Supports OpenAI-compatible, Anthropic, and Cohere v2.

    retries: max *retries* after the first attempt (not total attempts).
    Total attempts = 1 + retries. Default from _max_retries (CLI --max-retries).
    """
    if retries is None:
        retries = _max_retries
    max_attempts = 1 + max(0, int(retries))

    is_anthropic = target.api_format == "anthropic"
    is_cohere_v2 = target.api_format == "cohere-v2"
    is_groq = "groq.com" in target.base_url
    is_cerebras_gpt_oss = (
        "cerebras.ai" in target.base_url and "gpt-oss" in target.model.lower()
    )
    # Groq gpt-oss also wants max_completion_tokens (same family as Cerebras gpt-oss).
    is_gpt_oss = "gpt-oss" in target.model.lower()
    # Nemotron (any provider): append /no_think so reasoning does not eat max_tokens.
    msgs = messages_for_model(target.model, msgs)

    if is_anthropic:
        url = f"{target.base_url.rstrip('/')}/messages"
        system_msg = next((m for m in msgs if m.get("role") == "system"), None)
        user_msgs = [m for m in msgs if m.get("role") != "system"]
        body: dict[str, Any] = {
            "model": target.model,
            "messages": user_msgs,
            "max_tokens": target.max_tokens,
            "temperature": 0,
        }
        if system_msg and system_msg.get("content"):
            body["system"] = system_msg["content"]
        headers = {
            "x-api-key": target.key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
            "User-Agent": "agent-reviewer-gate/1.0 (+local)",
        }
    elif is_cohere_v2:
        url = f"{target.base_url.rstrip('/')}/chat"
        body = {
            "model": target.model,
            "messages": msgs,
            "temperature": 0,
            "max_tokens": target.max_tokens,
        }
        if target.thinking_budget is not None:
            body["thinking"] = {
                "type": "enabled",
                "token_budget": int(target.thinking_budget),
            }
        headers = {
            "Authorization": f"Bearer {target.key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "agent-reviewer-gate/1.0 (+local)",
        }
    else:
        url = f"{target.base_url.rstrip('/')}/chat/completions"
        body = {
            "model": target.model,
            "messages": msgs,
            "temperature": 0,
            "max_tokens": target.max_tokens,
        }
        # Groq + gpt-oss prefer max_completion_tokens.
        if is_groq or is_cerebras_gpt_oss or is_gpt_oss:
            body["max_completion_tokens"] = target.max_tokens
            if is_cerebras_gpt_oss or (is_groq and is_gpt_oss):
                body.pop("max_tokens", None)
        if target.reasoning_effort:
            body["reasoning_effort"] = target.reasoning_effort
        if (
            target.reasoning_max_tokens
            and target.reasoning_max_tokens > 0
            and not is_groq
        ):
            body["reasoning"] = {"max_tokens": int(target.reasoning_max_tokens)}
        if target.json_object:
            body["response_format"] = {"type": "json_object"}
        think_kw = nemotron_disable_thinking_kwargs(target.model)
        if think_kw:
            body["chat_template_kwargs"] = think_kw
        headers = {
            "Authorization": f"Bearer {target.key}",
            "Content-Type": "application/json",
            "User-Agent": "agent-reviewer-gate/1.0 (+local)",
            "Accept": "application/json",
        }

    if target.headers:
        headers.update(target.headers)

    last: dict[str, Any] | None = None
    for attempt in range(max_attempts):
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers=headers,
        )
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=target.timeout) as r:
                data = json.loads(r.read())
            ms = int((time.time() - t0) * 1000)
            text = extract_text(data)
            usage = data.get("usage") or {}
            # finish reason: Anthropic stop_reason, OpenAI choices[0].finish_reason; Cohere v2 top-level
            if is_anthropic:
                finish = data.get("stop_reason") or ""
            elif is_cohere_v2:
                finish = (
                    data.get("finish_reason")
                    or (data.get("message") or {}).get("finish_reason")
                    or ""
                )
            else:
                ch = (data.get("choices") or [{}])[0]
                finish = ch.get("finish_reason", "") or ""
            d, reason, method = parse(text)
            # Cohere v2 usage keys differ slightly
            ptok = usage.get("prompt_tokens") or usage.get("input_tokens")
            ctok = usage.get("completion_tokens") or usage.get("output_tokens")
            ttok = usage.get("total_tokens")
            if ttok is None and ptok is not None and ctok is not None:
                ttok = ptok + ctok
            rtok = None
            details = usage.get("completion_tokens_details") or usage.get("tokens") or {}
            if isinstance(details, dict):
                rtok = details.get("reasoning_tokens") or details.get("thinking_tokens")
            result = {
                "decision": d, "reason": reason, "method": method,
                "ms": ms, "text": text, "finish": finish,
                "prompt_tokens": ptok,
                "completion_tokens": ctok,
                "total_tokens": ttok,
                "reasoning_tokens": rtok,
            }
            # Treat truncated / unparsable responses as soft failures → retry.
            soft_fail = (
                d is None
                or (isinstance(finish, str) and finish.lower() == "length")
            )
            if soft_fail and attempt < max_attempts - 1:
                wait = _retry_sleep_s
                print(
                    f"    [{target.label}] retry {wait:g}s "
                    f"(attempt {attempt + 1}/{max_attempts} "
                    f"unparsed/finish={finish or '?'} ctok={ctok})",
                    flush=True,
                )
                time.sleep(wait)
                last = {**result, "error": f"soft_fail finish={finish} decision={d}"}
                continue
            return result
        except urllib.error.HTTPError as e:
            body_txt = e.read().decode()[:300]
            last = {
                "error": f"HTTP {e.code}: {body_txt}",
                "ms": int((time.time() - t0) * 1000),
            }
            # Retry on rate-limit / overload / 502 gateway flakes.
            if e.code in (429, 502, 503, 529) and attempt < max_attempts - 1:
                wait = _retry_sleep_s
                print(
                    f"    [{target.label}] retry {wait:g}s "
                    f"(attempt {attempt + 1}/{max_attempts} {e.code}) "
                    f"{body_txt[:80]!r}",
                    flush=True,
                )
                time.sleep(wait)
                continue
            return last
        except Exception as e:
            err_s = f"{type(e).__name__}: {e}"[:200]
            last = {
                "error": err_s,
                "ms": int((time.time() - t0) * 1000),
            }
            # Timeouts / network: same retry budget as other errors (max-retries).
            if attempt < max_attempts - 1:
                wait = _retry_sleep_s
                print(
                    f"    [{target.label}] retry {wait:g}s "
                    f"(attempt {attempt + 1}/{max_attempts} {err_s[:100]})",
                    flush=True,
                )
                time.sleep(wait)
                continue
            return last
    return last or {"error": "unknown", "ms": 0}


def result_entry(label: str, gold: str, r: dict[str, Any]) -> dict[str, Any]:
    if "error" in r and r.get("decision") is None and not r.get("method"):
        decision = "error"
        reason = r["error"]
        method = "error"
    else:
        decision = r.get("decision")
        reason = r.get("reason")
        method = r.get("method")
        if "error" in r and decision is None:
            decision = "error"
            reason = r["error"]
            method = "error"
    match = decision == gold
    fa = decision == "approve" and gold == "escalate"
    fe = decision == "escalate" and gold == "approve"
    return {
        "label": label, "gold": gold, "decision": decision,
        "reason": (reason or "")[:120], "method": method,
        "ms": r.get("ms", 0), "match": match, "fa": fa, "fe": fe,
        "error": r.get("error"), "finish": r.get("finish"),
        "text": (r.get("text") or "")[:300],
        "prompt_tokens": r.get("prompt_tokens"),
        "completion_tokens": r.get("completion_tokens"),
        "total_tokens": r.get("total_tokens"),
        "reasoning_tokens": r.get("reasoning_tokens"),
    }


def status_tag(entry: dict[str, Any]) -> str:
    if entry.get("error") and entry.get("decision") == "error":
        return "ERR"
    if entry["match"]:
        return "OK "
    if entry["fa"]:
        return "FA!"
    if entry["fe"]:
        return "FE!"
    return "MIS"


def score_block(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    correct = sum(1 for r in results if r["match"])
    fa_n = sum(1 for r in results if r["fa"])
    fe_n = sum(1 for r in results if r["fe"])
    valid = [r for r in results if r.get("decision") != "error" and not (
        r.get("error") and r.get("decision") == "error"
    )]
    # treat explicit error decision as invalid
    valid = [r for r in results if r.get("decision") in ("approve", "escalate")]
    avg_ms = sum(r["ms"] for r in valid) / len(valid) if valid else 0
    json_n = sum(1 for r in valid if r["method"] == "json")
    ctoks = [r["completion_tokens"] for r in valid if r["completion_tokens"] is not None]
    ptoks = [r["prompt_tokens"] for r in valid if r["prompt_tokens"] is not None]
    avg_ctok = sum(ctoks) / len(ctoks) if ctoks else 0
    avg_ptok = sum(ptoks) / len(ptoks) if ptoks else 0
    finish_len = sum(1 for r in valid if r.get("finish") == "length")
    err_n = sum(1 for r in results if r.get("decision") == "error" or (
        r.get("error") and r.get("decision") not in ("approve", "escalate")
    ))
    return {
        "total": total,
        "correct": correct,
        "fa": fa_n,
        "fe": fe_n,
        "errors": err_n,
        "avg_ms": round(avg_ms),
        "json": f"{json_n}/{len(valid)}" if valid else "0/0",
        "json_n": json_n,
        "valid_n": len(valid),
        "finish_length": finish_len,
        "avg_prompt_tokens": round(avg_ptok),
        "avg_completion_tokens": round(avg_ctok, 1),
        "min_completion_tokens": min(ctoks) if ctoks else 0,
        "max_completion_tokens": max(ctoks) if ctoks else 0,
    }


def print_score(prefix: str, s: dict[str, Any]) -> None:
    print(
        f"{prefix}SCORE {s['correct']}/{s['total']}  FA={s['fa']}  FE={s['fe']}  "
        f"ERR={s['errors']}  avg={s['avg_ms']}ms  JSON={s['json']}  "
        f"finish=length:{s['finish_length']}",
        flush=True,
    )
    print(
        f"{prefix}TOKENS: prompt avg={s['avg_prompt_tokens']}  "
        f"completion avg={s['avg_completion_tokens']}  "
        f"(min={s['min_completion_tokens']} max={s['max_completion_tokens']})",
        flush=True,
    )


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

def build_user_msg(permission: str, patterns: list[str] | None = None,
                   command: str | None = None) -> str:
    parts = [f"permission: {permission}"]
    if patterns:
        parts.append(f"patterns: {json.dumps(patterns)}")
    if command is not None:
        parts.append(f"command: {command}")
    return "\n".join(parts)


def load_balanced18() -> list[tuple[str, str, str]]:
    p = BALANCED18_GOLD
    if not p.exists():
        sys.exit(f"balanced18 requested but {p.name} not found")
    data = json.loads(p.read_text())
    cases = []
    for c in data:
        uc = build_user_msg(
            c["permission"],
            patterns=c.get("patterns"),
            command=c.get("command"),
        )
        label = c.get("name") or c.get("id") or "case"
        cases.append((label, c["gold"], uc))
    return cases


def load_hard10() -> list[tuple[str, str, str]]:
    p = HARD10_GOLD
    if not p.exists():
        p = Path("/tmp/gate_gemma_hard10.json")
    if not p.exists():
        return []
    data = json.loads(p.read_text())
    cases = []
    for c in data:
        patterns = c.get("patterns", [])
        uc = build_user_msg(c["permission"], patterns=patterns)
        cases.append((f"REAL #{c['n']}", c["gold"], uc))
    return cases


def load_extended() -> list[tuple[str, str, str]]:
    p = EXTENDED_GOLD
    if not p.exists():
        sys.exit(f"extended requested but {p.name} not found")
    data = json.loads(p.read_text())
    cases = []
    for c in data:
        uc = build_user_msg(
            c["permission"],
            patterns=c.get("patterns"),
            command=c.get("command"),
        )
        cases.append((f"{c['id']}:{c['category']}", c["gold"], uc))
    return cases


def select_cases(suite: str) -> list[tuple[str, str, str]]:
    cases: list[tuple[str, str, str]] = []
    if suite == "balanced18":
        cases.extend(load_balanced18())
    elif suite == "hard10":
        h10 = load_hard10()
        if not h10:
            sys.exit("hard10 requested but gate_hard10_gold.json not found")
        cases.extend(h10)
    elif suite == "extended":
        cases.extend(load_extended())
    elif suite == "all":
        cases.extend(load_extended())
        h10 = load_hard10()
        if h10:
            cases.extend(h10)
        cases.extend(load_balanced18())
    else:
        sys.exit(f"unknown suite {suite}")
    return cases


def find_start_case_index(cases: list[tuple[int, str, str, str]], spec: str) -> int:
    """Find 0-based index in cases list matching spec (1-based case number or ID/label substring)."""
    s = spec.strip()
    if not s:
        return 0

    # 1. Exact match on full label, ID prefix (before ':'), or case-insensitive ID match
    for idx, (_, label, _, _) in enumerate(cases):
        case_id = label.split(":")[0].strip()
        if s == label or s == case_id:
            return idx
        if s.lower() == label.lower() or s.lower() == case_id.lower():
            return idx

    # 2. Match by original 1-based case number (e.g. '66', '066') or 1-based index
    if s.isdigit():
        val = int(s)
        # Check matching original case number
        for idx, (num, _, _, _) in enumerate(cases):
            if num == val:
                return idx
        # Check 1-based position in filtered list
        if 1 <= val <= len(cases):
            return val - 1
        sys.exit(
            f"--from-case index {val} not found in available cases (valid range: 1..{len(cases)})."
        )

    # 3. Prefix or substring match on label or ID
    for idx, (_, label, _, _) in enumerate(cases):
        if label.lower().startswith(s.lower()):
            return idx
    for idx, (_, label, _, _) in enumerate(cases):
        if s.lower() in label.lower():
            return idx

    sample = ", ".join(c[1].split(":")[0] for c in cases[:5])
    sys.exit(
        f"--from-case '{spec}' not found in loaded cases.\n"
        f"Provide a 1-based number or case ID (e.g. {sample})."
    )


# ---------------------------------------------------------------------------
# Multi-model runner: fan-out per case, barrier, next case
# ---------------------------------------------------------------------------

def run_multi(
    targets: list[ModelTarget],
    system_prompt: str,
    cases: list[tuple[int, str, str, str]],
    suite_name: str,
    total_cases: int | None = None,
) -> dict[str, Any]:
    """
    For each case:
      1. Fire concurrent requests to ALL targets
      2. Wait until every target responds (barrier)
      3. Record + print, then advance to next case
    """
    n_models = len(targets)
    n_cases = len(cases)
    n_total = total_cases if total_cases is not None else n_cases
    print(f"\n{'=' * 78}", flush=True)
    if n_cases < n_total:
        print(
            f"MULTI-MODEL gate-suite [{suite_name}] | models={n_models} | cases={n_cases} of {n_total} (start at #{cases[0][0]})",
            flush=True,
        )
    else:
        print(
            f"MULTI-MODEL gate-suite [{suite_name}] | models={n_models} | cases={n_cases}",
            flush=True,
        )
    print(
        "  mode: per-case fan-out → all models parallel → barrier → next case",
        flush=True,
    )
    for t in targets:
        extra = ""
        if t.api_format == "cohere-v2":
            extra = f" format=cohere-v2 thinking_budget={t.thinking_budget}"
        elif t.reasoning_max_tokens:
            extra = f" reasoning.max_tokens={t.reasoning_max_tokens}"
        if t.reasoning_effort:
            extra += f" reasoning_effort={t.reasoning_effort}"
        print(
            f"  • {t.label}  max_tokens={t.max_tokens} timeout={t.timeout}s "
            f"sleep={t.sleep}s{extra}",
            flush=True,
        )
    print(f"{'=' * 78}", flush=True)

    # per-model ordered results
    by_model: dict[str, list[dict[str, Any]]] = {t.label: [] for t in targets}
    case_rows: list[dict[str, Any]] = []

    # Thread pool sized to number of models (one worker per model per case)
    with ThreadPoolExecutor(max_workers=max(1, n_models), thread_name_prefix="gate") as pool:
        for step_i, (case_num, label, gold, uc) in enumerate(cases, 1):
            msgs = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": uc},
            ]
            print(f"\n  [{case_num:03d}/{n_total:03d}] {label}  gold={gold}", flush=True)

            # --- fan-out: submit all models at once ---
            futures = {
                pool.submit(call_model, t, msgs): t for t in targets
            }

            # --- barrier: collect every future before next case ---
            raw_by_label: dict[str, dict[str, Any]] = {}
            for fut in as_completed(futures):
                t = futures[fut]
                try:
                    raw = fut.result()
                except Exception as e:
                    raw = {"error": f"future: {e}"[:200], "ms": 0}
                raw_by_label[t.label] = raw

            # ensure every target present (defensive)
            for t in targets:
                if t.label not in raw_by_label:
                    raw_by_label[t.label] = {"error": "missing future result", "ms": 0}

            case_by_model: dict[str, dict[str, Any]] = {}
            for t in targets:
                entry = result_entry(label, gold, raw_by_label[t.label])
                by_model[t.label].append(entry)
                case_by_model[t.label] = entry
                st = status_tag(entry)
                ctok = entry.get("completion_tokens")
                tok_str = f"ctok={ctok}" if ctok is not None else "ctok=?"
                reason = (entry.get("reason") or "")[:40]
                print(
                    f"    {st} {t.label:36s} got={str(entry['decision']):8s} "
                    f"{tok_str:12s} {entry['ms']:5d}ms  {reason}",
                    flush=True,
                )

            case_rows.append({
                "n": case_num,
                "label": label,
                "gold": gold,
                "by_model": case_by_model,
            })

            # post-case sleep: use the max configured sleep among targets
            # (rate-limit fairness — still one sleep after the barrier)
            sleep_s = max((t.sleep for t in targets), default=0.0)
            if sleep_s > 0 and step_i < n_cases:
                time.sleep(sleep_s)

    # --- scoreboard ---
    scores: dict[str, dict[str, Any]] = {}
    print(f"\n{'=' * 78}", flush=True)
    print("SCOREBOARD", flush=True)
    print(f"{'=' * 78}", flush=True)
    for t in targets:
        s = score_block(by_model[t.label])
        scores[t.label] = s
        print(f"\n  {t.label}", flush=True)
        print_score("    ", s)

    # disagreement summary: cases where models split approve/escalate
    disagreements = []
    for row in case_rows:
        decisions = {
            m: e["decision"]
            for m, e in row["by_model"].items()
            if e["decision"] in ("approve", "escalate")
        }
        if len(set(decisions.values())) > 1:
            disagreements.append({
                "label": row["label"],
                "gold": row["gold"],
                "decisions": decisions,
            })
    if disagreements:
        print(f"\n  DISAGREEMENTS ({len(disagreements)} cases where models split):", flush=True)
        for d in disagreements[:30]:
            parts = " | ".join(f"{m.split('/')[0]}={dec}" for m, dec in d["decisions"].items())
            print(f"    {d['label']:40s} gold={d['gold']:8s}  {parts}", flush=True)
        if len(disagreements) > 30:
            print(f"    ... +{len(disagreements) - 30} more", flush=True)

    return {
        "suite": suite_name,
        "mode": "multi-model-per-case-parallel",
        "models": [t.label for t in targets],
        "n_cases": n_cases,
        "scores": scores,
        "disagreements": disagreements,
        "cases": case_rows,
        "by_model": by_model,
    }


def run_single(
    target: ModelTarget,
    system_prompt: str,
    cases: list[tuple[int, str, str, str]],
    suite_name: str,
    total_cases: int | None = None,
) -> list[dict[str, Any]]:
    """Single-model sequential path (same barrier semantics with n=1)."""
    out = run_multi([target], system_prompt, cases, suite_name, total_cases=total_cases)
    return out["by_model"][target.label]


# ---------------------------------------------------------------------------
# Target construction from CLI / config
# ---------------------------------------------------------------------------

def build_target(
    provider: str,
    model_override: str | None,
    max_tokens_override: int | None,
    timeout_override: int | None,
    sleep: float,
    reasoning_effort: str | None,
    reasoning_max_tokens_override: int | None,
    key_override: str | None,
) -> ModelTarget:
    tier = _providers.get(provider)
    if not tier:
        sys.exit(f"unknown provider '{provider}'; known: {sorted(_providers)}")
    base_url = tier.get("baseURL") or ""
    if not base_url:
        sys.exit(f"no baseURL for provider '{provider}'")
    model = model_override or tier.get("model")
    if not model:
        sys.exit(f"no model for provider '{provider}' (pass --model or set in config)")
    max_tokens = max_tokens_override or tier.get("maxTokens") or 512
    timeout_ms = tier.get("timeoutMs") or 8000
    timeout = timeout_override if timeout_override is not None else max(1, int(timeout_ms) // 1000)
    api_format = tier.get("apiFormat") or "openai"
    thinking_budget = tier.get("thinkingBudget")
    if thinking_budget is not None:
        thinking_budget = int(thinking_budget)
    json_object = bool(tier.get("jsonObject") or False)
    # CLI --reasoning-effort overrides tier config; else use tier.reasoning_effort / reasoningEffort.
    reff = reasoning_effort
    if not reff:
        reff = tier.get("reasoning_effort") or tier.get("reasoningEffort") or None
        if reff is not None:
            reff = str(reff)
    rmt = reasoning_max_tokens_override
    if rmt is None:
        rmt = tier.get("reasoningMaxTokens")
        if rmt is None:
            nested = tier.get("reasoning")
            if isinstance(nested, dict):
                rmt = nested.get("max_tokens")
            else:
                rmt = tier.get("reasoning_max_tokens")
    if rmt is not None:
        rmt = int(rmt)
        if rmt <= 0:
            rmt = None
    headers = tier.get("headers")
    if not isinstance(headers, dict):
        headers = None
    return ModelTarget(
        name=provider,
        model=model,
        base_url=base_url,
        key=get_key(provider, key_override),
        max_tokens=int(max_tokens),
        timeout=int(timeout),
        api_format=api_format,
        thinking_budget=thinking_budget,
        reasoning_effort=reff,
        reasoning_max_tokens=rmt,
        sleep=float(sleep),
        json_object=json_object,
        headers=headers,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

class HelpFormatter(argparse.ArgumentDefaultsHelpFormatter, argparse.RawDescriptionHelpFormatter):
    pass


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Unified agent-reviewer gate-suite (multi-model per-case parallel)",
        formatter_class=HelpFormatter,
        epilog="""
Multi-model semantics:
  Each case is sent asynchronously to all selected models at once.
  The runner waits for ALL models to respond before starting the next case.

Examples:
  %(prog)s --list
  %(prog)s --providers 1 --suite hard10
  %(prog)s --providers 1,3,5 --suite extended
  %(prog)s --providers 1-3 --suite hard10
  %(prog)s --providers groq-qwen36-27b,together-bonsai-27b --suite balanced18
  %(prog)s --all-providers --suite hard10
  %(prog)s --providers 1 --suite balanced18 --sleep 0
  %(prog)s --providers 1 --from-case 45
  %(prog)s --providers 1 --from-case dp-07
  %(prog)s --providers 1 --log /tmp/my_test.log
  %(prog)s --providers 1 --overwrite
  %(prog)s --providers 1 --append
""",
    )
    g = ap.add_mutually_exclusive_group(required=False)
    g.add_argument("--list-providers", "--list", action="store_true", default=False,
                   help="list all available providers with 1-based numbers and exit")
    g.add_argument("--providers", default=None,
                   help="comma-separated provider names, 1-based numbers, or ranges (e.g. '1,3', '1-4', 'groq-qwen36-27b')")
    g.add_argument("--all-providers", action="store_true", default=False,
                   help="run all enabled tiers from config order")

    ap.add_argument("--model", default=None,
                    help="model id override (valid when a single provider is selected; multi uses config models)")
    ap.add_argument("--suite", default="extended",
                    choices=["extended", "balanced18", "hard10", "all"],
                    help="test suite: extended (108 categorized), balanced18, hard10, all")
    ap.add_argument("--max-tokens", type=int, default=None,
                    help="override max_tokens for all targets (default: per-tier config)")
    ap.add_argument("--timeout", type=int, default=None,
                    help="override timeout seconds for all targets (default: per-tier config)")
    ap.add_argument("--sleep", type=float, default=DEFAULT_CASE_SLEEP_S,
                    help="seconds after each case barrier for ALL models (use 0 to disable)")
    ap.add_argument("--reasoning-effort", default=None,
                    help="reasoning_effort param for OpenAI-compatible targets")
    ap.add_argument("--reasoning-max-tokens", type=int, default=None,
                    help="OpenRouter-style reasoning.max_tokens CoT budget "
                         "(overrides tier reasoning.max_tokens / reasoningMaxTokens)")
    ap.add_argument("--key", default=None,
                    help="explicit API key (valid when a single provider is selected)")
    ap.add_argument("--exclude", default=None,
                    help="comma-separated provider names or numbers to skip (with --all-providers)")
    ap.add_argument("--limit", type=int, default=None,
                    help="run only first N cases of the selected suite (smoke)")
    ap.add_argument("--filter-labels", default=None,
                    help="comma-separated case labels to keep (exact match), "
                         "or path to a text file with one label per line")
    ap.add_argument("--retry-sleep", type=float, default=DEFAULT_RETRY_SLEEP_S,
                    help="seconds to wait before retrying after timeout/HTTP error")
    ap.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES,
                    help="max retries per case after first attempt (total attempts = 1 + this)")
    ap.add_argument("--config", default=None,
                    help="path to alternate agent-reviewer.json (override default config path)")
    ap.add_argument("--cases", default=None,
                    help="comma-separated case IDs to run (e.g., 'dp-07,di-01,si-01')")
    ap.add_argument("--from-case", "--start-from", "--start-case", default=None,
                    help="start testing from a specific case (1-based number e.g. '45' or case ID e.g. 'dp-07')")
    ap.add_argument("--log", default="/tmp/gate-unified.log",
                    help="path to log file (default: /tmp/gate-unified.log; use --no-log to disable)")
    ap.add_argument("--no-log", action="store_true", default=False,
                    help="disable logging to file")
    ap.add_argument("--overwrite", action="store_true", default=False,
                    help="overwrite existing log file without interactive prompt")
    ap.add_argument("--append", action="store_true", default=False,
                    help="append to existing log file without interactive prompt")
    args = ap.parse_args()

    # Override config path if --config given
    if args.config:
        global _cfg_path
        _cfg_path = Path(args.config)
        if not _cfg_path.is_file():
            sys.exit(f"--config path not found: {_cfg_path}")

    if args.list_providers:
        load_providers()
        print_providers_list()
        return

    if not args.providers and not args.all_providers:
        ap.error("one of the arguments --providers, --all-providers, or --list is required")

    log_fp = None
    if not args.no_log and args.log and args.log.lower() not in ("none", "off", "no", "false", ""):
        log_fp = setup_log_file(args.log, overwrite=args.overwrite, append=args.append)
        sys.stdout = TeeStream(sys.stdout, log_fp)
        sys.stderr = TeeStream(sys.stderr, log_fp)

    if args.config:
        print(f"using config: {_cfg_path}", flush=True)

    load_providers()

    global _retry_sleep_s, _max_retries
    if args.retry_sleep < 0:
        sys.exit("--retry-sleep must be >= 0")
    _retry_sleep_s = float(args.retry_sleep)
    if args.max_retries < 0:
        sys.exit("--max-retries must be >= 0")
    _max_retries = int(args.max_retries)
    print(f"retry: sleep={_retry_sleep_s:g}s max_retries={_max_retries} "
          f"(max attempts/case={1 + _max_retries})", flush=True)

    sp = extract_system_prompt()
    print(f"SYSTEM_PROMPT: {len(sp)} chars", flush=True)

    # resolve provider list
    if args.providers:
        names = resolve_provider_names(args.providers)
    else:
        # --all-providers: only tiers listed in config.order (enabled chain)
        names = list(_order) if _order else list(_providers.keys())
        if args.exclude:
            skip_names = set(resolve_provider_names(args.exclude))
            names = [n for n in names if n not in skip_names]

    if not names:
        sys.exit("no providers selected")

    is_single = len(names) == 1
    if args.model and not is_single:
        print("note: --model ignored in multi-provider mode (using config models)",
              flush=True)
    if args.key and not is_single:
        sys.exit("--key only valid when a single provider is selected")

    targets = [
        build_target(
            provider=n,
            model_override=args.model if is_single else None,
            max_tokens_override=args.max_tokens,
            timeout_override=args.timeout,
            sleep=args.sleep,
            reasoning_effort=args.reasoning_effort,
            reasoning_max_tokens_override=args.reasoning_max_tokens,
            key_override=args.key if is_single else None,
        )
        for n in names
    ]

    print(f"targets: {', '.join(t.label for t in targets)}", flush=True)
    print(f"suite={args.suite}  sleep_after_case={args.sleep}s", flush=True)

    cases_raw = select_cases(args.suite)
    total_suite_cases = len(cases_raw)
    cases: list[tuple[int, str, str, str]] = [
        (i, label, gold, uc) for i, (label, gold, uc) in enumerate(cases_raw, 1)
    ]

    # Filter by --cases if given (comma-separated IDs)
    if args.cases:
        case_ids = {c.strip() for c in args.cases.split(",") if c.strip()}
        print(f"--cases filter: {len(case_ids)} IDs", flush=True)
        before = len(cases)
        # Match by prefix (case ID format is 'id:category', user may pass just 'id')
        cases = [c for c in cases if c[1].split(":")[0] in case_ids or c[1] in case_ids]
        matched_ids = {c[1].split(":")[0] for c in cases}
        missing = case_ids - matched_ids
        if missing:
            sys.exit(f"--cases IDs not found in suite: {sorted(missing)}")
        print(f"--cases kept {len(cases)}/{before} cases", flush=True)
        if not cases:
            sys.exit("no cases matched --cases filter")

    if args.filter_labels:
        raw = args.filter_labels.strip()
        if Path(raw).is_file():
            keep = {
                ln.strip()
                for ln in Path(raw).read_text().splitlines()
                if ln.strip() and not ln.strip().startswith("#")
            }
            print(f"filter-labels from file: {raw} ({len(keep)} labels)", flush=True)
        else:
            keep = {x.strip() for x in raw.split(",") if x.strip()}
            print(f"filter-labels: {len(keep)} labels", flush=True)
        before = len(cases)
        cases = [c for c in cases if c[1] in keep]
        missing = keep - {c[1] for c in cases}
        if missing:
            print(f"note: {len(missing)} filter labels not found in suite "
                  f"(e.g. {sorted(missing)[:3]})", flush=True)
        print(f"filter-labels kept {len(cases)}/{before} cases", flush=True)
        if not cases:
            sys.exit("no cases left after --filter-labels")

    if args.from_case:
        start_idx = find_start_case_index(cases, args.from_case)
        start_num = cases[start_idx][0]
        start_label = cases[start_idx][1]
        cases = cases[start_idx:]
        print(f"--from-case: starting from #{start_num}/{total_suite_cases} ({start_label}), {len(cases)} remaining", flush=True)

    if args.limit is not None:
        if args.limit < 1:
            sys.exit("--limit must be >= 1")
        cases = cases[: args.limit]
    print(f"cases loaded: {len(cases)}"
          + (f" of {total_suite_cases}" if len(cases) < total_suite_cases else "")
          + (f" (limit={args.limit})" if args.limit else ""), flush=True)

    payload = run_multi(targets, sp, cases, args.suite, total_cases=total_suite_cases)

    # output path
    ts = time.strftime("%Y%m%d_%H%M%S")
    if len(targets) == 1:
        t = targets[0]
        safe = t.model.replace("/", "-").replace(":", "-")
        out = Path(f"/tmp/gate_unified_{t.name}_{safe}_{args.suite}_{ts}.json")
        # keep single-model flat list for backward compat
        out.write_text(json.dumps(payload["by_model"][t.label], indent=2))
        print(f"\nSaved: {out}", flush=True)
    else:
        # Multi-model: write per-model reports + aggregate summary
        out_files = []
        for t in targets:
            safe = t.model.replace("/", "-").replace(":", "-")
            out = Path(f"/tmp/gate_unified_{t.name}_{safe}_{args.suite}_{ts}.json")
            out.write_text(json.dumps(payload["by_model"][t.label], indent=2))
            out_files.append(out)
            print(f"Saved: {out}", flush=True)
        
        # Aggregate summary: scoreboard + disagreements only (no full case data)
        summary = {
            "suite": payload["suite"],
            "mode": payload["mode"],
            "models": payload["models"],
            "n_cases": payload["n_cases"],
            "scores": payload["scores"],
            "disagreements": payload["disagreements"],
        }
        summary_out = Path(f"/tmp/gate_unified_multi_summary_{args.suite}_{ts}.json")
        summary_out.write_text(json.dumps(summary, indent=2))
        print(f"Saved aggregate summary: {summary_out}", flush=True)
    if log_fp:
        try:
            log_fp.flush()
            log_fp.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
