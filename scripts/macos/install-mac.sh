#!/usr/bin/env bash
# Idempotent provisioning for the in-car Mac Mini. Run from inside the repo on
# the Mac itself (sitting at it, or via deploy.sh over ssh). Safe to re-run;
# each step checks whether it's already in the desired state.
#
#   cd ~/vehicle-nav-gps-bridge
#   ./scripts/macos/install-mac.sh
#
# Flags:
#   --no-power    skip the sudo pmset/systemsetup power tweaks
#   --no-kiosk    install + start the bridge only (dev box, not the car)
#
# What it does:
#   1. checks Homebrew, installs node (>=18) and Google Chrome if missing
#   2. npm install for gps-bridge, npm install + build for display
#   3. seeds ~/.config/vehicle-nav/bridge.env from the example (never overwrites)
#   4. renders the two LaunchAgents into ~/Library/LaunchAgents and (re)loads them
#   5. disables sleep / display sleep / screensaver, enables auto-restart after
#      power loss (needs sudo — the only privileged step)
# Things it can't do for you (macOS wants a password in a GUI): enabling
# automatic login and disabling FileVault. It prints those at the end.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

DO_POWER=1
DO_KIOSK=1
for arg in "$@"; do
  case "$arg" in
    --no-power) DO_POWER=0 ;;
    --no-kiosk) DO_KIOSK=0 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[install] this script is for macOS. Aborting." >&2
  exit 1
fi
if [[ "$(id -u)" == "0" ]]; then
  echo "[install] refusing to run as root. Run as the login user that will own the kiosk session." >&2
  exit 1
fi
if [[ ! -f "$REPO_DIR/gps-bridge/bridge.js" ]]; then
  echo "[install] gps-bridge/bridge.js missing under $REPO_DIR — wrong directory?" >&2
  exit 1
fi

TARGET_USER="$(id -un)"
UID_NUM="$(id -u)"
echo "[install] repo:   $REPO_DIR"
echo "[install] user:   $TARGET_USER (uid $UID_NUM)"
echo "[install] macOS:  $(sw_vers -productVersion) $(uname -m)"

# ---------------------------------------------------------------------------
# Homebrew + node + browser
# ---------------------------------------------------------------------------

# Homebrew lives in /opt/homebrew on Apple silicon, /usr/local on Intel.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v brew >/dev/null 2>&1; then
  cat >&2 <<'MSG'
[install] Homebrew not found. Install it first (it needs your password interactively):

  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

then re-run this script.
MSG
  exit 1
fi
echo "[install] brew:   $(brew --prefix)"

if ! command -v node >/dev/null 2>&1; then
  echo "[install] installing node via Homebrew..."
  brew install node
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 18 )); then
  echo "[install] node $NODE_MAJOR too old (need 18+). Try: brew upgrade node" >&2
  exit 1
fi
echo "[install] node $(node --version) / npm $(npm --version)"

if (( DO_KIOSK )); then
  have_browser=0
  for c in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app" \
           "/Applications/Chromium.app" "$HOME/Applications/Chromium.app"; do
    [[ -d "$c" ]] && have_browser=1
  done
  if (( have_browser )); then
    echo "[install] Chromium-based browser already present"
  else
    echo "[install] installing Google Chrome via Homebrew cask..."
    brew install --cask google-chrome
  fi
  # Gatekeeper puts a quarantine flag on downloaded apps; the first launch then
  # shows an "are you sure you want to open it?" dialog that nobody is there to
  # click on an unattended boot. Strip it so the kiosk starts hands-free.
  for c in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app" \
           "/Applications/Chromium.app" "$HOME/Applications/Chromium.app"; do
    if [[ -d "$c" ]] && xattr -p com.apple.quarantine "$c" >/dev/null 2>&1; then
      echo "[install] removing Gatekeeper quarantine flag from $c"
      xattr -dr com.apple.quarantine "$c" 2>/dev/null || sudo xattr -dr com.apple.quarantine "$c"
    fi
  done
fi

# ---------------------------------------------------------------------------
# npm install + display build
# ---------------------------------------------------------------------------

echo "[install] npm install (gps-bridge)..."
( cd "$REPO_DIR/gps-bridge" && npm install --no-audit --no-fund )

echo "[install] npm install + build (display)..."
( cd "$REPO_DIR/display" && npm install --no-audit --no-fund && npm run build )

# ---------------------------------------------------------------------------
# Env file
# ---------------------------------------------------------------------------

ENV_DIR="$HOME/.config/vehicle-nav"
ENV_DST="$ENV_DIR/bridge.env"
mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_DST" ]]; then
  echo "[install] seeding $ENV_DST (edit it to override defaults)"
  cp "$SCRIPT_DIR/bridge.env.example" "$ENV_DST"
else
  echo "[install] $ENV_DST exists; leaving local edits intact"
fi

# ---------------------------------------------------------------------------
# LaunchAgents
# ---------------------------------------------------------------------------

LOG_DIR="$HOME/Library/Logs/vehicle-nav"
AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LOG_DIR" "$AGENTS_DIR"

# Render a plist template (__REPO__/__HOME__ placeholders) into place and
# (re)load it. bootout first so a changed plist is actually picked up;
# launchctl ignores edits to an already-loaded job otherwise.
install_agent() {
  local label="$1"
  local src="$SCRIPT_DIR/$label.plist"
  local dst="$AGENTS_DIR/$label.plist"
  local tmp
  tmp="$(mktemp)"
  sed -e "s|__REPO__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" "$src" > "$tmp"
  plutil -lint -s "$tmp" >/dev/null

  if [[ -f "$dst" ]] && cmp -s "$tmp" "$dst"; then
    echo "[install] $label plist already up to date"
  else
    echo "[install] installing $label -> $dst"
    install -m 0644 "$tmp" "$dst"
  fi
  rm -f "$tmp"

  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$dst"
  launchctl kickstart "gui/$UID_NUM/$label" 2>/dev/null || true
  echo "[install] $label loaded"
}

install_agent com.vehicle-nav.bridge
if (( DO_KIOSK )); then
  install_agent com.vehicle-nav.kiosk
else
  launchctl bootout "gui/$UID_NUM/com.vehicle-nav.kiosk" 2>/dev/null || true
  rm -f "$AGENTS_DIR/com.vehicle-nav.kiosk.plist"
  echo "[install] --no-kiosk: kiosk agent not installed"
fi

# ---------------------------------------------------------------------------
# Power / sleep / screensaver
# ---------------------------------------------------------------------------

if (( DO_POWER )); then
  echo "[install] power settings (sudo)..."
  # Never sleep, never blank the display, come back after a power cut. The
  # kiosk also wraps Chrome in caffeinate; these make the box safe even when
  # the kiosk agent isn't running.
  sudo pmset -a sleep 0 displaysleep 0 disksleep 0 autorestart 1 womp 1
  # Auto-restart after power failure. On newer macOS, systemsetup may need
  # Full Disk Access for the terminal; don't fail the install over it.
  sudo systemsetup -setrestartpowerfailure on >/dev/null 2>&1 \
    || echo "[install] (systemsetup -setrestartpowerfailure refused; pmset autorestart 1 covers most cases)"
  # Screensaver off for this user.
  defaults -currentHost write com.apple.screensaver idleTime -int 0
  echo "[install] sleep/display sleep/screensaver disabled, autorestart on"
else
  echo "[install] --no-power: skipping pmset/systemsetup"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

HOSTNAME_LOCAL="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"
WS_PORT_VAL="$(sed -n 's/^WS_PORT=\(.*\)$/\1/p' "$ENV_DST" | tail -1)"
WS_PORT_VAL="${WS_PORT_VAL:-8080}"

echo
echo "[install] done."
echo
echo "  status / restart:  scripts/macos/ctl.sh status | restart bridge | stop kiosk"
echo "  bridge logs:       scripts/macos/ctl.sh logs bridge   ($LOG_DIR/bridge.log)"
echo "  kiosk logs:        scripts/macos/ctl.sh logs kiosk"
echo "  config:            $ENV_DST"
echo "  control page:      http://$HOSTNAME_LOCAL:$WS_PORT_VAL/  (phone on same Wi-Fi)"
echo "  display app:       http://$HOSTNAME_LOCAL:$WS_PORT_VAL/app/"
echo "  health:            curl http://localhost:$WS_PORT_VAL/healthz"
echo
echo "  One-time manual steps for an unattended car install:"
echo "    - System Settings > Users & Groups > Automatic login: $TARGET_USER"
echo "      (requires FileVault OFF: System Settings > Privacy & Security > FileVault)"
echo "    - If the macOS firewall is on, allow 'node' incoming connections when prompted,"
echo "      or the phone control page won't reach the bridge."
echo "    - For deploy.sh from another machine: System Settings > General > Sharing > Remote Login."
if (( DO_KIOSK )); then
  echo
  echo "  The kiosk is starting now. Reboot to confirm it comes up unattended:"
  echo "    sudo reboot"
fi
