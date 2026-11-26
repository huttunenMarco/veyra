import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const api = env.VITE_API_URL || 'http://localhost:4000';
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    build: { chunkSizeWarningLimit: 2000 },
    server: {
      port: 5180,
      strictPort: true,
      // Same-origin API in development: cookies and images just work.
      proxy: { '/api/v1': { target: api }, '/api/docs': { target: api }, '/agent/v1': { target: api } },
    },
  };
});
