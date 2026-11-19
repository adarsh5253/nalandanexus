import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bootTestApp, createTeacherAndLogin } from './helpers/testApp.js';

/**
 * Lesson videos from the Teacher portal: course-level authorisation.
 *
 * A teacher may manage the videos of exactly the courses an administrator has
 * assigned them - the CourseAccess rows that already decide whose students
 * they see - and nothing else. The checks that matter are server-side and per
 * request: an unassigned course is refused before anything reaches the student
 * service, and revoking an assignment revokes editing at once.
 */

let ctx;
let api;
let student;
let CourseAccess;
let AuditLog;
let alice;
let bob;

const VIDEO = { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Welcome', isPublished: true };
const uniq = () => crypto.randomBytes(3).toString('hex');

before(async () => {
  ctx = await bootTestApp();
  api = ctx.api;
  student = ctx.student;
  ({ CourseAccess } = await import('../src/models/CourseAccess.js'));
  ({ AuditLog } = await import('../src/models/AuditLog.js'));
  alice = await createTeacherAndLogin(api, { name: 'Alice Rao', email: `alice.${uniq()}@nalanda.test` });
  bob = await createTeacherAndLogin(api, { name: 'Bob Iyer', email: `bob.${uniq()}@nalanda.test` });
});

after(async () => {
  await ctx.teardown();
});

beforeEach(async () => {
  student.reset();
  await CourseAccess.deleteMany({});
  // Alice teaches PRARAMBH (assigned directly) and GARUD (as instructor of an
  // Admin-authored course sold under that slug). Bob teaches YODDHA only.
  await CourseAccess.create([
    { teacher: alice.teacher._id, studentCourseSlug: 'prarambh', title: 'PRARAMBH', sources: ['teacher-assignment'] },
    { teacher: alice.teacher._id, studentCourseSlug: 'garud', title: 'GARUD', sources: ['course-instructor'] },
    { teacher: bob.teacher._id, studentCourseSlug: 'yoddha', title: 'YODDHA', sources: ['teacher-assignment'] },
  ]);
});

const put = (cookie, slug, lessonId = 'l-1', body = VIDEO) =>
  api('PUT', `/api/teacher/lesson-videos/courses/${slug}/lessons/${lessonId}`, { cookie, body });

test('every route needs a teacher session', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/teacher/lesson-videos/courses'],
    ['GET', '/api/teacher/lesson-videos/courses/prarambh'],
    ['POST', '/api/teacher/lesson-videos/inspect', { url: VIDEO.url }],
    ['PUT', '/api/teacher/lesson-videos/courses/prarambh/lessons/l-1', VIDEO],
    ['DELETE', '/api/teacher/lesson-videos/courses/prarambh/lessons/l-1'],
  ]) {
    assert.equal((await api(method, path, { body })).status, 401, `${method} ${path}`);
  }
  assert.equal(student.state.videoCalls.length, 0);
});

test('a teacher lists only their assigned courses', async () => {
  const res = await api('GET', '/api/teacher/lesson-videos/courses', { cookie: alice.cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((c) => c.slug).sort(), ['garud', 'prarambh']);
  const asked = student.state.videoCalls[0];
  assert.match(decodeURIComponent(asked.query), /slugs=(prarambh,garud|garud,prarambh)/);
  assert.doesNotMatch(asked.query, /yoddha/, 'another teacher\'s course is never even asked about');
});

test('a teacher can read, save, publish and remove videos in an assigned course', async () => {
  assert.equal((await api('GET', '/api/teacher/lesson-videos/courses/prarambh', { cookie: alice.cookie })).status, 200);

  const saved = await put(alice.cookie, 'prarambh');
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const sent = student.state.videoCalls.find((c) => c.method === 'PUT');
  assert.equal(sent.path, '/api/internal/lesson-videos/courses/prarambh/lessons/l-1');
  assert.equal(sent.body.url, VIDEO.url);
  assert.equal(sent.body.isPublished, true);
  assert.equal(sent.body.actor.portal, 'teacher');
  assert.equal(sent.body.actor.userId, String(alice.user._id));
  assert.equal(sent.body.actor.name, 'Alice Rao');

  // Assignment via instructorship counts exactly like a direct assignment.
  assert.equal((await put(alice.cookie, 'garud', 'g-1')).status, 200);

  const removed = await api('DELETE', '/api/teacher/lesson-videos/courses/prarambh/lessons/l-1', { cookie: alice.cookie });
  assert.equal(removed.status, 200);

  const actions = (await AuditLog.find({ actor: alice.user._id }).lean()).map((a) => a.action);
  assert.ok(actions.includes('course.lesson_video.published'));
  assert.ok(actions.includes('course.lesson_video.removed'));
});

test('a teacher cannot read or modify a course that is not assigned to them', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/teacher/lesson-videos/courses/yoddha'],
    ['PUT', '/api/teacher/lesson-videos/courses/yoddha/lessons/y-1', VIDEO],
    ['DELETE', '/api/teacher/lesson-videos/courses/yoddha/lessons/y-1'],
    // A course nobody is assigned is no different.
    ['PUT', '/api/teacher/lesson-videos/courses/some-other-course/lessons/l-1', VIDEO],
  ]) {
    const res = await api(method, path, { cookie: alice.cookie, body });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.error?.code || res.body.code, 'COURSE_NOT_ASSIGNED');
  }
  assert.equal(student.state.videoCalls.length, 0, 'a refused edit never reaches the student service');
});

test('slug case and padding cannot be used to slip past the assignment check', async () => {
  const res = await api('PUT', '/api/teacher/lesson-videos/courses/YODDHA/lessons/y-1', { cookie: alice.cookie, body: VIDEO });
  assert.equal(res.status, 403);
  const ok = await api('PUT', '/api/teacher/lesson-videos/courses/PRARAMBH/lessons/l-1', { cookie: alice.cookie, body: VIDEO });
  assert.equal(ok.status, 200);
  assert.equal(student.state.videoCalls[0].path, '/api/internal/lesson-videos/courses/prarambh/lessons/l-1');
});

test('revoking the assignment revokes editing immediately', async () => {
  assert.equal((await put(bob.cookie, 'yoddha')).status, 200);
  await CourseAccess.deleteOne({ teacher: bob.teacher._id, studentCourseSlug: 'yoddha' });
  assert.equal((await put(bob.cookie, 'yoddha')).status, 403);
});

test('malformed input is refused before the bridge', async () => {
  for (const body of [
    { url: 'https://youtu.be/dQw4w9WgXcQ', playbackMode: 'iframe' },
    { url: 'https://youtu.be/dQw4w9WgXcQ', isPublished: 'yes' },
    { url: { $gt: '' } },
    { url: 'x'.repeat(3000) },
  ]) {
    const res = await put(alice.cookie, 'prarambh', 'l-1', body);
    assert.equal(res.status, 422, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(student.state.videoCalls.length, 0);
});

test("the student service's refusal reaches the teacher with its code", async () => {
  student.state.videoReject = { status: 422, code: 'INVALID_VIDEO_ID', message: 'That YouTube link has a malformed video id.' };
  const res = await put(alice.cookie, 'prarambh', 'l-1', { url: 'https://youtu.be/bad' });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code || res.body.code, 'INVALID_VIDEO_ID');
});

test('an unreachable student service is a 503, never a false success', async () => {
  student.state.down = true;
  const res = await put(alice.cookie, 'prarambh');
  assert.equal(res.status, 503);
  assert.equal(res.body.error?.code || res.body.code, 'STUDENT_SERVICE_UNAVAILABLE');
});

test('module videos follow the same assignment rule', async () => {
  const ok = await api('PUT', '/api/teacher/lesson-videos/courses/prarambh/modules/mod-1', { cookie: alice.cookie, body: VIDEO });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(student.state.videoCalls[0].path, '/api/internal/lesson-videos/courses/prarambh/modules/mod-1');
  assert.equal(student.state.videoCalls[0].body.actor.portal, 'teacher');

  const refused = await api('PUT', '/api/teacher/lesson-videos/courses/yoddha/modules/y-mod-1', { cookie: alice.cookie, body: VIDEO });
  assert.equal(refused.status, 403);
  const refusedDelete = await api('DELETE', '/api/teacher/lesson-videos/courses/yoddha/modules/y-mod-1', { cookie: alice.cookie });
  assert.equal(refusedDelete.status, 403);
  assert.equal(student.state.videoCalls.length, 1);
});

test('the editor version is forwarded, and a conflict reaches the teacher with the current video', async () => {
  student.state.videoReject = { status: 409, code: 'VIDEO_CHANGED', message: 'This video was changed by Admin One since you opened it.' };
  const res = await api('PUT', '/api/teacher/lesson-videos/courses/prarambh/lessons/l-1', {
    cookie: alice.cookie,
    body: { ...VIDEO, expectedUpdatedAt: '2026-11-01T10:00:00.000Z' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error?.code || res.body.code, 'VIDEO_CHANGED');
  assert.equal(student.state.videoCalls[0].body.expectedUpdatedAt, '2026-11-01T10:00:00.000Z');

  const bad = await api('PUT', '/api/teacher/lesson-videos/courses/prarambh/lessons/l-1', { cookie: alice.cookie, body: { ...VIDEO, expectedUpdatedAt: 'soon' } });
  assert.equal(bad.status, 422);
});
