# vehicle-nav-gps-bridge

A Node.js service that reads NMEA from a u-blox M10 USB GPS receiver and broadcasts the vehicle's position over a local WebSocket. Also serves a phone-friendly control page for runtime tweaks (lock/unlock pan-zoom, recenter, change zoom, set destination).

## What it does

- Auto-detects a u-blox GPS receiver over USB serial. If none is found, the bridge stays up so the control page and dropout heartbeat still work — plug in the receiver later.
- Sends a UBX `CFG-RATE` command at startup to set the receiver to 10 Hz.
- Parses NMEA sentences (`RMC`, `GGA`) into structured data.
- Broadcasts position updates as JSON over a local WebSocket server (`/gps`).
- Exposes a second WebSocket channel (`/control`) used to drive the display at runtime, plus a static HTML control page (`/`) you open on your phone.
- Handles GPS dropout by emitting a `hasFix: false` heartbeat so consumers know the link is alive but unfixed.

## Requirements

- Node.js 18 or newer.
- A USB GPS receiver that speaks NMEA-0183:
  - u-blox M10 / M8 / M9 (USB CDC, 9600 baud factory)
  - GlobalSat BU-353N / BU-353S4 (Prolific PL2303 USB-Serial, 4800 baud)
  - Most receivers that present as `/dev/ttyACM*` or `/dev/ttyUSB*`
  The bridge sends a UBX `CFG-RATE` command at startup to bump u-blox receivers to 10 Hz; for non-UBX receivers (like the BU-353N) this is silently ignored and the receiver runs at its native rate (1 Hz for BU-353).
- On Linux, your user typically needs to be in the `dialout` group to access serial devices:

  ```bash
  sudo usermod -aG dialout $USER
  ```

  Log out and back in for the group change to take effect.

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

Configured via environment variables:

| Variable             | Default               | Description                                                                                  |
| -------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `GPS_SERIAL_PORT`    | auto-detected         | Serial device path for the GPS receiver. On the Pi, the udev rule provides `/dev/gps-ublox`. |
| `GPS_BAUD_RATE`      | `9600`                | Serial baud rate. u-blox: 9600. BU-353N: 115200 (Pi env file overrides to 115200). Use `probe.js` to scan if unsure. |
| `MAPBOX_TOKEN`       | _none_                | Mapbox public token (`pk.*`). Surfaced at `GET /control/config` so the phone control page can geocode addresses. |
| `WS_PORT`            | `8080`                | Port for the HTTP + WebSocket server (one port).                                             |
| `DISPLAY_DIST_DIR`   | `../display/dist`     | Path to the built display app. The bridge serves it at `/app/*`. Set empty to disable.       |

Example:

```bash
WS_PORT=9000 GPS_SERIAL_PORT=/dev/gps-ublox node bridge.js
```

## Finding the serial port

### Linux (Pi)

After `scripts/install-pi.sh` runs, the u-blox shows up as `/dev/gps-ublox` (a udev symlink that survives unplug/replug). Without the udev rule:

```bash
ls /dev/ttyACM*
lsusb | grep -i u-blox
```

### macOS

```bash
ls /dev/tty.usbmodem* /dev/tty.usbserial*
```

The u-blox typically appears as `/dev/tty.usbmodem<digits>`. To confirm the device is detected:

```bash
system_profiler SPUSBDataType | grep -i u-blox
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

On startup the bridge prints the LAN URLs of the control page; open one of them on a phone connected to the same Wi-Fi.

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

- **No data**: verify `GPS_SERIAL_PORT` points at the right device, confirm `GPS_BAUD_RATE` matches the receiver, and try a different USB cable.
- **Permission denied on Linux**: add your user to the `dialout` group (see Requirements).
- **Port busy**: another process (e.g. u-center) may already have the serial port open. Close it and retry.

## Roadmap

This is the GPS bridge layer. Next steps: map renderer, route overlay, dashboard UI.

## License

MIT
