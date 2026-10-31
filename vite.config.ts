import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Vite 8 unconditionally injects /@vite/client and calls transport.connect() at module load even when
 * server.hmr === false / server.ws === false. In proxied Cloud Run preview environments where HMR is
 * disabled or WebSocket upgrades are closed by the ingress proxy, this prevents unhandled
 * "Error: WebSocket closed without opened." rejections while keeping all CSS/module exports intact.
 */
function vite8SafeClientTransport(hmrDisabled: boolean): Plugin {
  return {
    name: 'bexora-vite8-safe-client-transport',
    apply: 'serve',
    enforce: 'post',
    transform(code, id) {
      const cleanId = id.split('?')[0].replace(/\\/g, '/');
      if (!cleanId.endsWith('/vite/dist/client/client.mjs')) {
        return null;
      }

      if (hmrDisabled) {
        return code.replace(
          /const createWebSocketModuleRunnerTransport\s*=\s*\(options\)\s*=>\s*\{[\s\S]*?\n\};/,
          `const createWebSocketModuleRunnerTransport = () => ({
  connect({ onMessage }) {
    onMessage({ type: "connected" });
  },
  disconnect() {},
  send() {}
});`
        );
      }

      // Even when HMR is enabled, prevent remote browsers from falling back to localhost:5173
      // or throwing unhandled rejections if an upstream proxy closes the WebSocket handshake.
      return code
        .replace(
          'if (!hmrPort) {',
          'if (!hmrPort && (importMetaUrl.hostname === "localhost" || importMetaUrl.hostname === "127.0.0.1")) {'
        )
        .replace(
          /console\.error\(`\[vite\] failed to connect to websocket[\s\S]*?throw e;/m,
          'console.debug("[vite] HMR WebSocket unavailable behind proxy; continuing without live reload."); return;'
        )
        .replace(
          /transport\.connect\(createHMRHandler\(handleMessage\)\);/g,
          'Promise.resolve(transport.connect(createHMRHandler(handleMessage))).catch(() => {});'
        );
    },
  };
}

export default defineConfig(() => {
  const hmrDisabled = process.env.DISABLE_HMR === 'true';
  const fcmOfficialDefaultVapidPublicKey =
    'BDOU99-h67HcA6JeFXHbSNMu7e2yNNu3RzoMj8TM4W88jITfq7ZmPvIM1Iv-4_l2LxQcYwhqby2xGpWwzjfAnG4';
  const rawEnvVapid = (process.env.VITE_FIREBASE_VAPID_KEY || '').trim();
  const resolvedPublicVapidKey =
    rawEnvVapid &&
    rawEnvVapid !== 'YOUR_FIREBASE_VAPID_KEY' &&
    rawEnvVapid !== 'MY_FIREBASE_VAPID_KEY' &&
    rawEnvVapid !== 'PASTE_YOUR_VAPID_KEY_HERE'
      ? rawEnvVapid
      : fcmOfficialDefaultVapidPublicKey;

  return {
    base: './',
    define: {
      'import.meta.env.VITE_FIREBASE_VAPID_KEY': JSON.stringify(resolvedPublicVapidKey),
    },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        manifestFilename: 'manifest.webmanifest',
        includeAssets: [
          'favicon.ico',
          'favicon-16x16.png',
          'favicon-32x32.png',
          'apple-touch-icon.png',
          'icon.svg',
          'bexora-logo.svg',
          'icon-192.png',
          'icon-512.png',
          'icon-maskable-512.png',
          'sounds/01_soft_normal.wav',
          'sounds/02_crisp_normal.wav',
          'sounds/03_premium_deal.wav',
          'sounds/04_urgent_deal.wav',
        ],
        manifest: {
          id: '/',
          name: 'BEXORA',
          short_name: 'BEXORA',
          description: 'Buy & Sell Digital Assets',
          theme_color: '#FF6500',
          background_color: '#0B1020',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: 'icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,wav}'],
          globIgnores: [
            '**/firebase-messaging-sw.js',
            '**/vendor/firebase/**',
            '**/BEXORA_INFINITYFREE_PRODUCTION.zip',
          ],
          navigateFallbackDenylist: [
            /^\/api\//,
            /^\/firebase-messaging-sw\.js$/,
            /^\/vendor\/firebase\/.*\.js$/,
            /^\/sounds\/.*\.wav$/,
            /BEXORA_INFINITYFREE_PRODUCTION\.zip$/,
          ],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'bexora-google-fonts',
                expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'bexora-gstatic-fonts',
                expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
      vite8SafeClientTransport(hmrDisabled),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      ws: hmrDisabled ? (false as const) : undefined,
      hmr: hmrDisabled ? (false as const) : { overlay: false },
      watch: hmrDisabled ? null : {},
    },
  };
});

