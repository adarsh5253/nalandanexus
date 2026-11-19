import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        /**
         * Vendor code is split out of the entry chunk so it can be cached
         * across deploys: application code changes on every release, the
         * React/router/chart/UI libraries do not, and bundling them all
         * together meant every release re-downloaded the lot.
         *
         * Splitting by library also keeps the heavy, rarely-needed pieces off
         * the critical path. This portal shipped a single ~930KB entry chunk
         * that had to be downloaded, parsed and executed before the login
         * screen could paint, because every page and every library it pulls
         * in was statically imported from App.jsx.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-vendor')) return 'charts';
          if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) return 'motion';
          if (id.includes('@mui') || id.includes('@emotion')) return 'mui';
          if (id.includes('socket.io-client') || id.includes('engine.io-client')) return 'realtime';
          if (id.includes('react-router')) return 'router';
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('scheduler')) return 'react';
          if (id.includes('lucide-react')) return 'icons';
          return 'vendor';
        },
      },
    },
  },
});
