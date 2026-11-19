import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: false
  },
  build: {
    // 600 is Vite's default warning line; the route chunks below sit well
    // under it, and anything that creeps back over deserves the warning.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        /**
         * Vendor code is split out of the entry chunk so it can be cached
         * across deploys: application code changes on every release, the
         * React/router/chart libraries do not, and bundling them together
         * means a one-line copy fix re-downloads all of it.
         *
         * Splitting by library rather than one big "vendor" chunk also keeps
         * the heavy, rarely-needed pieces off the critical path - `recharts`
         * alone is ~370KB and is only reached on the dashboard and the
         * performance page, so it must not sit in whatever chunk the landing
         * page needs.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-vendor')) return 'charts';
          if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) return 'motion';
          if (id.includes('socket.io-client') || id.includes('engine.io-client')) return 'realtime';
          if (id.includes('react-router')) return 'router';
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('scheduler')) return 'react';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('canvas-confetti')) return 'confetti';
          return 'vendor';
        },
      },
    },
  },
});
