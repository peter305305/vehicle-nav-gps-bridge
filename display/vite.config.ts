import { defineConfig } from 'vite';

// Host 0.0.0.0 so the Pi can serve to the LAN if needed (e.g. for debugging from a laptop).
//
// `base: './'` makes Vite emit *relative* asset URLs in the built index.html
// (e.g. `./assets/index-abc.js`). That lets the same build serve from any URL
// prefix — `/` in dev, `/app/` when hosted by gps-bridge on the Pi — without
// rebuilding for each environment.
export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
});
