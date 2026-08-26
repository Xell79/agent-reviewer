# agent-reviewer — install / layout

## Canonical live path (this machine)

| Item | Path |
|------|------|
| Plugin source | `~/.config/kilo/plugin/agent-reviewer.ts` |
| TUI overlay | `~/.config/kilo/tui/agent-reviewer-tui.tsx` + `tui.jsonc` |
| Docs | repo `README.md` / `AGENTS.md` (not copied into config) |
| Permission rules | `~/.config/kilo/kilo.jsonc` → `permission` |
| dlog | `~/.local/share/kilo/log/agent-reviewer/debug.log` |
| load log | `~/.local/share/kilo/log/agent-reviewer/load.log` |
| pending escalate IPC | `~/.local/share/kilo/log/agent-reviewer/pending/<sessionID>.json` |
| app.log | `~/.local/share/kilo/log/opencode.log` |

## How it loads

- Directory auto-scan: `{plugin,plugins}/*.{ts,js}` under `~/.config/kilo/`
- **No** `plugin` array entry required in `kilo.jsonc`
- Auto-scanned plugins do **not** receive `opts` → live chain is
  **`~/.config/kilo/agent-reviewer.json`** (`order` + `tiers`)
- Restart Kilo after `.ts` edits; JSON is hot-reloaded

## Keys

Tiers use `apiKey` in `agent-reviewer.json` (mode `600`). `apiKeyEnv` is optional
and unused when `apiKey` is present.

Redacted template (no live secrets): **`agent-reviewer.json.example`**.
Placeholders: `{OLLAMA_KEY}` `{GROQ_KEY}` `{KILO_GATEWAY_KEY}` `{MISTRAL_KEY}`
`{COHERE_KEY}` `{MIMO_KEY}` `{NVIDIA_NIM_KEY}` `{TOGETHER_KEY}`.

```bash
cp agent-reviewer.json.example ~/.config/kilo/agent-reviewer.json
# fill {PROVIDER_KEY} placeholders, then:
chmod 600 ~/.config/kilo/agent-reviewer.json
```

Live `order` (2026-08-19): Ollama `gemma4:31b` → Groq Qwen 3.6 → Laguna →
Codestral → Together Bonsai → Ministral-8B → Groq gpt-oss-20b → Cohere → MiMo.

Cerebras and Groq Llama 3.3/3.1 ids are **removed** (no free Cerebras; Groq 404).

## Build check

```bash
cd ~/.config/kilo
bun build plugin/agent-reviewer.ts --outfile=/tmp/ar-final-check.js --target=bun
```

## Install / update

Needs `git`, `python3`, and a checksum tool (`sha256sum`, `sha256`,
`md5sum`, `md5`, or `openssl`) on PATH. Host is Kilo (loads `.ts`
itself) — no npm/pip packages. Copies a dest file only when its
checksum differs from the source (`unchanged` otherwise; `--dry-run`
prints the same).

From a clone:

```bash
./install.sh
# optional: ./install.sh --dry-run
# optional: ./install.sh --dest /path/to/kilo-config
```

Without a clone (script clones into
`~/.local/share/kilo/src/agent-reviewer`; an incomplete leftover
checkout there is repaired with `git fetch` + `reset --hard`):

```bash
curl -fsSL https://raw.githubusercontent.com/Xell79/agent-reviewer/main/scripts/install.sh | bash
```

Copies `agent-reviewer.ts`, TUI overlay, and `agent-reviewer.json.example`.
Does not copy markdown. Ensures `tui.jsonc` lists the overlay.
**Never writes `agent-reviewer.json`** (keys). If that
file is missing, copy `agent-reviewer.json.example` yourself, fill
`{PROVIDER_KEY}`, `chmod 600`. Restart Kilo after install.
