#!/bin/bash
# Day-to-day control of the two LaunchAgents without remembering launchctl's
# gui/<uid>/ domain syntax.
#
#   scripts/macos/ctl.sh status
#   scripts/macos/ctl.sh restart bridge
#   scripts/macos/ctl.sh stop kiosk        # get the desktop back
#   scripts/macos/ctl.sh start kiosk
#   scripts/macos/ctl.sh logs bridge       # tail -f
set -euo pipefail

UID_NUM="$(id -u)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/vehicle-nav"

label_for() {
  case "$1" in
    bridge) echo com.vehicle-nav.bridge ;;
    kiosk)  echo com.vehicle-nav.kiosk ;;
    *) echo "unknown service '$1' (bridge|kiosk)" >&2; exit 2 ;;
  esac
}

targets() {
  if (( $# )); then echo "$@"; else echo bridge kiosk; fi
}

cmd="${1:-status}"; shift || true

case "$cmd" in
  status)
    for s in $(targets "$@"); do
      l="$(label_for "$s")"
      if launchctl print "gui/$UID_NUM/$l" >/dev/null 2>&1; then
        pid="$(launchctl print "gui/$UID_NUM/$l" 2>/dev/null | awk '/^\s*pid = /{print $3}')"
        echo "$s: loaded${pid:+, running (pid $pid)}"
      else
        echo "$s: not loaded"
      fi
    done
    if command -v curl >/dev/null; then
      echo -n "healthz: "; curl -fsS --max-time 1 "http://localhost:${WS_PORT:-8080}/healthz" 2>/dev/null || echo "(bridge not answering)"
      echo
    fi
    ;;
  start)
    for s in $(targets "$@"); do
      l="$(label_for "$s")"
      launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/$l.plist" 2>/dev/null || true
      launchctl kickstart "gui/$UID_NUM/$l"
      echo "$s: started"
    done
    ;;
  stop)
    for s in $(targets "$@"); do
      l="$(label_for "$s")"
      launchctl bootout "gui/$UID_NUM/$l" 2>/dev/null || true
      echo "$s: stopped (won't return until 'start' or next login)"
    done
    ;;
  restart)
    for s in $(targets "$@"); do
      l="$(label_for "$s")"
      if launchctl print "gui/$UID_NUM/$l" >/dev/null 2>&1; then
        launchctl kickstart -k "gui/$UID_NUM/$l"
      else
        launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/$l.plist"
      fi
      echo "$s: restarted"
    done
    ;;
  logs)
    s="${1:-bridge}"
    exec tail -n 50 -f "$LOG_DIR/$s.log"
    ;;
  *)
    sed -n '2,10p' "$0"; exit 2 ;;
esac
