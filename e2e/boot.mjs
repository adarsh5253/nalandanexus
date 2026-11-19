/**
 * Boots ONE portal backend for the cross-portal end-to-end run, in its own
 * process, against its own throwaway in-memory MongoDB.
 *
 *   node e2e/boot.mjs <student|admin|teacher> <port>
 *
 * Each portal is a separate process because each holds its own mongoose
 * connection and config singletons - three apps in one process would share
 * them and prove nothing about the real bridges between them.
 *
 * Always NODE_ENV=test (set by the driver), which makes every backend skip this
 * machine's .env - that file names production databases and services, and an
 * end-to-end run must never reach them.
 *
 * Prints "READY <port> <mongoUri>" once listening.
 */
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const [, , portal, portArg] = process.argv;
if (process.env.NODE_ENV !== 'test') {
  console.error('boot.mjs refuses to run without NODE_ENV=test');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, portal, 'backend');
const requireFromPortal = createRequire(path.join(dir, 'package.json'));
const load = (spec) => import(pathToFileURL(requireFromPortal.resolve(spec)).href);
const src = (rel) => import(pathToFileURL(path.join(dir, 'src', rel)).href);

const { MongoMemoryServer } = await load('mongodb-memory-server');
const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
const uri = mongod.getUri();
process.env.MONGODB_URI = uri;

let app;
let attachSockets;

if (portal === 'student') {
  const { connectDB } = await src('config/db.js');
  await connectDB(uri);
  const { createApp } = await src('app.js');
  ({ initSocket: attachSockets } = await src('sockets/index.js'));
  app = createApp();
  await seedStudent();
} else if (portal === 'admin') {
  const { connectDatabase } = await src('config/db.js');
  await connectDatabase({ retries: 1 });
  const { createApp } = await src('app.js');
  ({ initSockets: attachSockets } = await src('sockets/index.js'));
  app = createApp();
  const { Admin } = await src('models/Admin.js');
  const passwordHash = await Admin.hashPassword(process.env.E2E_PASSWORD);
  await Admin.create({ name: 'E2E Admin', email: 'admin@e2e.test', passwordHash, role: 'SUPER_ADMIN', status: 'ACTIVE' });
} else if (portal === 'teacher') {
  const { connectDatabase } = await src('config/db.js');
  await connectDatabase({ retries: 1 });
  const { createApp } = await src('app.js');
  ({ initSockets: attachSockets } = await src('sockets/index.js'));
  app = createApp();
  const { User } = await src('models/User.js');
  const { Teacher } = await src('models/Teacher.js');
  const passwordHash = await User.hashPassword(process.env.E2E_PASSWORD);
  for (const [name, email, teacherId] of [
    ['Alice Rao', 'alice@e2e.test', 'TCH-E2E-A'],
    ['Bob Iyer', 'bob@e2e.test', 'TCH-E2E-B'],
  ]) {
    const user = await User.create({ name, email, passwordHash, role: 'teacher', status: 'active' });
    await Teacher.create({ user: user._id, teacherId });
  }
} else {
  console.error(`Unknown portal "${portal}"`);
  process.exit(2);
}

const server = http.createServer(app);
attachSockets?.(server);
await new Promise((resolve) => server.listen(Number(portArg) || 0, '127.0.0.1', resolve));
console.log(`READY ${server.address().port} ${uri}`);

const shutdown = async () => {
  server.close();
  await mongod.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/** The three catalogue courses, shaped like the real ones, with lessons and no videos. */
async function seedStudent() {
  const { Course } = await src('models/Course.js');
  const lessons = (prefix, n) =>
    Array.from({ length: n }, (_, i) => ({
      lessonId: `${prefix}-${i + 1}`,
      title: `${prefix.toUpperCase()} lesson ${i + 1}`,
      duration: `${10 + i} mins`,
      order: i + 1,
      summary: `Summary of ${prefix} lesson ${i + 1}`,
      content: `Written material for ${prefix} lesson ${i + 1}.`,
    }));
  await Course.create([
    {
      slug: 'prarambh',
      title: 'PRARAMBH — The Awakening',
      subtitle: 'Foundation',
      priceInPaise: 0,
      isPublished: true,
      isPurchasable: true,
      pillar: 'communicate',
      videoUrl: '',
      modules: [
        { moduleId: 'mod-1', title: 'The Awakening', order: 1, lessons: lessons('l', 3) },
        { moduleId: 'mod-2', title: 'Mindset', order: 2, lessons: lessons('m', 2) },
      ],
    },
    { slug: 'garud', title: 'GARUD', priceInPaise: 0, isPublished: true, isPurchasable: false, modules: [{ moduleId: 'g-mod-1', title: 'Flight', order: 1, lessons: lessons('g', 2) }] },
    { slug: 'yoddha', title: 'YODDHA', priceInPaise: 0, isPublished: true, isPurchasable: false, modules: [{ moduleId: 'y-mod-1', title: 'Valour', order: 1, lessons: lessons('y', 2) }] },
  ]);
}
