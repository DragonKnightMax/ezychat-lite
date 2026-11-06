import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Single source of truth for the version: the root package.json (see scripts/sync-version.mjs).
const ROOT_PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string };

const SERVER = process.env.WATI_DEV_SERVER ?? 'http://127.0.0.1:7420';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(ROOT_PKG.version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // @ezychat/shared resolves to its TypeScript source inside the monorepo (no build needed).
    conditions: ['ezychat-source', ...defaultClientConditions],
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false, // src/pwa/registerSW.ts registers it
      includeAssets: [
        'favicon.ico',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-512.png',
        'badge-96.png',
      ],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      },
      manifest: {
        id: '/',
        name: 'EzyChat Lite',
        short_name: 'EzyChat Lite',
        description: 'Shared team inbox for WhatsApp',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#0F766E',
        background_color: '#ffffff',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      devOptions: { enabled: false, type: 'module' },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: false },
      '/socket.io': { target: SERVER, ws: true, changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      '/api': { target: SERVER, changeOrigin: false },
      '/socket.io': { target: SERVER, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
  },
});
