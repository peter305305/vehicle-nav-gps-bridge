#!/usr/bin/env bash
# Rsync the repo to the in-car Mac Mini, then run install-mac.sh remotely. Run
# from a dev machine (macOS or Linux) with key-based SSH access to the Mac
# already set up (System Settings > General > Sharing > Remote Login on the
# target).
#
#   ./scripts/deploy.sh                          # uses defaults below
#   MAC_SSH=marlon@carmini.local ./scripts/deploy.sh
#   ./scripts/deploy.sh --target=user@host
#   ./scripts/deploy.sh --skip-install           # rsync only, don't reinstall
#   ./scripts/deploy.sh --no-restart             # install but don't restart bridge
#   ./scripts/deploy.sh --dry-run                # show what rsync would send
#
# Extra flags after `--` are passed through to install-mac.sh, e.g.
#   ./scripts/deploy.sh -- --no-power

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults — override via env or flags. MAC_SSH is `user@host`; the user
# defaults to your local login, which is the common case for a personal Mini.
MAC_SSH="${MAC_SSH:-$(id -un)@macmini.local}"

SKIP_INSTALL=0
SKIP_RESTART=0
DRY_RUN=0
EXTRA_RSYNC=()
INSTALL_ARGS=()

while (( $# )); do
  case "$1" in
    --skip-install) SKIP_INSTALL=1 ;;
    --no-restart)   SKIP_RESTART=1 ;;
    --dry-run)      DRY_RUN=1; EXTRA_RSYNC+=("--dry-run") ;;
    --target=*)     MAC_SSH="${1#--target=}" ;;
    --)             shift; INSTALL_ARGS=("$@"); break ;;
    -h|--help)      sed -n '2,15p' "$0"; exit 0 ;;
    *)              echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

MAC_USER="${MAC_SSH%@*}"
MAC_HOST="${MAC_SSH#*@}"
MAC_DEST="${MAC_DEST:-/Users/$MAC_USER/vehicle-nav-gps-bridge}"

echo "[deploy] source: $REPO_DIR"
echo "[deploy] target: $MAC_SSH:$MAC_DEST"

# ---- reachability check ----------------------------------------------------
echo "[deploy] probing ssh..."
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$MAC_SSH" true 2>/dev/null; then
  echo "[deploy] ssh to $MAC_SSH failed. Make sure Remote Login is on and key auth works (try: ssh $MAC_SSH)" >&2
  exit 1
fi

# ---- rsync source over -----------------------------------------------------
# Excludes: build artifacts and dev clutter. node_modules MUST be rebuilt on
# the target because serialport ships native bindings per arch (an Intel dev
# Mac vs an Apple-silicon Mini, for instance).
ssh "$MAC_SSH" "mkdir -p '$MAC_DEST'"
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  ${EXTRA_RSYNC[@]+"${EXTRA_RSYNC[@]}"} \
  "$REPO_DIR/" "$MAC_SSH:$MAC_DEST/"

if (( DRY_RUN )); then
  echo "[deploy] dry run, stopping before remote install."
  exit 0
fi

# ---- remote provision ------------------------------------------------------
if (( SKIP_INSTALL )); then
  echo "[deploy] --skip-install set, not running install-mac.sh"
else
  echo "[deploy] running install-mac.sh on $MAC_HOST..."
  # -t allocates a TTY so the sudo password prompt for pmset works. Pass
  # `-- --no-power` to skip that step entirely for a password-free deploy.
  ssh -t "$MAC_SSH" "cd '$MAC_DEST' && bash scripts/macos/install-mac.sh ${INSTALL_ARGS[*]:-}"
fi

# ---- restart bridge --------------------------------------------------------
if (( SKIP_RESTART )); then
  echo "[deploy] --no-restart set, not bouncing the bridge"
else
  echo "[deploy] restarting bridge..."
  # id -u must resolve on the remote, hence the single quotes.
  ssh "$MAC_SSH" 'launchctl kickstart -k "gui/$(id -u)/com.vehicle-nav.bridge"'
fi

# ---- summary ---------------------------------------------------------------
echo
echo "[deploy] done."
echo "  control page:   http://$MAC_HOST:8080/"
echo "  display app:    http://$MAC_HOST:8080/app/"
echo "  bridge logs:    ssh $MAC_SSH 'tail -f ~/Library/Logs/vehicle-nav/bridge.log'"
echo "  status:         ssh $MAC_SSH '$MAC_DEST/scripts/macos/ctl.sh status'"
