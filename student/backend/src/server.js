import http from 'node:http';
import { createApp } from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { initSocket } from './sockets/index.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { startQuizExpirySweep } from './jobs/quizExpirySweep.job.js';
import { startLiveClassStatusSweep } from './jobs/liveClassStatusSweep.job.js';
import { startPortalSyncSweep } from './jobs/portalSyncSweep.job.js';
import { startLessonVideoRecheck } from './jobs/lessonVideoRecheck.job.js';

async function main() {
  try {
    await connectDB();
  } catch (err) {
    logger.error('[Startup] Failed to connect to MongoDB. The server will not start against a broken DB state.', err.message);
    process.exit(1);
  }

  const app = createApp();
  const httpServer = http.createServer(app);
  initSocket(httpServer);
  startQuizExpirySweep();
  startLiveClassStatusSweep();
  startPortalSyncSweep();
  startLessonVideoRecheck();

  httpServer.listen(env.port, () => {
    logger.info(`Nalanda Student Backend running on http://localhost:${env.port} (${env.nodeEnv})`);

    // Log the CORS allow-list at boot. A frontend origin missing from
    // CLIENT_URL takes the whole site down - every API call fails the
    // preflight - while the site itself still loads and looks fine, so the
    // cause is easy to miss. Moving to a custom domain is exactly when this
    // bites: www and the apex are separate origins and BOTH need listing.
    logger.info(`[CORS] Allowed browser origins: ${env.clientUrls.join(', ')}`);
    logger.info(`[Email] Links in outgoing email point to: ${env.clientUrl}`);
  });

  const shutdown = async (signal) => {
    logger.info(`[Shutdown] Received ${signal}, closing gracefully...`);
    httpServer.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    // Force-exit if graceful shutdown hangs.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('[UnhandledRejection]', reason);
  });
}

main();
