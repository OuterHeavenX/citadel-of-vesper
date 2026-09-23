import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages project site: https://outerheavenx.github.io/citadel-of-vesper/
  base: '/citadel-of-vesper/',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Keep chunks readable; avoid one gigantic bundle.
        manualChunks: {
          phaser: ['phaser'],
        },
      },
    },
  },
  server: {
    port: 5173,
    open: false,
  },
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
});
