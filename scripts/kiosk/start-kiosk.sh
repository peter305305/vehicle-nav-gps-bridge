#!/bin/bash
# Launches Chromium fullscreen against the local bridge for the in-car display.
# Invoked from the XDG autostart .desktop entry once the X11 session is up.

set -u

LOG="${HOME}/.local/state/vehicle-nav-kiosk.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "---- $(date -Is) start-kiosk ----"

KIOSK_URL="${KIOSK_URL:-http://localhost:8080/app/}"
HEALTH_URL="${HEALTH_URL:-http://localhost:8080/healthz}"
USER_DATA="${HOME}/.config/vehicle-nav-kiosk"

# Disable screen blanking, DPMS, and screensaver — passengers should never see
# the dashboard go black mid-trip. These commands no-op if X isn't ready yet,
# so we retry briefly.
for i in 1 2 3 4 5; do
  if xset -q >/dev/null 2>&1; then
    xset s off
    xset -dpms
    xset s noblank
    break
  fi
  sleep 1
done

# Hide the cursor after 2s idle. Backgrounded — dies with the session.
if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 2 -root &
fi

# Wait for the bridge to be reachable before pointing Chromium at it. The bridge
# is a system service that starts in parallel with the X session; without this
# wait Chromium can latch onto a 502/conn-refused page that Vue-style apps
# typically don't recover from cleanly.
echo "waiting for $HEALTH_URL"
for i in $(seq 1 60); do
  if curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "bridge up after ${i}s"
    break
  fi
  sleep 1
done

# Chromium kiosk flags chosen for an in-vehicle display: no chrome UI, no
# update nags, autoplay allowed (in case we ever overlay audio cues), pinch
# disabled (the dashboard touchscreen will be locked by the display itself
# unless the phone control toggles interactive mode), and a dedicated profile
# so cookies/extensions can't leak in from a desktop Chromium install.
exec /usr/bin/chromium \
  --kiosk \
  --app="$KIOSK_URL" \
  --user-data-dir="$USER_DATA" \
  --noerrdialogs \
  --disable-infobars \
  --disable-translate \
  --disable-features=TranslateUI,Translate \
  --disable-session-crashed-bubble \
  --disable-component-update \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --password-store=basic
