# vehicle-nav-gps-bridge

A passenger-facing vehicle navigation system built as a monorepo of two services: a GPS bridge that reads NMEA from a u-blox M10 USB receiver and broadcasts position over WebSocket, and a fullscreen "Airshow"-style moving-map display that consumes it. Designed to run on a Raspberry Pi 5 whose HDMI output feeds a Crestron AV system.

## Architecture

```
  u-blox M10 USB GPS
        │ NMEA over serial
        ▼
  ┌───────────────┐
  │  gps-bridge/  │   Node.js — parses NMEA, broadcasts position
  └───────┬───────┘
          │ WebSocket (JSON)
          ▼
  ┌───────────────┐
  │   display/    │   Vite + MapLibre — fullscreen kiosk map
  └───────┬───────┘
          │ HDMI
          ▼
   Crestron AV system
```

## Repo layout

- `gps-bridge/` — GPS-to-WebSocket service. See [gps-bridge/README.md](./gps-bridge/README.md).
- `display/` — passenger-facing moving-map display. See [display/README.md](./display/README.md).
- `scripts/` — Pi provisioning + deploy: systemd unit, udev rule, kiosk autostart, `install-pi.sh`, `deploy.sh`.

## Deploying to a Pi (canonical setup)

From a dev machine with key-based SSH already set up to the Pi:

```bash
./scripts/deploy.sh
```

That rsyncs the source over and runs `scripts/install-pi.sh` on the Pi, which installs apt deps, builds the display, installs the systemd unit + udev rule for the u-blox, and drops the kiosk autostart entry. Defaults target `beastpi@beastpi.local`; override with `PI_SSH=user@host`.

Once `sudo reboot` cycles the Pi, Chromium launches in `--kiosk` mode pointed at `http://localhost:8080/app/`, the bridge runs as a systemd service, and the u-blox shows up as a stable `/dev/gps-ublox` symlink regardless of which `ttyACM*` Linux happens to assign.

## Developing locally (macOS or Linux)

Two terminals:

```
# Terminal 1
cd gps-bridge && npm install && node bridge.js

# Terminal 2
cd display && npm install && npm run dev
# open http://localhost:5173
```

Without a GPS receiver plugged in, the display will show "GPS SIGNAL LOST" — that's expected. The bridge stays up even without a receiver so the control page below still works.

## Phone control page

The bridge serves a small control page at `http://<bridge-host>:8080/`. On startup it prints the LAN URLs — open one on your phone (same Wi-Fi) to:

- toggle map pan + pinch-zoom (locked by default in kiosk mode)
- recenter on the vehicle
- pick a zoom preset (Wide / Normal / Close)
- set or clear the destination pin

Controls are pushed over a second WebSocket channel (`/control`); see [gps-bridge/README.md](./gps-bridge/README.md#control-channel-control) for the wire protocol.

## Status

Bridge, display, phone control page, and Pi deployment scaffolding are done. Planned: POI overlay layer, optional read-only Tailscale tunnel so the dev machine can ship updates from anywhere.

## License

MIT
