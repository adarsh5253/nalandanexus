import mongoose from 'mongoose';
import dns from 'node:dns';
import { env } from './env.js';

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

// Applied to every schema compiled after this module loads (this file is
// imported before any model file anywhere in the app). Ensures every
// non-lean JSON response carries both `_id` and a plain string `id` —
// matching the id-keyed shape the admin frontend's components already
// expect from the entities they render.
mongoose.plugin((schema) => {
  schema.set('toJSON', { virtuals: true, ...(schema.get('toJSON') || {}) });
  schema.set('toObject', { virtuals: true, ...(schema.get('toObject') || {}) });
});

let hasConnectedOnce = false;

/**
 * Connects to MongoDB with a small retry loop so a slow-starting local
 * `mongod` (or a transient Atlas hiccup) doesn't crash the whole process on
 * boot. Logs connection state transitions so issues are easy to diagnose.
 */
export async function connectDatabase({ retries = 5, retryDelayMs = 3000 } = {}) {
  mongoose.connection.on('connected', () => {
    hasConnectedOnce = true;
    console.log(`[db] Mongoose connected -> ${maskUri(env.mongodbUri)}`);
  });
  mongoose.connection.on('error', (err) => {
    console.error('[db] Mongoose connection error:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] Mongoose disconnected.');
  });
  mongoose.connection.on('reconnected', () => {
    console.log('[db] Mongoose reconnected.');
  });

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await mongoose.connect(env.mongodbUri, {
        serverSelectionTimeoutMS: 8000,
        autoIndex: env.nodeEnv !== 'production',

        /**
         * Connection pool. Mongoose's default is maxPoolSize 100, which on a
         * single small instance means a traffic burst can open far more
         * connections to Atlas than the tier allows - Atlas then refuses
         * them, which surfaces in the browser as requests that hang until
         * their own timeout. 20 is comfortably above this service's real
         * concurrency and well inside the connection limit.
         *
         * minPoolSize keeps a few sockets warm so a request arriving after an
         * idle period does not pay for a fresh TCP + TLS + auth handshake
         * before its first query.
         */
        maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 20,
        minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 2,

        /**
         * A query that cannot be served promptly must fail rather than hold
         * its HTTP request open indefinitely - an un-timed-out operation is
         * the server-side half of a frontend stuck on a spinner.
         */
        socketTimeoutMS: 45000,
      });
      return mongoose.connection;
    } catch (err) {
      console.error(`[db] Connection attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) {
        throw new Error(
          `[db] Could not connect to MongoDB after ${retries} attempts. ` +
            `Check MONGODB_URI in your .env (currently pointing at ${maskUri(env.mongodbUri)}). ` +
            `Original error: ${err.message}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return undefined;
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
    console.log('[db] Mongoose connection closed gracefully.');
  }
}

export function isDatabaseConnected() {
  return mongoose.connection.readyState === 1 && hasConnectedOnce;
}

function maskUri(uri) {
  try {
    const u = new URL(uri);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
  }
}

export default connectDatabase;
