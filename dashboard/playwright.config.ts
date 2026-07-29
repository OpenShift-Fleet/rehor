import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.spec.ts',
  use: {
    baseURL: 'http://localhost:5174',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'npx vite --config vite.gallery.config.ts --port 5174',
    port: 5174,
    reuseExistingServer: !process.env.CI,
  },
});
