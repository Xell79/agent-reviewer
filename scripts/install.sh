#!/usr/bin/env bash
# Install or update agent-reviewer into the Kilo config dir.
#
# LOCKED: this script must NEVER create, copy, merge, overwrite, truncate,
# or chmod agent-reviewer.json (live, repo, or AGENT_REVIEWER_CONFIG).
# Keys live only in that file; the operator owns it. Template is
# agent-reviewer.json.example — copy it yourself if missing.
set -euo pipefail

REPO_URL="${AGENT_REVIEWER_REPO:-https://github.com/Xell79/agent-reviewer.git}"
SRC_DIR="${AGENT_REVIEWER_SRC:-${XDG_DATA_HOME:-${HOME}/.local/share}/kilo/src/agent-reviewer}"
DEST="${KILO_CONFIG:-${HOME}/.config/kilo}"
DRY_RUN=0
NO_PULL=0
ROOT=""

usage() {
	cat <<EOF
Usage: $(basename "$0") [options]

Clone/update the public repo (if needed), then copy plugin + TUI
into the Kilo config tree. Runtime host is Kilo (Bun auto-scan); there
is no npm/pip package for the gate itself. Docs stay in the repo.

  --dest DIR     Kilo config root (default: \$KILO_CONFIG or ~/.config/kilo)
  --src DIR      Checkout path (default: ~/.local/share/kilo/src/agent-reviewer)
  --repo URL     Git remote (default: ${REPO_URL})
  --no-pull      Do not git pull when the checkout already exists
  --dry-run      Print actions; write nothing (checksum skips included)
  -h, --help     This help

Never writes agent-reviewer.json. Restart Kilo after a real install.

One-liner (no local clone yet):
  curl -fsSL https://raw.githubusercontent.com/Xell79/agent-reviewer/main/scripts/install.sh | bash
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	-h | --help)
		usage
		exit 0
		;;
	--dry-run)
		DRY_RUN=1
		shift
		;;
	--no-pull)
		NO_PULL=1
		shift
		;;
	--dest)
		DEST="${2:?--dest requires a directory}"
		shift 2
		;;
	--src)
		SRC_DIR="${2:?--src requires a directory}"
		shift 2
		;;
	--repo)
		REPO_URL="${2:?--repo requires a URL}"
		shift 2
		;;
	*)
		echo "unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

is_forbidden_json() {
	local base
	base="$(basename "$1")"
	[[ "$base" == "agent-reviewer.json" ]]
}

die_if_forbidden() {
	local p="$1"
	if is_forbidden_json "$p"; then
		echo "REFUSED: scripts must never write agent-reviewer.json ($p)" >&2
		exit 1
	fi
}

run() {
	if [[ "$DRY_RUN" -eq 1 ]]; then
		printf 'dry-run:'
		printf ' %q' "$@"
		printf '\n'
		return 0
	fi
	"$@"
}

need_cmd() {
	local c="$1"
	if ! command -v "$c" >/dev/null 2>&1; then
		echo "missing dependency: $c" >&2
		echo "install it, then re-run this script." >&2
		exit 1
	fi
}

checkout_looks_like_repo() {
	local d="$1"
	[[ -f "$d/agent-reviewer.ts" && -f "$d/tui/agent-reviewer-tui.tsx" ]]
}

resolve_root() {
	local script="${BASH_SOURCE[0]:-}"
	if [[ -n "$script" && -f "$script" ]]; then
		local here
		here="$(cd "$(dirname "$script")/.." && pwd)"
		if checkout_looks_like_repo "$here"; then
			ROOT="$here"
			return 0
		fi
	fi
	ROOT="$SRC_DIR"
}

fetch_repo() {
	need_cmd git
	if checkout_looks_like_repo "$ROOT" && [[ -d "$ROOT/.git" ]]; then
		if [[ "$NO_PULL" -eq 1 ]]; then
			echo "using existing checkout (no pull): $ROOT"
			return 0
		fi
		echo "updating $ROOT"
		if [[ "$DRY_RUN" -eq 1 ]]; then
			echo "dry-run: git -C $ROOT pull --ff-only"
			return 0
		fi
		git -C "$ROOT" pull --ff-only
		return 0
	fi
	if [[ -e "$ROOT" && ! -d "$ROOT/.git" ]] && checkout_looks_like_repo "$ROOT"; then
		echo "using existing files (not a git checkout): $ROOT"
		return 0
	fi
	if [[ -e "$ROOT" && ! -d "$ROOT/.git" ]]; then
		echo "REFUSED: $ROOT exists and is not this repo checkout" >&2
		exit 1
	fi
	echo "cloning $REPO_URL → $ROOT"
	run mkdir -p "$(dirname "$ROOT")"
	run git clone --depth 1 "$REPO_URL" "$ROOT"
}

HASH_CMD=""

pick_hash_cmd() {
	local c
	for c in sha256sum sha256 md5sum md5 openssl; do
		if command -v "$c" >/dev/null 2>&1; then
			HASH_CMD="$c"
			return 0
		fi
	done
	echo "missing checksum tool (need one of: sha256sum, sha256, md5sum, md5, openssl)" >&2
	exit 1
}

file_hash() {
	local f="$1"
	[[ -f "$f" ]] || return 1
	case "$HASH_CMD" in
	sha256sum | md5sum)
		"$HASH_CMD" -- "$f" | awk '{print $1}'
		;;
	sha256)
		sha256 -q -- "$f"
		;;
	md5)
		# GNU coreutils: md5 -q FILE; BSD: md5 -q FILE
		md5 -q -- "$f" 2>/dev/null || md5 -q "$f"
		;;
	openssl)
		openssl dgst -sha256 "$f" | awk '{print $NF}'
		;;
	*)
		return 1
		;;
	esac
}

install_file() {
	local src="$1"
	local dest="$2"
	local src_hash dest_hash
	die_if_forbidden "$src"
	die_if_forbidden "$dest"
	if [[ ! -f "$src" ]]; then
		if [[ "$DRY_RUN" -eq 1 ]]; then
			echo "dry-run: missing source (would fail): $src"
			return 0
		fi
		echo "missing source: $src" >&2
		exit 1
	fi
	src_hash="$(file_hash "$src")"
	if [[ -f "$dest" ]]; then
		dest_hash="$(file_hash "$dest")"
		if [[ -n "$src_hash" && "$src_hash" == "$dest_hash" ]]; then
			echo "unchanged $dest"
			return 0
		fi
	fi
	if [[ "$DRY_RUN" -eq 1 ]]; then
		echo "dry-run: would install $dest"
		return 0
	fi
	mkdir -p "$(dirname "$dest")"
	cp -f "$src" "$dest"
	chmod 644 "$dest"
	echo "installed $dest"
}

ensure_tui_jsonc() {
	local tui_jsonc="$DEST/tui.jsonc"
	local uri="file://${DEST}/tui/agent-reviewer-tui.tsx"
	die_if_forbidden "$tui_jsonc"
	if [[ "$DRY_RUN" -eq 1 ]]; then
		echo "dry-run: ensure tui.jsonc plugin entry ${uri}"
		return 0
	fi
	python3 - "$tui_jsonc" "$uri" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
uri = sys.argv[2]
if path.name == "agent-reviewer.json":
    raise SystemExit("REFUSED: tui helper must not touch agent-reviewer.json")
if not path.exists():
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        '{\n'
        '  "$schema": "https://app.kilo.ai/config.json",\n'
        '  "plugin": [\n'
        f'    "{uri}"\n'
        "  ]\n"
        "}\n",
        encoding="utf-8",
    )
    print(f"created {path}")
    raise SystemExit(0)
text = path.read_text(encoding="utf-8")
if "agent-reviewer-tui.tsx" in text:
    print(f"tui.jsonc already lists overlay ({path})")
    raise SystemExit(0)
try:
    data = json.loads(text)
except json.JSONDecodeError:
    print(
        f"WARN: {path} is not JSON; add this plugin URI yourself:\n  {uri}",
        file=sys.stderr,
    )
    raise SystemExit(0)
plugins = data.get("plugin")
if plugins is None:
    data["plugin"] = [uri]
elif isinstance(plugins, list):
    if uri not in plugins and not any(
        isinstance(x, str) and x.endswith("agent-reviewer-tui.tsx") for x in plugins
    ):
        plugins.append(uri)
        data["plugin"] = plugins
    else:
        print(f"tui.jsonc already lists overlay ({path})")
        raise SystemExit(0)
else:
    print(
        f"WARN: {path} plugin field is not an array; add URI yourself:\n  {uri}",
        file=sys.stderr,
    )
    raise SystemExit(0)
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(f"updated {path} plugin array")
PY
}

need_cmd python3
pick_hash_cmd
echo "checksum: $HASH_CMD"
if ! command -v kilo >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1; then
	echo "WARN: neither 'kilo' nor 'bun' is on PATH. The plugin still copies;"
	echo "      install Kilo CLI so auto-scan can load plugin/*.ts."
fi

resolve_root
echo "repo:   $REPO_URL"
echo "source: $ROOT"
echo "dest:   $DEST"
fetch_repo
if [[ "$DRY_RUN" -eq 0 ]] && ! checkout_looks_like_repo "$ROOT"; then
	echo "clone/checkout is missing plugin files: $ROOT" >&2
	exit 1
fi

install_file "$ROOT/agent-reviewer.ts" "$DEST/plugin/agent-reviewer.ts"
install_file "$ROOT/tui/agent-reviewer-tui.tsx" "$DEST/tui/agent-reviewer-tui.tsx"
install_file "$ROOT/agent-reviewer.json.example" "$DEST/plugin/agent-reviewer.json.example"
ensure_tui_jsonc

LIVE_JSON="$DEST/agent-reviewer.json"
if [[ -e "$LIVE_JSON" ]]; then
	echo "left untouched: $LIVE_JSON"
else
	echo "NOTE: $LIVE_JSON is missing."
	echo "      Copy $ROOT/agent-reviewer.json.example there yourself,"
	echo "      fill {PROVIDER_KEY} placeholders, chmod 600."
	echo "      This script will not create or write that file."
fi

echo
echo "Done. Restart Kilo so the .ts / TUI plugin reload."
echo "JSON config is hot-reloaded and was not modified."
