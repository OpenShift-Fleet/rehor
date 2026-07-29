import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const mockWSPath = path.resolve(__dirname, 'e2e/mockWebSocket.tsx');

export default defineConfig({
  plugins: [
    {
      name: 'mock-websocket',
      enforce: 'pre',
      resolveId(source) {
        if (source.endsWith('/hooks/useWebSocket') || source.endsWith('/hooks/useWebSocket.tsx')) {
          return mockWSPath;
        }
      },
    },
    react(),
  ],
  root: '.',
  server: { port: 5174 },
});
