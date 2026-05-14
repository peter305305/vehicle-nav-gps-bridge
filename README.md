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

## Quick start

Two terminals:

```
# Terminal 1
cd gps-bridge && npm install && node bridge.js

# Terminal 2
cd display && npm install && npm run dev
# open http://localhost:5173
```

Without a GPS receiver plugged in, the display will show "GPS SIGNAL LOST" — that's expected.

## Status

Step 1 (gps-bridge) and step 2 (display) are done. Planned: dynamic destinations via a second WebSocket channel, POI overlay layer.

## License

MIT
