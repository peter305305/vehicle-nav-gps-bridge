const COMPASS_16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

export function headingToCompass(deg: number): string {
  // Normalize to [0, 360), then bucket into 22.5° slices. `+ 11.25` shifts the bucket
  // boundaries so e.g. 350° rounds to N (not NNW) — i.e. the slice is centered on the
  // cardinal direction rather than starting at it.
  const normalized = ((deg % 360) + 360) % 360;
  const idx = Math.floor(((normalized + 11.25) % 360) / 22.5);
  return COMPASS_16[idx] ?? 'N';
}

export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  const miles = meters / 1609.344;
  return `${miles.toFixed(1)} mi`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return '<1 min';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds - hours * 3600) / 60);
  return `${hours}h ${mins}m`;
}
