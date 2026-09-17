/**
 * vehicle-nav-gps-bridge / bridge.js
 * ---------------------------------------------------------------------------
 * GPS bridge service for a vehicle navigation display.
 *
 * Reads NMEA-0183 sentences from a USB GPS receiver (u-blox M10, GlobalSat
 * BU-353N, ...) over a serial port, parses them, merges RMC + GGA state, and
 * broadcasts a unified JSON position object to all connected WebSocket clients.
 *
 * Runs on macOS (Mac Mini in-car install, see scripts/macos/), Linux, or
 * Windows. The receiver is discovered automatically and re-attached whenever
 * it appears (hot-plug, sleep/wake), so the service is safe to run unattended.
 *
 * Also serves a phone-friendly control page (HTTP GET /) and a second
 * WebSocket channel (/control) used to drive the display at runtime:
 * toggle map interactivity, recenter, change zoom preset, set destination.
 *
 * Endpoints:
 *   HTTP GET  /          control.html (mobile control page)
 *   WS        /          GPS stream — back-compat alias for /gps
 *   WS        /gps       GPS stream (position broadcasts)
 *   WS        /control   bidirectional control channel
 *
 * Environment variables (all optional):
 *   GPS_SERIAL_PORT  Explicit serial device path. If set, auto-detection is
 *                    skipped. Examples:
 *                      macOS:   /dev/cu.usbmodem14101
 *                      Linux:   /dev/ttyACM0
 *                      Windows: COM5
 *   GPS_BAUD_RATE    Serial baud rate. Default 9600 (u-blox M10 factory).
 *   WS_PORT          HTTP + WebSocket server listen port. Default 8080.
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

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
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

// Surfaced (read-only) to the control page via GET /control/config so the phone
// geocoder can call Mapbox without the operator having to wire a token into
// both the display .env AND a second config file. Empty/missing => geocoding
// disabled (the page falls back to a manual lat/lon form).
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';

// Where the built display app lives. Default to the sibling display/dist
// directory in this monorepo; on a deployed machine this is what `npm run build`
// produces. Setting DISPLAY_DIST_DIR= (empty) disables /app/* serving.
const DEFAULT_DIST_DIR = path.resolve(__dirname, '..', 'display', 'dist');
const DISPLAY_DIST_DIR = process.env.DISPLAY_DIST_DIR === undefined
  ? DEFAULT_DIST_DIR
  : (process.env.DISPLAY_DIST_DIR || null);

// USB vendor IDs we recognise as GPS receivers. SerialPort returns vendorId as
// a lowercase hex string without the 0x prefix, so we compare string forms.
//   1546  u-blox (M8/M9/M10 direct USB CDC)
//   067b  Prolific PL2303 (GlobalSat BU-353N / S4 and most clones)
const GPS_VENDOR_IDS = new Set(['1546', '067b']);

// How long to wait between attempts to find/open the receiver when none is
// present. A Mac Mini in a car sleeps and wakes, and USB re-enumerates on
// wake, so the bridge must keep looking rather than give up at startup.
const SERIAL_RETRY_MS = 5000;

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
  // Fix is reported independently by GGA (fixQuality) and RMC (status A/V). We
  // track each source separately and OR them in deriveFix() so a valid GGA
  // position is shown even while RMC still reports 'V' — a common state on this
  // receiver (and others) before RMC validates its navigation solution. Letting
  // either sentence null shared lat/lon directly is what previously made a good
  // GGA fix flicker to "NO FIX" every cycle.
  ggaFix: false,
  rmcValid: false,
};

// Control-channel state. Held by the bridge so a freshly opened phone page
// reflects whatever the last toggle was. `touched` tracks whether a field has
// ever been explicitly set so we can distinguish "no opinion" (untouched, omit
// from broadcast) from "explicitly cleared" (touched, value null — needed to
// propagate destination clears to the display). Display's `init` only fills
// untouched fields, so a `set` from the phone wins over the display's startup
// defaults if the phone got there first.
const controlState = {
  interactive: null,
  zoom: null,
  destination: null,
};
const controlTouched = {
  interactive: false,
  zoom: false,
  destination: false,
};

function controlStatePayload() {
  const state = {};
  for (const key of ['interactive', 'zoom', 'destination']) {
    if (controlTouched[key]) state[key] = controlState[key];
  }
  return { type: 'state', state };
}

let lastSentenceAt = 0; // ms epoch — used for heartbeat dropout detection
let lastLogAt = 0;      // ms epoch — throttle console logging to ~1 Hz

let serialPort = null;
let wssGps = null;
let wssControl = null;
let httpServer = null;
let controlHtml = '';

// ---------------------------------------------------------------------------
// Serial port discovery
// ---------------------------------------------------------------------------

async function findGpsPort() {
  if (GPS_SERIAL_PORT) {
    return GPS_SERIAL_PORT;
  }

  const ports = await SerialPort.list();

  // First pass: match by known GPS vendor ID (most reliable).
  const byVendor = ports.find(
    (p) => p.vendorId && GPS_VENDOR_IDS.has(p.vendorId.toLowerCase())
  );
  if (byVendor) {
    console.log(`[bridge] GPS receiver detected by vendorId ${byVendor.vendorId} at ${byVendor.path}`);
    return preferCallout(byVendor.path);
  }

  // Second pass: fall back to path heuristics. Some OS/driver combos don't
  // surface vendorId reliably (especially on Windows and older macOS).
  const byPath = ports.find((p) =>
    FALLBACK_PATH_PATTERNS.some((re) => re.test(p.path))
  );
  if (byPath) {
    console.log(`[bridge] GPS candidate detected by path pattern at ${byPath.path}`);
    return preferCallout(byPath.path);
  }

  return null;
}

// macOS exposes every serial device twice: /dev/tty.* (dial-in, blocks on
// open until carrier-detect) and /dev/cu.* (call-out, opens immediately).
// SerialPort.list() reports the tty.* name; for a USB GPS we want cu.*.
function preferCallout(portPath) {
  if (process.platform !== 'darwin') return portPath;
  if (!portPath.startsWith('/dev/tty.')) return portPath;
  const cu = '/dev/cu.' + portPath.slice('/dev/tty.'.length);
  return fs.existsSync(cu) ? cu : portPath;
}

// ---------------------------------------------------------------------------
// Sentence handling
// ---------------------------------------------------------------------------

function knotsToMph(knots) {
  return knots * 1.15078;
}

// nmea-simple reports GGA fix quality as a NAME ('fix', 'delta', ...) rather
// than the raw NMEA integer. Map it back to the numeric code so downstream
// consumers (display, .gps-watch.js, maybeLog) can keep using `=== 2` (DGPS),
// `>= 1` (any fix), etc. Index order matches the NMEA GGA fix-quality field.
const FIX_QUALITY_BY_NAME = {
  none: 0, fix: 1, delta: 2, pps: 3, rtk: 4, frtk: 5,
  estimated: 6, manual: 7, simulation: 8,
};

// Recompute hasFix from the two independent fix sources. We have a fix if either
// GGA reports fixQuality > 0 or RMC reports status 'A'. Only when BOTH agree
// there's no fix do we null the position; otherwise stale coords are cleared by
// the 3s dropout heartbeat, not by a single contradicting sentence.
function deriveFix() {
  state.hasFix = state.ggaFix || state.rmcValid;
  if (!state.hasFix) {
    state.lat = null;
    state.lon = null;
  }
}

function handleParsed(packet) {
  // nmea-simple emits objects with a `sentenceId` like 'RMC', 'GGA', etc.
  // We only care about RMC and GGA for position/speed/heading/fix info.
  switch (packet.sentenceId) {
    case 'RMC': {
      // nmea-simple reports RMC status as 'valid' (raw 'A') or 'warning' (raw
      // 'V') — NOT the raw letter. Accept both spellings for safety. Record
      // validity but don't clobber a position GGA may have provided; deriveFix()
      // decides the merged result.
      state.rmcValid = packet.status === 'valid' || packet.status === 'A';
      if (state.rmcValid) {
        if (typeof packet.latitude === 'number') state.lat = packet.latitude;
        if (typeof packet.longitude === 'number') state.lon = packet.longitude;
      }
      // Speed/heading/time always update when present, fix or not.
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
      deriveFix();
      break;
    }

    case 'GGA': {
      // fixQuality: 0 = invalid, 1 = GPS fix, 2 = DGPS, etc. nmea-simple gives a
      // name in `fixType`; normalize to the number. Fall back to a numeric
      // `fixQuality` if a future parser version provides one.
      let q = packet.fixType !== undefined ? packet.fixType : packet.fixQuality;
      if (typeof q === 'string') q = FIX_QUALITY_BY_NAME[q] ?? null;
      state.fixQuality = typeof q === 'number' ? q : null;
      if (typeof packet.satellitesInView === 'number') {
        state.satellites = packet.satellitesInView;
      }
      state.ggaFix = state.fixQuality !== null && state.fixQuality > 0;
      if (state.ggaFix) {
        if (typeof packet.latitude === 'number') state.lat = packet.latitude;
        if (typeof packet.longitude === 'number') state.lon = packet.longitude;
      }
      deriveFix();
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

function gpsPayload() {
  return JSON.stringify({
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
}

function broadcastGps() {
  if (!wssGps) return;
  const payload = gpsPayload();
  for (const client of wssGps.clients) {
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
// Control channel
// ---------------------------------------------------------------------------

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function validateDestination(d) {
  if (d === null) return true;
  if (typeof d !== 'object' || d === null) return false;
  if (!isFiniteNumber(d.lat) || !isFiniteNumber(d.lon)) return false;
  if (d.lat < -90 || d.lat > 90 || d.lon < -180 || d.lon > 180) return false;
  if (d.label !== undefined && typeof d.label !== 'string') return false;
  return true;
}

function broadcastControl(obj, except) {
  if (!wssControl) return;
  const payload = JSON.stringify(obj);
  for (const client of wssControl.clients) {
    if (client === except) continue;
    if (client.readyState !== WebSocket.OPEN) continue;
    try {
      client.send(payload);
    } catch (err) {
      console.error('[bridge] control send error:', err.message);
    }
  }
}

function handleControlMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'set': {
      if (typeof msg.key !== 'string') return;
      if (msg.key === 'interactive') {
        if (typeof msg.value !== 'boolean') return;
        controlState.interactive = msg.value;
        controlTouched.interactive = true;
      } else if (msg.key === 'zoom') {
        if (!isFiniteNumber(msg.value) || msg.value < 0 || msg.value > 24) return;
        controlState.zoom = msg.value;
        controlTouched.zoom = true;
      } else if (msg.key === 'destination') {
        if (!validateDestination(msg.value)) return;
        controlState.destination = msg.value;
        controlTouched.destination = true;
      } else {
        return;
      }
      broadcastControl(controlStatePayload());
      return;
    }

    case 'recenter': {
      // Transient — no state mutation, just fan out to every other client so
      // the display reacts and the phone UI can flash an acknowledgment.
      broadcastControl({ type: 'recenter' });
      return;
    }

    case 'init': {
      // Only the display sends `init`, to seed initial values it inherited
      // from its env. We only fill untouched fields so a phone command that
      // arrived first still wins.
      if (!msg.state || typeof msg.state !== 'object') return;
      const s = msg.state;
      let changed = false;
      if (!controlTouched.interactive && typeof s.interactive === 'boolean') {
        controlState.interactive = s.interactive;
        controlTouched.interactive = true;
        changed = true;
      }
      if (!controlTouched.zoom && isFiniteNumber(s.zoom)) {
        controlState.zoom = s.zoom;
        controlTouched.zoom = true;
        changed = true;
      }
      if (!controlTouched.destination && s.destination !== undefined && validateDestination(s.destination)) {
        controlState.destination = s.destination;
        controlTouched.destination = true;
        changed = true;
      }
      if (changed) broadcastControl(controlStatePayload());
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

// MIME types we serve from /app/. Everything else falls back to
// application/octet-stream — fine for binary assets, browser will sniff.
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.map':   'application/json; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  if (!DISPLAY_DIST_DIR) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('display dist serving disabled');
    return;
  }
  // Strip the /app prefix. `/app` or `/app/` → index.html.
  let rel = urlPath.replace(/^\/app\/?/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  // Path-traversal guard: resolve and confirm the result still lives under
  // DISPLAY_DIST_DIR. Anything outside (../foo, absolute paths, symlink
  // escapes) gets a 403 even if it would otherwise be readable.
  const resolved = path.resolve(DISPLAY_DIST_DIR, rel);
  const base = DISPLAY_DIST_DIR.endsWith(path.sep) ? DISPLAY_DIST_DIR : DISPLAY_DIST_DIR + path.sep;
  if (!resolved.startsWith(base) && resolved !== DISPLAY_DIST_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const mime = STATIC_MIME[ext] || 'application/octet-stream';
    // Long-cache hashed Vite assets, but never cache the entry index.html so
    // a redeploy is picked up on next reload. Vite emits filenames like
    // `assets/index-abc123.js`; the hash makes them safe to cache hard.
    const isHashed = /\/assets\//.test(resolved) && /-[A-Za-z0-9_]{8,}\./.test(resolved);
    const cache = isHashed ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cache });
    fs.createReadStream(resolved).pipe(res);
  });
}

function loadControlHtml() {
  const file = path.join(__dirname, 'control.html');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.warn(`[bridge] control.html not found at ${file}: ${err.message}`);
    return '<!doctype html><meta charset="utf-8"><title>control</title><p>control.html missing — reinstall gps-bridge.</p>';
  }
}

function startServer() {
  controlHtml = loadControlHtml();

  httpServer = http.createServer((req, res) => {
    // Only GET / and GET /control are HTML; anything else gets 404. Keep this
    // surface tiny — the bridge is not a general-purpose web server.
    if (req.method === 'GET' && (req.url === '/' || req.url === '/control' || req.url.startsWith('/?') || req.url.startsWith('/control?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(controlHtml);
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, hasFix: state.hasFix }));
      return;
    }
    if (req.method === 'GET' && req.url === '/control/config') {
      // Public config for the control page. Token is intentionally surfaced
      // here — it's a Mapbox pk.* token which is meant to be client-visible.
      // Restrict by URL referrer in your Mapbox account if you want hardening.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ mapboxToken: MAPBOX_TOKEN || null }));
      return;
    }
    // Built display app at /app/*. Parse the URL to ignore query strings.
    let urlPath;
    try {
      urlPath = new URL(req.url, 'http://localhost').pathname;
    } catch {
      urlPath = req.url;
    }
    if (req.method === 'GET' && (urlPath === '/app' || urlPath.startsWith('/app/'))) {
      serveStatic(req, res, urlPath);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  wssGps = new WebSocket.Server({ noServer: true });
  wssControl = new WebSocket.Server({ noServer: true });

  // Path-based WS routing. `/` is kept as a back-compat alias for `/gps` so
  // older display builds that default to ws://host:port (no path) still work.
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === '/gps' || pathname === '/') {
      wssGps.handleUpgrade(req, socket, head, (ws) => wssGps.emit('connection', ws, req));
    } else if (pathname === '/control') {
      wssControl.handleUpgrade(req, socket, head, (ws) => wssControl.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  wssGps.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;
    console.log(`[bridge] gps client connected: ${peer}`);
    // Send the current state immediately so a fresh client doesn't have to
    // wait up to a full second for the next sentence.
    try { ws.send(gpsPayload()); } catch (_) { /* ignore */ }
    ws.on('close', () => console.log(`[bridge] gps client disconnected: ${peer}`));
    ws.on('error', (err) => console.error('[bridge] gps client error:', err.message));
  });

  wssControl.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;
    console.log(`[bridge] control client connected: ${peer}`);
    try { ws.send(JSON.stringify(controlStatePayload())); } catch (_) { /* ignore */ }
    ws.on('message', (data) => handleControlMessage(ws, data));
    ws.on('close', () => console.log(`[bridge] control client disconnected: ${peer}`));
    ws.on('error', (err) => console.error('[bridge] control client error:', err.message));
  });

  httpServer.on('error', (err) => {
    console.error('[bridge] http server error:', err.message);
  });

  httpServer.listen(WS_PORT, () => {
    console.log(`[bridge] HTTP + WebSocket server listening on :${WS_PORT}`);
    const ips = lanAddresses();
    const hosts = ips.length ? ips : ['localhost'];
    console.log('[bridge] control page:');
    for (const ip of hosts) console.log(`         http://${ip}:${WS_PORT}/`);
    if (DISPLAY_DIST_DIR) {
      const haveDist = fs.existsSync(path.join(DISPLAY_DIST_DIR, 'index.html'));
      if (haveDist) {
        console.log(`[bridge] display app (built from ${DISPLAY_DIST_DIR}):`);
        for (const ip of hosts) console.log(`         http://${ip}:${WS_PORT}/app/`);
      } else {
        console.log(`[bridge] /app/ enabled but ${DISPLAY_DIST_DIR}/index.html not found yet — run \`npm run build\` in display/`);
      }
    }
  });
}

function lanAddresses() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main startup
// ---------------------------------------------------------------------------

let serialRetryTimer = null;
let warnedNoPort = false;

function scheduleSerialRetry() {
  if (shuttingDown || serialRetryTimer !== null) return;
  serialRetryTimer = setTimeout(() => {
    serialRetryTimer = null;
    connectSerial().catch((err) => {
      console.error('[bridge] serial connect failed:', err.message);
      scheduleSerialRetry();
    });
  }, SERIAL_RETRY_MS);
}

// Drop all fix state and tell clients. Used when the serial link closes
// (unplug, sleep/wake re-enumeration) so the display flips to GPS SIGNAL LOST
// immediately instead of waiting out the dropout heartbeat.
function markGpsLost() {
  state.ggaFix = false;
  state.rmcValid = false;
  state.hasFix = false;
  state.lat = null;
  state.lon = null;
  state.timestamp = new Date().toISOString();
  broadcastGps();
}

// Find and open the receiver. Never throws on "not there yet" — it schedules
// a retry instead, so the HTTP/WS side keeps running unattended and the GPS
// attaches whenever it shows up. Re-entered from the 'close' handler so an
// unplug/replug (or a Mac waking from sleep) recovers without a restart.
async function connectSerial() {
  if (shuttingDown || serialPort) return;

  const portPath = await findGpsPort();
  if (!portPath) {
    if (!warnedNoPort) {
      console.warn(`[bridge] No GPS serial port found. Set GPS_SERIAL_PORT to override auto-detection. Retrying every ${SERIAL_RETRY_MS / 1000}s.`);
      warnedNoPort = true;
    }
    scheduleSerialRetry();
    return;
  }
  warnedNoPort = false;

  console.log(`[bridge] Opening ${portPath} @ ${GPS_BAUD_RATE} baud`);

  const port = new SerialPort({ path: portPath, baudRate: GPS_BAUD_RATE }, (err) => {
    if (err) {
      // Keep the bridge up so the control channel continues; try again later.
      console.warn(`[bridge] Failed to open serial port ${portPath}: ${err.message}. Retrying in ${SERIAL_RETRY_MS / 1000}s.`);
      if (serialPort === port) serialPort = null;
      scheduleSerialRetry();
    }
  });
  serialPort = port;

  port.on('error', (err) => {
    console.error('[bridge] Serial port error:', err.message);
  });

  port.on('open', () => {
    console.log(`[bridge] Serial open. Configuring nav rate to 10 Hz...`);
    // Best-effort UBX CFG-RATE. If the device is already configured (saved to
    // flash/BBR) or doesn't accept the command, we just continue and rely on
    // whatever rate it's already running at.
    try {
      port.write(UBX_CFG_RATE_10HZ, (err) => {
        if (err) {
          console.warn('[bridge] UBX CFG-RATE write failed:', err.message);
        }
      });
    } catch (err) {
      console.warn('[bridge] UBX CFG-RATE threw:', err.message);
    }
  });

  port.on('close', () => {
    if (shuttingDown) return;
    console.warn(`[bridge] Serial port ${portPath} closed (unplugged or system slept). Reconnecting...`);
    if (serialPort === port) serialPort = null;
    markGpsLost();
    scheduleSerialRetry();
  });

  // NMEA is line-oriented (\r\n terminated). Split into lines, then parse.
  const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

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
      broadcastGps();
      maybeLog();
    }
  });
}

async function main() {
  // Start the server first so the control page is reachable even before GPS
  // hardware is ready — useful when bringing the machine up before the receiver.
  startServer();

  // ---- Dropout heartbeat ----
  // If the serial link goes silent for 3s, emit a no-fix heartbeat so clients
  // can show "GPS offline" rather than freezing on stale data.
  setInterval(() => {
    if (lastSentenceAt === 0) return; // never received anything yet — let it run
    if (Date.now() - lastSentenceAt < 3000) return;
    if (!state.hasFix && state.lat === null) {
      // Already reported lost; just keep the heartbeat ticking.
      state.timestamp = new Date().toISOString();
      broadcastGps();
      return;
    }
    markGpsLost();
    maybeLog();
  }, 1000);

  await connectSerial();
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
  if (wssGps) {
    pending++;
    wssGps.close(() => {
      pending--;
      if (pending === 0) done();
    });
  }
  if (wssControl) {
    pending++;
    wssControl.close(() => {
      pending--;
      if (pending === 0) done();
    });
  }
  if (httpServer) {
    pending++;
    httpServer.close(() => {
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

// Only wire up signals and start the serial/HTTP stack when run directly. When
// required as a module (e.g. by tests) we expose the pure sentence-merge
// internals so fix logic can be exercised without opening the serial port.
if (require.main === module) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  main().catch((err) => {
    console.error('[bridge] fatal:', err);
    process.exit(1);
  });
}

module.exports = { handleParsed, deriveFix, state };
