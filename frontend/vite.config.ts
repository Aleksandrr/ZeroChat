import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-vite-plugin'
import path from 'path'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
// mkcert is disabled in this sandbox (no sudo available). Re-enable in
// your local dev environment to get HTTPS for SameSite=None cookies.
// import mkcert from 'vite-plugin-mkcert'
export default defineConfig({
  // TanStack Router plugin must be before react plugin
  plugins: [
    // mkcert(), // HTTPS for SameSite=None cookies
    TanStackRouterVite({
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    wasm(),
    topLevelAwait()
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Fix for @tanstack/router-plugin importing nested zod without index.js
      "zod": path.resolve(__dirname, "./node_modules/zod"),
    },
    // Важно для работы на сетевых дисках (SMB/WebDAV)
    // Предотвращает ошибки резолвинга пакетов
    preserveSymlinks: true,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
  },
  server: {
    port: 3000,
    host: true,
    // Добавлено для работы на сетевых дисках (SMB)
    watch: {
      usePolling: true,      // Включает опрос файловой системы
      interval: 1000,        // Интервал опроса в миллисекундах (можно уменьшить до 300 для большей отзывчивости)
    },
    // Proxy API requests to backend to avoid CORS issues with cookies
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        // Rewrite cookie domain from backend to frontend
        cookieDomainRewrite: {
          '*': '',
        },
        // Forward cookies from backend response
        cookiePathRewrite: {
          '*': '/',
        },
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  optimizeDeps: {
    // Exclude @getmaapp/signal-wasm and argon2-browser from optimization
    // WASM modules need special handling and should not be pre-bundled
    exclude: ['@getmaapp/signal-wasm', 'argon2-browser'],
  },
  // WASM files need to be served correctly
  assetsInclude: ['**/*.wasm'],
})