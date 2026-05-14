/**
 * vehicle-nav-gps-bridge / bridge.js
 * ---------------------------------------------------------------------------
 * GPS bridge service for a vehicle navigation display.
 *
 * Reads NMEA-0183 sentences from a u-blox M10 USB GPS receiver over a serial
 * port, parses them, merges RMC + GGA state, and broadcasts a unified JSON
 * position object to all connected WebSocket clients.
 *
 * Step one of a vehicle navigation display pipeline. Designed to be resilient:
 * malformed sentences are silently dropped, no-fix conditions are still
 * broadcast (so downstream UI knows we're alive), and a heartbeat fires when
 * the serial link goes quiet.
 *
 * Environment variables (all optional):
 *   GPS_SERIAL_PORT  Explicit serial device path. If set, auto-detection is
 *                    skipped. Examples:
 *                      macOS:   /dev/tty.usbmodem14101
 *                      Linux:   /dev/ttyACM0
 *                      Windows: COM5
 *   GPS_BAUD_RATE    Serial baud rate. Default 9600 (u-blox M10 factory).
 *   WS_PORT          WebSocket server listen port. Default 8080.
 *
 * Run:
 *   node bridge.js
 *   GPS_SERIAL_PORT=/dev/tty.usbmodem14101 WS_PORT=9000 node bridge.js
 *
 * Dependencies (installed via package.json, not here):
 *   serialport (>=12), @serialport/parser-readline, nmea-simple, ws
 * ---------------------------------------------------------------------------
 */

'use strict';

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const nmea = require('nmea-simple');
const WebSocket = require('ws');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GPS_SERIAL_PORT = process.env.GPS_SERIAL_PORT || null;
const GPS_BAUD_RATE = parseInt(process.env.GPS_BAUD_RATE, 10) || 9600;
const WS_PORT = parseInt(process.env.WS_PORT, 10) || 8080;

// u-blox USB vendor ID. SerialPort returns vendorId as a lowercase hex string
// without the 0x prefix, so we compare against the string form.
const UBLOX_VENDOR_ID = '1546';

// Path patterns that typically correspond to USB serial / USB CDC devices on
// each major platform. Used only when vendorId isn't reported by the OS.
const FALLBACK_PATH_PATTERNS = [
  /^\/dev\/tty\.usbmodem/i, // macOS USB CDC (u-blox shows up here)
  /^\/dev\/tty\.usbserial/i, // macOS FTDI / CP210x / PL2303
  /^\/dev\/ttyACM\d+$/i,    // Linux USB CDC (u-blox)
  /^\/dev\/ttyUSB\d+$/i,    // Linux USB UART bridges
  /^COM\d+$/i,              // Windows
];

// ---------------------------------------------------------------------------
// UBX CFG-RATE: set navigation rate to 10 Hz
// ---------------------------------------------------------------------------
//
// Framing:  B5 62  CLS ID  LEN(LE)  PAYLOAD          CK_A CK_B
//           B5 62  06  08   06 00   64 00 01 00 01 00  7A   12
//
// Payload fields (little-endian):
//   measRate = 0x0064 = 100 ms  -> 10 Hz measurement rate
//   navRate  = 0x0001           -> 1 nav solution per measurement
//   timeRef  = 0x0001           -> align to GPS time
//
// Checksum (Fletcher-8 over CLS..end-of-payload) precomputed: 7A 12.
const UBX_CFG_RATE_10HZ = Buffer.from([
  0xB5, 0x62,             // sync chars
  0x06, 0x08,             // class CFG (0x06), id RATE (0x08)
  0x06, 0x00,             // payload length = 6 (LE)
  0x64, 0x00,             // measRate = 100 ms
  0x01, 0x00,             // navRate = 1
  0x01, 0x00,             // timeRef = GPS
  0x7A, 0x12,             // CK_A, CK_B
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Merged GPS state. RMC carries lat/lon/speed/heading/time/status, GGA carries
// lat/lon/fixQuality/satellites/altitude. We keep the most recent value of
// every field across sentences so a GGA-only update can still broadcast a
// complete picture and vice versa.
const state = {
  lat: null,
  lon: null,
  speedKnots: null,
  speedMph: null,
  heading: null,
  satellites: null,
  fixQuality: null,
  timestamp: null,
  hasFix: false,
};

let lastSentenceAt = 0; // ms epoch — used for heartbeat dropout detection
let lastLogAt = 0;      // ms epoch — throttle console logging to ~1 Hz

let serialPort = null;
let wss = null;

// ---------------------------------------------------------------------------
// Serial port discovery
// ---------------------------------------------------------------------------

async function findGpsPort() {
  if (GPS_SERIAL_PORT) {
    return GPS_SERIAL_PORT;
  }

  const ports = await SerialPort.list();

  // First pass: match by u-blox vendor ID (most reliable).
  const byVendor = ports.find(
    (p) => p.vendorId && p.vendorId.toLowerCase() === UBLOX_VENDOR_ID
  );
  if (byVendor) {
    console.log(`[bridge] u-blox device detected by vendorId at ${byVendor.path}`);
    return byVendor.path;
  }

  // Second pass: fall back to path heuristics. Some OS/driver combos don't
  // surface vendorId reliably (especially on Windows and older macOS).
  const byPath = ports.find((p) =>
    FALLBACK_PATH_PATTERNS.some((re) => re.test(p.path))
  );
  if (byPath) {
    console.log(`[bridge] GPS candidate detected by path pattern at ${byPath.path}`);
    return byPath.path;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sentence handling
// ---------------------------------------------------------------------------

function knotsToMph(knots) {
  return knots * 1.15078;
}

function handleParsed(packet) {
  // nmea-simple emits objects with a `sentenceId` like 'RMC', 'GGA', etc.
  // We only care about RMC and GGA for position/speed/heading/fix info.
  switch (packet.sentenceId) {
    case 'RMC': {
      // status === 'A' means active/valid fix; 'V' is void.
      const valid = packet.status === 'A';
      if (valid) {
        state.lat = packet.latitude;
        state.lon = packet.longitude;
        state.hasFix = true;
      } else {
        // No fix — null out coords but keep other known fields so the UI can
        // still show last-known sats / heading context if it wants to.
        state.lat = null;
        state.lon = null;
        state.hasFix = false;
      }
      if (typeof packet.speedKnots === 'number') {
        state.speedKnots = packet.speedKnots;
        state.speedMph = knotsToMph(packet.speedKnots);
      }
      if (typeof packet.trackTrue === 'number') {
        state.heading = packet.trackTrue;
      }
      if (packet.datetime instanceof Date) {
        state.timestamp = packet.datetime.toISOString();
      } else {
        state.timestamp = new Date().toISOString();
      }
      break;
    }

    case 'GGA': {
      // fixQuality: 0 = invalid, 1 = GPS fix, 2 = DGPS, etc.
      state.fixQuality = packet.fixType !== undefined ? packet.fixType
                       : (typeof packet.fixQuality === 'number' ? packet.fixQuality : null);
      if (typeof packet.satellitesInView === 'number') {
        state.satellites = packet.satellitesInView;
      }
      if (state.fixQuality && state.fixQuality > 0) {
        if (typeof packet.latitude === 'number') state.lat = packet.latitude;
        if (typeof packet.longitude === 'number') state.lon = packet.longitude;
        state.hasFix = true;
      } else {
        state.lat = null;
        state.lon = null;
        state.hasFix = false;
      }
      // GGA timestamps are time-of-day only; prefer wall clock if we don't
      // already have a full RMC timestamp.
      if (!state.timestamp) {
        state.timestamp = new Date().toISOString();
      }
      break;
    }

    default:
      // GSV/GSA/VTG/etc. — useful but not required for position broadcast.
      return false;
  }

  return true;
}

function broadcast() {
  if (!wss) return;
  const payload = JSON.stringify({
    lat: state.lat,
    lon: state.lon,
    speedKnots: state.speedKnots,
    speedMph: state.speedMph,
    heading: state.heading,
    satellites: state.satellites,
    fixQuality: state.fixQuality,
    timestamp: state.timestamp || new Date().toISOString(),
    hasFix: state.hasFix,
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (err) {
        // Individual client send failures shouldn't take down the broadcast.
        console.error('[bridge] ws send error:', err.message);
      }
    }
  }
}

function maybeLog() {
  const now = Date.now();
  if (now - lastLogAt < 1000) return; // throttle to ~1 Hz even at 10 Hz nav rate
  lastLogAt = now;

  const ts = new Date().toTimeString().slice(0, 8);
  if (state.hasFix && state.lat !== null && state.lon !== null) {
    const fixLabel = state.fixQuality === 2 ? 'DGPS'
                   : state.fixQuality >= 1 ? '3D'
                   : '??';
    const lat = state.lat.toFixed(5);
    const lon = state.lon.toFixed(5);
    const kn = (state.speedKnots ?? 0).toFixed(1);
    const mph = (state.speedMph ?? 0).toFixed(1);
    const hdg = state.heading !== null ? state.heading.toFixed(0).padStart(3, '0') : '---';
    const sats = state.satellites ?? '?';
    console.log(
      `[${ts}] FIX ${fixLabel}  ${lat},${lon}  ${kn}kn (${mph}mph)  hdg ${hdg}°  sats ${sats}`
    );
  } else {
    const sats = state.satellites ?? '?';
    console.log(`[${ts}] NO FIX  sats ${sats}`);
  }
}

// ---------------------------------------------------------------------------
// Main startup
// ---------------------------------------------------------------------------

async function main() {
  const path = await findGpsPort();
  if (!path) {
    console.error(
      '[bridge] No GPS serial port found. Set GPS_SERIAL_PORT to override auto-detection.'
    );
    process.exit(1);
  }

  console.log(`[bridge] Opening ${path} @ ${GPS_BAUD_RATE} baud`);

  serialPort = new SerialPort({ path, baudRate: GPS_BAUD_RATE }, (err) => {
    if (err) {
      console.error(`[bridge] Failed to open serial port ${path}: ${err.message}`);
      process.exit(1);
    }
  });

  serialPort.on('error', (err) => {
    console.error('[bridge] Serial port error:', err.message);
  });

  serialPort.on('open', () => {
    console.log(`[bridge] Serial open. Configuring nav rate to 10 Hz...`);
    // Best-effort UBX CFG-RATE. If the device is already configured (saved to
    // flash/BBR) or doesn't accept the command, we just continue and rely on
    // whatever rate it's already running at.
    try {
      serialPort.write(UBX_CFG_RATE_10HZ, (err) => {
        if (err) {
          console.warn('[bridge] UBX CFG-RATE write failed:', err.message);
        }
      });
    } catch (err) {
      console.warn('[bridge] UBX CFG-RATE threw:', err.message);
    }
  });

  // NMEA is line-oriented (\r\n terminated). Split into lines, then parse.
  const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  parser.on('data', (line) => {
    if (!line || !line.startsWith('$')) return; // skip UBX echoes and noise

    let packet;
    try {
      packet = nmea.parseNmeaSentence(line);
    } catch (err) {
      // nmea-simple throws on malformed/unsupported sentences. We deliberately
      // swallow these — the GPS emits dozens of sentence types per second and
      // logging each rejection would drown the console.
      return;
    }

    lastSentenceAt = Date.now();
    const updated = handleParsed(packet);
    if (updated) {
      broadcast();
      maybeLog();
    }
  });

  // ---- WebSocket server ----
  wss = new WebSocket.Server({ port: WS_PORT });
  wss.on('listening', () => {
    console.log(`[bridge] WebSocket server listening on :${WS_PORT}`);
  });
  wss.on('error', (err) => {
    console.error('[bridge] WebSocket server error:', err.message);
  });
  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;
    console.log(`[bridge] client connected: ${peer}`);
    // Send the current state immediately so a fresh client doesn't have to
    // wait up to a full second for the next sentence.
    try {
      ws.send(JSON.stringify({
        lat: state.lat,
        lon: state.lon,
        speedKnots: state.speedKnots,
        speedMph: state.speedMph,
        heading: state.heading,
        satellites: state.satellites,
        fixQuality: state.fixQuality,
        timestamp: state.timestamp || new Date().toISOString(),
        hasFix: state.hasFix,
      }));
    } catch (_) { /* ignore */ }
    ws.on('close', () => console.log(`[bridge] client disconnected: ${peer}`));
    ws.on('error', (err) => console.error('[bridge] client error:', err.message));
  });

  // ---- Dropout heartbeat ----
  // If the serial link goes silent for 3s, emit a no-fix heartbeat so clients
  // can show "GPS offline" rather than freezing on stale data.
  setInterval(() => {
    if (lastSentenceAt === 0) return; // never received anything yet — let it run
    if (Date.now() - lastSentenceAt < 3000) return;

    state.hasFix = false;
    state.lat = null;
    state.lon = null;
    state.timestamp = new Date().toISOString();
    broadcast();
    maybeLog();
  }, 1000);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[bridge] ${signal} received, shutting down...`);

  const done = () => process.exit(0);

  let pending = 0;
  if (wss) {
    pending++;
    wss.close(() => {
      pending--;
      if (pending === 0) done();
    });
  }
  if (serialPort && serialPort.isOpen) {
    pending++;
    serialPort.close(() => {
      pending--;
      if (pending === 0) done();
    });
  }
  if (pending === 0) done();

  // Hard exit after 2s if something hangs.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[bridge] fatal:', err);
  process.exit(1);
});
