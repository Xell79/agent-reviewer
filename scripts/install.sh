#!/usr/bin/env bash
# Install or update agent-reviewer into the Kilo config dir.
#
# LOCKED: this script must NEVER create, copy, merge, overwrite, truncate,
# or chmod agent-reviewer.json (live, repo, or AGENT_REVIEWER_CONFIG).
# Keys live only in that file; the operator owns it. Template is
# agent-reviewer.json.example — copy it yourself if missing.
set -euo pipefail

# ── Colors (auto-detect terminal support) ──────────────────────────────
if [[ -t 1 ]] && [[ "${TERM:-}" != "dumb" ]] && [[ -n "${TERM:-}" ]]; then
	_c_red=$'\033[0;31m'    # errors
	_c_yellow=$'\033[0;33m' # warnings, notes
	_c_green=$'\033[0;32m'  # success
	_c_cyan=$'\033[0;36m'   # info
	_c_bold=$'\033[1m'      # headers
	_c_dim=$'\033[2m'       # dry-run, paths
	_c_reset=$'\033[0m'
else
	_c_red=''
	_c_yellow=''
	_c_green=''
	_c_cyan=''
	_c_bold=''
	_c_dim=''
	_c_reset=''
fi

# shellcheck disable=SC2059
msg_ok()   { printf "${_c_green}✓${_c_reset} %s\n" "$*"; }
# shellcheck disable=SC2059
msg_info() { printf "${_c_cyan}•${_c_reset} %s\n" "$*"; }
# shellcheck disable=SC2059
msg_warn() { printf "${_c_yellow}⚠${_c_reset} %s\n" "$*"; }
# shellcheck disable=SC2059
msg_err()  { printf "${_c_red}✗${_c_reset} %s\n" "$*" >&2; }
# shellcheck disable=SC2059
msg_hdr()  { printf "\n${_c_bold}%s${_c_reset}\n" "$*"; }
# shellcheck disable=SC2059
msg_path() { printf "  ${_c_dim}%s${_c_reset}" "$*"; }
# shellcheck disable=SC2059
msg_dry()  { printf "  ${_c_dim}dry-run: %s${_c_reset}\n" "$*"; }

REPO_URL="${AGENT_REVIEWER_REPO:-https://github.com/Xell79/agent-reviewer.git}"
SRC_DIR="${AGENT_REVIEWER_SRC:-${XDG_DATA_HOME:-${HOME}/.local/share}/kilo/src/agent-reviewer}"
DEST="${KILO_CONFIG:-${HOME}/.config/kilo}"
DRY_RUN=0
NO_PULL=0
SRC_EXPLICIT=0
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
		SRC_EXPLICIT=1
		shift 2
		;;
	--repo)
		REPO_URL="${2:?--repo requires a URL}"
		shift 2
		;;
	*)
		msg_err "unknown argument: $1"
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
		msg_err "REFUSED: scripts must never write agent-reviewer.json ($p)"
		exit 1
	fi
}

run() {
	if [[ "$DRY_RUN" -eq 1 ]]; then
		msg_dry "$*"
		return 0
	fi
	"$@"
}

need_cmd() {
	local c="$1"
	if ! command -v "$c" >/dev/null 2>&1; then
		msg_err "missing dependency: $c"
		msg_err "install it, then re-run this script."
		exit 1
	fi
}

checkout_looks_like_repo() {
	local d="$1"
	[[ -f "$d/agent-reviewer.ts" && -f "$d/tui/agent-reviewer-tui.tsx" ]]
}

normalize_git_url() {
	local u="${1%.git}"
	u="${u%/}"
	u="${u#git@}"
	u="${u#https://}"
	u="${u#http://}"
	u="${u#ssh://}"
	u="${u/:/\/}"
	printf '%s\n' "$u"
}

same_origin() {
	local origin
	origin="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"
	[[ -n "$origin" ]] || return 1
	[[ "$(normalize_git_url "$origin")" == "$(normalize_git_url "$REPO_URL")" ]]
}

# SRC_DIR is a disposable cache. Hard-reset is OK there (force-push, leftover
# LICENSE-only clone). Never hard-reset a checkout next to this script.
repair_cache_checkout() {
	msg_info "repairing checkout: $ROOT"
	if [[ "$DRY_RUN" -eq 1 ]]; then
		msg_dry "git -C $ROOT fetch --depth 1 origin"
		msg_dry "git -C $ROOT reset --hard origin/main"
		return 0
	fi
	git -C "$ROOT" fetch --depth 1 origin
	if git -C "$ROOT" rev-parse --verify origin/main >/dev/null 2>&1; then
		git -C "$ROOT" reset --hard origin/main
	else
		git -C "$ROOT" reset --hard FETCH_HEAD
	fi
}

resolve_root() {
	if [[ "$SRC_EXPLICIT" -eq 1 ]]; then
		ROOT="$SRC_DIR"
		return 0
	fi
	local script="${BASH_SOURCE[0]:-}"
	if [[ -n "$script" && -f "$script" ]]; then
		local here dir
		dir="$(cd "$(dirname "$script")" && pwd)"
		# scripts/install.sh → repo root; also allow a root-level wrapper
		if [[ "$(basename "$dir")" == "scripts" ]]; then
			here="$(cd "$dir/.." && pwd)"
		else
			here="$dir"
		fi
		if checkout_looks_like_repo "$here"; then
			ROOT="$here"
			return 0
		fi
	fi
	ROOT="$SRC_DIR"
}

fetch_repo() {
	need_cmd git
	local is_cache=0
	[[ "$ROOT" == "$SRC_DIR" ]] && is_cache=1

	# Developer / local clone next to this script: copy as-is. Never pull
	# (no upstream, dirty worktree, force-push). Cache path is disposable.
	if [[ "$is_cache" -eq 0 ]]; then
		if checkout_looks_like_repo "$ROOT"; then
			msg_ok "using local checkout: $ROOT"
			return 0
		fi
		msg_err "REFUSED: local checkout missing plugin files: $ROOT"
		exit 1
	fi

	if checkout_looks_like_repo "$ROOT" && [[ "$NO_PULL" -eq 1 ]]; then
		msg_ok "using existing checkout (no pull): $ROOT"
		return 0
	fi
	# Complete or leftover cache (LICENSE-only after a GitHub force-push)
	if [[ -d "$ROOT/.git" ]]; then
		if ! same_origin; then
			msg_err "REFUSED: $ROOT is a git checkout of a different repo"
			exit 1
		fi
		repair_cache_checkout
		if [[ "$DRY_RUN" -eq 0 ]] && ! checkout_looks_like_repo "$ROOT"; then
			msg_err "repair left $ROOT without plugin files"
			exit 1
		fi
		return 0
	fi
	if [[ -e "$ROOT" ]] && checkout_looks_like_repo "$ROOT"; then
		msg_ok "using existing files (not a git checkout): $ROOT"
		return 0
	fi
	if [[ -e "$ROOT" ]]; then
		msg_err "REFUSED: $ROOT exists and is not this repo checkout"
		exit 1
	fi
	msg_info "cloning $REPO_URL → $ROOT"
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
	msg_err "missing checksum tool (need one of: sha256sum, sha256, md5sum, md5, openssl)"
	exit 1
}

# Semver from dest/source plugin (PLUGIN_VERSION = "x.y.z"). Missing → unknown.
plugin_version_from_ts() {
	local f="$1"
	local v=""
	if [[ -f "$f" ]]; then
		v="$(sed -n 's/.*PLUGIN_VERSION[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -n 1)"
	fi
	if [[ -z "$v" ]]; then
		printf 'unknown\n'
	else
		printf '%s\n' "$v"
	fi
}

repo_version() {
	local f="$ROOT/VERSION"
	if [[ ! -f "$f" ]]; then
		printf 'unknown\n'
		return 0
	fi
	tr -d '[:space:]' <"$f"
	printf '\n'
}

report_version_drift() {
	local repo dest_ver
	repo="$(repo_version)"
	dest_ver="$(plugin_version_from_ts "$DEST/plugin/agent-reviewer.ts")"
	if [[ "$repo" == "$dest_ver" && "$repo" != "unknown" ]]; then
		msg_ok "version: repo ${repo}  dest ${dest_ver}  ${_c_green}in sync${_c_reset}"
	else
		msg_info "version: repo ${repo}  dest ${dest_ver}"
		# shellcheck disable=SC2059
		printf "  ${_c_yellow}→ update available${_c_reset}: dest ${dest_ver} → repo ${repo}\n"
	fi
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
			msg_dry "would install $dest (after clone/repair)"
			return 0
		fi
		msg_err "missing source: $src"
		exit 1
	fi
	src_hash="$(file_hash "$src")"
	if [[ -f "$dest" ]]; then
		dest_hash="$(file_hash "$dest")"
		if [[ -n "$src_hash" && "$src_hash" == "$dest_hash" ]]; then
			# shellcheck disable=SC2059
		printf "  ${_c_dim}unchanged${_c_reset} %s\n" "$dest"
			return 0
		fi
	fi
	if [[ "$DRY_RUN" -eq 1 ]]; then
		msg_dry "would install $dest"
		return 0
	fi
	mkdir -p "$(dirname "$dest")"
	cp -f "$src" "$dest"
	chmod 644 "$dest"
	msg_ok "installed $dest"
}

ensure_tui_jsonc() {
	local tui_jsonc="$DEST/tui.jsonc"
	local uri="file://${DEST}/tui/agent-reviewer-tui.tsx"
	die_if_forbidden "$tui_jsonc"
	if [[ "$DRY_RUN" -eq 1 ]]; then
		msg_dry "ensure tui.jsonc plugin entry ${uri}"
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
msg_info "checksum: ${_c_bold}$HASH_CMD${_c_reset}"
if ! command -v kilo >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1; then
	msg_warn "neither 'kilo' nor 'bun' is on PATH. The plugin still copies;"
	printf "         install Kilo CLI so auto-scan can load plugin/*.ts.\n"
fi

resolve_root
# shellcheck disable=SC2059
printf "${_c_bold}repo:${_c_reset}   %s\n" "$REPO_URL"
# shellcheck disable=SC2059
printf "${_c_bold}source:${_c_reset} %s\n" "$ROOT"
# shellcheck disable=SC2059
printf "${_c_bold}dest:${_c_reset}   %s\n" "$DEST"
fetch_repo
if [[ "$DRY_RUN" -eq 0 ]] && ! checkout_looks_like_repo "$ROOT"; then
	msg_err "clone/checkout is missing plugin files: $ROOT"
	exit 1
fi

install_file "$ROOT/agent-reviewer.ts" "$DEST/plugin/agent-reviewer.ts"
install_file "$ROOT/lib/least-connections.ts" "$DEST/plugin/lib/least-connections.ts"
install_file "$ROOT/tui/agent-reviewer-tui.tsx" "$DEST/tui/agent-reviewer-tui.tsx"
install_file "$ROOT/agent-reviewer.json.example" "$DEST/plugin/agent-reviewer.json.example"
ensure_tui_jsonc
report_version_drift

LIVE_JSON="$DEST/agent-reviewer.json"
if [[ -e "$LIVE_JSON" ]]; then
	# shellcheck disable=SC2059
	printf "  ${_c_dim}left untouched${_c_reset} %s\n" "$LIVE_JSON"
else
	msg_warn "$LIVE_JSON is missing."
	# shellcheck disable=SC2059
	printf "  Copy ${_c_bold}$ROOT/agent-reviewer.json.example${_c_reset} there yourself,\n"
	printf "  fill {PROVIDER_KEY} placeholders, chmod 600.\n"
	printf "  This script will not create or write that file.\n"
fi

echo
# shellcheck disable=SC2059
printf "${_c_bold}${_c_green}Done.${_c_reset} Restart Kilo so the .ts / TUI plugin reload.\n"
# shellcheck disable=SC2059
printf "${_c_dim}JSON config is hot-reloaded and was not modified.${_c_reset}\n"
