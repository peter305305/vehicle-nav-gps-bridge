'use strict';
// Regression test for the RMC/GGA fix-merge logic. Exercises the real
// handleParsed() from bridge.js against captured sentences. Run: node test-fix-merge.js
//
// Background: nmea-simple reports GGA fix quality as a name ('fix'/'none'/...)
// and RMC status as 'valid'/'warning' — not the raw '1'/'A' the original code
// compared against, so hasFix was permanently false. These cases lock in the fix.
const assert = require('assert');
const nmea = require('nmea-simple');
const { handleParsed, state } = require('./bridge.js');

function reset() {
  Object.assign(state, {
    lat: null, lon: null, speedKnots: null, speedMph: null, heading: null,
    satellites: null, fixQuality: null, timestamp: null, hasFix: false,
    ggaFix: false, rmcValid: false,
  });
}
function feed(raw) { handleParsed(nmea.parseNmeaSentence(raw)); }

// Real captures from the receiver (indoors, marginal sky):
const GGA_FIX  = '$GPGGA,235229.200,4045.1407,N,07400.1946,W,1,5,1.70,63.0,M,-34.2,M,,0000*51';
const GGA_DGPS = '$GPGGA,235229.200,4045.1407,N,07400.1946,W,2,5,1.70,63.0,M,-34.2,M,,0000*52';
const RMC_VOID = '$GPRMC,000423.900,V,,,,,,,020626,,,N*41';
function withChecksum(body) {
  let c = 0; for (const ch of body) c ^= ch.charCodeAt(0);
  return '$' + body + '*' + c.toString(16).toUpperCase().padStart(2, '0');
}
const GGA_NONE = withChecksum('GPGGA,235229.200,,,,,0,00,,,M,,M,,');
function rmcValidRaw() {
  return withChecksum('GPRMC,000423.900,A,4045.1407,N,07400.1946,W,12.0,90.0,020626,,,A');
}

let pass = 0;
function t(name, fn) { reset(); fn(); console.log('  ok -', name); pass++; }

// The original bug: GGA reports a valid fix, RMC is void, RMC arrives last.
t('GGA fix then RMC void -> hasFix true, coords from GGA kept', () => {
  feed(GGA_FIX); feed(RMC_VOID);
  assert.strictEqual(state.hasFix, true);
  assert.ok(Math.abs(state.lat - 40.75234) < 1e-3, 'lat preserved');
  assert.ok(Math.abs(state.lon - -74.00324) < 1e-3, 'lon preserved');
  assert.strictEqual(state.fixQuality, 1, 'fixQuality normalized to number 1');
});

t('RMC void then GGA fix -> hasFix true', () => {
  feed(RMC_VOID); feed(GGA_FIX);
  assert.strictEqual(state.hasFix, true);
  assert.ok(state.lat !== null && state.lon !== null);
});

t('RMC valid alone -> hasFix true, coords from RMC', () => {
  feed(rmcValidRaw());
  assert.strictEqual(state.rmcValid, true);
  assert.strictEqual(state.hasFix, true);
  assert.ok(state.lat !== null);
  assert.ok(Math.abs(state.speedMph - 12 * 1.15078) < 0.1, 'speed converted');
});

t('GGA DGPS -> fixQuality === 2', () => {
  feed(GGA_DGPS);
  assert.strictEqual(state.fixQuality, 2);
  assert.strictEqual(state.hasFix, true);
});

t('both no-fix (GGA none + RMC void) -> hasFix false, coords nulled', () => {
  feed(GGA_FIX); feed(RMC_VOID);   // establish a fix first
  assert.strictEqual(state.hasFix, true);
  feed(GGA_NONE); feed(RMC_VOID);  // then lose it on both sources
  assert.strictEqual(state.hasFix, false);
  assert.strictEqual(state.lat, null);
  assert.strictEqual(state.lon, null);
});

console.log(`\n${pass} passed`);
