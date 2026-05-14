import type { DirectionsResult } from './types';
import { formatDistance, formatDuration, headingToCompass } from './format';

interface LiveValues {
  speedMph: number | null;
  heading: number | null;
}

export class Overlay {
  private etaEl!: HTMLElement;
  private distEl!: HTMLElement;
  private speedEl!: HTMLElement;
  private hdgEl!: HTMLElement;
  private staleEl: HTMLElement | null;

  constructor(rootId: string, staleId = 'stale-indicator') {
    const root = document.getElementById(rootId);
    if (!root) throw new Error(`Overlay: #${rootId} not found`);
    root.innerHTML = `
      <div class="strip">
        <div class="cell"><div class="label">ETA</div><div class="value" id="eta">—</div></div>
        <div class="cell"><div class="label">DIST</div><div class="value" id="dist">—</div></div>
        <div class="cell"><div class="label">SPEED</div><div class="value" id="speed">—</div><div class="unit">mph</div></div>
        <div class="cell"><div class="label">HDG</div><div class="value" id="hdg">—</div></div>
      </div>
    `;
    this.etaEl = root.querySelector('#eta') as HTMLElement;
    this.distEl = root.querySelector('#dist') as HTMLElement;
    this.speedEl = root.querySelector('#speed') as HTMLElement;
    this.hdgEl = root.querySelector('#hdg') as HTMLElement;
    this.staleEl = document.getElementById(staleId);
  }

  // Split into two methods because speed/heading update at 10 Hz from the GPS stream
  // while ETA/distance only refresh every ~30s from the Directions API. Combining them
  // forced awkward "null means keep last value" semantics; two methods is cleaner.
  updateLive(values: LiveValues): void {
    this.speedEl.textContent =
      values.speedMph !== null && Number.isFinite(values.speedMph)
        ? Math.round(values.speedMph).toString()
        : '—';
    if (values.heading !== null && Number.isFinite(values.heading)) {
      const compass = headingToCompass(values.heading);
      const deg = Math.round(values.heading);
      this.hdgEl.textContent = `${compass} ${deg}°`;
    } else {
      this.hdgEl.textContent = '—';
    }
  }

  updateDirections(result: DirectionsResult): void {
    if (!result) {
      this.etaEl.textContent = '—';
      this.distEl.textContent = '—';
      return;
    }
    this.etaEl.textContent = formatDuration(result.durationSeconds);
    this.distEl.textContent = formatDistance(result.distanceMeters);
  }

  setStale(stale: boolean): void {
    if (!this.staleEl) return;
    this.staleEl.classList.toggle('hidden', !stale);
  }
}
