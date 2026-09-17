# Vehicle Display

Fullscreen "Airshow"-style moving-map display for a passenger vehicle navigation system. Consumes GPS position from the `gps-bridge/` WebSocket and renders a glanceable dark map with destination, ETA, and live telemetry.

## What it does

- Connects to the GPS bridge over WebSocket (auto-reconnect with backoff)
- Renders a dark MapLibre vector map (style is configurable)
- Smoothly interpolates the vehicle marker at 60fps between 10 Hz GPS updates
- Vehicle marker rotates to heading; map stays north-up
- Shows a destination pin and connector line
- Periodically queries the Mapbox Directions API for ETA and remaining distance
- Displays a premium data strip overlay: ETA, distance, speed (mph), heading (compass)
- Shows "GPS SIGNAL LOST" banner when `hasFix` goes false; keeps last known position visible (no jumping)
- Designed for kiosk mode: no scrollbars, no cursor, edge-to-edge

## Requirements

- Node.js 18+ for the dev/build toolchain
- A modern Chromium-based browser to render (the dev/preview server is just Vite)
- The `gps-bridge` service running and broadcasting on a reachable WebSocket
- Optional: a Mapbox access token for the Directions API and (optionally) a Mapbox map style
- Optional: a MapTiler API key if using a MapTiler dark style

## Install

```
cd display
npm install
```

## Configure

```
cp .env.example .env
# edit .env
```

Environment variables:

- `VITE_GPS_WS_URL` — WebSocket URL of the bridge. Default `ws://localhost:8080`.
- `VITE_MAP_STYLE_URL` — MapLibre style JSON URL. Default `https://demotiles.maplibre.org/style.json` (basic, no key needed). For the premium look, use one of:
  - MapTiler dark: `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=YOUR_KEY`
  - Mapbox dark: needs Mapbox SDK style URL handling — recommend exporting your style from Mapbox Studio as a JSON URL.
- `VITE_MAPBOX_TOKEN` — Mapbox access token. Without it, ETA and distance show `—`.
- `VITE_DESTINATION_LAT` / `VITE_DESTINATION_LON` / `VITE_DESTINATION_LABEL` — static destination. Will later be replaced by a second WebSocket channel.
- `VITE_DIRECTIONS_REFRESH_MS` — how often to query Mapbox Directions. Default `30000`.

Example invocation:

```
VITE_MAPBOX_TOKEN=pk.eyJ... npm run dev
```

## Run

Development:

```
npm run dev
# open http://localhost:5173
```

Production build:

```
npm run build
npm run preview
# served on http://localhost:4173, listens on 0.0.0.0
```

The production build is plain static files in `dist/` — you can serve it with anything (caddy, nginx, `python -m http.server`, or `npm run preview`).

## Running with the GPS bridge for local testing

In a separate terminal:

```
cd ../gps-bridge
npm install      # first time only
node bridge.js   # auto-detects a u-blox device, or set GPS_SERIAL_PORT
```

The display will auto-reconnect once the bridge is up. See `gps-bridge/README.md` for full bridge documentation.

If you don't have a GPS receiver plugged in, the display still loads — it will just show "GPS SIGNAL LOST" and the destination pin/connector won't have a vehicle to anchor to.

## Kiosk autostart on the Mac Mini

Handled by `scripts/macos/install-mac.sh` at the repo root. It builds this app, and the bridge then serves the result at `http://localhost:8080/app/`. A LaunchAgent (`com.vehicle-nav.kiosk`) runs `scripts/macos/start-kiosk.sh`, which waits for the bridge's `/healthz`, then launches Google Chrome with `--kiosk --app=<url>` under `caffeinate` so the display never sleeps. If Chrome quits, launchd relaunches it.

Requirements that the installer can't set for you: automatic login for the kiosk user (System Settings → Users & Groups; needs FileVault off), so the GUI session exists after a cold boot.

Useful commands on the Mini:

```bash
scripts/macos/ctl.sh stop kiosk      # quit Chrome and keep it quit until start/next login
scripts/macos/ctl.sh start kiosk
scripts/macos/ctl.sh logs kiosk      # ~/Library/Logs/vehicle-nav/kiosk.log
```

Chrome runs with its own profile in `~/Library/Application Support/vehicle-nav-kiosk`, so a desktop Chrome on the same account is unaffected.

Rebuild after changing the display:

```bash
cd display && npm run build
```

No restart needed — the bridge serves `dist/` with `no-cache` on `index.html`, so a reload (or `scripts/macos/ctl.sh restart kiosk`) picks it up.

## Architecture and extension points

File layout:

```
display/
  index.html
  src/
    main.ts              orchestration
    config.ts            env-driven config
    types.ts             shared types
    gps.ts               WebSocket client with auto-reconnect
    interpolation.ts     60fps smoothing of 10Hz GPS data
    map.ts               MapLibre setup, vehicle marker, destination, connector line
    destination.ts       DestinationProvider interface + static implementation
    directions.ts        Mapbox Directions API polling
    overlay.ts           data strip DOM
    format.ts            heading→compass, distance, duration formatters
    vehicle-marker.svg.ts inline SVG for the vehicle marker
    style.css
```

Planned extension points (intentionally stubbed, not implemented yet):

- Dynamic destination via a second WebSocket channel. `destination.ts` defines a `DestinationProvider` interface; the current implementation is `StaticDestinationProvider`. To add dynamic destinations, write a `WebSocketDestinationProvider` that subscribes to the second channel and call `onChange` listeners when the destination changes. `main.ts` will wire it in identically.
- "Points of interest near me" layer. Add a new module (e.g. `src/poi.ts`) that owns a MapLibre source + layer, queries POIs based on the live vehicle position, and updates the source. Hook it from `main.ts`; do not touch `map.ts` internals.

## Troubleshooting

- Map is blank or low-res — your style URL probably needs an API key. Try the default demo tiles first.
- ETA / distance always show `—` — `VITE_MAPBOX_TOKEN` is unset or invalid, or the device has no internet.
- "GPS SIGNAL LOST" banner stays on — the bridge isn't running or has no receiver. `curl http://localhost:8080/healthz` should answer; `scripts/macos/ctl.sh logs bridge` shows whether a serial device was found.
- App appears windowed, not fullscreen — Chrome wasn't launched with `--kiosk`. Check `~/Library/Logs/vehicle-nav/kiosk.log` for which browser the launcher picked.

## License

MIT
