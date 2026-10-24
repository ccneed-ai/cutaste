#!/bin/sh
# Public bootstrap only. All product behavior comes from the pinned npm package.
set -eu
cutaste_host=${1:-}
case "$cutaste_host" in codex|claude-code) shift ;; *) printf '%s\n' 'Cutaste: expected host codex or claude-code.' >&2; exit 2 ;; esac
cutaste_action=${1:-}
cutaste_fail() {
  if [ "$cutaste_action" = hook ]; then
    if [ "${2:-${cutaste_event:-}}" = SessionStart ]; then printf '%s\n' "$1" >&2; fi
    exit 0
  fi
  printf '%s\n' "$1" >&2
  exit 1
}
cutaste_event=${2:-}
if [ -n "${CUTASTE_NODE:-}" ]; then
  case "$CUTASTE_NODE" in /*) cutaste_node=$CUTASTE_NODE ;; *) cutaste_fail 'Cutaste: CUTASTE_NODE must be an absolute local Node.js path.' ;; esac
else
  cutaste_node=$(command -v node 2>/dev/null || :)
fi
if [ -z "$cutaste_node" ] || [ ! -x "$cutaste_node" ]; then
  cutaste_fail 'Cutaste requires local Node.js >=22.12.0 and npm. Install Node.js and restart the assistant; no global Cutaste or Docker is required.'
fi
if ! "$cutaste_node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || a===22 && b>=12 ? 0 : 1)' >/dev/null 2>&1; then
  cutaste_fail 'Cutaste requires local Node.js >=22.12.0; the selected executable is too old or cannot run.'
fi
cutaste_script_dir=$(CDPATH= cd -- "${0%/*}" && pwd)
export CUTASTE_NODE="$cutaste_node"
exec "$cutaste_node" "$cutaste_script_dir/launch.mjs" "$cutaste_host" "$@"
