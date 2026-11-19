import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Creating a teacher from the Admin portal, end to end through the real routes.
 *
 * Three stand-ins record what actually leaves this service: the Teacher Portal,
 * the student catalogue (the only place PRARAMBH / GARUD / YODDHA exist), and
 * SendGrid. That is the only honest way to test the claims that matter - that no
 * password is ever sent or emailed, that the link in the email is the one the
 * Teacher Portal was given, and that a failure anywhere is recorded rather than
 * reported as success.
 */

let mongod;
let server;
let base;
let teacherPortal;
let studentPortal;
let sendgrid;
let Teacher;
let cookie;

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const uniq = () => crypto.randomBytes(3).toString('hex');
const PORTAL = 'https://teacher.example.test';

function startPeer(handler) {
  const state = { calls: [], down: false };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { raw };
      }
      const call = { method: req.method, url: req.url, headers: req.headers, raw, body };
      state.calls.push(call);
      if (state.down) return req.socket.destroy();
      handler(call, res, state);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        state,
        url: `http://127.0.0.1:${srv.address().port}`,
        close: () => new Promise((r) => srv.close(r)),
      })
    );
  });
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

before(async () => {
  teacherPortal = await startPeer((call, res, state) => {
    const { method, url, body } = call;
    state.accounts ||= new Map();
    if (method === 'POST' && url === '/api/internal/teachers') {
      if (state.provisionStatus && state.provisionStatus !== 201) return json(res, state.provisionStatus, { success: false });
      state.accounts.set(body.email, body);
      return json(res, 201, { success: true, data: { userId: 'u1', teacherId: 't1', teacherCode: state.teacherCode || body.teacherId, portalUrl: PORTAL } });
    }
    if (method === 'PATCH' && url === '/api/internal/teachers/credentials') {
      if (!state.accounts.has(body.email)) return json(res, 404, { success: false, error: { code: 'ACCOUNT_NOT_FOUND' } });
      state.accounts.set(body.email, { ...state.accounts.get(body.email), ...body });
      return json(res, 200, { success: true, data: { teacherCode: state.accounts.get(body.email).teacherId, portalUrl: PORTAL } });
    }
    if (method === 'PUT' && url === '/api/internal/teachers/courses') {
      if (state.coursesStatus && state.coursesStatus !== 200) return json(res, state.coursesStatus, { success: false });
      return json(res, 200, { success: true, data: { updated: true } });
    }
    return json(res, 200, { success: true, data: { updated: true } });
  });

  studentPortal = await startPeer((call, res, state) => {
    if (call.url === '/api/public/courses') {
      if (state.catalogStatus && state.catalogStatus !== 200) return json(res, state.catalogStatus, { success: false });
      return json(res, 200, {
        success: true,
        data: [
          { id: '1', slug: 'prarambh', title: 'PRARAMBH', isPurchasable: true },
          { id: '2', slug: 'garud', title: 'GARUD', isPurchasable: false },
          { id: '3', slug: 'yoddha', title: 'YODDHA', isPurchasable: false },
        ],
      });
    }
    return json(res, 200, { success: true, data: null });
  });

  sendgrid = await startPeer((call, res, state) => {
    if (state.status && state.status !== 202) {
      return json(res, state.status, { errors: [{ message: state.errorMessage || 'rejected', field: 'from' }] });
    }
    res.writeHead(202, { 'X-Message-Id': `msg-${uniq()}` });
    res.end();
  });

  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test_onboarding_secret';
  process.env.CLIENT_URL = 'http://localhost:5175';
  process.env.SERVER_URL = 'http://admin.example.test';
  process.env.COOKIE_SAMESITE = 'lax';
  process.env.STUDENT_BACKEND_URL = studentPortal.url;
  process.env.STUDENT_BACKEND_SERVICE_KEY = 'student_key';
  process.env.TEACHER_BACKEND_URL = teacherPortal.url;
  process.env.TEACHER_BACKEND_SERVICE_KEY = 'teacher_key';
  process.env.SENDGRID_API_KEY = 'SG.test-key';
  process.env.SENDGRID_API_URL = `${sendgrid.url}/v3/mail/send`;
  process.env.SMTP_FROM = 'Nalanda Nexus <no-reply@example.test>';
  process.env.RATE_LIMIT_MAX = '100000';
  process.env.AUTH_RATE_LIMIT_MAX = '100000';

  const { connectDatabase } = await import('../src/config/db.js');
  await connectDatabase();
  const { createApp } = await import('../src/app.js');
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  ({ Teacher } = await import('../src/models/Teacher.js'));
  const { Admin } = await import('../src/models/Admin.js');
  await Admin.create({ name: 'QA Admin', email: 'qa.admin@test.local', passwordHash: await Admin.hashPassword('TestPass123!'), role: 'SUPER_ADMIN', status: 'ACTIVE' });
  const res = await call('/api/admin/auth/login', { method: 'POST', body: { email: 'qa.admin@test.local', password: 'TestPass123!' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  cookie = res.cookie;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await Promise.all([teacherPortal.close(), studentPortal.close(), sendgrid.close()]);
  const mongoose = (await import('mongoose')).default;
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(() => {
  for (const peer of [teacherPortal, studentPortal, sendgrid]) {
    peer.state.calls = [];
    peer.state.down = false;
  }
  Object.assign(teacherPortal.state, { provisionStatus: null, coursesStatus: null, teacherCode: null, accounts: new Map() });
  Object.assign(studentPortal.state, { catalogStatus: null });
  Object.assign(sendgrid.state, { status: null, errorMessage: null });
});

async function call(path, { method = 'GET', body, headers = {}, form } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, body: parsed, headers: res.headers, buffer: text, cookie: setCookie.map((c) => c.split(';')[0]).join('; ') };
}

const input = (over = {}) => ({
  name: 'Priya Menon',
  email: `priya.${uniq()}@nalanda.test`,
  subject: 'Physics',
  courseSlugs: ['garud', 'yoddha'],
  ...over,
});

const create = (over) => call('/api/admin/teachers', { method: 'POST', body: input(over) });
const portalCall = (method, url) => teacherPortal.state.calls.find((c) => c.method === method && c.url === url);
const lastMail = () => sendgrid.state.calls.at(-1);
const mailText = (m) => m.body.content.find((c) => c.type === 'text/plain').value;
const mailHtml = (m) => m.body.content.find((c) => c.type === 'text/html').value;
const ageLastAttempt = (id) => Teacher.updateOne({ _id: id }, { emailLastAttemptAt: new Date(Date.now() - 60 * 1000) });

// ---------------------------------------------------------------------------
// Required and optional fields
// ---------------------------------------------------------------------------

test('creating a teacher needs a name, an email, a subject or department, and at least one course', async () => {
  for (const [label, over] of [
    ['no name', { name: '' }],
    ['bad email', { email: 'not-an-email' }],
    ['no courses', { courseSlugs: [] }],
    ['courses missing', { courseSlugs: undefined }],
    ['no subject or department', { subject: undefined }],
  ]) {
    const res = await create(over);
    assert.equal(res.status, 422, `${label}: ${JSON.stringify(res.body)}`);
  }
  assert.equal(teacherPortal.state.calls.length, 0, 'nothing reached the Teacher Portal');
  assert.equal(sendgrid.state.calls.length, 0, 'and nothing was emailed');
});

test('a department alone satisfies "subject / department"; designation, phone and photo are optional', async () => {
  const res = await create({ subject: undefined, department: 'Science', designation: 'Senior Faculty', phone: '+91 98765 43210' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.designation, 'Senior Faculty');
  assert.equal(res.body.data.phone, '+91 98765 43210');
  const bare = await create({});
  assert.equal(bare.status, 201);
  assert.equal(bare.body.data.designation, undefined);
});

test('a course that is not in the catalogue is refused, and leaves no half-made teacher', async () => {
  const email = `ghost.${uniq()}@nalanda.test`;
  const res = await create({ email, courseSlugs: ['garud', 'not-a-course'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'COURSE_NOT_FOUND');
  assert.equal(await Teacher.countDocuments({ email }), 0);
  assert.equal(teacherPortal.state.calls.length, 0);
});

test('an unreachable catalogue is an error, never "no such course"', async () => {
  studentPortal.state.catalogStatus = 400;
  const email = `nocat.${uniq()}@nalanda.test`;
  const res = await create({ email });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'COURSE_CATALOG_UNAVAILABLE');
  assert.equal(await Teacher.countDocuments({ email }), 0);
});

test('a second teacher with the same email is refused', async () => {
  const email = `dup.${uniq()}@nalanda.test`;
  assert.equal((await create({ email })).status, 201);
  const again = await create({ email: email.toUpperCase() });
  assert.equal(again.status, 409);
});

test('only an authenticated administrator can create a teacher', async () => {
  const saved = cookie;
  cookie = '';
  const res = await create({});
  cookie = saved;
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Credentials: a link, never a password
// ---------------------------------------------------------------------------

test('no password is generated, sent to the Teacher Portal, emailed or returned', async () => {
  const res = await create({});
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const provisioning = portalCall('POST', '/api/internal/teachers');
  assert.ok(provisioning, 'the Teacher Portal login was created');
  assert.equal(provisioning.headers['x-internal-service-key'], 'teacher_key');
  assert.ok(!('tempPassword' in provisioning.body) && !('password' in provisioning.body));
  assert.match(provisioning.body.setupTokenHash, /^[a-f0-9]{64}$/);

  const mail = lastMail();
  assert.ok(!/password\s*:/i.test(mailText(mail)), 'the email carries no password');
  const everything = JSON.stringify([res.body, provisioning.body, mail.body]);
  assert.ok(!/tempPassword|tempPasswordFallback|passwordHash/.test(everything));
  assert.ok(!('passwordHash' in res.body.data) && !('tempPasswordFallback' in res.body.data));

  const stored = await Teacher.findById(res.body.data._id).select('+passwordHash').lean();
  assert.ok(stored.passwordHash, 'a hash exists, of a random value nobody was told');
});

test('the emailed link is the one the Teacher Portal was given, and it expires', async () => {
  const res = await create({ name: 'Anita Rao' });
  const provisioning = portalCall('POST', '/api/internal/teachers');
  const text = mailText(lastMail());

  const [, token] = text.match(/setup-password\?token=([a-f0-9]{64})/) || [];
  assert.ok(token, `a 64-character token link is in the email:\n${text}`);
  assert.ok(text.includes(`${PORTAL}/setup-password?token=`), 'it points at the Teacher Portal, not at this API');
  assert.equal(sha256(token), provisioning.body.setupTokenHash, 'the Teacher Portal holds exactly the hash of the emailed token');

  const hours = (new Date(provisioning.body.setupTokenExpiresAt) - Date.now()) / 36e5;
  assert.ok(hours > 71 && hours <= 72.01, `expires in about 72h, got ${hours}`);
  assert.equal(new Date(res.body.data.setupLinkExpiresAt).toISOString(), new Date(provisioning.body.setupTokenExpiresAt).toISOString());

  assert.ok(!(await Teacher.findById(res.body.data._id).lean()).setupTokenHash, 'this database never stores the token or its hash');
  assert.ok(!JSON.stringify(await Teacher.findById(res.body.data._id).lean()).includes(token));
});

test('the email carries the login URL, the Teacher ID, the assigned courses and first-login instructions', async () => {
  const res = await create({});
  const mail = lastMail();
  const text = mailText(mail);

  assert.equal(mail.body.personalizations[0].to[0].email, res.body.data.email);
  assert.match(res.body.data.teacherId, /^TCH-\d{4,}$/);
  assert.ok(text.includes(`Teacher ID: ${res.body.data.teacherId}`));
  assert.ok(text.includes(`${PORTAL}/login`), 'the Teacher Portal login page');
  assert.ok(text.includes('GARUD') && text.includes('YODDHA'));
  assert.match(text, /First sign-in/);
  assert.match(text, /never send passwords by email/);
  assert.equal(mail.body.from.email, 'no-reply@example.test');
  assert.equal(mail.body.tracking_settings.click_tracking.enable, false, 'a one-time link is not rewritten through a tracker');
  assert.match(mailHtml(mail), /Set your password/);
});

test('a teacher id the Teacher Portal changes is adopted, so the email shows one the login accepts', async () => {
  teacherPortal.state.teacherCode = 'TCH-0777';
  const res = await create({});
  assert.equal(res.body.data.teacherId, 'TCH-0777');
  assert.ok(mailText(lastMail()).includes('TCH-0777'));
});

test('names are escaped in the HTML email', async () => {
  const { teacherOnboardingEmail } = await import('../src/services/email.service.js');
  const { html, text } = teacherOnboardingEmail({
    name: '<img src=x onerror=alert(1)>',
    teacherId: 'TCH-0001',
    loginUrl: `${PORTAL}/login`,
    setupUrl: `${PORTAL}/setup-password?token=${'a'.repeat(64)}`,
    expiresAt: new Date(Date.now() + 36e5),
    courses: [{ slug: 'garud', title: '"><script>x</script>' }],
  });
  assert.ok(!html.includes('<img src=x') && !html.includes('<script>'));
  assert.ok(html.includes('&lt;img src=x'));
  assert.ok(text.includes('<img src=x'), 'plain text is plain text');
});

// ---------------------------------------------------------------------------
// Email status, and honesty about failure
// ---------------------------------------------------------------------------

test('a delivered email is recorded with the provider message id and time', async () => {
  const res = await create({});
  const t = await Teacher.findById(res.body.data._id).lean();
  assert.equal(t.emailDeliveryStatus, 'sent');
  assert.equal(t.credentialEmailSent, true);
  assert.ok(t.credentialEmailSentAt && t.emailLastAttemptAt);
  assert.match(t.emailProviderMessageId, /^msg-/);
  assert.equal(t.emailAttempts, 1);
  assert.equal(t.emailDeliveryError, null);
  assert.deepEqual(res.body.meta.warnings, []);
});

test('a provider rejection is recorded with the provider\'s own reason, and surfaced', async () => {
  sendgrid.state.status = 403;
  sendgrid.state.errorMessage = 'The from address does not match a verified Sender Identity.';
  const res = await create({});

  assert.equal(res.status, 201, 'the teacher is still created');
  assert.ok(res.body.meta.warnings.includes('EMAIL_DELIVERY_FAILED'));
  const t = await Teacher.findById(res.body.data._id).lean();
  assert.equal(t.emailDeliveryStatus, 'failed');
  assert.equal(t.credentialEmailSent, false);
  assert.match(t.emailDeliveryError, /403.*verified Sender Identity/);
  assert.equal(res.body.data.emailDeliveryStatus, 'failed');
  assert.match(res.body.data.emailDeliveryError, /Sender Identity/);
});

test('with no email provider configured the status says so, not "sent"', async () => {
  const { env } = await import('../src/config/env.js');
  const key = env.email.sendgridApiKey;
  env.email.sendgridApiKey = '';
  try {
    const res = await create({});
    const t = await Teacher.findById(res.body.data._id).lean();
    assert.equal(t.emailDeliveryStatus, 'stubbed');
    assert.match(t.emailDeliveryError, /No email provider/);
    assert.ok(res.body.meta.warnings.includes('EMAIL_DELIVERY_FAILED'));
    assert.equal(sendgrid.state.calls.length, 0);
  } finally {
    env.email.sendgridApiKey = key;
  }
});

test('if the Teacher Portal login cannot be created, no email is sent - its link would lead nowhere', async () => {
  teacherPortal.state.provisionStatus = 422;
  const res = await create({});
  assert.equal(res.status, 201);
  assert.ok(res.body.meta.warnings.includes('PORTAL_PROVISIONING_FAILED'));
  assert.equal(sendgrid.state.calls.length, 0);
  const t = await Teacher.findById(res.body.data._id).lean();
  assert.equal(t.portalProvisioned, false);
  assert.equal(t.emailDeliveryStatus, 'not_sent');
  assert.match(t.emailDeliveryError, /could not be created/);
});

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

test('resend issues a brand-new link: the Teacher Portal is told, the old hash is replaced, and no password appears', async () => {
  const created = await create({});
  const id = created.body.data._id;
  const firstHash = portalCall('POST', '/api/internal/teachers').body.setupTokenHash;
  await ageLastAttempt(id);
  sendgrid.state.calls = [];

  const res = await call(`/api/admin/teachers/${id}/resend-credentials`, { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const patch = portalCall('PATCH', '/api/internal/teachers/credentials');
  assert.ok(patch);
  assert.ok(!('newPassword' in patch.body));
  assert.notEqual(patch.body.setupTokenHash, firstHash, 'a fresh token, so the earlier link dies');

  const text = mailText(lastMail());
  const [, token] = text.match(/token=([a-f0-9]{64})/);
  assert.equal(sha256(token), patch.body.setupTokenHash);
  assert.match(lastMail().body.subject, /new/i);
  assert.ok(!/password\s*:/i.test(text));
  assert.ok(!JSON.stringify(res.body).includes('tempPassword'));

  const t = await Teacher.findById(id).lean();
  assert.equal(t.emailAttempts, 2);
  assert.equal(t.emailDeliveryStatus, 'sent');
});

test('resend cannot be hammered: a second one straight away is refused', async () => {
  const created = await create({});
  const res = await call(`/api/admin/teachers/${created.body.data._id}/resend-credentials`, { method: 'POST' });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'RESEND_TOO_SOON');
  assert.equal(sendgrid.state.calls.length, 1, 'only the creation email went out');
});

test('resending after a failed email delivers it, and the status turns to sent', async () => {
  sendgrid.state.status = 403;
  const created = await create({});
  assert.equal((await Teacher.findById(created.body.data._id).lean()).emailDeliveryStatus, 'failed');

  sendgrid.state.status = null;
  await ageLastAttempt(created.body.data._id);
  const res = await call(`/api/admin/teachers/${created.body.data._id}/resend-credentials`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.meta.warnings, []);
  const t = await Teacher.findById(created.body.data._id).lean();
  assert.equal(t.emailDeliveryStatus, 'sent');
  assert.equal(t.emailDeliveryError, null);
});

test('resend creates the Teacher Portal login if the original attempt never did, and sends the courses with it', async () => {
  teacherPortal.state.provisionStatus = 422;
  const created = await create({});
  assert.equal((await Teacher.findById(created.body.data._id).lean()).portalProvisioned, false);
  assert.equal(sendgrid.state.calls.length, 0);

  teacherPortal.state.provisionStatus = null;
  teacherPortal.state.calls = [];
  await ageLastAttempt(created.body.data._id);
  const res = await call(`/api/admin/teachers/${created.body.data._id}/resend-credentials`, { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.meta.warnings, []);

  assert.ok(portalCall('POST', '/api/internal/teachers'), 'the account was created this time');
  const courses = portalCall('PUT', '/api/internal/teachers/courses');
  assert.deepEqual(courses.body.courses.map((c) => c.slug).sort(), ['garud', 'yoddha']);
  const t = await Teacher.findById(created.body.data._id).lean();
  assert.equal(t.portalProvisioned, true);
  assert.equal(t.courseSyncStatus, 'synced');
  assert.equal(t.emailDeliveryStatus, 'sent');
  assert.equal(sendgrid.state.calls.length, 1);
});

test('when the Teacher Portal cannot be reached, resend says so and sends nothing', async () => {
  const created = await create({});
  await ageLastAttempt(created.body.data._id);
  sendgrid.state.calls = [];
  teacherPortal.state.down = true;

  const res = await call(`/api/admin/teachers/${created.body.data._id}/resend-credentials`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok(res.body.meta.warnings.includes('PORTAL_PROVISIONING_FAILED'));
  assert.equal(sendgrid.state.calls.length, 0, 'a link that was never issued must not be emailed');
  assert.equal((await Teacher.findById(created.body.data._id).lean()).emailDeliveryStatus, 'not_sent');
});

test('"reset password" is the same single path: a new link, not a password', async () => {
  const created = await create({});
  await ageLastAttempt(created.body.data._id);
  const res = await call(`/api/admin/teachers/${created.body.data._id}/reset-password`, { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(mailText(lastMail()), /setup-password\?token=[a-f0-9]{64}/);
});

test('a suspended teacher cannot be sent a link', async () => {
  const created = await create({});
  await call(`/api/admin/teachers/${created.body.data._id}/suspend`, { method: 'POST', body: { reason: 'Policy review' } });
  await ageLastAttempt(created.body.data._id);
  const res = await call(`/api/admin/teachers/${created.body.data._id}/resend-credentials`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TEACHER_SUSPENDED');
});

// ---------------------------------------------------------------------------
// Course assignment
// ---------------------------------------------------------------------------

test('the courses chosen at creation are saved on the teacher and sent to the Teacher Portal', async () => {
  const res = await create({ courseSlugs: ['GARUD', 'garud', 'prarambh'] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.assignedCourses.map((c) => c.slug).sort(), ['garud', 'prarambh'], 'case-insensitive and de-duplicated');
  assert.equal(res.body.data.assignedCourses.find((c) => c.slug === 'garud').title, 'GARUD', 'titles come from the catalogue');

  const sent = portalCall('PUT', '/api/internal/teachers/courses');
  assert.equal(sent.body.teacherEmail, res.body.data.email);
  assert.deepEqual(sent.body.courses.map((c) => c.slug).sort(), ['garud', 'prarambh']);
  assert.equal(res.body.data.courseSyncStatus, 'synced');
});

test('assigned courses are visible on the teacher\'s profile and filterable', async () => {
  const a = await create({ courseSlugs: ['garud'] });
  const b = await create({ courseSlugs: ['yoddha'] });

  const profile = await call(`/api/admin/teachers/${a.body.data._id}`);
  assert.deepEqual(profile.body.data.assignedCourses.map((c) => c.slug), ['garud']);
  assert.deepEqual(profile.body.data.authoredCourses, []);

  const list = await call('/api/admin/teachers?course=garud&limit=100');
  const ids = list.body.data.map((t) => t._id);
  assert.ok(ids.includes(a.body.data._id));
  assert.ok(!ids.includes(b.body.data._id));
  assert.ok(list.body.data.every((t) => !('passwordHash' in t)));
});

test('courses can be changed later, as a full replacement, and the Teacher Portal is told', async () => {
  const created = await create({ courseSlugs: ['garud', 'yoddha'] });
  const id = created.body.data._id;
  teacherPortal.state.calls = [];

  const res = await call(`/api/admin/teachers/${id}/courses`, { method: 'PUT', body: { courseSlugs: ['yoddha', 'prarambh'] } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.assignedCourses.map((c) => c.slug).sort(), ['prarambh', 'yoddha']);
  assert.deepEqual(portalCall('PUT', '/api/internal/teachers/courses').body.courses.map((c) => c.slug).sort(), ['prarambh', 'yoddha']);

  const cleared = await call(`/api/admin/teachers/${id}/courses`, { method: 'PUT', body: { courseSlugs: [] } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.data.assignedCourses, []);
  assert.deepEqual(teacherPortal.state.calls.filter((c) => c.method === 'PUT').at(-1).body.courses, []);
});

test('a course change the Teacher Portal did not accept is recorded and reported, and retrying fixes it', async () => {
  const created = await create({ courseSlugs: ['garud'] });
  const id = created.body.data._id;

  teacherPortal.state.coursesStatus = 422;
  const failed = await call(`/api/admin/teachers/${id}/courses`, { method: 'PUT', body: { courseSlugs: ['garud', 'yoddha'] } });
  assert.equal(failed.status, 200);
  assert.ok(failed.body.meta.warnings.includes('COURSE_SYNC_FAILED'));
  assert.equal(failed.body.data.courseSyncStatus, 'failed');
  assert.ok(failed.body.data.courseSyncError);
  assert.equal(failed.body.data.assignedCourses.length, 2, 'what the admin chose is kept');

  teacherPortal.state.coursesStatus = null;
  const retry = await call(`/api/admin/teachers/${id}/courses`, { method: 'PUT', body: { courseSlugs: ['garud', 'yoddha'] } });
  assert.deepEqual(retry.body.meta.warnings, []);
  assert.equal(retry.body.data.courseSyncStatus, 'synced');
  assert.equal(retry.body.data.courseSyncError, null);
});

test('assigning an unknown course, or something that is not a slug, is refused', async () => {
  const created = await create({});
  const id = created.body.data._id;
  const unknown = await call(`/api/admin/teachers/${id}/courses`, { method: 'PUT', body: { courseSlugs: ['nope'] } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'COURSE_NOT_FOUND');
  const hostile = await call(`/api/admin/teachers/${id}/courses`, { method: 'PUT', body: { courseSlugs: ['../../etc'] } });
  assert.equal(hostile.status, 422);
  const operator = await call(`/api/admin/teachers/${id}/courses`, { method: 'PUT', body: { courseSlugs: [{ $ne: 1 }] } });
  assert.equal(operator.status, 422);
  assert.deepEqual((await call(`/api/admin/teachers/${id}`)).body.data.assignedCourses.map((c) => c.slug).sort(), ['garud', 'yoddha'], 'unchanged');
});

test('several teachers can hold the same course', async () => {
  const a = await create({ courseSlugs: ['prarambh'] });
  const b = await create({ courseSlugs: ['prarambh'] });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
});

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function photoForm(buffer, filename = 'me.png', type = 'image/png') {
  const form = new FormData();
  form.append('photo', new Blob([buffer], { type }), filename);
  return form;
}

test('a profile photo is stored in the database, served publicly, and shown on the record', async () => {
  const created = await create({});
  const id = created.body.data._id;

  const up = await call(`/api/admin/teachers/${id}/photo`, { method: 'POST', form: photoForm(PNG) });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const url = up.body.data.avatar;
  assert.match(url, /^http:\/\/admin\.example\.test\/api\/admin\/files\/[a-f0-9]{24}$/);

  const saved = cookie;
  cookie = ''; // a browser loading an <img> has no admin session
  const served = await call(new URL(url).pathname);
  cookie = saved;
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
});

test('a file that only claims to be an image is refused', async () => {
  const created = await create({});
  const html = Buffer.from('<html><script>alert(1)</script></html> padding padding');
  const res = await call(`/api/admin/teachers/${created.body.data._id}/photo`, { method: 'POST', form: photoForm(html, 'x.png', 'image/png') });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'FILE_TYPE_NOT_ALLOWED');
});

test('a photo URL can be supplied at creation, and must be a real URL', async () => {
  const ok = await create({ avatar: 'https://cdn.example.test/p.jpg' });
  assert.equal(ok.status, 201);
  assert.equal(portalCall('POST', '/api/internal/teachers').body.avatarUrl, 'https://cdn.example.test/p.jpg');
  const bad = await create({ avatar: 'data:image/png;base64,AAAA' });
  assert.equal(bad.status, 422);
});
