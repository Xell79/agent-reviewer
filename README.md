# agent-reviewer

Pre-auto-approve safety gate for [Kilo](https://kilo.ai).
A chain of small LLM reviewers decides before mutating tools
ask for permission.

- **approve** → tool runs (TUI says "approved by you")
- **escalate** → native Permit/Reject; overlay shows reason
- **fail** → next tier in chain; all fail = human (**fail-closed**)

| | |
|---|---|
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
**Never** writes `agent-reviewer.json`.

If the live JSON is missing:

```bash
cp agent-reviewer.json.example ~/.config/kilo/agent-reviewer.json
# fill {PROVIDER_KEY}, then:
chmod 600 ~/.config/kilo/agent-reviewer.json
```

Restart Kilo. Confirm: `tail -5 ~/.local/share/kilo/log/agent-reviewer/load.log`

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
are ignored). The plugin sends a short payload to the first
non-cooling tier in `order`. First definitive `approve` or
`escalate` wins — escalate never falls through. Timeout
(8s default, 30s MiMo) falls through without cooldown until
3 consecutive timeouts trigger 30 min cooldown.

<details>
<summary>Full flow and cooldown details</summary>

<br>

1. `permission.asked` fires → skip if `permission` is in `skip`.
2. Plugin sends payload + `systemPrompt` to `order[0]`.
3. Model answers `{"decision":"approve"|"escalate","reason":"…"}`.
4. First definitive answer wins. Overlay is
   `Gate reviewing · <tier>` while chain runs.
5. HTTP 4xx/5xx, missing key, empty/unparseable body →
   **30 min cooldown** (first failure). Timeout falls through
   without cooldown until **3 consecutive** timeouts.
   Approve/escalate do not cool.

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
`thinkingBudget`, `reasoningEffort`, `fallbackModels`.

Auth: non-empty `apiKey` wins; else `process.env[apiKeyEnv]`;
else throw and **immediate** cooldown.

Full redacted snapshot: [`agent-reviewer.json.example`](./agent-reviewer.json.example).

</details>

---

## Day to day

- Routine `ls`/git/source edits → usually auto-approved by primary.
- `sudo`, `rm -rf`, `.env`, force-push → escalate (you click).
- HTTP/5xx on a tier → 30 min cooldown; request continues down `order`.
- One timeout → next tier, primary still tried next ask.
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

## Related

| Path | Role |
|------|------|
| `scripts/install.sh` | Install/update (**never** writes live JSON) |
| `AGENTS.md` | Hooks, schemas, edit constraints |
| `LICENSE` | MIT |
