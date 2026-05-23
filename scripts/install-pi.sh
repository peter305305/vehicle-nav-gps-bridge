#!/usr/bin/env bash
# Idempotent provisioning for the in-car Pi. Run from inside the repo on the
# Pi itself, after the source has been rsynced over. Safe to re-run; each step
# checks whether it's already in the desired state.
#
#   cd ~/vehicle-nav-gps-bridge
#   ./scripts/install-pi.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths and target user
# ---------------------------------------------------------------------------

# Detect repo root from this script's location so it doesn't matter where it's
# invoked from. install-pi.sh lives at <repo>/scripts/install-pi.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Target user — defaults to whoever's running install-pi.sh. Must NOT be root,
# since the systemd unit and kiosk autostart both run as this user.
TARGET_USER="${TARGET_USER:-$(id -un)}"
if [[ "$TARGET_USER" == "root" ]]; then
  echo "[install] refusing to provision as root. Run as the login user (use sudo only where this script asks)." >&2
  exit 1
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
if [[ -z "$TARGET_HOME" || ! -d "$TARGET_HOME" ]]; then
  echo "[install] cannot resolve home directory for $TARGET_USER" >&2
  exit 1
fi

echo "[install] repo:   $REPO_DIR"
echo "[install] user:   $TARGET_USER"
echo "[install] home:   $TARGET_HOME"

# Sanity check that we're really inside the project.
if [[ ! -f "$REPO_DIR/gps-bridge/bridge.js" ]]; then
  echo "[install] gps-bridge/bridge.js missing under $REPO_DIR — wrong directory?" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# APT dependencies
# ---------------------------------------------------------------------------

echo "[install] apt deps..."
APT_PKGS=(nodejs npm chromium curl unclutter x11-xserver-utils ca-certificates)
MISSING=()
for pkg in "${APT_PKGS[@]}"; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then MISSING+=("$pkg"); fi
done
if (( ${#MISSING[@]} )); then
  echo "[install] installing: ${MISSING[*]}"
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${MISSING[@]}"
else
  echo "[install] all apt deps already present"
fi

# Verify Node is recent enough (bridge requires >=18; trixie ships 20).
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 18 )); then
  echo "[install] node $NODE_MAJOR too old (need 18+). Install a newer node manually." >&2
  exit 1
fi
echo "[install] node $(node --version) / npm $(npm --version)"

# ---------------------------------------------------------------------------
# dialout group — needed to read the GPS serial device without root
# ---------------------------------------------------------------------------

if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx dialout; then
  echo "[install] $TARGET_USER already in dialout"
else
  echo "[install] adding $TARGET_USER to dialout group"
  sudo usermod -aG dialout "$TARGET_USER"
  echo "[install] NOTE: log out and back in (or reboot) for group change to take effect"
fi

# ---------------------------------------------------------------------------
# npm install + display build
# ---------------------------------------------------------------------------

echo "[install] npm install (gps-bridge)..."
( cd "$REPO_DIR/gps-bridge" && npm install --no-audit --no-fund )

echo "[install] npm install + build (display)..."
( cd "$REPO_DIR/display" && npm install --no-audit --no-fund && npm run build )

# ---------------------------------------------------------------------------
# systemd unit
# ---------------------------------------------------------------------------

UNIT_SRC="$REPO_DIR/scripts/systemd/vehicle-nav-bridge.service"
UNIT_DST="/etc/systemd/system/vehicle-nav-bridge@.service"

if [[ ! -f "$UNIT_DST" ]] || ! sudo cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  echo "[install] installing systemd unit -> $UNIT_DST"
  sudo install -m 0644 "$UNIT_SRC" "$UNIT_DST"
  sudo systemctl daemon-reload
else
  echo "[install] systemd unit already up to date"
fi

ENV_SRC="$REPO_DIR/scripts/systemd/vehicle-nav-bridge.env.example"
ENV_DST="/etc/default/vehicle-nav-bridge"
if [[ ! -f "$ENV_DST" ]]; then
  echo "[install] seeding $ENV_DST (edit on the Pi to override defaults)"
  # Substitute the actual home path so DISPLAY_DIST_DIR is correct for this user.
  sudo sh -c "sed 's|/home/beastpi|$TARGET_HOME|g' '$ENV_SRC' > '$ENV_DST'"
  sudo chmod 0644 "$ENV_DST"
else
  echo "[install] $ENV_DST exists; leaving local edits intact"
fi

INSTANCE="vehicle-nav-bridge@${TARGET_USER}.service"
sudo systemctl enable "$INSTANCE" >/dev/null
sudo systemctl restart "$INSTANCE"
echo "[install] systemd: $INSTANCE active"

# ---------------------------------------------------------------------------
# udev rule for the u-blox receiver
# ---------------------------------------------------------------------------

UDEV_SRC="$REPO_DIR/scripts/udev/99-vehicle-nav-gps.rules"
UDEV_DST="/etc/udev/rules.d/99-vehicle-nav-gps.rules"
# Earlier installs dropped a u-blox-only rule; remove it so we don't have two
# rules racing to create the same/different symlinks for the same device.
OLD_UDEV="/etc/udev/rules.d/99-vehicle-nav-ublox.rules"
if [[ -f "$OLD_UDEV" ]]; then
  echo "[install] removing obsolete udev rule $OLD_UDEV"
  sudo rm -f "$OLD_UDEV"
fi
if [[ ! -f "$UDEV_DST" ]] || ! sudo cmp -s "$UDEV_SRC" "$UDEV_DST"; then
  echo "[install] installing udev rule -> $UDEV_DST"
  sudo install -m 0644 "$UDEV_SRC" "$UDEV_DST"
  sudo udevadm control --reload-rules
  sudo udevadm trigger --subsystem-match=tty
else
  echo "[install] udev rule already up to date"
fi

# ---------------------------------------------------------------------------
# Kiosk autostart (user-level XDG autostart entry)
# ---------------------------------------------------------------------------

KIOSK_DESKTOP_SRC="$REPO_DIR/scripts/kiosk/vehicle-nav-kiosk.desktop"
AUTOSTART_DIR="$TARGET_HOME/.config/autostart"
KIOSK_DESKTOP_DST="$AUTOSTART_DIR/vehicle-nav-kiosk.desktop"

mkdir -p "$AUTOSTART_DIR"
# Rewrite the hard-coded /home/beastpi path so the .desktop works for any user.
sed "s|/home/beastpi|$TARGET_HOME|g" "$KIOSK_DESKTOP_SRC" > "$KIOSK_DESKTOP_DST"
chmod 0644 "$KIOSK_DESKTOP_DST"
echo "[install] kiosk autostart -> $KIOSK_DESKTOP_DST"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "[install] done."
echo
echo "  bridge service:   systemctl status $INSTANCE"
echo "  bridge logs:      journalctl -u $INSTANCE -f"
echo "  control page:     http://$(hostname).local:8080/  (also at LAN IPs)"
echo "  display app:      http://$(hostname).local:8080/app/"
echo "  health:           curl http://localhost:8080/healthz"
echo
echo "  Kiosk launches on next desktop login. Reboot to verify:"
echo "    sudo reboot"
