#!/bin/bash
# launchd entry point for the in-car display. Waits for the bridge, then runs
# Chrome fullscreen against it, wrapped in `caffeinate` so the Mac never sleeps
# or blanks the display while the kiosk is up. launchd relaunches this script
# if Chrome ever exits.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${VEHICLE_NAV_ENV:-$HOME/.config/vehicle-nav/bridge.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

LOG_DIR="$HOME/Library/Logs/vehicle-nav"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/kiosk.log" 2>&1
echo "---- $(date '+%Y-%m-%dT%H:%M:%S%z') start-kiosk ----"

WS_PORT="${WS_PORT:-8080}"
KIOSK_URL="${KIOSK_URL:-http://localhost:${WS_PORT}/app/}"
HEALTH_URL="${HEALTH_URL:-http://localhost:${WS_PORT}/healthz}"
# Dedicated Chrome profile so the kiosk never inherits extensions, sessions or
# "restore pages?" prompts from a desktop Chrome on the same account.
PROFILE_DIR="$HOME/Library/Application Support/vehicle-nav-kiosk"

# ---- pick a browser ---------------------------------------------------------
find_browser() {
  if [[ -n "${KIOSK_BROWSER:-}" && -x "$KIOSK_BROWSER" ]]; then
    echo "$KIOSK_BROWSER"; return 0
  fi
  local c
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$HOME/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
    if [[ -x "$c" ]]; then echo "$c"; return 0; fi
  done
  return 1
}

if ! BROWSER="$(find_browser)"; then
  echo "no Chromium-based browser found. Install one: brew install --cask google-chrome"
  # Sleep so launchd's KeepAlive doesn't hot-loop; it will retry after this.
  sleep 30
  exit 1
fi
echo "browser: $BROWSER"

# ---- wait for the bridge ----------------------------------------------------
# The bridge is a separate LaunchAgent starting in parallel with this one.
# Without this wait Chrome can latch onto a connection-refused page.
echo "waiting for $HEALTH_URL"
for i in $(seq 1 60); do
  if curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "bridge up after ${i}s"
    break
  fi
  sleep 1
done

# ---- launch -----------------------------------------------------------------
# caffeinate: -d no display sleep, -i no idle sleep, -s no system sleep (on AC,
# which a Mac Mini always is). Dies with Chrome, so nothing lingers.
#
# Chrome flags: no browser UI, no first-run / update / crash-restore nags,
# autoplay allowed (future audio cues), pinch handled by the display itself.
exec caffeinate -dis "$BROWSER" \
  --kiosk \
  --app="$KIOSK_URL" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-component-update \
  --disable-features=TranslateUI,Translate \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required
