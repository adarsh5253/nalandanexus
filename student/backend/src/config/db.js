import mongoose from 'mongoose';
import dns from 'node:dns';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// Windows dev-machine workaround: Node's bundled DNS resolver sometimes
// falls back to a dead 127.0.0.1 loopback instead of the network adapter's
// real DNS server, even though the OS's own resolver works fine - this
// makes mongodb+srv:// SRV lookups fail with ECONNREFUSED while `nslookup`
// succeeds from the same machine. Only kicks in when that exact broken
// state is detected, so it's a no-op anywhere DNS is already configured
// correctly (e.g. production).
if (dns.getServers().length === 1 && dns.getServers()[0] === '127.0.0.1') {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

mongoose.set('strictQuery', true);

let isConnected = false;

export async function connectDB(uriOverride) {
  const uri = uriOverride || env.mongoUri;

  mongoose.connection.on('connected', () => {
    isConnected = true;
    logger.info(`[MongoDB] Connected -> ${maskUri(uri)}`);
  });

  mongoose.connection.on('error', (err) => {
    logger.error('[MongoDB] Connection error', err.message);
  });

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logger.warn('[MongoDB] Disconnected');
  });

  // Do not let the server run silently against a broken DB.
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,

    /**
     * Connection pool. Mongoose's default is maxPoolSize 100, which on a
     * single small instance means a burst of traffic can open far more
     * connections to Atlas than the tier allows - and Atlas then refuses
     * them, which surfaces in the browser as requests that hang until their
     * own timeout. 20 is comfortably above this service's real concurrency
     * and well inside the connection limit.
     *
     * minPoolSize keeps a few sockets warm so a request arriving after an
     * idle period does not pay for a fresh TCP + TLS + auth handshake before
     * its first query - that handshake is a large part of why the first page
     * load after a quiet spell felt slow.
     */
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 20,
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 2,

    /**
     * A query that cannot be served promptly must fail rather than hold a
     * request open. Without this a stalled operation kept its HTTP request
     * pending indefinitely, which is the server-side half of the hanging
     * requests the frontends were spinning on.
     */
    socketTimeoutMS: 45000,

    /**
     * Index builds belong in a deploy step, not on the hot path of a boot.
     * With autoIndex left at its default of true, every cold start walked
     * every schema and issued createIndex for all of them before the process
     * could usefully serve traffic - on this instance, which sleeps when idle,
     * that cost was paid on the first request of every quiet period. The
     * sibling teacher and admin services already disable it in production;
     * this one did not. Indexes are still created automatically in
     * development and test, where schemas change.
     */
    autoIndex: env.nodeEnv !== 'production',
  });

  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
  isConnected = false;
}

export function isDbConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}

function maskUri(uri) {
  try {
    const url = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://'));
    if (url.password) url.password = '****';
    if (url.username) url.username = '****';
    return url.toString();
  } catch {
    return 'mongodb://***';
  }
}
