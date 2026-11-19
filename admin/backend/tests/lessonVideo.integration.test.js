import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Lesson videos from the Admin portal.
 *
 * This portal holds no lessons: it gates (courses.manage), forwards to the
 * student service, and audits. So the test stands up a stand-in student
 * service and checks exactly that - who gets through, what crosses the bridge
 * (including who did it), that the student service's own refusal reaches the
 * admin with its code intact, and that an unreachable service is a 503 rather
 * than a silent success. The student-side behaviour itself is covered in
 * student/backend/tests/lessonVideo.integration.test.js and the cross-portal
 * run in e2e/lessonVideo.e2e.mjs.
 */

let mongod;
let server;
let base;
let student;
const received = [];
const fake = { down: false, rejectNext: null };

function startFakeStudentService() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (fake.down) return req.socket.destroy();
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined;
        received.push({ method: req.method, url: req.url, key: req.headers['x-internal-service-key'], body });
        const send = (status, payload) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (fake.rejectNext) {
          const r = fake.rejectNext;
          fake.rejectNext = null;
          return send(r.status, { success: false, error: { code: r.code, message: r.message, details: r.details } });
        }
        if (req.method === 'PUT') {
          return send(200, {
            success: true,
            data: {
              lessonId: 'l-1',
              previousVideoId: null,
              wasPublished: false,
              video: { videoId: 'dQw4w9WgXcQ', isPublished: Boolean(body?.isPublished), availability: 'available' },
            },
          });
        }
        if (req.method === 'DELETE') return send(200, { success: true, data: { lessonId: 'l-1', removed: true, previousVideoId: 'dQw4w9WgXcQ' } });
        if (req.url.endsWith('/inspect')) return send(200, { success: true, data: { videoId: 'dQw4w9WgXcQ', availability: 'available' } });
        if (req.url.endsWith('/lesson-videos/courses')) return send(200, { success: true, data: [{ slug: 'prarambh', title: 'PRARAMBH' }] });
        return send(200, { success: true, data: { slug: 'prarambh', modules: [] } });
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  student = await startFakeStudentService();

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test_lesson_video_secret';
  process.env.CLIENT_URL = 'http://localhost:5175';
  process.env.COOKIE_SAMESITE = 'lax';
  process.env.STUDENT_BACKEND_URL = `http://127.0.0.1:${student.address().port}`;
  process.env.STUDENT_BACKEND_SERVICE_KEY = 'admin_to_student_key';

  const { connectDatabase } = await import('../src/config/db.js');
  await connectDatabase();
  const { createApp } = await import('../src/app.js');
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const { Admin } = await import('../src/models/Admin.js');
  const passwordHash = await Admin.hashPassword('TestPass123!');
  await Admin.create({ name: 'Super', email: 'super@test.local', passwordHash, role: 'SUPER_ADMIN', status: 'ACTIVE' });
  await Admin.create({ name: 'Staffer', email: 'staff@test.local', passwordHash, role: 'STAFF', status: 'ACTIVE' });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => student.close(r));
  const mongoose = (await import('mongoose')).default;
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(() => {
  received.length = 0;
  fake.down = false;
  fake.rejectNext = null;
});

async function call(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, body: json, cookie: setCookie.map((c) => c.split(';')[0]).join('; ') };
}

const login = async (email) => (await call('/api/admin/auth/login', { method: 'POST', body: { email, password: 'TestPass123!' } })).cookie;

const VIDEO = { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Welcome', isPublished: true };
const ROUTES = [
  { method: 'GET', path: '/api/admin/lesson-videos/courses' },
  { method: 'GET', path: '/api/admin/lesson-videos/courses/prarambh' },
  { method: 'POST', path: '/api/admin/lesson-videos/inspect', body: { url: VIDEO.url } },
  { method: 'PUT', path: '/api/admin/lesson-videos/courses/prarambh/lessons/l-1', body: VIDEO },
  { method: 'DELETE', path: '/api/admin/lesson-videos/courses/prarambh/lessons/l-1' },
];

test('every lesson video route needs a session, and STAFF is refused', async () => {
  const staff = await login('staff@test.local');
  assert.ok(staff, 'STAFF must genuinely log in, or this proves nothing');
  for (const r of ROUTES) {
    assert.equal((await call(r.path, { method: r.method, body: r.body })).status, 401, `${r.method} ${r.path} unauthenticated`);
    assert.equal((await call(r.path, { method: r.method, body: r.body, cookie: staff })).status, 403, `${r.method} ${r.path} STAFF`);
  }
  assert.equal(received.length, 0, 'nothing refused here may reach the student service');
});

test('saving forwards the edit with the service key and the acting admin, and is audited', async () => {
  const cookie = await login('super@test.local');
  const res = await call('/api/admin/lesson-videos/courses/prarambh/lessons/l-1', { method: 'PUT', body: VIDEO, cookie });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const sent = received.find((r) => r.method === 'PUT');
  assert.equal(sent.url, '/api/internal/lesson-videos/courses/prarambh/lessons/l-1');
  assert.equal(sent.key, 'admin_to_student_key');
  assert.equal(sent.body.url, VIDEO.url);
  assert.equal(sent.body.isPublished, true);
  assert.equal(sent.body.actor.portal, 'admin');
  assert.equal(sent.body.actor.name, 'Super');

  const { AuditLog } = await import('../src/models/AuditLog.js');
  const entry = await AuditLog.findOne({ action: 'course.lesson_video.published' }).lean();
  assert.ok(entry, 'the publish is in the audit log');
  assert.equal(entry.metadata.lessonId, 'l-1');
  assert.equal(entry.metadata.videoId, 'dQw4w9WgXcQ');
});

test('removing forwards the delete and is audited', async () => {
  const cookie = await login('super@test.local');
  const res = await call('/api/admin/lesson-videos/courses/prarambh/lessons/l-1', { method: 'DELETE', cookie });
  assert.equal(res.status, 200);
  assert.equal(received.find((r) => r.method === 'DELETE').body.actor.portal, 'admin');
  const { AuditLog } = await import('../src/models/AuditLog.js');
  assert.ok(await AuditLog.exists({ action: 'course.lesson_video.removed' }));
});

test("the student service's refusal reaches the admin with its status and code", async () => {
  const cookie = await login('super@test.local');
  fake.rejectNext = { status: 422, code: 'UNSUPPORTED_PROVIDER', message: 'Only YouTube links are supported.' };
  const res = await call('/api/admin/lesson-videos/courses/prarambh/lessons/l-1', {
    method: 'PUT',
    body: { url: 'https://vimeo.com/1' },
    cookie,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code || res.body.code, 'UNSUPPORTED_PROVIDER');
  assert.match(res.body.message || res.body.error?.message, /Only YouTube/);
});

test('malformed requests are refused before the bridge', async () => {
  const cookie = await login('super@test.local');
  const bad = [
    { path: '/api/admin/lesson-videos/courses/prarambh/lessons/l-1', body: { url: 'https://youtu.be/dQw4w9WgXcQ', playbackMode: 'iframe' } },
    { path: '/api/admin/lesson-videos/courses/prarambh/lessons/l-1', body: { url: 'x'.repeat(3000) } },
    { path: '/api/admin/lesson-videos/courses/prarambh/lessons/l-1', body: { url: { $gt: '' } } },
    { path: '/api/admin/lesson-videos/courses/bad%20slug!/lessons/l-1', body: VIDEO },
  ];
  for (const b of bad) {
    assert.equal((await call(b.path, { method: 'PUT', body: b.body, cookie })).status, 422, JSON.stringify(b.body).slice(0, 80));
  }
  assert.equal(received.length, 0);
});

test('an unreachable student service is a 503, never a false success', async () => {
  const cookie = await login('super@test.local');
  fake.down = true;
  const res = await call('/api/admin/lesson-videos/courses/prarambh/lessons/l-1', { method: 'PUT', body: VIDEO, cookie });
  assert.equal(res.status, 503);
  assert.match(res.body.message || res.body.error?.message, /lesson videos/);
});

test('module videos go to the module route, with the same gate and audit', async () => {
  const staff = await login('staff@test.local');
  assert.equal((await call('/api/admin/lesson-videos/courses/prarambh/modules/mod-1', { method: 'PUT', body: VIDEO, cookie: staff })).status, 403);
  const cookie = await login('super@test.local');
  const res = await call('/api/admin/lesson-videos/courses/prarambh/modules/mod-1', { method: 'PUT', body: VIDEO, cookie });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sent = received.find((r) => r.method === 'PUT');
  assert.equal(sent.url, '/api/internal/lesson-videos/courses/prarambh/modules/mod-1');
  const del = await call('/api/admin/lesson-videos/courses/prarambh/modules/mod-1', { method: 'DELETE', cookie });
  assert.equal(del.status, 200);
  const { AuditLog } = await import('../src/models/AuditLog.js');
  const entry = await AuditLog.findOne({ action: 'course.lesson_video.removed', 'metadata.moduleId': 'mod-1' }).lean();
  assert.ok(entry, 'module removal is audited with its module');
});

test('a version conflict reaches the admin intact, with the current video, however long the answer', async () => {
  const cookie = await login('super@test.local');
  const current = { videoId: 'M7lc1UVf-VE', title: 'x'.repeat(180), description: 'y'.repeat(900), updatedBy: { name: 'Alice Rao', portal: 'teacher' } };
  fake.rejectNext = { status: 409, code: 'VIDEO_CHANGED', message: 'This video was changed by Alice Rao since you opened it.', details: { current } };
  const res = await call('/api/admin/lesson-videos/courses/prarambh/lessons/l-1', {
    method: 'PUT',
    body: { ...VIDEO, expectedUpdatedAt: '2026-11-01T10:00:00.000Z' },
    cookie,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error?.code || res.body.code, 'VIDEO_CHANGED');
  assert.equal(res.body.error?.message || res.body.message, 'This video was changed by Alice Rao since you opened it.');
  assert.equal((res.body.errors || res.body.error?.details).current.description.length, 900);
  assert.equal(received.find((r) => r.method === 'PUT').body.expectedUpdatedAt, '2026-11-01T10:00:00.000Z');
});

test('a malformed version is refused before the bridge', async () => {
  const cookie = await login('super@test.local');
  const res = await call('/api/admin/lesson-videos/courses/prarambh/lessons/l-1', { method: 'PUT', body: { ...VIDEO, expectedUpdatedAt: 'soon' }, cookie });
  assert.equal(res.status, 422);
  assert.equal(received.length, 0);
});
