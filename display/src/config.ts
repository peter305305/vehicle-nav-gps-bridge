import type { Destination } from './types';

// We parse env vars at module load and freeze the result. Vite inlines import.meta.env
// at build time, so anything missing from .env falls back to the defaults below.
function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseString(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw === '') return fallback;
  return raw;
}

function parseOptional(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  return raw;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Same-origin WebSocket URL derived from the page that served this bundle.
// Used when the env var isn't explicitly set, so a build deployed behind the
// bridge's HTTP server (Pi kiosk) just works without baking in localhost.
function sameOriginWs(path: string): string {
  if (typeof location === 'undefined') return `ws://localhost:8080${path}`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

const env = import.meta.env;

const mapboxToken = parseOptional(env.VITE_MAPBOX_TOKEN as string | undefined);

// Default map style. We want a real dark cartography out of the box because
// the kiosk runs in dim cabin lighting and the demo MapLibre style is bright
// and stylized — wrong for the room.
//
// OpenFreeMap's dark-matter is MapLibre-native vector tiles, free, hosted, and
// key-free. We deliberately DON'T auto-upgrade to Mapbox's dark-v11 even when
// VITE_MAPBOX_TOKEN is set, because Mapbox's current style schema includes
// proprietary properties (3D models, lights, etc.) that MapLibre's strict
// validator rejects ("unknown property" errors → blank map). The token still
// powers the Directions API and the address geocoder; for the basemap, point
// VITE_MAP_STYLE_URL at a known MapLibre-compatible style (MapTiler, Stadia,
// or a Mapbox Studio style exported as MapLibre-compatible) if you want a
// different look.
const defaultStyleUrl = 'https://tiles.openfreemap.org/styles/dark';

export const config = {
  gpsWsUrl: parseString(env.VITE_GPS_WS_URL as string | undefined, sameOriginWs('/gps')),
  controlWsUrl: parseString(env.VITE_CONTROL_WS_URL as string | undefined, sameOriginWs('/control')),
  mapStyleUrl: parseString(env.VITE_MAP_STYLE_URL as string | undefined, defaultStyleUrl),
  mapboxToken,
  destinationLat: parseOptional(env.VITE_DESTINATION_LAT as string | undefined),
  destinationLon: parseOptional(env.VITE_DESTINATION_LON as string | undefined),
  destinationLabel: parseString(env.VITE_DESTINATION_LABEL as string | undefined, 'Destination'),
  directionsRefreshMs: parseNumber(env.VITE_DIRECTIONS_REFRESH_MS as string | undefined, 30000),
  // Off by default for kiosk use; turn on for dev/demo so you can pan and zoom.
  mapInteractive: parseBoolean(env.VITE_MAP_INTERACTIVE as string | undefined, false),
} as const;

export function getDestinationFromEnv(): Destination | null {
  if (config.destinationLat === null || config.destinationLon === null) return null;
  const lat = Number(config.destinationLat);
  const lon = Number(config.destinationLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: config.destinationLabel };
}
