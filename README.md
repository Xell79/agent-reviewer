# agent-reviewer

Pre-auto-approve safety gate for Kilo.
When a mutating tool (`bash`, `edit`, `write`, `apply_patch`) would normally ask
you for permission, this plugin first asks a **chain of small LLM reviewers**.
If the first reachable tier says **approve**, Kilo continues without a click.
If it says **escalate**, a TUI overlay shows the **reason**;
**Permit / Reject** stay on the native permission prompt.
If a tier is down / times out / returns garbage, the next tier is tried.
If **all** tiers fail operationally, the request is left for the human
(**fail-closed**).

| | |
|---|---|
| **Plugin (server)** | `~/.config/kilo/plugin/agent-reviewer.ts` |
| **Plugin (TUI)** | `~/.config/kilo/tui/agent-reviewer-tui.tsx` via `tui.jsonc` `plugin` array |
| **Config** | `~/.config/kilo/agent-reviewer.json` (keys, tiers, models, cooldown) |
| **Config example** | [`agent-reviewer.json.example`](./agent-reviewer.json.example) — same schema, keys as `{PROVIDER_KEY}` |
| **Load** | Server: auto-scanned from `plugin/*.{ts,js}`. TUI: `tui.jsonc` (do **not** drop the TUI file in `plugin/` — auto-scan would treat it as a server plugin). |
| **Reload** | Restart Kilo after `.ts` / `tui.jsonc` edits. JSON (`agent-reviewer.json`) is hot-reloaded. |
| **UI note** | Approve still shows **«approved by you»**. While reviewing: overlay `Gate reviewing · <tier>`. Escalate: `Gate escalate · <tier>` + reason; native **Permit / Reject**. |

For agent-oriented technical reference (hooks, schemas, edit constraints), see **[AGENTS.md](./AGENTS.md)**.

---

## What it does

1. Kilo raises `permission.asked` (any tool still in `ask`). The gate runs
   unless the name is in `skip`.
2. Plugin builds a short user message (permission name, patterns,
   command, tool args when available).
3. Sends that + a fixed system prompt to tier **#1** (`order[0]`;
   currently Ollama Cloud `gemma4:31b`).
4. Model must answer with JSON:

   ```json
   {"decision":"approve"|"escalate","reason":"<short English>"}
   ```

5. **First definitive answer wins:**
    - `approve` → plugin replies `once` on the permission → tool runs.
    - `escalate` → leave the native permission prompt; TUI overlay
      title is `Gate escalate · <tier>` (e.g. `ollama-gemma4-31b`),
      body is the reviewer **reason**. IPC:
      `~/.local/share/kilo/log/agent-reviewer/pending/<sessionID>.json`
      (this session only; cleared when you Permit/Reject).
      While the LLM chain runs, the same overlay shows
      `Gate reviewing · <tier>` immediately (placeholder reason
      `gate reviewing…`), then updates on escalate or vanishes on approve.
6. A tier is **skipped** only on **operational** failure (HTTP error,
   timeout/abort, empty body, unparsable text that the fail-closed heuristic
   cannot rescue, missing API key).
   After such a failure the tier is put on a **30-minute cooldown**
   (`TIER_COOLDOWN_MS`): further `permission.asked` events skip it until the
   timer expires (or Kilo restarts). This avoids hammering a 429/down provider
   on every tool call.
   **Escalate does not fall through** — a cautious primary model will never be
   “overruled” by a weaker fallback that might false-approve.
   Approve/escalate do **not** start a cooldown.

Chain accuracy for a given request = accuracy of the **first reachable** tier.
Extra tiers buy **resilience**, not a second vote.

---

## Current tier chain (2026-08-19)

| # | Name | Endpoint | Model | `max_tokens` | `json_object` | Timeout | Role |
|---|------|----------|-------|--------------|---------------|---------|------|
| 1 | `ollama-gemma4-31b` | `https://ollama.com/v1` | `gemma4:31b` | 512 | off | 8s | **Primary** (extended **97/98**, FA0) |
| 2 | `groq-qwen36-27b` | `https://api.groq.com/openai/v1` | `qwen/qwen3.6-27b` | 512 | off | 8s | Fallback; `reasoning_effort: none` (95/98 stitched) |
| 3 | `kilo-gateway` | `https://app.kilo.ai/api/gateway/v1` | `poolside/laguna-s-2.1:free` | 512 | off | 8s | Free gateway (93/98 merged) |
| 4 | `mistral-codestral` | `https://api.mistral.ai/v1` | `codestral-2508` | 256 | off | 8s | 92/98 |
| 5 | `together-bonsai-27b` | `https://api.together.ai/v1` | `Prism-ML/Ternary-Bonsai-27B` | 512 | **on** | 8s | Thinking off via `jsonObject` (~1s) |
| 6 | `mistral-ministral-8b` | `https://api.mistral.ai/v1` | `ministral-8b-2512` | 256 | off | 8s | 88/98 |
| 7 | `groq-gpt-oss-20b` | `https://api.groq.com/openai/v1` | `openai/gpt-oss-20b` | 256 | off | 8s | `reasoning_effort: low` (88/98) |
| 8 | `cohere` | `https://api.cohere.com/v2` | `command-a-plus-05-2026` | 512 | off | 8s | Native `apiFormat: cohere-v2` + thinking budget 50 (84/98) |
| 9 | `xiaomi-mimo` | `https://token-plan-sgp.xiaomimimo.com/v1` | `mimo-v2.5` | 256 | **on** | 30s | Last fallback (71/98 merged) |

All of the above live in **`~/.config/kilo/agent-reviewer.json`**
(not in plugin source).

Hot-reload: JSON is re-read on each `permission.asked` (mtime) —
**no Kilo restart** for config edits. Plugin `.ts` still needs a
restart.

Path override: env `AGENT_REVIEWER_CONFIG=/path/to.json`. Default
`~/.config/kilo/agent-reviewer.json`. Mode `600` recommended.

### `agent-reviewer.json` — root fields

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `order` | `string[]` | `[]` | **Live chain.** Names of enabled tiers, first = primary. Names not listed stay in `tiers` but are **not** called. Empty/missing → no active tiers → fail-closed. Unknown names are skipped (`config.order_unknown`). |
| `tiers` | `object` (map) or legacy `array` | `{}` | Model **defs** keyed by name. Presence here does **not** enable a tier — only `order` does. |
| `skip` | `string[]` | `[]` | Tool names the gate **ignores**. Empty = review every `permission.asked`. Kilo never emits that event for tools already `allow` in `kilo.jsonc`. |
| `cache` | `boolean` | `true` | Hash-cache of identical parsed decisions. Approve → auto-reply; escalate → leave for human. Operational failures are **not** cached. |
| `tierCooldownMs` | `number` (ms) | `1800000` (30 min) | After an **operational** throw (HTTP/timeout/empty/unparseable/missing key), skip that tier until `now + cooldown`. In-memory; cleared on Kilo restart. Approve/escalate do **not** start a cooldown. `0`/missing → default 30m. |
| `systemPrompt` | `string` | built-in `DEFAULT_SYSTEM_PROMPT` | Gate policy. Empty/missing → plugin fallback. Prefer editing here (hot-reloaded). |

Unknown extra keys at root are ignored (`[key: string]: unknown`).

### `tiers.<name>` — per-tier fields

| Field | Type | Required | Default | Meaning |
|-------|------|----------|---------|---------|
| `baseURL` | `string` | **yes** | — | Provider root **without** `/chat/completions`. Trailing `/` stripped. Plugin appends `/chat/completions` (openai) or `/chat` (cohere-v2). |
| `model` | `string` | **yes** | — | Model id sent in the request body. |
| `apiKey` | `string` | one of key/env | — | Literal key. If non-empty, **this wins** and `apiKeyEnv` is never read. |
| `apiKeyEnv` | `string` | one of key/env | — | Env var **name** (e.g. `GROQ_API_KEY`). Used **only** when `apiKey` is omitted/empty. Must be in the **Kilo process** env, not only `~/.profile`. |
| `timeoutMs` | `number` | no | `8000` | AbortController timeout for the HTTP call. |
| `maxTokens` | `number` | no | `512` | Cap on completion tokens. Groq / gpt-oss send `max_completion_tokens`; others `max_tokens`. |
| `jsonObject` | `boolean` | no | `false` | If `true`, send `response_format: {type:"json_object"}`. Keep **off** for free gateway models (often HTTP 400). Parser still extracts JSON from plain text. |
| `apiFormat` | `"openai"` \| `"cohere-v2"` | no | `"openai"` | Wire format. `openai` → `POST {base}/chat/completions`. `cohere-v2` → `POST {base}/chat` (native Cohere v2). |
| `thinkingBudget` | `number` | no | unset | **Cohere v2 only.** `thinking: {type:"enabled", token_budget}`. Do **not** use `reasoning_effort: "none"` on Cohere (422). |
| `reasoning_effort` or `reasoningEffort` | `string` | no | unset | OpenAI-compat field (`none` / `low` / `medium` / `high`). Omitted from body if unset. **Not** sent on cohere-v2. Used for Groq Qwen (`none`) and Groq gpt-oss (`low`). |
| `fallbackModels` | `string[]` | no | `[]` | Same endpoint/key: if `model` fails operationally, try these ids in order before failing the **tier**. A definitive approve/escalate on any of them still stops the chain. |
| `disabled` | `boolean` | no | — | **Legacy / suite only.** Plugin **ignores** this on the map format — omit the name from `order` to disable. `gate_suite_unified.py` skips `disabled: true` even if you pass `--provider`. |

`name` is the **map key**, not a field inside the object.

Auth resolution (`resolveApiKey`): `apiKey` if non-empty, else
`process.env[apiKeyEnv]`, else throw (operational fail + cooldown).

### Example

Full redacted snapshot of the live schema (same `order`, research `tiers`,
`systemPrompt` v6): **[`agent-reviewer.json.example`](./agent-reviewer.json.example)**.

Copy → `~/.config/kilo/agent-reviewer.json`, replace `{OLLAMA_KEY}`, `{GROQ_KEY}`,
`{KILO_GATEWAY_KEY}`, `{MISTRAL_KEY}`, `{COHERE_KEY}`, `{MIMO_KEY}`,
`{NVIDIA_NIM_KEY}`, `{TOGETHER_KEY}`, then `chmod 600`.

Tiers in `tiers` but not in `order` (NIM, extra Ollama/Mistral) are research
defs — gate-suite can still target them with `--provider <name>`.

Live chain: **Ollama gemma4:31b → Groq Qwen 3.6 27B → Laguna →
Codestral → Together Bonsai → Ministral-8B → Groq gpt-oss-20b →
Cohere → MiMo**.

### Dropped (2026-08-18/19)

| Provider / model | Why removed from `order` (and then from `tiers`) |
|------------------|---------------------------------------------------|
| **Cerebras** `gemma-4-31b` / `gpt-oss-120b` | Free tier gone — API returns **402 payment_required**. Was primary. |
| **Groq** `llama-3.3-70b-versatile` | **404 model_not_found** (Groq retired the id). Tiers `groq` / `groq-llama70b` deleted. |
| **Groq** `llama-3.1-8b-instant` | Same: **404 model_not_found**. Tier `groq-llama8b` deleted. |

Groq remaining: `qwen/qwen3.6-27b` and `openai/gpt-oss-20b` only.

### Research tiers (in `tiers`, **not** in `order`)

Used for gate-suite / candidates; they never auto-approve live traffic:

| Name | Model | Notes |
|------|-------|--------|
| `nim-muse-glimmer-30b` | `meta/muse-glimmer-30b` | NIM; was disabled for timeouts 2026-08-11; re-enabled for extended 98 |
| `nim-nemotron-nano-9b-v2` | `nvidia/nvidia-nemotron-nano-9b-v2` | NIM; `/no_think` |
| `nim-nemotron-lightning-30b` | `nvidia/nemotron-3.5-lightning-30b-a3b` | NIM research; **93/98** FA1 FE4; `/no_think` ignored — `enable_thinking=false` |
| `nim-nemotron-super-120b` | `nvidia/nemotron-3-super-120b-a12b` | NIM research; **94/98** FA1 FE3; same thinking off-switch |
| `mistral-ministral-3b` | `ministral-3b-2512` | kept as bench def |
| `ollama-nemotron-30b` / `ollama-gpt-oss-20b` | ollama.com | kept as bench defs |

Extended 98 scores in the table above are from 2026-08-11 prompt v6 unless noted.

**Rejected for Cohere:** `reasoning_effort=none`
(~50% `422 INVALID_TOOL_GENERATION`);
`response_format=json_object` (rambles into length limit).

---

## Prerequisites

1. **Kilo CLI** with plugin auto-scan of `~/.config/kilo/plugin/`.
2. **Config file** `~/.config/kilo/agent-reviewer.json`
   (mode `600` recommended):
    - `tiers` — map of defs (`baseURL`, `model`, `apiKey`,
      `timeoutMs`, `maxTokens`, `jsonObject`)
    - `order` — enabled chain (names from `tiers`)
    - `tierCooldownMs` — default `1800000` (30m)
    - `skip` — tools that bypass the gate (default `[]`)
    - `cache` — decision cache on/off
    - Override path: env `AGENT_REVIEWER_CONFIG=/path/to.json`
    - Plugin source has **no** provider secrets;
      missing/empty config → no tiers → fail-closed
  1. Network access to the base URLs of tiers listed in `order`.
  2. After any edit to `agent-reviewer.ts`: **restart Kilo**.
     Edits to `agent-reviewer.json` (order, tiers, prompt) are
     **hot-reloaded** (mtime).

Optional build sanity check (does not load the plugin into Kilo):

```bash
cd ~/.config/kilo
bun build plugin/agent-reviewer.ts --outfile=/tmp/ar-check.js --target=bun
```

---

## Installation / enablement

Kilo auto-loads `plugin/*.{ts,js}`. There is **no** `plugin` array entry
required in `kilo.json` / `kilo.jsonc` for auto-scanned files. The TUI
overlay is loaded from `tui.jsonc`. No npm/pip step — Kilo loads the
TypeScript file. **Never overwrite** `~/.config/kilo/agent-reviewer.json`
(keys). Restart Kilo after `.ts` / TUI changes.

### Script

```bash
# from a clone
./scripts/install.sh

# or one-liner (clones into ~/.local/share/kilo/src/agent-reviewer)
curl -fsSL https://raw.githubusercontent.com/Xell79/agent-reviewer/main/scripts/install.sh | bash
```

Needs `git` + `python3` and one of `sha256sum` / `sha256` / `md5sum` /
`md5` / `openssl`. Clones/updates the public repo, copies
`plugin/agent-reviewer.ts`, `tui/agent-reviewer-tui.tsx`, and
`agent-reviewer.json.example` into `~/.config/kilo` (`--dest` /
`KILO_CONFIG`) **only if the dest checksum differs** (or the file is
missing). `--dry-run` reports `unchanged` vs `would install`. Adds the
overlay URI to `tui.jsonc` if missing. Does **not** copy markdown docs.
**Does not** write `agent-reviewer.json`.

### Manual install / update

```bash
git clone https://github.com/Xell79/agent-reviewer.git
# later: git -C agent-reviewer pull --ff-only
cd agent-reviewer

mkdir -p ~/.config/kilo/plugin ~/.config/kilo/tui
cp -f agent-reviewer.ts agent-reviewer.json.example ~/.config/kilo/plugin/
cp -f tui/agent-reviewer-tui.tsx ~/.config/kilo/tui/
```

Point `~/.config/kilo/tui.jsonc` at the overlay (create the file if it
does not exist; merge into `"plugin"` if it already does):

```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": [
    "file:///home/YOU/.config/kilo/tui/agent-reviewer-tui.tsx"
  ]
}
```

Replace `YOU` with your username. Do **not** copy
`agent-reviewer.json.example` over a live `agent-reviewer.json`. Only if
that file is missing:

```bash
cp agent-reviewer.json.example ~/.config/kilo/agent-reviewer.json
# fill {PROVIDER_KEY} placeholders, then:
chmod 600 ~/.config/kilo/agent-reviewer.json
```

Confirm load after restart:

```bash
tail -5 ~/.local/share/kilo/log/agent-reviewer/load.log
# expect: ISO-timestamp import pid=… cwd=…
```

If that file is empty after a restart, the module was not imported
(wrong path, or Kilo not using this config root).

---

## Day-to-day use

- **Safe routine work** (ls, git status, ordinary source edits, tests):
  usually auto-approved by **Ollama Cloud `gemma4:31b`** within **8s**
  (`timeoutMs`; slower calls cooldown and Groq Qwen 3.6 takes over ~0.2–0.4s).
  Overlay shows `Gate reviewing · ollama-gemma4-31b` until the reply; then TUI
  `Edit src/foo.ts · approved by you`.
- **Dangerous / ambiguous** (sudo, rm -rf, mkfs, .env edits, curl\|sh,
  force-push main): tier returns `escalate` → normal permission prompt
  for you.
- **Primary outage / timeout**: next `order` tier
  (Qwen → Laguna → Codestral → … → MiMo).
  Cohere is **paid** and is hit only on **operational** failures
  of earlier tiers, not when a tier returns escalate.
- **All tiers fail**: fail-closed → human prompt.

You do **not** configure per-command rules for this gate;
policy lives in `systemPrompt` in `agent-reviewer.json` (fallback:
in-source `DEFAULT_SYSTEM_PROMPT`).

---

## Logs

Two channels by design. Plugin debug is **not** mixed into Kilo’s main log.

### 1. Plugin debug log (rich, may contain secrets)

```text
~/.local/share/kilo/log/agent-reviewer/debug.log
```

Override directory with `AGENT_REVIEWER_LOG_DIR`. Synchronous `appendFileSync` with
**in-process size rotation** (10 MiB × keep 5 → `debug.log.1` …). Also covered by
user logrotate (see below). Strings truncated to 400 chars in JSON fields.

Useful phases:

| Phase | Meaning |
|-------|---------|
| `import` / `factory.enter` / `factory.hooks_ready` | Plugin loaded |
| `event.permission.asked` | Gate saw a permission |
| `review.start` | Includes `userContent` (commands/diffs — sensitive) |
| `tier.call` | About to call a tier |
| `tier.request` | `max_tokens`, `jsonObject` actually sent |
| `tier.response` | `text_head` / `text_tail` of model output (sensitive) |
| `tier.result` | Parsed `decision` + `reason` |
| `tier.fail` | Operational failure; fall through; starts 30m cooldown |
| `tier.cooldown` | Tier marked cooling (`untilMs`, error) |
| `tier.skip_cooldown` | Later ask skipped while cooling |
| `reply.approve` / `reply.approve.ok` | Auto-approve reply |
| `escalate` | Definitive escalate to human |
| `all_tiers_failed` | Fail-closed |

Clear between experiments:

```bash
: > ~/.local/share/kilo/log/agent-reviewer/debug.log
```

### 2. Server / TUI app log (non-sensitive summary)

Via fire-and-forget `client.app.log` → typically:

```text
~/.local/share/kilo/log/opencode.log
```

Also visible in Kilo’s log/console panel. Messages include:

- `plugin loaded` — tier names
- `review start` — permission, patterns, command, tier **names** (no full tool body)
- **`tier result`** — **`tier` + `model` + `decision` + `reason`** ← who approved/escalated
- `escalating to human` — includes `model` (symmetry)
- `tier operational failure; next tier` — error snippet
- `all tiers failed; fail-closed escalate to human`

**Security rule:** raw model text and full `userContent` go **only**
to the local debug log, never to `app.log`.

### Load marker

```text
~/.local/share/kilo/log/agent-reviewer/load.log
```

One line per process import — proves the file was scanned.

### Log rotation

User-level logrotate (no root):

| Piece | Path |
|-------|------|
| Config | `~/.config/logrotate/kilo` |
| Timer | `systemctl --user status logrotate-kilo.timer` |
| State | `~/.local/share/logrotate/kilo.status` |

| Log | Policy |
|-----|--------|
| `opencode.log` | daily **or** ≥20 MiB, 14 gens, compress, **copytruncate**, maxage 30d |
| `agent-reviewer/*.log` | daily **or** ≥10 MiB, 10 gens + in-process 10 MiB×5 |

```bash
# manual force
logrotate --force --state ~/.local/share/logrotate/kilo.status ~/.config/logrotate/kilo
```

---

## Who approved? (model attribution)

| Surface | Shows model? |
|---------|----------------|
| TUI line `· approved by you` | **No** (hardcoded for all permission replies) |
| Overlay title `Gate reviewing/escalate · <tier>` | **Tier name** (not model id) |
| `app.log` / console → `tier result` | **Yes** (`tier`, `model`) |
| `~/.local/share/kilo/log/agent-reviewer/debug.log` | **Yes** (plus raw response if needed) |

There is no supported way to inject the model name into the
permission-reply UI: the reply API accepts only
`{ "response": "once"|"always"|"reject" }`.

---

## Safety policy (what the model is told)

Summarized from `DEFAULT_SYSTEM_PROMPT` in source / `systemPrompt` in
JSON (JSON wins when set; source is fallback if this drifts):

**Always escalate:** destructive/irreversible ops, sudo / shell injection
/ curl\|sh, secrets (`.env`, SSH keys, credentials), protected paths
(`/etc`, `~/.ssh`, …), secret exfiltration, intent-vs-action mismatch,
ambiguity.

**Approve when clearly routine:** read-only / low-impact shell,
ordinary project source edits, non-destructive git, scoped package installs
when not malicious.

**When in doubt, escalate.**

Aliases accepted by the parser (models should still emit
`approve`/`escalate`):  
approve ← allow, yes, ok, safe;  
escalate ← deny, reject, block, ask, human, unsafe, review, no.

---

## Cache

Identical permission payloads can reuse a prior **parsed** decision (default
**on**, `cache` in `agent-reviewer.json`). Cache key hashes permission +
patterns + metadata + enriched tool args. Bounded (pruned when large).
Set `"cache": false` in that JSON to disable. Auto-scanned plugins usually
receive **no** factory `opts` — live chain is the config file, not
hardcoded `DEFAULT_TIERS` (`FALLBACK_TIERS` is empty / fail-closed).

---

## Cost & rate limits

| Tier | Cost / risk |
|------|-------------|
| Ollama Cloud `gemma4:31b` | **Primary**; cloud quota; **8s** timeout (then cooldown → next `order`) |
| Groq Qwen 3.6 27B / gpt-oss-20b | Free/dev org (~**30 RPM** — check [console](https://console.groq.com/settings/limits)). Burst 429 → next tier |
| Cohere Command A Plus | **Paid**; only when earlier `order` tiers fail operationally |
| Gateway Laguna free | Free pool; may 429; `mayTrainOnYourPrompts` often true on free models |
| MiMo | Free plan key; last resort |

Privacy: free Gateway / Poolside tiers may train on prompts. Prefer not to put
raw secrets into commands that will be reviewed if those tiers are reached.
The debug log **will** store reviewed content locally either way.

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Never auto-approves | `~/.local/share/kilo/log/agent-reviewer/load.log` empty → not loaded / no restart. Else debug log for `permission.asked` / `skip-list` |
| Always asks human | `tier.result` / `escalate` — model chose escalate; or `all_tiers_failed` |
| Primary never called | Missing/empty `apiKey` in `agent-reviewer.json` → throw → cooldown 30m; or dlog `config.missing` / empty `order` |
| Config not applied | Wrong path; check dlog `config.loaded` / `factory.hooks_ready`. JSON edits are hot-reloaded; `.ts` needs restart |
| Groq 403 | Missing/blocked `User-Agent` (plugin sets one); or bad Groq `apiKey` |
| Groq 429 | RPM/TPM/RPD; cooldown 30m; falls through to next `order` tier |
| Groq 404 `model_not_found` | Id retired (happened to llama-3.3-70b / llama-3.1-8b-instant 2026-08-19) — remove from `order`/`tiers` |
| Always skips a tier | dlog `tier.skip_cooldown` / `tier.cooldown` — wait 30m or restart Kilo |
| Cohere never appears | Expected unless earlier tiers throw/cooldown; first-definitive |
| Cohere 429 cascade | Trial rate limit; cooldown; falls through to Gateway |
| Empty / weird Gateway answers | Free models often put text in `reasoning*`; extractor already checks those fields |
| Plugin “dead” after factory hang | Do **not** `await` network before hooks return; `log()` is fire-and-forget by design |
| Build fails | `bun build plugin/agent-reviewer.ts --target=bun` |

---

## Changing tiers / models

1. Edit **`~/.config/kilo/agent-reviewer.json`**: put model settings
   under `tiers.<name>`, enable/order via `order` array (not plugin
   source). Hot-reloaded.
2. Optional `maxTokens` per tier (default 512). **Do not** set Cohere
   below 1024 without re-benching.
3. Prefer OpenAI-compat `/chat/completions` URLs; plugin appends
   that path.
4. Keep `jsonObject: true` only for models that accept
   `response_format` (MiMo yes; free Gateway often **no**).
5. Re-run a small gate suite (see [AGENTS.md](./AGENTS.md)) before trusting a new model.
6. Restart Kilo.

Do **not** change the tier loop to “fall through on escalate”: a weaker
fallback could auto-approve danger that a stronger primary correctly escalated.

---

## Related files

| Path | Role |
|------|------|
| `scripts/install.sh` | Install/update live files (**never** writes `agent-reviewer.json`) |
| `~/.config/kilo/plugin/agent-reviewer.ts` | Plugin source (no secrets) |
| `~/.config/kilo/agent-reviewer.json` | Tiers, keys, model settings (`chmod 600`, operator-owned) |
| `README.md` / `AGENTS.md` | Human + agent docs (repo only; not copied into config) |
| `~/.config/kilo/tui/agent-reviewer-tui.tsx` | Escalate overlay (via `tui.jsonc`) |
| `~/.local/share/kilo/log/agent-reviewer/debug.log` | Rich local log (rotated) |
| `~/.local/share/kilo/log/agent-reviewer/load.log` | Import proof |
| `~/.local/share/kilo/log/opencode.log` | app.log sink |
| `~/bin/kilo/*-benchmark.sh` | Optional research benches (not required at runtime) |

---

## Changelog (high level)

- **2026-08-26:** Overlay title uses **tier name**
  (`Gate reviewing · ollama-gemma4-31b` / `Gate escalate · …`).
  Placeholder IPC is written as soon as `permission.asked` fires so the
  TUI does not wait for gemma (~8–21s). Agent docs file is **`AGENTS.md`**
  (was `README-AI.md`).
- **2026-08-19 (NIM Lightning + Super):** research tiers
  `nim-nemotron-lightning-30b` (`nvidia/nemotron-3.5-lightning-30b-a3b`) and
  `nim-nemotron-super-120b` (`nvidia/nemotron-3-super-120b-a12b`). Not in
  `order`. `/no_think` does **not** disable CoT on these (Lightning: 512 ctok
  thinking, finish=length; Super: reasoning_content still ~400–700 chars).
  Plugin+suite now send `chat_template_kwargs: {enable_thinking: false}` for
  any `*nemotron*` model in addition to `/no_think` (Nano 9B / Ollama still
  need `/no_think`; kwargs-only on Nano left empty content + finish=length).
- **2026-08-19 (Bonsai promoted):** `together-bonsai-27b` into `order` (pos 5)
  with `jsonObject: true` — kills Qwen3.6-heritage thinking (ctok ~212 → ~27,
  ~3.7s → ~1s; `reasoning:{enabled:false}` / `thinking_budget_tokens:0` are
  silently ignored by Together for this model). Live `order`:
  Ollama `gemma4:31b` → Groq Qwen 3.6 → Laguna → Codestral → **Bonsai** →
  Ministral-8B → Groq gpt-oss-20b → Cohere → MiMo.
- **2026-08-19 (naga.ac dropped):** Free limits 10 RPM / 100 RPD make a full
  98-case suite or a live `order` slot useless. Tiers, `kilo.json` provider,
  and `check-providers.json` entry removed.
- **2026-08-25 (escalate reason overlay):** On `escalate`, TUI `app` slot overlay
  shows only the reviewer **reason**. **Permit / Reject** stay on the native
  permission dialog. Overlay hides on `permission.replied`. Server still writes
  `pending/<sessionID>.json`; TUI plugin is loaded from `tui.jsonc`, not `plugin/`.
  Restart Kilo after install.
- **2026-08-19 (escalate dialog):** On `escalate`, TUI `DialogSelect` with the
  reviewer reason and **Permit / Reject**. Server writes
  `pending-escalate.json`; TUI plugin (loaded from `tui.jsonc`, not `plugin/`)
  polls and replies `once`/`reject`. Restart Kilo after install. (Superseded
  2026-08-25: reason overlay; native Permit/Reject.)
- **2026-08-19:** **Cerebras dropped** — no free tier (`402 payment_required` on
  `gemma-4-31b` and `gpt-oss-120b`). **Groq Llama dropped** — `llama-3.3-70b-versatile`
  and `llama-3.1-8b-instant` return `404 model_not_found`. Live `order`:
  Ollama `gemma4:31b` → Groq Qwen 3.6 → Laguna → Codestral → Ministral-8B →
  Groq gpt-oss-20b → Cohere → MiMo. Research defs (not in `order`): NIM muse-glimmer.
  `apiKeyEnv` removed wherever `apiKey` is set.
- **2026-08-10 (later still):** Primary **Cerebras** `gemma-4-31b` before Groq
  (hard-10 10/10). Chain Cerebras → Groq → Cohere → Laguna → MiMo.
  Env `CEREBRAS_API_KEY`. Free Cerebras limits documented (5 RPM / 30k TPM).
  **Tier cooldown:** any operational failure → skip that tier for 30 minutes
  (`TIER_COOLDOWN_MS`); dlog `tier.cooldown` / `tier.skip_cooldown`.
- **2026-08-10 (later):** Primary **Groq** `llama-3.3-70b-versatile` (replaces
  NIM); chain Groq → Cohere → Laguna → MiMo. `User-Agent` +
  `max_completion_tokens` for Groq. Candidate documented:
  `openai/gpt-oss-20b` (17/18).
- **2026-08-10:** Cohere tier; gateway model →
  `poolside/laguna-s-2.1:free`; per-tier `maxTokens`; dlog `tier.request` /
  `tier.response` / `userContent`; escalate app.log includes `model`.
  Documented impossibility of model name in “approved by you”.
- **Earlier:** NIM primary → Gateway → MiMo; `permission.asked` +
  `postSessionIdPermissionsPermissionId`; fail-closed + first-definitive;
  hash cache; factory no-await-network fix.
