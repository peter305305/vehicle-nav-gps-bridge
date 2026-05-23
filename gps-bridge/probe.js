#!/usr/bin/env node
// GPS receiver probe. Tries a sequence of baud rates against /dev/gps and
// prints, for each, how many bytes arrived and what they look like. Drop in
// /home/beastpi/vehicle-nav-gps-bridge/gps-bridge so it can pick up serialport
// from the already-installed node_modules.

'use strict';
const { SerialPort } = require('serialport');

const PATH = process.argv[2] || '/dev/gps';
const BAUDS = [4800, 9600, 19200, 38400, 57600, 115200];
const PER_BAUD_MS = 3000;

(async () => {
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
