import type { ConnectionState, GpsReading } from './types';

type ReadingListener = (r: GpsReading) => void;
type StateListener = (s: ConnectionState) => void;

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 10000;

// Minimal validator. The bridge is trusted but malformed packets shouldn't crash the UI.
// We only require `hasFix` to be boolean — every other field can be null.
function isReading(msg: unknown): msg is GpsReading {
  return typeof msg === 'object' && msg !== null && typeof (msg as GpsReading).hasFix === 'boolean';
}

export class GpsClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: number | null = null;
  private readingListeners = new Set<ReadingListener>();
  private stateListeners = new Set<StateListener>();

  constructor(private readonly url: string) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.emitState('closed');
  }

  onReading(cb: ReadingListener): () => void {
    this.readingListeners.add(cb);
    return () => this.readingListeners.delete(cb);
  }

  onConnectionState(cb: StateListener): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private connect(): void {
    if (this.stopped) return;
    this.emitState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;

    ws.addEventListener('open', () => {
      this.backoffMs = BACKOFF_INITIAL_MS;
      this.emitState('open');
    });

    ws.addEventListener('message', (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (!isReading(parsed)) return;
      for (const cb of this.readingListeners) cb(parsed);
    });

    ws.addEventListener('error', () => {
      // The browser will follow up with a `close` event; reconnect logic lives there.
    });

    ws.addEventListener('close', () => {
      this.socket = null;
      this.emitState('closed');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    // Exponential backoff capped at BACKOFF_MAX_MS. Reset happens on successful 'open'.
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private emitState(s: ConnectionState): void {
    for (const cb of this.stateListeners) cb(s);
  }
}
