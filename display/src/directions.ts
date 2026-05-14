import type { Destination, DirectionsResult } from './types';

type ResultListener = (r: DirectionsResult) => void;

interface Pos {
  lat: number;
  lon: number;
}

// We delay the very first request a few seconds after `start()` so the GPS has time to
// produce a fix. Otherwise we'd burn an API call from a stale/null vehicle position.
const INITIAL_DEBOUNCE_MS = 5000;

export class DirectionsService {
  private vehicle: Pos | null = null;
  private destination: Destination | null = null;
  private listeners = new Set<ResultListener>();
  private started = false;

  constructor(
    private readonly token: string | null,
    private readonly refreshMs: number,
  ) {}

  setVehicle(pos: Pos): void {
    this.vehicle = pos;
    if (!this.started) this.start();
  }

  setDestination(dest: Destination | null): void {
    this.destination = dest;
    if (!dest) this.emit(null);
  }

  onResult(cb: ResultListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;

    if (!this.token) {
      // No token = no Directions API available. Emit null once so the overlay shows
      // the em-dash placeholder, then stay quiet — no point setting up a timer.
      this.emit(null);
      return;
    }

    window.setTimeout(() => this.tick(), INITIAL_DEBOUNCE_MS);
  }

  private tick(): void {
    void this.fetchOnce().finally(() => {
      window.setTimeout(() => this.tick(), this.refreshMs);
    });
  }

  private async fetchOnce(): Promise<void> {
    if (!this.token || !this.vehicle || !this.destination) {
      this.emit(null);
      return;
    }
    const v = this.vehicle;
    const d = this.destination;
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving/` +
      `${v.lon},${v.lat};${d.lon},${d.lat}` +
      `?overview=false&access_token=${encodeURIComponent(this.token)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        this.emit(null);
        return;
      }
      const data: unknown = await res.json();
      const route = (data as { routes?: Array<{ distance?: number; duration?: number }> }).routes?.[0];
      if (
        !route ||
        typeof route.distance !== 'number' ||
        typeof route.duration !== 'number'
      ) {
        this.emit(null);
        return;
      }
      this.emit({ distanceMeters: route.distance, durationSeconds: route.duration });
    } catch {
      this.emit(null);
    }
  }

  private emit(r: DirectionsResult): void {
    for (const cb of this.listeners) cb(r);
  }
}
