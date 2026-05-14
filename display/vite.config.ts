import { defineConfig } from 'vite';

// Host 0.0.0.0 so the Pi can serve to the LAN if needed (e.g. for debugging from a laptop).
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
});
