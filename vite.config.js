import { defineConfig, loadEnv } from 'vite';

// 臺中GTA prototype 的 Vite 設定（保持最小化）
// 若要從通道 / 自訂網域連入 dev server，在 .env.local（不入庫）設定：
//   DEV_ALLOWED_HOSTS=your.domain.example,another.example
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const allowedHosts = (env.DEV_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    base: './',
    server: {
      host: true,
      port: 5273,
      strictPort: true,
      allowedHosts,
    },
    preview: {
      host: true,
      port: 5273,
      strictPort: true,
      allowedHosts,
    },
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 1500,
    },
  };
});
