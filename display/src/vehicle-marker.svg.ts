// Stylized chevron pointing up (= north when rotation = 0). The marker is rotated by
// MapLibre to match the GPS heading; we keep the map north-up so passengers always see
// a stable world while the arrow swings to reflect the vehicle's direction of travel.
export const vehicleMarkerSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <defs>
    <filter id="vm-shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.55" />
    </filter>
  </defs>
  <g filter="url(#vm-shadow)">
    <path
      d="M16 3 L27 27 L16 22 L5 27 Z"
      fill="#E6F7FF"
      stroke="#0B1620"
      stroke-width="1.5"
      stroke-linejoin="round"
    />
  </g>
</svg>
`.trim();
