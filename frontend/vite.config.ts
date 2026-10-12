import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import path from 'node:path'

// MiniFoundry SPA.
// - TanStack Router generates src/routeTree.gen.ts from src/routes/.
// - /api is proxied to the Rust API gateway (same-origin for cookies, so the
//   frontend keeps its relative fetch URLs unchanged from the Next.js app).
export default defineConfig({
  plugins: [
    TanStackRouterVite({
      quoteStyle: 'single',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  css: {
    // Disable upward PostCSS config discovery — the repo root still holds the
    // legacy Next.js postcss.config.mjs; Tailwind v4 runs via the Vite plugin.
    postcss: { plugins: [] },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
  },
})
