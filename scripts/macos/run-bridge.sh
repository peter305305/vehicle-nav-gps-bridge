#!/bin/bash
# launchd entry point for the GPS bridge. Sources the user's env file, makes
# sure Homebrew's node is on PATH (launchd agents start with a minimal PATH),
# then execs bridge.js so launchd supervises node directly.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${VEHICLE_NAV_ENV:-$HOME/.config/vehicle-nav/bridge.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# bridge.js treats DISPLAY_DIST_DIR="" as "disabled" and an unset var as
# "use the default". The env file can't express "unset", so translate:
# empty -> unset (default), "off" -> empty (disabled).
if [[ "${DISPLAY_DIST_DIR:-}" == "" ]]; then
  unset DISPLAY_DIST_DIR
elif [[ "$DISPLAY_DIST_DIR" == "off" ]]; then
  export DISPLAY_DIST_DIR=""
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "[run-bridge] node not found on PATH ($PATH). Install with: brew install node" >&2
  exit 1
fi

cd "$REPO_DIR/gps-bridge" || exit 1
exec node bridge.js
