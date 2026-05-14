import type { GpsReading } from './types';

interface Pos {
  lat: number;
  lon: number;
  heading: number;
}

type FrameListener = (p: Pos) => void;

// 150ms gives us a hair of headroom over the nominal 100ms (10 Hz) update period.
// If we used exactly 100ms the marker would briefly freeze whenever a packet was late;
// at 150ms the next packet almost always arrives before the previous interpolation
// finishes, so the motion stays smooth without ever overshooting.
const INTERP_DURATION_MS = 150;

// Ease-out cubic: starts fast, decelerates to the target. Feels natural for vehicle motion —
// the marker "settles" rather than slamming to the new fix.
function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

// Shortest-angle interpolation across the 0/360 boundary. Without this, a heading change
// from 350° to 10° would spin the marker the long way around (340°) instead of the short
// way (20°). We normalize the delta to (-180, 180] before lerping.
function lerpHeading(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > 180) delta -= 360;
  while (delta <= -180) delta += 360;
  let result = a + delta * t;
  // Keep output in [0, 360)
  result = ((result % 360) + 360) % 360;
  return result;
}

export class PositionAnimator {
  private previous: Pos | null = null;
  private target: Pos | null = null;
  private current: Pos | null = null;
  private startTime = 0;
  private listeners = new Set<FrameListener>();
  private rafId: number | null = null;

  update(reading: GpsReading): void {
    // No-fix readings freeze the marker; the overlay handles the "stale" UX separately.
    if (reading.lat === null || reading.lon === null) return;

    const next: Pos = {
      lat: reading.lat,
      lon: reading.lon,
      heading: reading.heading ?? this.current?.heading ?? 0,
    };

    // Start from whatever we last rendered so we never jump.
    this.previous = this.current ? { ...this.current } : { ...next };
    this.target = next;
    this.startTime = performance.now();
    if (!this.current) this.current = { ...next };
  }

  onFrame(cb: FrameListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (this.rafId !== null) return; // idempotent
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.step();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private step(): void {
    if (!this.previous || !this.target || !this.current) return;
    const elapsed = performance.now() - this.startTime;
    const tRaw = elapsed / INTERP_DURATION_MS;
    const t = tRaw <= 0 ? 0 : tRaw >= 1 ? 1 : tRaw;
    const eased = easeOutCubic(t);

    this.current.lat = this.previous.lat + (this.target.lat - this.previous.lat) * eased;
    this.current.lon = this.previous.lon + (this.target.lon - this.previous.lon) * eased;
    this.current.heading = lerpHeading(this.previous.heading, this.target.heading, eased);

    for (const cb of this.listeners) cb(this.current);
  }
}
