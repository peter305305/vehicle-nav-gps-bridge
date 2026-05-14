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

## Kiosk autostart on Raspberry Pi OS

Target: Raspberry Pi 5 running Raspberry Pi OS (Bookworm), Wayland-based labwc or X11 LXDE. Goal: on boot, the Pi comes up directly into Chromium displaying the app fullscreen, no cursor, no panels, no scrollbars.

### Step 1: Build the app on the Pi (or copy the built `dist/`)

```
cd ~/vehicle-nav-gps-bridge/display
npm install
npm run build
```

### Step 2: Serve it locally

A few options:

- `npm run preview` (simplest, but ties the kiosk to Node)
- A tiny static server:
  ```
  npx serve -s dist -l 4173
  ```
- Or symlink `dist/` into nginx/caddy if you already have one running.

### Step 3: Disable screen blanking

For Wayland/labwc (Bookworm default on Pi 5):

```
sudo apt install wlr-randr
# in ~/.config/labwc/autostart, add:
swayidle timeout 300 'wlr-randr --output HDMI-A-1 --off' resume 'wlr-randr --output HDMI-A-1 --on' &
# OR just disable it entirely:
xset s off s noblank -dpms     # X11 fallback
```

Simpler: in `raspi-config` → Display Options → disable screen blanking.

### Step 4: Hide the cursor at the OS level

CSS already hides it inside the page, but the cursor is briefly visible during load:

```
sudo apt install unclutter-xfixes
```

### Step 5: Autostart Chromium in kiosk mode

On Bookworm with labwc/Wayland — edit (or create) `~/.config/labwc/autostart`:

```
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-translate \
  --disable-features=TranslateUI \
  --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --start-fullscreen \
  --window-position=0,0 \
  --app=http://localhost:4173 &
unclutter-xfixes --timeout 0 &
```

On X11/LXDE (older Raspberry Pi OS) — edit `/etc/xdg/lxsession/LXDE-pi/autostart`:

```
@xset s off
@xset -dpms
@xset s noblank
@chromium-browser --kiosk --noerrdialogs --disable-infobars --app=http://localhost:4173
@unclutter -idle 0
```

### Step 6: Make the static server start on boot

Easiest is a `systemd` user unit. Create `~/.config/systemd/user/vehicle-display.service`:

```
[Unit]
Description=Vehicle Display static server
After=network.target

[Service]
WorkingDirectory=/home/pi/vehicle-nav-gps-bridge/display
ExecStart=/usr/bin/npx serve -s dist -l 4173
Restart=always

[Install]
WantedBy=default.target
```

Enable it:

```
systemctl --user enable --now vehicle-display.service
loginctl enable-linger pi   # so the user service starts before login
```

You'll want a matching `systemd` unit for `gps-bridge` — see `gps-bridge/README.md` for that (or just adapt the same pattern, pointing `WorkingDirectory` at `../gps-bridge` and `ExecStart` at `/usr/bin/node bridge.js`).

### Step 7: Reboot

The Pi should come up directly into the display.

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
- "GPS SIGNAL LOST" banner stays on — the bridge isn't running, or `VITE_GPS_WS_URL` doesn't match. From the Pi, `wscat -c ws://localhost:8080` to confirm the bridge is reachable.
- Cursor visible briefly on boot — install `unclutter-xfixes` and start it from your autostart file.
- App appears windowed, not fullscreen — ensure Chromium was launched with `--kiosk` and that no window manager is overriding it.

## License

MIT
