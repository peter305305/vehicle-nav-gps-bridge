import type { Destination } from './types';

// Extension point: today the destination is static (from env vars). In a later step the
// bridge will gain a second channel for dynamic destinations, at which point we'll add a
// WebSocketDestinationProvider that subscribes and pushes updates through `onChange`.
// The rest of the app already talks to this interface, so swapping providers will be a
// one-line change in main.ts.

export interface DestinationProvider {
  getCurrent(): Destination | null;
  onChange(cb: (d: Destination | null) => void): () => void;
}

export class StaticDestinationProvider implements DestinationProvider {
  constructor(private readonly destination: Destination | null) {}

  getCurrent(): Destination | null {
    return this.destination;
  }

  onChange(_cb: (d: Destination | null) => void): () => void {
    return () => {
      // no-op: static provider never changes
    };
  }
}
