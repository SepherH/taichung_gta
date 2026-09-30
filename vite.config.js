import { defineConfig } from 'vite';

// 臺中GTA prototype 的 Vite 設定（保持最小化）
export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5273,
    strictPort: true,
    allowedHosts: ['tcgta.i23iv.cc'],
  },
  preview: {
    host: true,
    port: 5273,
    strictPort: true,
    allowedHosts: ['tcgta.i23iv.cc'],
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
});
