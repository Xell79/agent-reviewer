# agent-reviewer

Pre-auto-approve safety gate for [Kilo](https://kilo.ai).
A chain of small LLM reviewers decides before mutating tools
ask for permission.

- **approve** → tool runs (TUI says "approved by you")
- **escalate** → native Permit/Reject; overlay shows reason
- **fail** → next tier in chain; all fail = human (**fail-closed**)

| | |
|---|---|
| Version | [`VERSION`](./VERSION) = `PLUGIN_VERSION` in the plugin ([changelog](./CHANGELOG.md)) |
| Plugin | `~/.config/kilo/plugin/agent-reviewer.ts` (auto-scan) |
| Overlay | `~/.config/kilo/tui/agent-reviewer-tui.tsx` via `tui.jsonc` |
| Config | `~/.config/kilo/agent-reviewer.json` (`chmod 600`, operator-owned) |
| Example | [`agent-reviewer.json.example`](./agent-reviewer.json.example) |

JSON is hot-reloaded. Restart Kilo after `.ts`/`tui.jsonc` edits.

Agent/implementer reference: **[AGENTS.md](./AGENTS.md)**.

---

## Install

```bash
./install.sh
# or ./scripts/install.sh
# or
curl -fsSL https://raw.githubusercontent.com/Xell79/agent-reviewer/main/scripts/install.sh | bash
```

Needs `git`, `python3`, and a checksum tool
(`sha256sum`/`sha256`/`md5sum`/`md5`/`openssl`).
Copies plugin + TUI + example only if the dest checksum differs.
Does **not** copy `VERSION` or `CHANGELOG.md`. Prints
`version: repo … dest …` then `in sync` or `update available`.
**Never** writes `agent-reviewer.json`.

If the live JSON is missing:

```bash
cp agent-reviewer.json.example ~/.config/kilo/agent-reviewer.json
# fill {PROVIDER_KEY}, then:
chmod 600 ~/.config/kilo/agent-reviewer.json
```

Restart Kilo. Confirm: `tail -5 ~/.local/share/kilo/log/agent-reviewer/load.log`
(line includes `version=`). GitHub Releases:
<https://github.com/Xell79/agent-reviewer/releases>

<details>
<summary>Manual copy and tui.jsonc</summary>

<br>

```bash
git clone https://github.com/Xell79/agent-reviewer.git
cd agent-reviewer
mkdir -p ~/.config/kilo/plugin ~/.config/kilo/tui
cp -f agent-reviewer.ts agent-reviewer.json.example ~/.config/kilo/plugin/
cp -f tui/agent-reviewer-tui.tsx ~/.config/kilo/tui/
```

```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": [
    "file:///home/YOU/.config/kilo/tui/agent-reviewer-tui.tsx"
  ]
}
```

Replace `YOU`. Do not overwrite a live `agent-reviewer.json`.

</details>

---

## How it works

Kilo emits `permission.asked` (tools in `ask`; names in `skip`
are ignored). Concurrent reviews pick the least-loaded
non-cooling unattempted tier; `order` breaks ties (a free
lower-priority tier beats a busy primary). First definitive
`approve` or `escalate` wins for that request — escalate never
falls through. Timeout (8s default, 30s MiMo) falls through
without cooldown until 3 consecutive timeouts trigger 30 min
cooldown.

<details>
<summary>Full flow and cooldown details</summary>

<br>

1. `permission.asked` fires → skip if `permission` is in `skip`.
2. Plugin selects least-loaded non-cooling unattempted tier
   (`order` only when counts are equal).
3. Model answers `{"decision":"approve"|"escalate","reason":"…"}`.
4. First definitive answer wins **for that request**. Overlay is
   `Gate reviewing · <tier>` while a tier is in flight.
5. HTTP 4xx/5xx, missing key, empty/unparseable body →
   **30 min cooldown** (first failure), then pick again among
   remaining tiers. Timeout falls through without cooldown until
   **3 consecutive** timeouts. Approve/escalate do not cool.

</details>

---

## Live chain

Enabled by `order` in `agent-reviewer.json`. Timeout **8s** except MiMo (**30s**).

| # | Name | Model |
|---|------|-------|
| 1 | `ollama-gemma4-31b` | `gemma4:31b` |
| 2 | `groq-qwen36-27b` | `qwen/qwen3.6-27b` |
| 3 | `kilo-gateway` | `poolside/laguna-s-2.1:free` |
| 4 | `mistral-codestral` | `codestral-2508` |
| 5 | `together-bonsai-27b` | `Prism-ML/Ternary-Bonsai-27B` |
| 6 | `mistral-ministral-8b` | `ministral-8b-2512` |
| 7 | `groq-gpt-oss-20b` | `openai/gpt-oss-20b` |
| 8 | `cohere` | `command-a-plus-05-2026` |
| 9 | `xiaomi-mimo` | `mimo-v2.5` |
| — | `kirocc-qwen3-coder-next` | `qwen3-coder-next` (local Anthropic proxy; optional, not in default `order`) |

<details>
<summary>Config fields</summary>

<br>

Root: `order`, `tiers`, `skip` (default `[]`), `cache`
(default `true`), `tierCooldownMs` (default 30 min),
`systemPrompt` (else in-source fallback).
Override path: `AGENT_REVIEWER_CONFIG`.

Per tier: `baseURL`, `model`, `apiKey` **or** `apiKeyEnv`,
optional `timeoutMs` (8000), `maxTokens` (512),
`jsonObject` (false), `apiFormat` (`openai`/`cohere-v2`),
`thinkingBudget`, `reasoningEffort`, `fallbackModels`,
`headers` (`Record<string, string>`).

`headers` are merged after the plugin defaults
(`Content-Type`, `Authorization: Bearer <key>`, `User-Agent`,
Cohere `Accept`). On a colliding key, the tier value wins.
Use for provider-specific headers (`anthropic-version`,
session ids on a local proxy).

Auth: non-empty `apiKey` wins; else `process.env[apiKeyEnv]`;
else throw and **immediate** cooldown.

Full redacted snapshot: [`agent-reviewer.json.example`](./agent-reviewer.json.example).

Validate syntax: `scripts/json-lint ~/.config/kilo/agent-reviewer.json`
(or `python3 -m json.tool <file> > /dev/null`, or `jq empty <file>`).

</details>

---

## Day to day

- Routine `ls`/git/source edits → usually auto-approved (idle → primary).
- Concurrent asks may be decided by a lower-priority idle tier.
- `sudo`, `rm -rf`, `.env`, force-push → escalate (you click).
- HTTP/5xx on a tier → 30 min cooldown; this request picks again.
- One timeout → next remaining tier, primary still tried next ask.
  Three consecutive → 30 min cooldown.

<details>
<summary>Troubleshooting</summary>

<br>

| Symptom | Check |
|---------|--------|
| Never auto-approves | `load.log` empty → not loaded. Else `skip-list`/escalate |
| Primary never called | empty `apiKey` → immediate 30m cooldown; or empty `order` |
| Always skips a tier | `tier.skip_cooldown` — wait 30m or restart |
| Config ignored | JSON is hot-reloaded; `.ts` needs restart |
| Dest behind repo | `install.sh` prints `update available: dest X → repo Y` |

</details>

---

## Logs

| | |
|---|---|
| Debug (may contain secrets) | `~/.local/share/kilo/log/agent-reviewer/debug.log` |
| Load marker | `…/agent-reviewer/load.log` |
| Overlay IPC | `…/agent-reviewer/pending/<sessionID>.json` |
| App log (no raw model text) | `~/.local/share/kilo/log/opencode.log` |

Override dir: `AGENT_REVIEWER_LOG_DIR`.

<details>
<summary>Debug phases and build check</summary>

<br>

Useful `dlog` phases: `review.start` (`userContent`),
`tier.select` (selected name + `activeCounts`),
`tier.request`/`tier.response` (sensitive), `tier.result`,
`tier.fail` (`isTimeout`, `consecutiveTimeouts`,
`cooldownMs`; `0` = no cooldown yet), `tier.cooldown`,
`tier.skip_cooldown`, `escalate`, `all_tiers_failed`.

`app.log` has `tier result` with **tier + model + decision + reason**.

Build check (does not load the plugin):

```bash
cd ~/.config/kilo
bun build plugin/agent-reviewer.ts --outfile=/tmp/ar-check.js --target=bun
```

</details>

---

## Probe tiers (`check-agent-reviewer.py`)

Local availability checker. Reads live `agent-reviewer.json` and pings
every configured model (primary, then `fallbackModels`) with the same
request shape as the plugin. Different `baseURL`s run in parallel;
models that share a provider stay sequential (`--sleep` / retries).

**Not** installed by `install.sh`. Needs a live JSON with keys
(`chmod 600`); that file is gitignored and must never be committed.

```bash
# default config: ./agent-reviewer.json next to the script (gitignored)
python3 check-agent-reviewer.py

# canonical live path after install
python3 check-agent-reviewer.py --config ~/.config/kilo/agent-reviewer.json

# subset
python3 check-agent-reviewer.py --only ollama-gemma4-31b,groq-qwen36-27b
```

On a TTY the full probe list is drawn first and rewritten in place.
`--no-live` / `--no-color` for logs. Ctrl+C exits 130 (no traceback).

| | |
|---|---|
| Exit `0` | every target OK |
| Exit `1` | at least one FAIL or SKIP (missing key) |
| Exit `2` | config error / no tiers |
| Exit `130` | interrupted |

The checker sends `Authorization: Bearer …` but does **not** print
keys. FAIL notes may include a short HTTP error body from the
provider (truncated). Do not paste those logs into issues if they
look sensitive.

<details>
<summary>Flags and request parity</summary>

<br>

| Flag | Default | |
|------|---------|---|
| `--config` | `./agent-reviewer.json` | same schema as the plugin |
| `--only` | all | comma-separated tier names |
| `--sleep` | `12` | seconds between checks of the same `baseURL` |
| `--retries` | `2` | extra attempts on network / 429 / 5xx |
| `--retry-sleep` | `60` | seconds before a retry |

Parity with `callReviewer`: OpenAI `POST {base}/chat/completions`,
Cohere `apiFormat: cohere-v2` → `POST {base}/chat`, Groq
`max_completion_tokens`, Nemotron `/no_think`, `jsonObject` →
`response_format: json_object`. Key order: `tier.apiKey`, then
`env(tier.apiKeyEnv)`. `tier.headers` merged after standard
headers (tier value wins on collision).

</details>

---

## Related

| Path | Role |
|------|------|
| `VERSION` | Semver (source of truth; not copied to dest) |
| `CHANGELOG.md` | Keep a Changelog; GitHub Release notes |
| `scripts/install.sh` | Install/update (**never** writes live JSON) |
| `scripts/json-lint` | Lightweight JSON validator (Python, zero deps) |
| `check-agent-reviewer.py` | Probe every configured model (local; not installed) |
| `AGENTS.md` | Hooks, schemas, edit constraints |
| `LICENSE` | MIT |
