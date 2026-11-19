import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bootTestApp } from './helpers/testApp.js';

/**
 * Teacher onboarding and course-wise student visibility, end to end through the
 * real routes.
 *
 * Two promises are tested here, and for each the interesting cases are the ones
 * that must NOT work: a setup link used twice, a link that has expired, a
 * teacher reading a course nobody assigned them, a stale record undoing a newer
 * one. A passing happy path would prove very little on its own.
 */

let ctx;
let api;
let student;
let User;
let CourseEnrollment;
let CourseAccess;

const KEY = { 'X-Internal-Service-Key': 'test_service_key' };
const uniq = () => crypto.randomBytes(3).toString('hex');
const objectId = () => crypto.randomBytes(12).toString('hex');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

before(async () => {
  ctx = await bootTestApp();
  api = ctx.api;
  student = ctx.student;
  ({ User } = await import('../src/models/User.js'));
  ({ CourseEnrollment } = await import('../src/models/CourseEnrollment.js'));
  ({ CourseAccess } = await import('../src/models/CourseAccess.js'));
  await Promise.all([User.init(), CourseEnrollment.init(), CourseAccess.init()]);
});

after(async () => {
  await ctx.teardown();
});

beforeEach(async () => {
  student.reset();
  // Tests share one database and slugs like "garud". A roster left behind by an
  // earlier test is not part of what a later one is asserting about - and a sync
  // that (correctly) reports an empty course revokes whatever is there.
  await Promise.all([CourseAccess.deleteMany({}), CourseEnrollment.deleteMany({})]);
});

/** Provisions a teacher the way the Admin portal does, with a setup link and no password. */
async function provision({ name = 'Priya Menon', requestedId, expires = inAnHour() } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const email = `priya.${uniq()}@nalanda.test`;
  const res = await api('POST', '/api/internal/teachers', {
    headers: KEY,
    body: {
      name,
      email,
      subject: 'Physics',
      teacherId: requestedId,
      setupTokenHash: sha256(token),
      setupTokenExpiresAt: expires,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token, email, ...res.body.data };
}

const STRONG = 'Chosen#Pass9';

async function onboard(options) {
  const t = await provision(options);
  const setup = await api('POST', '/api/teacher/auth/setup-password', { body: { token: t.token, password: STRONG } });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const login = await api('POST', '/api/teacher/auth/login', { body: { email: t.email, password: STRONG } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { ...t, cookie: login.cookie };
}

const enrolled = (n, slug, batchId = null) =>
  Array.from({ length: n }, (_, i) => ({
    enrollmentId: `ENR-2026-${slug.toUpperCase().slice(0, 2)}${String(i + 1).padStart(4, '0')}`,
    batchId,
    batchCode: batchId ? 'PB1' : null,
    userId: objectId(),
    name: `Student ${slug} ${String(i + 1).padStart(2, '0')}`,
    email: `s${i + 1}.${slug}.${uniq()}@example.com`,
    avatar: null,
    enrolledAt: new Date().toISOString(),
  }));

async function waitFor(check, { timeoutMs = 5000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function assignCourses(email, slugs) {
  const res = await api('PUT', '/api/internal/teachers/courses', {
    headers: KEY,
    body: { teacherEmail: email, courses: slugs.map((slug) => ({ slug, title: slug.toUpperCase() })) },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}

const rosterOf = (cookie, slug, query = '') => api('GET', `/api/teacher/courses/assigned/${slug}/students${query}`, { cookie });

// ---------------------------------------------------------------------------
// Credentials: a setup link, never a password
// ---------------------------------------------------------------------------

test('provisioning needs no password and says where the real login page is', async () => {
  const t = await provision();
  assert.match(t.teacherCode, /^TCH-\d{4,}$/);
  assert.equal(t.portalUrl, 'http://localhost:5174');

  const user = await User.findById(t.userId).select('+setupTokenHash +passwordHash');
  assert.equal(user.setupTokenHash, sha256(t.token), 'only the hash of the link is stored');
  assert.ok(!JSON.stringify(user.toObject()).includes(t.token), 'the token itself is never stored');
});

test('nobody can sign in before the link is used - there is no password to guess', async () => {
  const t = await provision();
  for (const guess of ['password', 'Welcome1!', t.token, sha256(t.token)]) {
    const res = await api('POST', '/api/teacher/auth/login', { body: { email: t.email, password: guess } });
    assert.equal(res.status, 401);
  }
});

test('the link shows who it is for, then lets them choose a password and sign in by email or Teacher ID', async () => {
  const t = await provision({ name: 'Anita Rao' });

  const look = await api('GET', `/api/teacher/auth/setup-password/${t.token}`);
  assert.equal(look.status, 200);
  assert.equal(look.body.data.name, 'Anita Rao');
  assert.equal(look.body.data.teacherId, t.teacherCode);
  assert.ok(!('passwordHash' in look.body.data));

  const set = await api('POST', '/api/teacher/auth/setup-password', { body: { token: t.token, password: STRONG } });
  assert.equal(set.status, 200);

  const byEmail = await api('POST', '/api/teacher/auth/login', { body: { email: t.email, password: STRONG } });
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.body.data.user.mustChangePassword, false);

  // The onboarding email hands out the Teacher ID, so it has to work as a username.
  const byId = await api('POST', '/api/teacher/auth/login', { body: { email: t.teacherCode, password: STRONG } });
  assert.equal(byId.status, 200, JSON.stringify(byId.body));
  assert.equal(byId.body.data.user.teacherId, t.teacherCode);

  const lower = await api('POST', '/api/teacher/auth/login', { body: { email: t.teacherCode.toLowerCase(), password: STRONG } });
  assert.equal(lower.status, 200);
});

test('a link works exactly once', async () => {
  const t = await provision();
  const first = await api('POST', '/api/teacher/auth/setup-password', { body: { token: t.token, password: STRONG } });
  assert.equal(first.status, 200);

  const again = await api('POST', '/api/teacher/auth/setup-password', { body: { token: t.token, password: 'Another#Pass1' } });
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, 'SETUP_LINK_INVALID');

  const look = await api('GET', `/api/teacher/auth/setup-password/${t.token}`);
  assert.equal(look.status, 400);

  // ...and the second attempt must not have changed the password.
  const login = await api('POST', '/api/teacher/auth/login', { body: { email: t.email, password: STRONG } });
  assert.equal(login.status, 200);
});

test('two simultaneous uses of one link cannot both succeed', async () => {
  const t = await provision();
  const attempts = await Promise.all(
    ['First#Pass1x', 'Second#Pass2y', 'Third#Pass3z'].map((password) =>
      api('POST', '/api/teacher/auth/setup-password', { body: { token: t.token, password } })
    )
  );
  assert.equal(attempts.filter((r) => r.status === 200).length, 1);
  assert.ok(attempts.filter((r) => r.status !== 200).every((r) => r.status === 400));
});

test('an expired or invented link is refused with the same answer', async () => {
  const expiring = await provision({ expires: new Date(Date.now() + 700).toISOString() });
  await new Promise((r) => setTimeout(r, 900));

  for (const token of [expiring.token, crypto.randomBytes(32).toString('hex'), 'short']) {
    const res = await api('POST', '/api/teacher/auth/setup-password', { body: { token, password: STRONG } });
    assert.ok([400, 422].includes(res.status), `status ${res.status}`);
  }
  const res = await api('POST', '/api/teacher/auth/setup-password', { body: { token: expiring.token, password: STRONG } });
  assert.equal(res.body.error.code, 'SETUP_LINK_INVALID');
});

test('the password must be strong enough', async () => {
  const t = await provision();
  for (const weak of ['short1A', 'alllowercase1', 'ALLUPPERCASE1', 'NoDigitsHere']) {
    const res = await api('POST', '/api/teacher/auth/setup-password', { body: { token: t.token, password: weak } });
    assert.equal(res.status, 422, weak);
  }
  // A rejected attempt must not have spent the link.
  const ok = await api('POST', '/api/teacher/auth/setup-password', { body: { token: t.token, password: STRONG } });
  assert.equal(ok.status, 200);
});

test('resending replaces the link: the old one dies, and a working teacher is not locked out', async () => {
  const t = await onboard();

  const fresh = crypto.randomBytes(32).toString('hex');
  const reissue = await api('PATCH', '/api/internal/teachers/credentials', {
    headers: KEY,
    body: { email: t.email, setupTokenHash: sha256(fresh), setupTokenExpiresAt: inAnHour() },
  });
  assert.equal(reissue.status, 200, JSON.stringify(reissue.body));
  assert.equal(reissue.body.data.portalUrl, 'http://localhost:5174');

  // Sending a link changes nothing until it is used.
  const stillIn = await api('GET', '/api/teacher/auth/me', { cookie: t.cookie });
  assert.equal(stillIn.status, 200);
  const stillWorks = await api('POST', '/api/teacher/auth/login', { body: { email: t.email, password: STRONG } });
  assert.equal(stillWorks.status, 200);

  // The first link was already used; issue another and show the replaced one dies.
  const second = crypto.randomBytes(32).toString('hex');
  await api('PATCH', '/api/internal/teachers/credentials', {
    headers: KEY,
    body: { email: t.email, setupTokenHash: sha256(second), setupTokenExpiresAt: inAnHour() },
  });
  const oldLink = await api('POST', '/api/teacher/auth/setup-password', { body: { token: fresh, password: 'Replaced#Pass1' } });
  assert.equal(oldLink.status, 400, 'a replaced link must stop working');

  const newLink = await api('POST', '/api/teacher/auth/setup-password', { body: { token: second, password: 'Replaced#Pass1' } });
  assert.equal(newLink.status, 200);

  // Redeeming it revokes the sessions the account already had.
  const revoked = await api('GET', '/api/teacher/auth/me', { cookie: t.cookie });
  assert.equal(revoked.status, 401);
});

test('a suspended account cannot use its link', async () => {
  const t = await provision();
  await api('PATCH', '/api/internal/teachers/status', { headers: KEY, body: { email: t.email, status: 'suspended' } });
  const res = await api('POST', '/api/teacher/auth/setup-password', { body: { token: t.token, password: STRONG } });
  assert.equal(res.status, 403);
});

test('the Teacher ID asked for is honoured when free and replaced by the next free one when not', async () => {
  const wanted = `TCH-${String(5000 + Math.floor(Math.random() * 3000))}`;
  const first = await provision({ requestedId: wanted });
  assert.equal(first.teacherCode, wanted);

  const second = await provision({ requestedId: wanted });
  assert.notEqual(second.teacherCode, wanted, 'a taken ID must never be issued twice');
  assert.match(second.teacherCode, /^TCH-\d{4,}$/);
});

test('provisioning is refused without a setup link or a password', async () => {
  const res = await api('POST', '/api/internal/teachers', { headers: KEY, body: { name: 'X Y', email: `x.${uniq()}@nalanda.test` } });
  assert.equal(res.status, 422);
});

test('the internal provisioning route is closed without the service key', async () => {
  const res = await api('POST', '/api/internal/teachers', { body: { name: 'X Y', email: 'x@nalanda.test', setupTokenHash: sha256('a'), setupTokenExpiresAt: inAnHour() } });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Course-wise student visibility
// ---------------------------------------------------------------------------

test('assigning a course makes every student already enrolled in it visible, with no sync pressed', async () => {
  student.state.enrolledBySlug.garud = enrolled(7, 'garud');
  const t = await onboard();

  const result = await assignCourses(t.email, ['garud']);
  assert.deepEqual(result.added, ['garud']);

  await waitFor(async () => (await rosterOf(t.cookie, 'garud')).body?.data?.course?.rosterSyncStatus === 'synced');
  const res = await rosterOf(t.cookie, 'garud');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.students.length, 7);
  assert.equal(res.body.data.course.studentCount, 7);
  assert.equal(res.body.meta.totalRecords, 7);

  const courses = await api('GET', '/api/teacher/courses/assigned', { cookie: t.cookie });
  const garud = courses.body.data.find((c) => c.studentCourseSlug === 'garud');
  assert.equal(garud.studentCount, 7);
  assert.equal(garud.kind, 'catalogue');
});

test('students of a course the teacher was not assigned are invisible - and indistinguishable from a course that does not exist', async () => {
  student.state.enrolledBySlug.garud = enrolled(3, 'garud');
  student.state.enrolledBySlug.yoddha = enrolled(4, 'yoddha');
  const t = await onboard();
  await assignCourses(t.email, ['garud']);
  await waitFor(async () => (await rosterOf(t.cookie, 'garud')).body?.data?.course?.rosterSyncStatus === 'synced');

  const other = await rosterOf(t.cookie, 'yoddha');
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, 'COURSE_NOT_ASSIGNED');
  const invented = await rosterOf(t.cookie, 'no-such-course');
  assert.equal(invented.status, 404);
  assert.deepEqual(invented.body.error, other.body.error);

  const refresh = await api('POST', '/api/teacher/courses/assigned/yoddha/refresh', { cookie: t.cookie });
  assert.equal(refresh.status, 404);

  // Never in the roster at all: nobody teaches yoddha here yet.
  assert.equal(await CourseEnrollment.countDocuments({ studentCourseSlug: 'yoddha' }), 0);
});

test("one teacher's course is not another's: each sees only their own", async () => {
  student.state.enrolledBySlug.prarambh = enrolled(5, 'prarambh');
  student.state.enrolledBySlug.garud = enrolled(2, 'garud');
  const a = await onboard({ name: 'Teacher A' });
  const b = await onboard({ name: 'Teacher B' });
  await assignCourses(a.email, ['prarambh']);
  await assignCourses(b.email, ['garud']);
  await waitFor(async () => (await rosterOf(a.cookie, 'prarambh')).body?.data?.course?.rosterSyncStatus === 'synced');
  await waitFor(async () => (await rosterOf(b.cookie, 'garud')).body?.data?.course?.rosterSyncStatus === 'synced');

  assert.equal((await rosterOf(a.cookie, 'prarambh')).body.data.students.length, 5);
  assert.equal((await rosterOf(b.cookie, 'garud')).body.data.students.length, 2);
  assert.equal((await rosterOf(a.cookie, 'garud')).status, 404);
  assert.equal((await rosterOf(b.cookie, 'prarambh')).status, 404);
});

test('two teachers assigned the same course both see its students', async () => {
  student.state.enrolledBySlug.prarambh = enrolled(4, 'prarambh');
  const a = await onboard({ name: 'Teacher A' });
  const b = await onboard({ name: 'Teacher B' });
  await assignCourses(a.email, ['prarambh']);
  await assignCourses(b.email, ['prarambh']);
  await waitFor(async () => (await rosterOf(b.cookie, 'prarambh')).body?.data?.course?.rosterSyncStatus === 'synced');

  assert.equal((await rosterOf(a.cookie, 'prarambh')).body.data.students.length, 4);
  assert.equal((await rosterOf(b.cookie, 'prarambh')).body.data.students.length, 4);
});

test('a student who enrols afterwards appears by itself, from the record the student portal already sends', async () => {
  student.state.enrolledBySlug.garud = enrolled(2, 'garud');
  const t = await onboard();
  await assignCourses(t.email, ['garud']);
  await waitFor(async () => (await rosterOf(t.cookie, 'garud')).body?.data?.course?.rosterSyncStatus === 'synced');
  assert.equal((await rosterOf(t.cookie, 'garud')).body.data.students.length, 2);

  const userId = objectId();
  const push = await api('PUT', `/api/internal/portal-students/${userId}`, {
    headers: KEY,
    body: {
      userId,
      fullName: 'Kabir Anand',
      email: `kabir.${uniq()}@example.com`,
      enrollmentNumber: 'NN26-000501',
      grade: '11',
      enrollments: [{ enrollmentId: 'ENR-2026-900001', status: 'active', courseSlug: 'garud', enrolledAt: new Date().toISOString() }],
      sourceUpdatedAt: new Date().toISOString(),
    },
  });
  assert.equal(push.status, 200, JSON.stringify(push.body));

  const res = await rosterOf(t.cookie, 'garud');
  assert.equal(res.body.data.students.length, 3);
  const kabir = res.body.data.students.find((s) => s.name === 'Kabir Anand');
  assert.equal(kabir.enrollmentNumber, 'NN26-000501');
  assert.equal(kabir.enrollmentId, 'ENR-2026-900001');
  assert.ok(!('phone' in kabir) && !('guardianName' in kabir), 'a roster shows identity only');

  // Repeating the same record, or one for the same student, never creates a second row.
  await api('PUT', `/api/internal/portal-students/${userId}`, {
    headers: KEY,
    body: {
      userId,
      fullName: 'Kabir Anand',
      email: kabir.email,
      enrollments: [{ enrollmentId: 'ENR-2026-900001', status: 'active', courseSlug: 'garud' }],
      sourceUpdatedAt: new Date(Date.now() + 1000).toISOString(),
    },
  });
  assert.equal((await rosterOf(t.cookie, 'garud')).body.data.students.length, 3);
});

test('an enrolment in a course nobody teaches here is not stored', async () => {
  const t = await onboard();
  await assignCourses(t.email, ['garud']);
  const userId = objectId();
  const push = await api('PUT', `/api/internal/portal-students/${userId}`, {
    headers: KEY,
    body: {
      userId,
      fullName: 'Isha Verma',
      email: `isha.${uniq()}@example.com`,
      enrollments: [{ enrollmentId: 'ENR-2026-900002', status: 'active', courseSlug: 'yoddha' }],
      sourceUpdatedAt: new Date().toISOString(),
    },
  });
  assert.equal(push.status, 200);
  assert.equal(await CourseEnrollment.countDocuments({ enrollmentId: 'ENR-2026-900002' }), 0);
});

test('a revoked enrolment leaves the roster, and a name correction arrives', async () => {
  student.state.enrolledBySlug.garud = [];
  const t = await onboard();
  await assignCourses(t.email, ['garud']);
  await waitFor(async () => (await rosterOf(t.cookie, 'garud')).body?.data?.course?.rosterSyncStatus === 'synced');

  const userId = objectId();
  const send = (extra, at) =>
    api('PUT', `/api/internal/portal-students/${userId}`, {
      headers: KEY,
      body: {
        userId,
        email: `m.${userId.slice(0, 6)}@example.com`,
        fullName: 'Meera K',
        enrollments: [{ enrollmentId: 'ENR-2026-900003', status: 'active', courseSlug: 'garud' }],
        sourceUpdatedAt: new Date(at).toISOString(),
        ...extra,
      },
    });

  const t0 = Date.now();
  await send({}, t0);
  assert.equal((await rosterOf(t.cookie, 'garud')).body.data.students[0].name, 'Meera K');

  await send({ fullName: 'Meera Krishnan' }, t0 + 1000);
  assert.equal((await rosterOf(t.cookie, 'garud')).body.data.students[0].name, 'Meera Krishnan');

  // A record that was read earlier but arrives later must not put the old name back.
  await send({ fullName: 'Meera K' }, t0 + 500);
  assert.equal((await rosterOf(t.cookie, 'garud')).body.data.students[0].name, 'Meera Krishnan');

  await send({ enrollments: [{ enrollmentId: 'ENR-2026-900003', status: 'revoked', courseSlug: 'garud' }] }, t0 + 2000);
  assert.equal((await rosterOf(t.cookie, 'garud')).body.data.students.length, 0);
  const revoked = await rosterOf(t.cookie, 'garud', '?status=revoked');
  assert.equal(revoked.body.data.students.length, 1);
});

test('taking the course away takes its students away at once, and giving it back restores them', async () => {
  student.state.enrolledBySlug.garud = enrolled(3, 'garud');
  const t = await onboard();
  await assignCourses(t.email, ['garud']);
  await waitFor(async () => (await rosterOf(t.cookie, 'garud')).body?.data?.course?.rosterSyncStatus === 'synced');
  assert.equal((await rosterOf(t.cookie, 'garud')).status, 200);

  const removal = await assignCourses(t.email, []);
  assert.deepEqual(removal.removed, ['garud']);
  assert.equal((await rosterOf(t.cookie, 'garud')).status, 404);
  assert.equal(await CourseEnrollment.countDocuments({ studentCourseSlug: 'garud' }), 0, 'nobody may see them, so no copy is kept');

  await assignCourses(t.email, ['garud']);
  await waitFor(async () => (await rosterOf(t.cookie, 'garud')).body?.data?.course?.rosterSyncStatus === 'synced');
  assert.equal((await rosterOf(t.cookie, 'garud')).body.data.students.length, 3);
});

test('assignment is a replacement: courses left out are removed, kept ones stay', async () => {
  student.state.enrolledBySlug.garud = enrolled(2, 'garud');
  student.state.enrolledBySlug.yoddha = enrolled(2, 'yoddha');
  const t = await onboard();
  await assignCourses(t.email, ['garud', 'yoddha']);
  const swap = await assignCourses(t.email, ['yoddha', 'prarambh']);
  assert.deepEqual(swap.removed, ['garud']);
  assert.deepEqual(swap.added, ['prarambh']);
  const courses = await api('GET', '/api/teacher/courses/assigned', { cookie: t.cookie });
  assert.deepEqual(courses.body.data.map((c) => c.studentCourseSlug).sort(), ['prarambh', 'yoddha']);
});

test('a student portal that is down never empties a roster, and says so', async () => {
  student.state.enrolledBySlug.garud = enrolled(4, 'garud');
  const t = await onboard();
  await assignCourses(t.email, ['garud']);
  await waitFor(async () => (await rosterOf(t.cookie, 'garud')).body?.data?.course?.rosterSyncStatus === 'synced');

  student.state.down = true;
  const refresh = await api('POST', '/api/teacher/courses/assigned/garud/refresh', { cookie: t.cookie });
  assert.equal(refresh.status, 503);
  assert.equal(refresh.body.error.code, 'ENROLLMENT_SOURCE_UNAVAILABLE');

  const res = await rosterOf(t.cookie, 'garud');
  assert.equal(res.body.data.students.length, 4, 'an unreachable peer is not an empty course');
  assert.equal(res.body.data.course.rosterSyncStatus, 'failed');
  assert.ok(res.body.data.course.rosterSyncError);

  student.state.down = false;
  const again = await api('POST', '/api/teacher/courses/assigned/garud/refresh', { cookie: t.cookie });
  assert.equal(again.status, 200);
  assert.equal((await rosterOf(t.cookie, 'garud')).body.data.course.rosterSyncStatus, 'synced');
});

test('a refresh notices a student who left the course', async () => {
  const people = enrolled(3, 'garud');
  student.state.enrolledBySlug.garud = people;
  const t = await onboard();
  await assignCourses(t.email, ['garud']);
  await waitFor(async () => (await rosterOf(t.cookie, 'garud')).body?.data?.course?.rosterSyncStatus === 'synced');

  student.state.enrolledBySlug.garud = people.slice(0, 2);
  assert.equal((await api('POST', '/api/teacher/courses/assigned/garud/refresh', { cookie: t.cookie })).status, 200);
  assert.equal((await rosterOf(t.cookie, 'garud')).body.data.students.length, 2);
});

test('search and paging work against the whole course, not one page of it', async () => {
  student.state.enrolledBySlug.garud = enrolled(25, 'garud');
  const t = await onboard();
  await assignCourses(t.email, ['garud']);
  await waitFor(async () => (await rosterOf(t.cookie, 'garud')).body?.data?.course?.rosterSyncStatus === 'synced');

  const page1 = await rosterOf(t.cookie, 'garud', '?limit=10&page=1');
  assert.equal(page1.body.data.students.length, 10);
  assert.equal(page1.body.meta.totalRecords, 25);
  assert.equal(page1.body.meta.totalPages, 3);
  const page3 = await rosterOf(t.cookie, 'garud', '?limit=10&page=3');
  assert.equal(page3.body.data.students.length, 5);

  const found = await rosterOf(t.cookie, 'garud', '?search=garud%2024');
  assert.equal(found.body.data.students.length, 1);
  assert.equal(found.body.data.students[0].name, 'Student garud 24');

  // Regex characters in a search are text, not a pattern.
  const hostile = await rosterOf(t.cookie, 'garud', `?search=${encodeURIComponent('.*')}`);
  assert.equal(hostile.body.data.students.length, 0);
});

test('the roster is read-only and requires a signed-in teacher', async () => {
  student.state.enrolledBySlug.garud = enrolled(1, 'garud');
  const t = await onboard();
  await assignCourses(t.email, ['garud']);

  assert.equal((await api('GET', '/api/teacher/courses/assigned/garud/students')).status, 401);
  const write = await api('POST', '/api/teacher/courses/assigned/garud/students', { cookie: t.cookie, body: { name: 'Planted' } });
  assert.ok([404, 405].includes(write.status));
  assert.equal(await CourseEnrollment.countDocuments({ name: 'Planted' }), 0);

  // The course-assignment endpoints are service-to-service only.
  const viaTeacher = await api('PUT', '/api/internal/teachers/courses', { cookie: t.cookie, body: { teacherEmail: t.email, courses: [{ slug: 'yoddha' }] } });
  assert.equal(viaTeacher.status, 401);
});

test('an administrator-authored course sold under a slug gives its instructor that course too, and only while they hold it', async () => {
  student.state.enrolledBySlug['ai-basics'] = enrolled(3, 'ai-basics');
  const a = await onboard({ name: 'Teacher A' });
  const b = await onboard({ name: 'Teacher B' });
  const assign = (email) =>
    api('PUT', '/api/internal/courses/admin-course-1', {
      headers: KEY,
      body: { teacherEmail: email, title: 'AI Basics', courseCode: 'AIB', studentCourseSlug: 'ai-basics', status: 'APPROVED' },
    });

  assert.equal((await assign(a.email)).status, 200);
  await waitFor(async () => (await rosterOf(a.cookie, 'ai-basics')).body?.data?.course?.rosterSyncStatus === 'synced');
  assert.equal((await rosterOf(a.cookie, 'ai-basics')).body.data.students.length, 3);

  // The course appears once, as the authored course, with its student count.
  const list = await api('GET', '/api/teacher/courses/assigned', { cookie: a.cookie });
  assert.equal(list.body.data.filter((c) => c.studentCourseSlug === 'ai-basics').length, 1);
  assert.equal(list.body.data.find((c) => c.studentCourseSlug === 'ai-basics').studentCount, 3);

  // Reassigned to B: A loses the students, B gains them.
  assert.equal((await assign(b.email)).status, 200);
  assert.equal((await rosterOf(a.cookie, 'ai-basics')).status, 404);
  await waitFor(async () => (await rosterOf(b.cookie, 'ai-basics')).status === 200);

  // Unassigned: nobody has them.
  assert.equal((await api('DELETE', '/api/internal/courses/admin-course-1', { headers: KEY })).status, 200);
  assert.equal((await rosterOf(b.cookie, 'ai-basics')).status, 404);
});

test('a course-assignment for an unknown teacher is reported, not thrown', async () => {
  const res = await api('PUT', '/api/internal/teachers/courses', {
    headers: KEY,
    body: { teacherEmail: `nobody.${uniq()}@nalanda.test`, courses: [{ slug: 'garud' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.updated, false);
  assert.equal(res.body.data.reason, 'TEACHER_NOT_FOUND');
});

test('invalid slugs are rejected before anything is stored', async () => {
  const t = await onboard();
  const before = await CourseAccess.countDocuments({});
  const res = await api('PUT', '/api/internal/teachers/courses', {
    headers: KEY,
    body: { teacherEmail: t.email, courses: [{ slug: '../etc/passwd' }] },
  });
  assert.equal(res.status, 422);
  assert.equal(await CourseAccess.countDocuments({}), before);
});
