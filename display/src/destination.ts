import type { Destination } from './types';

// The destination can now be set at runtime by the control channel; this
// provider holds the current value and notifies listeners on change. Seeded
// from env on construction so the display still works with no control client.

export interface DestinationProvider {
  getCurrent(): Destination | null;
  onChange(cb: (d: Destination | null) => void): () => void;
}

export class MutableDestinationProvider implements DestinationProvider {
  private current: Destination | null;
  private listeners = new Set<(d: Destination | null) => void>();

  constructor(initial: Destination | null) {
    this.current = initial;
  }

  getCurrent(): Destination | null {
    return this.current;
  }

  setDestination(d: Destination | null): void {
    // Cheap equality check to avoid notifying for no-op updates from the bridge
    // echoing our own values back to us.
    if (sameDestination(this.current, d)) return;
    this.current = d;
    for (const cb of this.listeners) cb(d);
  }

  onChange(cb: (d: Destination | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

function sameDestination(a: Destination | null, b: Destination | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.lat === b.lat && a.lon === b.lon && (a.label ?? '') === (b.label ?? '');
}
