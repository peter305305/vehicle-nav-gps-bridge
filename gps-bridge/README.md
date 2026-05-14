# vehicle-nav-gps-bridge

A Node.js service that reads NMEA from a u-blox M10 USB GPS receiver and broadcasts the vehicle's position over a local WebSocket.

## What it does

- Auto-detects a u-blox GPS receiver over USB serial.
- Sends a UBX `CFG-RATE` command at startup to set the receiver to 10 Hz.
- Parses NMEA sentences (`RMC`, `GGA`) into structured data.
- Broadcasts position updates as JSON over a local WebSocket server.
- Handles GPS dropout by emitting a `hasFix: false` heartbeat so consumers know the link is alive but unfixed.

## Requirements

- Node.js 18 or newer.
- A u-blox M10 USB GPS receiver. Should also work with most UBX-capable u-blox devices.
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

| Variable           | Default        | Description                                  |
| ------------------ | -------------- | -------------------------------------------- |
| `GPS_SERIAL_PORT`  | auto-detected  | Serial device path for the GPS receiver.     |
| `GPS_BAUD_RATE`    | `9600`         | Serial baud rate.                            |
| `WS_PORT`          | `8080`         | Port for the local WebSocket server.         |

Example:

```bash
WS_PORT=9000 GPS_SERIAL_PORT=/dev/tty.usbmodem14101 node bridge.js
```

## Finding the serial port

### macOS

```bash
ls /dev/tty.usbmodem* /dev/tty.usbserial*
```

The u-blox typically appears as `/dev/tty.usbmodem<digits>`. To confirm the device is detected:

```bash
system_profiler SPUSBDataType | grep -i u-blox
```

### Linux

```bash
ls /dev/ttyACM* /dev/ttyUSB*
```

The u-blox is usually `/dev/ttyACM0`. If you don't see it, plug the device in and check kernel messages:

```bash
dmesg | tail
lsusb
```

Look for a u-blox vendor entry (e.g. `1546:01a9`).

### Windows

Open **Device Manager** -> **Ports (COM & LPT)**. The u-blox appears as `u-blox GNSS Receiver (COMx)`. Set the env var to that COM port:

```bat
set GPS_SERIAL_PORT=COM3
```

## WebSocket output format

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

## Quick test

With `websocat`:

```bash
websocat ws://localhost:8080
```

Or from a browser console:

```js
const ws = new WebSocket('ws://localhost:8080');
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
