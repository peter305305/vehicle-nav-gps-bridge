import type { ConnectionState, Destination } from './types';

// State shape relayed by the bridge on /control. Fields are *present* iff the
// bridge has been told a value for them (either by the display's `init` seed
// or by a phone `set`). Absent fields mean "no opinion"; the display should
// keep whatever it already has. For `destination`, an explicit `null` means
// "cleared" — different from absent, so the display can wipe its env default.
export interface ControlState {
  interactive?: boolean;
  zoom?: number;
  destination?: Destination | null;
}

type StateListener = (s: ControlState) => void;
type RecenterListener = () => void;
type StateConnListener = (s: ConnectionState) => void;

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 10000;

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function parseDestination(d: unknown): Destination | null {
  if (d === null || d === undefined) return null;
  if (typeof d !== 'object') return null;
  const obj = d as Record<string, unknown>;
  if (!isFiniteNumber(obj.lat) || !isFiniteNumber(obj.lon)) return null;
  const lat = obj.lat as number;
  const lon = obj.lon as number;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, label: typeof obj.label === 'string' ? obj.label : undefined };
}

function parseState(s: unknown): ControlState | null {
  if (!s || typeof s !== 'object') return null;
  const obj = s as Record<string, unknown>;
  const out: ControlState = {};
  if (typeof obj.interactive === 'boolean') out.interactive = obj.interactive;
  if (isFiniteNumber(obj.zoom)) out.zoom = obj.zoom as number;
  if ('destination' in obj) {
    // Explicit null means the value was set then cleared; honor it. A real
    // object goes through parseDestination for shape/range validation.
    out.destination = obj.destination === null ? null : parseDestination(obj.destination);
  }
  return out;
}

export class ControlClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: number | null = null;
  private stateListeners = new Set<StateListener>();
  private recenterListeners = new Set<RecenterListener>();
  private connListeners = new Set<StateConnListener>();
  // `init` payload to send on every (re)connect so the bridge can seed its
  // controlState with our env defaults if no phone has set a value yet.
  private initPayload: ControlState | null = null;

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
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  setInitPayload(state: ControlState): void {
    this.initPayload = state;
    // If we're already connected, push it now so the bridge has the seed even
    // if main wired the listener after connection opened.
    this.sendInit();
  }

  onState(cb: StateListener): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onRecenter(cb: RecenterListener): () => void {
    this.recenterListeners.add(cb);
    return () => this.recenterListeners.delete(cb);
  }

  onConnectionState(cb: StateConnListener): () => void {
    this.connListeners.add(cb);
    return () => this.connListeners.delete(cb);
  }

  private sendInit(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (!this.initPayload) return;
    try {
      this.socket.send(JSON.stringify({ type: 'init', state: this.initPayload }));
    } catch {
      // ignore — next reconnect will retry
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.emitConn('connecting');
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
      this.emitConn('open');
      this.sendInit();
    });

    ws.addEventListener('message', (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: unknown; state?: unknown };
      if (m.type === 'state') {
        const parsed = parseState(m.state);
        if (parsed) for (const cb of this.stateListeners) cb(parsed);
      } else if (m.type === 'recenter') {
        for (const cb of this.recenterListeners) cb();
      }
    });

    ws.addEventListener('close', () => {
      this.socket = null;
      this.emitConn('closed');
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // close will follow; reconnect logic lives there
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private emitConn(s: ConnectionState): void {
    for (const cb of this.connListeners) cb(s);
  }
}
