#!/usr/bin/env bash
# Thin wrapper so a clone can run ./install.sh from the repo root.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/install.sh" "$@"
