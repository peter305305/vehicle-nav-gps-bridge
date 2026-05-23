// Stylized chevron pointing up (= north when rotation = 0). The marker is rotated by
// MapLibre to match the GPS heading; we keep the map north-up so passengers always see
// a stable world while the arrow swings to reflect the vehicle's direction of travel.
//
// Visual stack (back → front):
//   1. Cyan outer glow (Gaussian blur)
//   2. Drop shadow for depth on dark backgrounds
//   3. The chevron itself: near-white fill, dark stroke for crispness against any tile color
export const vehicleMarkerSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
  <defs>
    <filter id="vm-glow" x="-75%" y="-75%" width="250%" height="250%">
      <feGaussianBlur stdDeviation="2.2" result="b" />
      <feFlood flood-color="#22D3EE" flood-opacity="0.7" />
      <feComposite in2="b" operator="in" result="glow" />
      <feMerge>
        <feMergeNode in="glow" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
    <filter id="vm-shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.6" />
    </filter>
    <linearGradient id="vm-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="100%" stop-color="#A5F3FC" />
    </linearGradient>
  </defs>
  <g filter="url(#vm-glow)">
    <g filter="url(#vm-shadow)">
      <path
        d="M20 4 L33 33 L20 27 L7 33 Z"
        fill="url(#vm-fill)"
        stroke="#0B1620"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </g>
  </g>
</svg>
`.trim();
