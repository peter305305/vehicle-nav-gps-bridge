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

const env = import.meta.env;

export const config = {
  gpsWsUrl: parseString(env.VITE_GPS_WS_URL as string | undefined, 'ws://localhost:8080'),
  mapStyleUrl: parseString(
    env.VITE_MAP_STYLE_URL as string | undefined,
    'https://demotiles.maplibre.org/style.json',
  ),
  mapboxToken: parseOptional(env.VITE_MAPBOX_TOKEN as string | undefined),
  destinationLat: parseOptional(env.VITE_DESTINATION_LAT as string | undefined),
  destinationLon: parseOptional(env.VITE_DESTINATION_LON as string | undefined),
  destinationLabel: parseString(env.VITE_DESTINATION_LABEL as string | undefined, 'Destination'),
  directionsRefreshMs: parseNumber(env.VITE_DIRECTIONS_REFRESH_MS as string | undefined, 30000),
} as const;

export function getDestinationFromEnv(): Destination | null {
  if (config.destinationLat === null || config.destinationLon === null) return null;
  const lat = Number(config.destinationLat);
  const lon = Number(config.destinationLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: config.destinationLabel };
}
