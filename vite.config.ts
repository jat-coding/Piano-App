import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['demo.mid', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Cascade — Piano Visualizer',
        short_name: 'Cascade',
        description: 'Turn MIDI, audio, and video into falling-note piano visualizations.',
        theme_color: '#14110d',
        background_color: '#14110d',
        display: 'fullscreen',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The transcription worker bundles tfjs (~3.4MB) — precache it for offline.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,bin,json,mid,png,wasm}'],
        runtimeCaching: [
          {
            // Salamander piano samples — cache on first use so audio works offline.
            urlPattern: /^https:\/\/tonejs\.github\.io\/.*\.mp3$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'piano-samples',
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 60 },
            },
          },
          {
            // Google Fonts (Fraunces / Spectral) — cache for offline + speed.
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
  },
  // The desktop transcription helper (tools/transcribe-helper, 127.0.0.1:5192, a system unit)
  // is reached through this same-origin route, so the phone over Tailscale needs no new port.
  // Long timeouts: a CPU-only run of a 2-minute clip takes minutes. Hosts without this proxy
  // (e.g. a Vercel build) answer 404, and the app falls back to the on-device engine.
  preview: {
    proxy: {
      '/api/transcribe': {
        target: 'http://127.0.0.1:5192',
        changeOrigin: false,
        timeout: 15 * 60 * 1000,
        proxyTimeout: 15 * 60 * 1000,
        // The proxy doesn't pass a client hang-up upstream on its own, so Cancel in the app
        // would leave the GPU job running. Drop the upstream request when the client goes away
        // before the reply is done; the helper sees the closed socket and stops the job.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, _req, res) => {
            res.on('close', () => {
              if (!res.writableFinished) proxyReq.destroy();
            });
          });
        },
      },
    },
  },
});
