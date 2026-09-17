# vehicle-nav-gps-bridge

A Node.js service that reads NMEA from a USB GPS receiver (u-blox M10, GlobalSat BU-353N, ...) and broadcasts the vehicle's position over a local WebSocket. Also serves a phone-friendly control page for runtime tweaks (lock/unlock pan-zoom, recenter, change zoom, set destination).

## What it does

- Auto-detects a USB GPS receiver by vendor ID (u-blox `1546`, Prolific `067b`) with a path-pattern fallback. If none is found, the bridge stays up and re-scans every 5 s; if the receiver disappears (unplug, Mac sleep/wake) it reconnects on its own. On macOS it opens the `/dev/cu.*` call-out node rather than `/dev/tty.*`.
- Sends a UBX `CFG-RATE` command at startup to set the receiver to 10 Hz.
- Parses NMEA sentences (`RMC`, `GGA`) into structured data.
- Broadcasts position updates as JSON over a local WebSocket server (`/gps`).
- Exposes a second WebSocket channel (`/control`) used to drive the display at runtime, plus a static HTML control page (`/`) you open on your phone.
- Handles GPS dropout by emitting a `hasFix: false` heartbeat so consumers know the link is alive but unfixed.

## Requirements

- Node.js 18 or newer (`brew install node` on macOS).
- A USB GPS receiver that speaks NMEA-0183:
  - u-blox M10 / M8 / M9 (USB CDC, 9600 baud factory). Works on macOS with no driver.
  - GlobalSat BU-353N / BU-353S4 (Prolific PL2303 USB-Serial). Recent macOS versions include a PL2303 driver; if the device doesn't show up under `ls /dev/cu.usb*`, install Prolific's driver from the Mac App Store.
  - Most receivers that present as `/dev/cu.usb*` (macOS) or `/dev/ttyACM*` / `/dev/ttyUSB*` (Linux)
  The bridge sends a UBX `CFG-RATE` command at startup to bump u-blox receivers to 10 Hz; for non-UBX receivers (like the BU-353N) this is silently ignored and the receiver runs at its native rate (1 Hz for BU-353).
- macOS needs no group membership or udev rule to read a USB serial device. On Linux, add your user to `dialout`.

## Install

```bash
npm install
```

## Run

```bash
node bridge.js
```

Or, if defined in `package.json`:

```bash
npm start
```

## Configuration

Configured via environment variables. On the Mac Mini these live in `~/.config/vehicle-nav/bridge.env` (seeded from `scripts/macos/bridge.env.example` by the installer) and are applied with `scripts/macos/ctl.sh restart bridge`.

| Variable             | Default               | Description                                                                                  |
| -------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `GPS_SERIAL_PORT`    | auto-detected         | Serial device path for the GPS receiver. Leave unset unless auto-detect picks the wrong device. |
| `GPS_BAUD_RATE`      | `9600`                | Serial baud rate. u-blox: 9600. BU-353N: 115200. Use `probe.js` to scan if unsure.          |
| `MAPBOX_TOKEN`       | _none_                | Mapbox public token (`pk.*`). Surfaced at `GET /control/config` so the phone control page can geocode addresses. |
| `WS_PORT`            | `8080`                | Port for the HTTP + WebSocket server (one port).                                             |
| `DISPLAY_DIST_DIR`   | `../display/dist`     | Path to the built display app. The bridge serves it at `/app/*`. Set empty to disable (in the env file, use the word `off`). |

Example:

```bash
WS_PORT=9000 GPS_SERIAL_PORT=/dev/cu.usbmodem14101 node bridge.js
```

## Finding the serial port

You normally don't need to: the bridge auto-detects and logs what it picked. To see it yourself:

### macOS

```bash
ls /dev/cu.usbmodem* /dev/cu.usbserial*
```

The u-blox appears as `/dev/cu.usbmodem<digits>`, a BU-353N as `/dev/cu.usbserial-<id>`. Every device also has a `/dev/tty.*` twin; prefer `cu.*` (it opens without waiting for carrier-detect). To confirm the OS sees the receiver at all:

```bash
system_profiler SPUSBDataType | grep -iE 'u-blox|prolific'
```

Not sure of the baud rate? With the receiver plugged in:

```bash
node probe.js
```

### Linux

```bash
ls /dev/ttyACM* /dev/ttyUSB*
lsusb | grep -iE 'u-blox|prolific'
```

### Windows

Open **Device Manager** -> **Ports (COM & LPT)**. The u-blox appears as `u-blox GNSS Receiver (COMx)`. Set the env var to that COM port:

```bat
set GPS_SERIAL_PORT=COM3
```

## Endpoints

| Path        | Kind | Purpose                                                                  |
| ----------- | ---- | ------------------------------------------------------------------------ |
| `/`         | HTTP | Mobile-friendly control page (open on your phone)                        |
| `/control`  | HTTP | Same page as `/` (alternate URL)                                         |
| `/healthz`  | HTTP | Liveness check: `{ ok: true, hasFix: <bool> }`                           |
| `/gps`      | WS   | GPS position stream (display subscribes here)                            |
| `/`         | WS   | Back-compat alias for `/gps` — old clients without a path still work     |
| `/control`  | WS   | Bidirectional control channel (display + phone both subscribe)           |

On startup the bridge prints the LAN URLs of the control page; open one of them on a phone connected to the same Wi-Fi. On the Mac Mini, `http://<name>.local:8080/` also works via Bonjour.

## WebSocket output format (`/gps`)

Each broadcast is a single JSON message:

```json
{
  "lat": 37.78491,
  "lon": -122.40689,
  "speedKnots": 12.3,
  "speedMph": 14.15,
  "heading": 87.2,
  "satellites": 11,
  "fixQuality": 1,
  "timestamp": "2026-05-14T12:34:56.000Z",
  "hasFix": true
}
```

When the receiver has no fix, `lat` and `lon` are `null` and `hasFix` is `false`. The service continues to emit heartbeat messages so consumers can distinguish "no fix" from "bridge offline".

## Control channel (`/control`)

The control channel is a small JSON-over-WebSocket protocol. Any connected client (phone control page, display, ad-hoc tooling) can send commands; the bridge maintains a `controlState` and rebroadcasts to all clients.

### Client → bridge

```jsonc
{ "type": "set", "key": "interactive", "value": true }            // lock/unlock pan + pinch-zoom
{ "type": "set", "key": "zoom",        "value": 13 }               // change zoom (0-24)
{ "type": "set", "key": "destination", "value": { "lat": 25.7907, "lon": -80.13, "label": "Demo" } }
{ "type": "set", "key": "destination", "value": null }             // clear destination
{ "type": "recenter" }                                             // transient: snap map to vehicle
{ "type": "init", "state": { ... } }                               // display only: seed untouched fields from env
```

### Bridge → clients

```jsonc
{ "type": "state", "state": { /* only fields that have been touched */ } }
{ "type": "recenter" }
```

A field appears in `state` only after it's been explicitly set (by either the display's `init` seed or a phone `set`). This lets the display distinguish "no opinion from bridge" (key absent — keep local) from "explicitly cleared" (key present, value `null`).

### Security note

The control channel is unauthenticated and bound to all interfaces. It's intended for a trusted in-vehicle LAN. If you ever expose `WS_PORT` to a wider network, put it behind a firewall or reverse-proxy with auth.

## Quick test

With `websocat`:

```bash
websocat ws://localhost:8080/gps
```

Or from a browser console:

```js
const ws = new WebSocket('ws://localhost:8080/gps');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

## Troubleshooting

- **No data**: check the log (`scripts/macos/ctl.sh logs bridge`) for which device it opened, confirm `GPS_BAUD_RATE` matches the receiver (`node probe.js`), and try a different USB cable.
- **"No GPS serial port found" repeating every 5 s**: the OS doesn't see the receiver. `ls /dev/cu.usb*` should list it; for a BU-353N on macOS you may need the Prolific driver.
- **Port busy**: another process (e.g. u-center, a second bridge instance, `probe.js`) may already have the serial port open. Close it and retry.
- **Bridge not running after login on the Mini**: `scripts/macos/ctl.sh status`, then `scripts/macos/ctl.sh start bridge`. Make sure the LaunchAgent is loaded in the GUI session (it won't run over a bare SSH login before anyone has logged into the desktop).
- **Permission denied on Linux**: add your user to the `dialout` group.

## Tests

```bash
node test-fix-merge.js
```

Exercises the RMC/GGA fix-merge logic against the real NMEA parser (no hardware needed).

## License

MIT
