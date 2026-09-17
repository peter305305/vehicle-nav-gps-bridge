#!/usr/bin/env node
// GPS receiver probe. Tries a sequence of baud rates against a serial device
// and prints, for each, how many bytes arrived and what they look like. Use it
// to find the right GPS_BAUD_RATE for a new receiver.
//
//   node probe.js                        # auto-detect the USB receiver
//   node probe.js /dev/cu.usbmodem14101  # explicit device
//
// Run from gps-bridge/ so it picks up serialport from node_modules.

'use strict';
const fs = require('fs');
const { SerialPort } = require('serialport');

const BAUDS = [4800, 9600, 19200, 38400, 57600, 115200];
const PER_BAUD_MS = 3000;

// Same discovery heuristics as bridge.js: known GPS vendor IDs first, then
// USB-serial path patterns. On macOS prefer the /dev/cu.* call-out node.
const GPS_VENDOR_IDS = new Set(['1546', '067b']);
const PATH_PATTERNS = [/^\/dev\/tty\.usbmodem/i, /^\/dev\/tty\.usbserial/i, /^\/dev\/ttyACM\d+$/i, /^\/dev\/ttyUSB\d+$/i, /^COM\d+$/i];

async function detect() {
  const ports = await SerialPort.list();
  const hit = ports.find((p) => p.vendorId && GPS_VENDOR_IDS.has(p.vendorId.toLowerCase()))
    || ports.find((p) => PATH_PATTERNS.some((re) => re.test(p.path)));
  if (!hit) return null;
  let p = hit.path;
  if (process.platform === 'darwin' && p.startsWith('/dev/tty.')) {
    const cu = '/dev/cu.' + p.slice('/dev/tty.'.length);
    if (fs.existsSync(cu)) p = cu;
  }
  return p;
}

(async () => {
  const PATH = process.argv[2] || await detect();
  if (!PATH) {
    console.error('No USB GPS receiver found. Pass the device path explicitly, e.g. node probe.js /dev/cu.usbmodem14101');
    process.exit(1);
  }
  console.log(`probing ${PATH}`);
  for (const baud of BAUDS) {
    process.stdout.write(`=== ${baud} baud ===\n`);
    let port;
    try {
      port = await new Promise((resolve, reject) => {
        const p = new SerialPort({ path: PATH, baudRate: baud }, (err) => {
          if (err) reject(err);
          else resolve(p);
        });
      });
    } catch (err) {
      console.log(`  open failed: ${err.message}`);
      continue;
    }
    const chunks = [];
    port.on('data', (b) => chunks.push(b));
    await new Promise((r) => setTimeout(r, PER_BAUD_MS));
    await new Promise((r) => port.close(r));
    const buf = Buffer.concat(chunks);
    console.log(`  bytes: ${buf.length}`);
    const text = buf.toString('utf8');
    const printable = text.replace(/[^\x20-\x7E\n\r\t]/g, '.');
    console.log(`  printable (first 240): ${printable.slice(0, 240)}`);
    const nmeaLines = text.split(/[\r\n]+/).filter((l) => /^\$[A-Z]{2,3},/.test(l));
    console.log(`  NMEA-shaped lines: ${nmeaLines.length}`);
    if (nmeaLines.length) {
      console.log(`  first NMEA: ${nmeaLines[0].slice(0, 120)}`);
    }
    // Show first 32 bytes as hex too, helps spot binary sync patterns
    const hex = Array.from(buf.slice(0, 32))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    console.log(`  hex(32): ${hex}`);
  }
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
