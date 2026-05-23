#!/usr/bin/env bash
# Rsync the repo to the Pi, then run install-pi.sh remotely. Run from a dev
# machine (macOS or Linux) with key-based SSH access to the Pi already set up.
#
#   ./scripts/deploy.sh                       # uses defaults below
#   PI_SSH=pi@othepi.local ./scripts/deploy.sh
#   ./scripts/deploy.sh --skip-install        # rsync only, don't reinstall
#   ./scripts/deploy.sh --no-restart          # install but don't restart bridge

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults — override via env or flags. PI_SSH must include `user@host`.
PI_SSH="${PI_SSH:-beastpi@beastpi.local}"
PI_DEST="${PI_DEST:-/home/$(echo "$PI_SSH" | cut -d@ -f1)/vehicle-nav-gps-bridge}"

SKIP_INSTALL=0
SKIP_RESTART=0
DRY_RUN=0
EXTRA_RSYNC=()

while (( $# )); do
  case "$1" in
    --skip-install) SKIP_INSTALL=1 ;;
    --no-restart)   SKIP_RESTART=1 ;;
    --dry-run)      DRY_RUN=1; EXTRA_RSYNC+=("--dry-run") ;;
    --target=*)     PI_SSH="${1#--target=}" ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *)
      echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# Final sanity on PI_DEST in case --target changed the user.
PI_USER="$(echo "$PI_SSH" | cut -d@ -f1)"
PI_HOST="$(echo "$PI_SSH" | cut -d@ -f2)"
PI_DEST="${PI_DEST_OVERRIDE:-/home/$PI_USER/vehicle-nav-gps-bridge}"

echo "[deploy] source: $REPO_DIR"
echo "[deploy] target: $PI_SSH:$PI_DEST"

# ---- reachability check ----------------------------------------------------
echo "[deploy] probing ssh..."
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$PI_SSH" true 2>/dev/null; then
  echo "[deploy] ssh to $PI_SSH failed. Make sure key auth works (try: ssh $PI_SSH)" >&2
  exit 1
fi

# ---- rsync source over -----------------------------------------------------
# Excludes: build artifacts and dev clutter. node_modules in particular MUST
# be rebuilt on the Pi because serialport ships native bindings per arch.
ssh "$PI_SSH" "mkdir -p '$PI_DEST'"
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  ${EXTRA_RSYNC[@]+"${EXTRA_RSYNC[@]}"} \
  "$REPO_DIR/" "$PI_SSH:$PI_DEST/"

if (( DRY_RUN )); then
  echo "[deploy] dry run, stopping before remote install."
  exit 0
fi

# ---- remote provision ------------------------------------------------------
if (( SKIP_INSTALL )); then
  echo "[deploy] --skip-install set, not running install-pi.sh"
else
  echo "[deploy] running install-pi.sh on $PI_HOST..."
  # -t allocates a TTY so sudo password prompts (if any) work. If you've
  # configured passwordless sudo for this user, this is silent.
  ssh -t "$PI_SSH" "cd '$PI_DEST' && bash scripts/install-pi.sh"
fi

# ---- restart bridge --------------------------------------------------------
if (( SKIP_RESTART )); then
  echo "[deploy] --no-restart set, not bouncing the bridge"
else
  echo "[deploy] restarting vehicle-nav-bridge@$PI_USER..."
  ssh "$PI_SSH" "sudo systemctl restart vehicle-nav-bridge@$PI_USER"
fi

# ---- summary ---------------------------------------------------------------
echo
echo "[deploy] done."
echo "  control page:   http://$PI_HOST:8080/"
echo "  display app:    http://$PI_HOST:8080/app/"
echo "  bridge logs:    ssh $PI_SSH 'journalctl -u vehicle-nav-bridge@$PI_USER -f'"
