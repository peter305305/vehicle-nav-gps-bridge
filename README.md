# vehicle-nav-gps-bridge (Mac Mini fork)

A passenger-facing vehicle navigation system built as a monorepo of two services: a GPS bridge that reads NMEA from a USB GPS receiver and broadcasts position over WebSocket, and a fullscreen "Airshow"-style moving-map display that consumes it. This fork targets a **Mac Mini** whose HDMI output feeds a Crestron AV system, running unattended as two launchd agents.

Forked from [peter305305/vehicle-nav-gps-bridge](https://github.com/peter305305/vehicle-nav-gps-bridge), which targets a Raspberry Pi 5. The bridge and display code are shared; only the provisioning under `scripts/` differs.

## Architecture

```
  USB GPS (u-blox M10 / BU-353N)
        │ NMEA over serial (/dev/cu.usb*)
        ▼
  ┌───────────────┐
  │  gps-bridge/  │   Node.js — parses NMEA, broadcasts position    (launchd: com.vehicle-nav.bridge)
  └───────┬───────┘
          │ WebSocket (JSON) + serves display at /app/
          ▼
  ┌───────────────┐
  │   display/    │   Vite + MapLibre — Chrome --kiosk               (launchd: com.vehicle-nav.kiosk)
  └───────┬───────┘
          │ HDMI
          ▼
   Crestron AV system
```

## Repo layout

- `gps-bridge/` — GPS-to-WebSocket service + phone control page. See [gps-bridge/README.md](./gps-bridge/README.md).
- `display/` — passenger-facing moving-map display. See [display/README.md](./display/README.md).
- `scripts/macos/` — Mac Mini provisioning: `install-mac.sh`, two LaunchAgent plists, the kiosk launcher, the env file template, and `ctl.sh` for start/stop/logs.
- `scripts/deploy.sh` — rsync + remote install from a dev machine over SSH.

## Setting up the Mac Mini (canonical setup)

Prereqs on the Mini: macOS 13 or newer, [Homebrew](https://brew.sh) installed, and a user account that will own the kiosk session. Then, sitting at the Mini:

```bash
git clone https://github.com/beem23/vehicle-nav-gps-bridge.git ~/vehicle-nav-gps-bridge
cd ~/vehicle-nav-gps-bridge
./scripts/macos/install-mac.sh
```

The installer is idempotent. It installs `node` and Google Chrome via Homebrew if missing, builds the display, seeds `~/.config/vehicle-nav/bridge.env`, renders and loads the two LaunchAgents into `~/Library/LaunchAgents/`, and (with `sudo`) disables sleep, display sleep and the screensaver and turns on auto-restart after power loss.

Two things macOS won't let a script do, so finish them in System Settings:

1. **Users & Groups → Automatic login** for the kiosk user, so the GUI session (and therefore the agents) comes up after a cold boot. This requires **FileVault off**.
2. If the firewall is on, allow `node` to accept incoming connections when prompted, or the phone control page can't reach the bridge.

Reboot. Chrome launches in `--kiosk` mode at `http://localhost:8080/app/`, the bridge runs as a LaunchAgent, and the GPS is detected automatically and re-attached after unplug/replug or sleep/wake.

Daily control:

```bash
scripts/macos/ctl.sh status
scripts/macos/ctl.sh stop kiosk       # get the desktop back to work on the machine
scripts/macos/ctl.sh start kiosk
scripts/macos/ctl.sh restart bridge   # after editing ~/.config/vehicle-nav/bridge.env
scripts/macos/ctl.sh logs bridge
```

### Deploying from another machine

With Remote Login enabled on the Mini (System Settings → General → Sharing) and key-based SSH set up:

```bash
MAC_SSH=marlon@carmini.local ./scripts/deploy.sh
```

That rsyncs the source over, runs `install-mac.sh` remotely, and restarts the bridge. `--skip-install`, `--no-restart` and `--dry-run` are available; `-- --no-power` skips the sudo step for a password-free deploy.

## Developing locally (any Mac or Linux box)

Two terminals:

```
# Terminal 1
cd gps-bridge && npm install && node bridge.js

# Terminal 2
cd display && npm install && npm run dev
# open http://localhost:5173
```

Without a GPS receiver plugged in, the display shows "GPS SIGNAL LOST" — that's expected. The bridge stays up, keeps looking for a receiver every 5 s, and the control page below still works.

Run the bridge's regression test with `node gps-bridge/test-fix-merge.js`.

## Phone control page

The bridge serves a small control page at `http://<mac-mini>.local:8080/`. On startup it prints the LAN URLs — open one on your phone (same Wi-Fi) to:

- toggle map pan + pinch-zoom (locked by default in kiosk mode)
- recenter on the vehicle
- pick a zoom preset (Wide / Normal / Close)
- set or clear the destination pin (address search if a Mapbox token is configured)

Controls are pushed over a second WebSocket channel (`/control`); see [gps-bridge/README.md](./gps-bridge/README.md#control-channel-control) for the wire protocol.

## Status

Bridge, display, phone control page, and Mac Mini provisioning are done. Planned: POI overlay layer, optional read-only Tailscale tunnel so the dev machine can ship updates from anywhere.

## License

MIT
