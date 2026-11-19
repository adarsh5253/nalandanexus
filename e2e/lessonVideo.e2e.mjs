/**
 * Lesson videos, end to end across all three real backends.
 *
 *   node e2e/lessonVideo.e2e.mjs          run the scenario, then stop everything
 *   node e2e/lessonVideo.e2e.mjs --keep   leave the services up for a browser check
 *
 * Starts the student, admin and teacher backends as separate processes (see
 * boot.mjs), each on its own in-memory database, wired together with one
 * shared service key exactly as in production. Nothing here talks to a
 * deployed service: every child runs with NODE_ENV=test, which makes it ignore
 * this machine's .env, and every outbound URL is either one of these three or
 * empty.
 *
 * The scenario is the acceptance list: an administrator adds and publishes a
 * video, the enrolled student sees the right thumbnail and embed, the URL is
 * changed and the student sees the new one, a draft stays hidden, an assigned
 * teacher does the same for their course, an unassigned teacher is refused,
 * and none of it touches the student's completion or XP.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const KEEP = process.argv.includes('--keep');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'e2e_service_key';
const PASSWORD = 'E2e-Pass-123!';
const PORTS = KEEP ? { student: 5101, teacher: 5102, admin: 5103 } : { student: 0, teacher: 0, admin: 0 };
const ID_1 = 'dQw4w9WgXcQ';
const ID_2 = 'M7lc1UVf-VE';
const ID_3 = 'aqz-KE-bpKQ';

// Nothing from the parent shell that could name a real database or service.
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/MONGO|_URL$|_URI$|KEY|SECRET|TOKEN|SMTP|MAIL|RAZORPAY|CLOUDINARY|GOOGLE|RESEND|BACKEND/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, NODE_ENV: 'test', E2E_PASSWORD: PASSWORD, AUTH_RATE_LIMIT_MAX: '100000', RATE_LIMIT_MAX: '100000', ...extra };
}

const children = [];
function boot(portal, port, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'e2e', 'boot.mjs'), portal, String(port)], {
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error(`${portal} did not start:\n${out}`)), 120_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /READY (\d+) (\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ url: `http://127.0.0.1:${m[1]}`, mongoUri: m[2] });
      }
    });
    child.stderr.on('data', (d) => {
      out += d;
      if (process.env.E2E_VERBOSE) process.stderr.write(`[${portal}] ${d}`);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!/READY/.test(out)) reject(new Error(`${portal} exited (${code}):\n${out}`));
    });
  });
}

function stopAll() {
  for (const c of children) c.kill('SIGTERM');
}

async function http(base, method, p, { body, cookie, bearer, headers = {} } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  const setCookie = res.headers.getSetCookie?.() || [];
  return { status: res.status, body: json, cookie: setCookie.map((c) => c.split(';')[0]).join('; ') };
}

let step = 0;
async function check(name, fn) {
  step += 1;
  try {
    await fn();
    console.log(`  ok ${step} - ${name}`);
  } catch (err) {
    console.log(`  not ok ${step} - ${name}`);
    throw err;
  }
}

const lessonOf = (content, id) => content.modules.flatMap((m) => m.lessons).find((l) => l.lessonId === id);

async function main() {
  console.log('Booting student, teacher and admin backends (in-memory databases)…');
  const student = await boot('student', PORTS.student, {
    JWT_ACCESS_SECRET: 'e2e_access',
    JWT_REFRESH_SECRET: 'e2e_refresh',
    CLIENT_URL: 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000',
    INTERNAL_SERVICE_KEY: KEY,
  });
  const [teacher, admin] = await Promise.all([
    boot('teacher', PORTS.teacher, {
      JWT_SECRET: 'e2e_teacher_jwt',
      CLIENT_URL: 'http://localhost:5174',
      COOKIE_SAMESITE: 'lax',
      STUDENT_BACKEND_URL: student.url,
      STUDENT_BACKEND_SERVICE_KEY: KEY,
    }),
    boot('admin', PORTS.admin, {
      JWT_SECRET: 'e2e_admin_jwt',
      CLIENT_URL: 'http://localhost:5175',
      COOKIE_SAMESITE: 'lax',
      STUDENT_BACKEND_URL: student.url,
      STUDENT_BACKEND_SERVICE_KEY: KEY,
    }),
  ]);
  console.log(`  student ${student.url}  teacher ${teacher.url}  admin ${admin.url}\n`);

  // --- A real, verified, profile-complete, enrolled student ---------------
  const email = 'student@e2e.test';
  const reg = await http(student.url, 'POST', '/api/auth/register', { body: { name: 'Asha Verma', email, password: PASSWORD } });
  const token = new URL(reg.body.data.verificationUrlFallback).searchParams.get('token');
  const verified = await http(student.url, 'POST', '/api/auth/verify-email', { body: { token } });
  const studentToken = verified.body.data.accessToken;
  const userId = verified.body.data.user.id || verified.body.data.user._id;
  const prof = await http(student.url, 'PUT', '/api/student/profile/completion', {
    bearer: studentToken,
    body: { fullName: 'Asha Verma', guardianName: 'Ravi Verma', grade: 'Class 9', phone: '9876543210' },
  });
  assert.equal(prof.status, 200, JSON.stringify(prof.body));

  // Enrolment is written straight to the student database, as the payment
  // flow would - purchases are not what this run is about.
  const requireFromStudent = createRequire(path.join(root, 'student', 'backend', 'package.json'));
  const { MongoClient, ObjectId } = await import(pathToFileURL(requireFromStudent.resolve('mongodb')).href);
  const mongo = new MongoClient(student.mongoUri);
  await mongo.connect();
  const sdb = mongo.db();
  const prarambh = await sdb.collection('courses').findOne({ slug: 'prarambh' });
  await sdb.collection('enrollments').insertOne({
    userId: new ObjectId(userId),
    courseId: prarambh._id,
    status: 'active',
    enrollmentId: 'ENR-2026-000001',
    enrolledAt: new Date(),
    progressPercent: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const studentView = async () => {
    const r = await http(student.url, 'GET', '/api/student/courses/prarambh/content', { bearer: studentToken });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  };

  const adminCookie = (await http(admin.url, 'POST', '/api/admin/auth/login', { body: { email: 'admin@e2e.test', password: PASSWORD } })).cookie;
  assert.ok(adminCookie, 'admin login');
  const adminPut = (slug, lessonId, body) => http(admin.url, 'PUT', `/api/admin/lesson-videos/courses/${slug}/lessons/${lessonId}`, { cookie: adminCookie, body });

  console.log('Admin');
  await check('admin sees every catalogue course, including GARUD and YODDHA', async () => {
    const r = await http(admin.url, 'GET', '/api/admin/lesson-videos/courses', { cookie: adminCookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.map((c) => c.slug).sort(), ['garud', 'prarambh', 'yoddha']);
  });

  await check('admin adds and publishes a YouTube video on a lesson', async () => {
    const r = await adminPut('prarambh', 'l-1', { url: `https://www.youtube.com/watch?v=${ID_1}`, title: 'Welcome to Nalanda', isPublished: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.video.videoId, ID_1);
    assert.equal(r.body.data.video.updatedBy.portal, 'admin');
  });

  console.log('Student');
  await check('the enrolled student sees the correct thumbnail and embed', async () => {
    const l = lessonOf(await studentView(), 'l-1');
    assert.equal(l.video.videoId, ID_1);
    assert.equal(l.video.title, 'Welcome to Nalanda');
    assert.equal(l.video.thumbnailUrl, `https://img.youtube.com/vi/${ID_1}/hqdefault.jpg`);
    assert.equal(l.video.thumbnailMaxUrl, `https://img.youtube.com/vi/${ID_1}/maxresdefault.jpg`);
    assert.ok(l.video.embedUrl.startsWith(`https://www.youtube-nocookie.com/embed/${ID_1}?`));
    assert.equal(l.video.watchUrl, `https://www.youtube.com/watch?v=${ID_1}`);
  });

  let xpBefore;
  await check('the student completes the lesson and earns XP once', async () => {
    const r = await http(student.url, 'POST', '/api/student/courses/lessons/l-1/progress', { bearer: studentToken });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.xpAwarded, 10);
    xpBefore = await sdb.collection('xpevents').countDocuments({ userId: new ObjectId(userId) });
  });

  console.log('Admin changes the video');
  await check('admin replaces the URL (youtu.be form) and the student sees the new video', async () => {
    const r = await adminPut('prarambh', 'l-1', { url: `https://youtu.be/${ID_2}`, title: 'Welcome, take two', isPublished: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.previousVideoId, ID_1);
    const l = lessonOf(await studentView(), 'l-1');
    assert.equal(l.video.videoId, ID_2);
    assert.equal(l.video.title, 'Welcome, take two');
  });

  await check('the change did not reset completion or award XP again', async () => {
    const l = lessonOf(await studentView(), 'l-1');
    assert.equal(l.completed, true);
    assert.equal(await sdb.collection('xpevents').countDocuments({ userId: new ObjectId(userId) }), xpBefore);
  });

  await check('a draft stays hidden from the student', async () => {
    const r = await adminPut('prarambh', 'l-2', { url: `https://www.youtube.com/shorts/${ID_3}`, isPublished: false });
    assert.equal(r.status, 200);
    const l = lessonOf(await studentView(), 'l-2');
    assert.equal(l.video, null);
    assert.equal(JSON.stringify(l).includes(ID_3), false);
  });

  await check('an invalid link is refused end to end with its reason', async () => {
    const r = await adminPut('prarambh', 'l-3', { url: 'https://vimeo.com/76979871', isPublished: true });
    assert.equal(r.status, 422);
    assert.equal(r.body.error?.code || r.body.code, 'UNSUPPORTED_PROVIDER');
  });

  console.log('Teacher');
  // Exactly what the Admin portal sends when it assigns a catalogue course.
  const assign = await http(teacher.url, 'PUT', '/api/internal/teachers/courses', {
    headers: { 'X-Internal-Service-Key': KEY },
    body: { teacherEmail: 'alice@e2e.test', courses: [{ slug: 'prarambh', title: 'PRARAMBH' }] },
  });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  const alice = (await http(teacher.url, 'POST', '/api/teacher/auth/login', { body: { email: 'alice@e2e.test', password: PASSWORD } })).cookie;
  const bob = (await http(teacher.url, 'POST', '/api/teacher/auth/login', { body: { email: 'bob@e2e.test', password: PASSWORD } })).cookie;
  assert.ok(alice && bob, 'teacher logins');

  await check('an assigned teacher sees only their course', async () => {
    const r = await http(teacher.url, 'GET', '/api/teacher/lesson-videos/courses', { cookie: alice });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.map((c) => c.slug), ['prarambh']);
    assert.equal(r.body.data[0].lessonCount, 5);
  });

  await check('the assigned teacher publishes a video and the student sees it', async () => {
    const r = await http(teacher.url, 'PUT', '/api/teacher/lesson-videos/courses/prarambh/lessons/m-1', {
      cookie: alice,
      body: { url: `https://www.youtube.com/live/${ID_3}`, title: 'Mindset live session', isPublished: true },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const l = lessonOf(await studentView(), 'm-1');
    assert.equal(l.video.videoId, ID_3);
    assert.equal(l.video.title, 'Mindset live session');
    const editorView = await http(admin.url, 'GET', '/api/admin/lesson-videos/courses/prarambh', { cookie: adminCookie });
    const m1 = lessonOf(editorView.body.data, 'm-1');
    assert.equal(m1.video.updatedBy.portal, 'teacher');
    assert.equal(m1.video.updatedBy.name, 'Alice Rao');
  });

  await check('an unassigned teacher cannot modify the course', async () => {
    const before = await studentView();
    for (const [method, p] of [
      ['PUT', '/api/teacher/lesson-videos/courses/prarambh/lessons/l-1'],
      ['DELETE', '/api/teacher/lesson-videos/courses/prarambh/lessons/l-1'],
      ['GET', '/api/teacher/lesson-videos/courses/prarambh'],
    ]) {
      const r = await http(teacher.url, method, p, { cookie: bob, body: method === 'PUT' ? { url: `https://youtu.be/${ID_1}`, isPublished: true } : undefined });
      assert.equal(r.status, 403, `${method} ${p}: ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual(lessonOf(await studentView(), 'l-1').video, lessonOf(before, 'l-1').video);
  });

  await check('the assigned teacher cannot modify a course outside their assignment', async () => {
    const r = await http(teacher.url, 'PUT', '/api/teacher/lesson-videos/courses/garud/lessons/g-1', {
      cookie: alice,
      body: { url: `https://youtu.be/${ID_1}`, isPublished: true },
    });
    assert.equal(r.status, 403);
  });

  await check('the student service refuses the bridge without the key', async () => {
    const r = await http(student.url, 'PUT', '/api/internal/lesson-videos/courses/prarambh/lessons/l-1', { body: { url: `https://youtu.be/${ID_1}` } });
    assert.equal(r.status, 401);
  });

  console.log('Module introductions and concurrent edits');
  await check('admin publishes a module introduction; the student sees it on the module', async () => {
    const r = await http(admin.url, 'PUT', '/api/admin/lesson-videos/courses/prarambh/modules/mod-2', {
      cookie: adminCookie,
      body: { url: `https://youtu.be/${ID_1}`, title: 'Mindset, introduced', isPublished: true },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mod = (await studentView()).modules.find((m) => m.moduleId === 'mod-2');
    assert.equal(mod.video.videoId, ID_1);
    assert.equal(mod.video.title, 'Mindset, introduced');
  });

  await check('a teacher editing from an outdated version is refused with who changed it; nothing is overwritten', async () => {
    const editor = await http(teacher.url, 'GET', '/api/teacher/lesson-videos/courses/prarambh', { cookie: alice });
    const loaded = editor.body.data.modules.find((m) => m.moduleId === 'mod-2').video.updatedAt;
    // The admin changes it after the teacher opened it...
    const adminSave = await http(admin.url, 'PUT', '/api/admin/lesson-videos/courses/prarambh/modules/mod-2', {
      cookie: adminCookie,
      body: { url: `https://youtu.be/${ID_2}`, title: 'Admin version', isPublished: true, expectedUpdatedAt: loaded },
    });
    assert.equal(adminSave.status, 200);
    // ...so the teacher's save, based on the old version, is refused.
    const stale = await http(teacher.url, 'PUT', '/api/teacher/lesson-videos/courses/prarambh/modules/mod-2', {
      cookie: alice,
      body: { url: `https://youtu.be/${ID_3}`, title: 'Teacher version', isPublished: true, expectedUpdatedAt: loaded },
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.match(stale.body.error?.message || stale.body.message, /changed by E2E Admin/);
    assert.equal(stale.body.error?.details?.current?.title, 'Admin version');
    assert.equal((await studentView()).modules.find((m) => m.moduleId === 'mod-2').video.title, 'Admin version');
  });

  await check('the admin sees the same conflict shape when the teacher got there first', async () => {
    const before = (await http(admin.url, 'GET', '/api/admin/lesson-videos/courses/prarambh', { cookie: adminCookie })).body.data;
    const loaded = before.modules.find((m) => m.moduleId === 'mod-2').video.updatedAt;
    const teacherSave = await http(teacher.url, 'PUT', '/api/teacher/lesson-videos/courses/prarambh/modules/mod-2', {
      cookie: alice,
      body: { url: `https://youtu.be/${ID_3}`, title: 'Teacher version', isPublished: true, expectedUpdatedAt: loaded },
    });
    assert.equal(teacherSave.status, 200);
    const stale = await http(admin.url, 'DELETE', '/api/admin/lesson-videos/courses/prarambh/modules/mod-2', {
      cookie: adminCookie,
      body: { expectedUpdatedAt: loaded },
    });
    assert.equal(stale.status, 409);
    assert.equal((stale.body.errors || stale.body.error?.details).current.title, 'Teacher version');
  });

  console.log('Removal');
  await check('admin unpublishes, then removes; the student sees no video and keeps completion', async () => {
    let r = await adminPut('prarambh', 'l-1', { url: `https://youtu.be/${ID_2}`, isPublished: false });
    assert.equal(r.status, 200);
    assert.equal(lessonOf(await studentView(), 'l-1').video, null);
    r = await http(admin.url, 'DELETE', '/api/admin/lesson-videos/courses/prarambh/lessons/l-1', { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.removed, true);
    const l = lessonOf(await studentView(), 'l-1');
    assert.equal(l.video, null);
    assert.equal(l.completed, true);
  });

  await check('other lessons were never touched', async () => {
    const view = await studentView();
    assert.equal(lessonOf(view, 'm-1').video.videoId, ID_3);
    assert.equal(lessonOf(view, 'l-3').video, null);
    assert.equal(lessonOf(view, 'l-3').content, 'Written material for l lesson 3.');
  });

  if (KEEP) {
    // Leave something to look at in a browser.
    await adminPut('prarambh', 'l-1', { url: `https://www.youtube.com/watch?v=${ID_1}`, title: 'Welcome to Nalanda', isPublished: true });
    await sdb.collection('enrollments').updateOne({ userId: new ObjectId(userId) }, { $set: { currentLessonId: 'l-1', currentModuleId: 'mod-1' } });
  }
  await mongo.close();

  console.log(`\n${step} checks passed.`);
  if (KEEP) {
    console.log(`\nServices left running (Ctrl+C to stop):
  student API ${student.url}/api   (student@e2e.test)
  teacher API ${teacher.url}/api/teacher   (alice@e2e.test assigned PRARAMBH, bob@e2e.test unassigned)
  admin API   ${admin.url}/api/admin   (admin@e2e.test)
  password for all: the E2E_PASSWORD constant in this file`);
    process.on('SIGINT', () => {
      stopAll();
      process.exit(0);
    });
    return;
  }
  stopAll();
}

main().catch((err) => {
  console.error(err);
  stopAll();
  process.exit(1);
});
