import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component tests only; the production build keeps using vite.config.js.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    setupFiles: ['./src/test-setup.js'],
    restoreMocks: true,
  },
});
