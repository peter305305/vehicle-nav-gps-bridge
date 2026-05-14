// Shape of a single GPS reading broadcast by the bridge service.
// Mirrors the bridge's JSON exactly — do not add fields here without a corresponding
// change on the bridge side.
export interface GpsReading {
  lat: number | null;
  lon: number | null;
  speedKnots: number | null;
  speedMph: number | null;
  /** Degrees from North, clockwise. 0 = N, 90 = E. */
  heading: number | null;
  satellites: number | null;
  fixQuality: number | null;
  /** ISO 8601 timestamp from the bridge. */
  timestamp: string;
  hasFix: boolean;
}

export interface Destination {
  lat: number;
  lon: number;
  label?: string;
}

export type ConnectionState = 'connecting' | 'open' | 'closed';

export type DirectionsResult = {
  distanceMeters: number;
  durationSeconds: number;
} | null;
