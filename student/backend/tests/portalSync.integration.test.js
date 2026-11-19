import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { bootTestApp, registerAndLogin, bearer } from './helpers/testApp.js';

// Read by the env module when the app boots.
process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';

/**
 * Sending a student's record to the admin and teacher portals.
 *
 * A student could buy a course and appear in neither portal's student list: the
 * admin portal was only ever told about the payment, and the teacher roster row
 * stayed an unverified placeholder. This proves that every way of gaining a
 * course - payment, its webhook, a coupon - and every change to what those lists
 * show - completing or editing the profile - sends the student's current record,
 * keyed on their user id, with the name they actually have; that repeats are
 * harmless; that a portal being down never costs the student their course; and
 * that what failed is retried.
 *
 * The two portals are local stand-ins that record what they receive and, like
 * the real receivers, keep one record per user id with the newest one winning.
 * Google's token check is replaced exactly as in googleAuth.integration.test.js.
 */

OAuth2Client.prototype.verifyIdToken = async function verifyTestToken({ idToken, audience }) {
  if (audience !== process.env.GOOGLE_CLIENT_ID) throw new Error('audience mismatch');
  const payload = JSON.parse(Buffer.from(idToken, 'base64url').toString('utf8'));
  if (!payload?.sub) throw new Error('bad signature');
  return { getPayload: () => payload };
};

const KEY = 'test_internal_key'; // set by helpers/testApp.js for every bridge

function startPeer(name) {
  const state = { status: 200, down: false, puts: [], records: new Map(), placements: [], placeBatchId: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (state.down) return req.socket.destroy();
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-internal-service-key'] !== KEY) return send(401, { success: false });
      const body = raw ? JSON.parse(raw) : {};

      const portalStudent = req.url.match(/^\/api\/internal\/portal-students\/([0-9a-f]{24})$/);
      if (portalStudent && req.method === 'PUT') {
        state.puts.push({ userId: portalStudent[1], body });
        if (state.status !== 200) return send(state.status, { success: false, error: { message: 'peer unavailable' } });
        const previous = state.records.get(portalStudent[1]);
        if (!previous || new Date(previous.sourceUpdatedAt) <= new Date(body.sourceUpdatedAt)) state.records.set(portalStudent[1], body);
        return send(200, { success: true, data: { outcome: previous ? 'updated' : 'created' } });
      }
      if (name === 'teacher' && req.url === '/api/internal/batches/place') {
        state.placements.push(body);
        return send(200, { success: true, data: state.placeBatchId ? { batchId: state.placeBatchId, batchCode: 'PB1' } : null });
      }
      // Every other bridge call (payments ledger, teacher lookups) is a side channel.
      return send(200, { success: true, data: null });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}`,
        reset() {
          Object.assign(state, { status: 200, down: false, puts: [], records: new Map(), placements: [], placeBatchId: null });
        },
        close: () => new Promise((r) => server.close(r)),
      })
    )
  );
}

let ctx;
let request;
let adminPeer;
let teacherPeer;
let User;
let StudentProfile;
let Enrollment;
let Course;
let couponService;
let paymentService;
let portalSync;

before(async () => {
  adminPeer = await startPeer('admin');
  teacherPeer = await startPeer('teacher');
  process.env.ADMIN_BACKEND_URL = adminPeer.url;
  process.env.TEACHER_BACKEND_URL = teacherPeer.url;

  ctx = await bootTestApp();
  request = ctx.request;
  ({ User } = await import('../src/models/User.js'));
  ({ StudentProfile } = await import('../src/models/StudentProfile.js'));
  ({ Enrollment } = await import('../src/models/Enrollment.js'));
  ({ Course } = await import('../src/models/Course.js'));
  couponService = await import('../src/services/coupon.service.js');
  paymentService = await import('../src/services/payment.service.js');
  portalSync = await import('../src/services/portalSync.service.js');
  await Promise.all([StudentProfile.init(), Enrollment.init(), User.init()]);

  for (const [slug, priceInPaise] of [['sync-a', 99900], ['sync-b', 49900], ['sync-c', 29900]]) {
    await Course.create({ slug, title: `Course ${slug}`, description: 'A course for the sync tests', priceInPaise, isPublished: true, isPurchasable: true });
  }
});

after(async () => {
  await ctx.teardown();
  await adminPeer.close();
  await teacherPeer.close();
});

beforeEach(() => {
  adminPeer.reset();
  teacherPeer.reset();
});

const uniq = () => crypto.randomBytes(4).toString('hex');
const as = (session) => bearer(session.accessToken);
const PROFILE = Object.freeze({ fullName: 'Aarav Sharma', guardianName: 'Sunita Sharma', grade: 'Class 9', phone: '98765 43210' });

async function newStudent(label, name = `Student ${label}`) {
  const email = `sync.${label}.${uniq()}@example.com`;
  const session = await registerAndLogin(request, { name, email });
  const user = await User.findOne({ email }).lean();
  return { ...session, email, userId: String(user._id) };
}

async function checkout(session, courseSlug) {
  const order = await request.post('/api/payments/orders').set(as(session)).send({ courseSlug });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const razorpay_order_id = order.body.data.razorpayOrderId;
  const razorpay_payment_id = `pay_${uniq()}`;
  return {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature: paymentService.mockSignatureFor(razorpay_order_id, razorpay_payment_id),
  };
}

const verify = (session, payment) => request.post('/api/payments/verify').set(as(session)).send(payment);

async function purchase(session, courseSlug) {
  const res = await verify(session, await checkout(session, courseSlug));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res;
}

function sendWebhook(orderId, paymentId) {
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: orderId } } } });
  const signature = crypto.createHmac('sha256', 'test_webhook_secret').update(raw).digest('hex');
  return request.post('/api/payments/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', signature).send(raw);
}

async function redeemFreeCoupon(session, courseSlug) {
  const course = await Course.findOne({ slug: courseSlug });
  const { coupons } = await couponService.createCampaign({ courseId: course._id, name: `sync-${uniq()}`, count: 1 });
  return request.post('/api/coupons/redeem').set(as(session)).send({ code: coupons[0].code, courseSlug });
}

const completeProfile = (session, body = PROFILE) => request.put('/api/student/profile/completion').set(as(session)).send(body);
const latest = (peer, userId) => [...peer.state.puts].reverse().find((p) => p.userId === userId)?.body;
const google = (claims) => request.post('/api/auth/google').send({ idToken: Buffer.from(JSON.stringify({ email_verified: true, ...claims })).toString('base64url') });

// --- TEST 1: complete profile, then pay -------------------------------------------

test('a student with a complete profile reaches both portals by name and number as soon as payment is verified', async () => {
  const s = await newStudent('complete');
  assert.equal((await completeProfile(s)).status, 200);
  assert.equal(adminPeer.state.puts.length, 0, 'an account with no course is nobody either portal lists');

  teacherPeer.state.placeBatchId = '64b0000000000000000000b1';
  const paid = await purchase(s, 'sync-a');
  const number = paid.body.data.studentProfile.enrollmentNumber;

  const admin = latest(adminPeer, s.userId);
  assert.ok(admin, 'the admin portal received the student');
  assert.equal(admin.userId, s.userId, 'keyed on the stable user id, not the name');
  assert.equal(admin.fullName, 'Aarav Sharma');
  assert.equal(admin.email, s.email);
  assert.equal(admin.enrollmentNumber, number);
  assert.equal(admin.guardianName, 'Sunita Sharma');
  assert.equal(admin.grade, 'Class 9');
  assert.equal(admin.phone, '+919876543210');
  assert.equal(admin.profileComplete, true);
  assert.equal(admin.enrollments.length, 1);
  assert.equal(admin.enrollments[0].courseSlug, 'sync-a');
  assert.equal(admin.enrollments[0].status, 'active');
  assert.equal(admin.enrollments[0].enrollmentId, paid.body.data.enrollment.enrollmentId);
  assert.equal(admin.enrollments[0].batchCode, 'PB1', 'sent after placement, so the batch is included');
  assert.ok(admin.enrollments[0].enrolledAt);

  const teacher = latest(teacherPeer, s.userId);
  assert.equal(teacher.fullName, 'Aarav Sharma');
  assert.equal(teacher.enrollmentNumber, number);
  assert.deepEqual(Object.keys(teacher.enrollments[0]).sort(), ['batchCode', 'batchId', 'courseSlug', 'enrolledAt', 'enrollmentId', 'status']);
  assert.equal(teacher.enrollments[0].courseSlug, 'sync-a', 'the slug lets the course-wide roster place the student');
  assert.equal(JSON.stringify(teacher).includes('Course sync-a'), false, 'but no course title goes with it');
  assert.equal(JSON.stringify(teacher).includes('99900'), false, 'and no price');
  assert.equal(teacher.enrollments[0].batchId, '64b0000000000000000000b1');

  for (const body of [admin, teacher]) {
    const text = JSON.stringify(body);
    for (const secret of ['payments', 'orderId', 'amountInPaise', 'razorpay', 'passwordHash', 'googleId']) {
      assert.equal(text.includes(secret), false, `${secret} never leaves the student portal in a record`);
    }
  }

  const profile = await StudentProfile.findOne({ userId: s.userId }).lean();
  assert.equal(profile.portalSync.pendingSince, null, 'nothing left owing');
  assert.ok(profile.portalSync.lastSyncedAt);
});

// --- TEST 2: pay first, complete the profile afterwards ---------------------------

test('a student who pays before completing the profile is resent with the name they then enter', async () => {
  const s = await newStudent('later', 'riya2026');
  const paid = await purchase(s, 'sync-a');
  const number = paid.body.data.studentProfile.enrollmentNumber;

  const atPurchase = latest(adminPeer, s.userId);
  assert.equal(atPurchase.fullName, 'riya2026', 'at purchase the portals get the account name - the only one there is');
  assert.equal(atPurchase.profileComplete, false);
  assert.equal(atPurchase.enrollmentNumber, number, 'but already the enrollment number');

  const saved = await completeProfile(s, { fullName: 'Riya Kapoor', guardianName: 'Meena Kapoor', grade: 'Class 10', phone: '98111 22233' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  for (const peer of [adminPeer, teacherPeer]) {
    const record = peer.state.records.get(s.userId);
    assert.equal(record.fullName, 'Riya Kapoor', 'the completed name replaces it');
    assert.equal(record.guardianName, 'Meena Kapoor');
    assert.equal(record.grade, 'Class 10');
    assert.equal(record.enrollmentNumber, number, 'with the same number');
  }
  assert.equal(adminPeer.state.records.get(s.userId).profileComplete, true);
  assert.equal(adminPeer.state.records.size, 1, 'one student, however many times it was sent');
});

// --- TEST 3: coupon ------------------------------------------------------------------

test('a coupon enrolment is sent exactly like a paid one, and updated when the profile is completed', async () => {
  const s = await newStudent('coupon', 'dev2026');
  const redeemed = await redeemFreeCoupon(s, 'sync-b');
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.body));

  const atRedeem = latest(adminPeer, s.userId);
  assert.equal(atRedeem.enrollments[0].courseSlug, 'sync-b');
  assert.equal(atRedeem.enrollments[0].enrollmentId, redeemed.body.data.enrollment.enrollmentId);
  assert.match(atRedeem.enrollmentNumber, /^NN\d{2}-\d{6}$/);

  await completeProfile(s, { fullName: 'Dev Malhotra', guardianName: 'Rakesh Malhotra', grade: 'Class 8', phone: '+91 99887 76655' });
  assert.equal(adminPeer.state.records.get(s.userId).fullName, 'Dev Malhotra');
  assert.equal(teacherPeer.state.records.get(s.userId).fullName, 'Dev Malhotra');
});

// --- TEST 4: second course -------------------------------------------------------------

test('a second course is added to the same student record, with the same number and name', async () => {
  const s = await newStudent('second');
  await purchase(s, 'sync-a');
  await completeProfile(s);
  const number = adminPeer.state.records.get(s.userId).enrollmentNumber;

  await purchase(s, 'sync-b');
  const record = adminPeer.state.records.get(s.userId);
  assert.equal(adminPeer.state.records.size, 1, 'still one student');
  assert.equal(record.enrollmentNumber, number);
  assert.equal(record.fullName, 'Aarav Sharma');
  assert.deepEqual(record.enrollments.map((e) => e.courseSlug).sort(), ['sync-a', 'sync-b']);
  assert.equal(new Set(adminPeer.state.puts.map((p) => p.userId)).size, 1);
});

// --- TESTS 5 and 6: Google ----------------------------------------------------------

test('a new Google student is sent with the name Google gave, and a returning one stays the same student', async () => {
  const sub = `g-${uniq()}`;
  const email = `google.${uniq()}@example.com`;
  const first = await google({ sub, email, name: 'Adarsh Tiwari' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const session = { accessToken: first.body.data.accessToken };
  const userId = String(first.body.data.user._id);

  const paid = await purchase(session, 'sync-a');
  const number = paid.body.data.studentProfile.enrollmentNumber;
  assert.equal(latest(adminPeer, userId).fullName, 'Adarsh Tiwari');
  assert.equal(latest(teacherPeer, userId).fullName, 'Adarsh Tiwari');

  // TEST 6: signs in again - Google now reports a different display name - and buys another course.
  const again = await google({ sub, email, name: 'A. Tiwari (Google)' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(String(again.body.data.user._id), userId, 'the same internal account');
  await purchase({ accessToken: again.body.data.accessToken }, 'sync-b');

  const record = adminPeer.state.records.get(userId);
  assert.equal(record.userId, userId);
  assert.equal(record.fullName, 'Adarsh Tiwari', 'the account keeps its name; a later Google name does not rename it');
  assert.equal(record.enrollmentNumber, number);
  assert.equal(record.enrollments.length, 2);
  assert.equal(await User.countDocuments({ email }), 1, 'no duplicate account');
});

// --- TEST 7: name changes ----------------------------------------------------------------

test('changing the name later - on the profile form or in settings - reaches both portals', async () => {
  const s = await newStudent('rename');
  await purchase(s, 'sync-a');
  await completeProfile(s);

  await completeProfile(s, { ...PROFILE, fullName: 'Aarav Kumar Sharma' });
  assert.equal(adminPeer.state.records.get(s.userId).fullName, 'Aarav Kumar Sharma');
  assert.equal(teacherPeer.state.records.get(s.userId).fullName, 'Aarav Kumar Sharma');

  const patched = await request.patch('/api/student/profile').set(as(s)).send({ name: 'Aarav K Sharma' });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(adminPeer.state.records.get(s.userId).fullName, 'Aarav K Sharma');
  assert.equal(teacherPeer.state.records.get(s.userId).fullName, 'Aarav K Sharma');
});

// --- TEST 8: repeats ------------------------------------------------------------------------

test('a verify repeated, a replayed webhook and a simultaneous verify and webhook all leave one enrolment and one record', async () => {
  const s = await newStudent('repeat');
  const payment = await checkout(s, 'sync-a');

  const [a, b] = await Promise.all([verify(s, payment), sendWebhook(payment.razorpay_order_id, payment.razorpay_payment_id)]);
  assert.ok([200, 201].includes(a.status), JSON.stringify(a.body));
  assert.equal(b.status, 200);
  assert.equal((await verify(s, payment)).status, 200, 'a refresh after paying');
  assert.equal((await sendWebhook(payment.razorpay_order_id, payment.razorpay_payment_id)).status, 200, 'Razorpay retrying');

  const course = await Course.findOne({ slug: 'sync-a' }).lean();
  assert.equal(await Enrollment.countDocuments({ userId: s.userId, courseId: course._id }), 1);
  assert.equal(adminPeer.state.records.size, 1);
  const bodies = adminPeer.state.puts.map((p) => p.body);
  assert.ok(bodies.length >= 1);
  assert.equal(new Set(bodies.map((body) => body.enrollmentNumber)).size, 1, 'every delivery names the same student');
  assert.equal(new Set(bodies.map((body) => body.enrollments[0].enrollmentId)).size, 1, 'and the same enrolment');
});

// --- failure, retry and recovery ------------------------------------------------------------

test('a portal that is down never costs the student the course; the record is kept pending and retried', async () => {
  const s = await newStudent('down');
  adminPeer.state.status = 503;
  teacherPeer.state.down = true;

  const started = Date.now();
  const paid = await purchase(s, 'sync-c');
  assert.ok(Date.now() - started < 12_000, 'an unreachable portal is given up on quickly');
  assert.equal(paid.body.data.enrollment.status, 'active', 'the course is granted regardless');

  let profile = await StudentProfile.findOne({ userId: s.userId }).lean();
  assert.ok(profile.portalSync.pendingSince, 'the undelivered record is remembered');
  assert.equal(profile.portalSync.attempts, 1);
  assert.match(profile.portalSync.lastError, /admin: HTTP 503/);

  // Nothing is retried before its back-off has passed.
  const early = await portalSync.retryPendingPortalSyncs({ now: new Date() });
  assert.equal(early.considered, 0);

  adminPeer.state.status = 200;
  teacherPeer.state.down = false;
  const retried = await portalSync.retryPendingPortalSyncs({ now: new Date(Date.now() + 5 * 60_000) });
  assert.ok(retried.synced >= 1, JSON.stringify(retried));

  profile = await StudentProfile.findOne({ userId: s.userId }).lean();
  assert.equal(profile.portalSync.pendingSince, null);
  assert.equal(profile.portalSync.attempts, 0);
  assert.equal(adminPeer.state.records.get(s.userId).enrollments[0].courseSlug, 'sync-c');
  assert.ok(teacherPeer.state.records.get(s.userId));
});

test('an enrolment the teacher portal could not place at purchase is placed when the record is next sent', async () => {
  const s = await newStudent('unplaced');
  const paid = await purchase(s, 'sync-a');
  const enrollmentId = paid.body.data.enrollment.enrollmentId;
  assert.equal((await Enrollment.findOne({ enrollmentId }).lean()).batchId, null, 'no batch had room at purchase');

  teacherPeer.state.placeBatchId = '64b0000000000000000000c3';
  await completeProfile(s);

  assert.equal((await Enrollment.findOne({ enrollmentId }).lean()).batchId, '64b0000000000000000000c3');
  assert.equal(teacherPeer.state.records.get(s.userId).enrollments[0].batchId, '64b0000000000000000000c3');
  assert.equal(teacherPeer.state.placements.at(-1).studentName, 'Aarav Sharma');
});

test('a student with no course is never sent anywhere', async () => {
  const s = await newStudent('nocourse');
  await completeProfile(s);
  await request.patch('/api/student/profile').set(as(s)).send({ name: 'Somebody Else' });
  assert.equal(adminPeer.state.puts.length + teacherPeer.state.puts.length, 0);
});

test('the resync endpoint needs the service key, is dry unless asked, and resends one, pending or all', async () => {
  const s = await newStudent('resync');
  await purchase(s, 'sync-a');
  await completeProfile(s);
  const number = adminPeer.state.records.get(s.userId).enrollmentNumber;
  adminPeer.reset();
  teacherPeer.reset();

  assert.equal((await request.post('/api/internal/portal-students/resync').send({ mode: 'all' })).status, 401);
  const key = { 'X-Internal-Service-Key': KEY };
  assert.equal((await request.post('/api/internal/portal-students/resync').set(key).send({ mode: 'one' })).status, 422, 'one needs a number');
  assert.equal((await request.post('/api/internal/portal-students/resync').set(key).send({ mode: 'everything' })).status, 422);

  const dry = await request.post('/api/internal/portal-students/resync').set(key).send({ mode: 'all' });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.ok(dry.body.data.total >= 1);
  assert.equal(adminPeer.state.puts.length, 0, 'a dry run sends nothing');

  const one = await request.post('/api/internal/portal-students/resync').set(key).send({ mode: 'one', enrollmentNumber: number.toLowerCase(), apply: true });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.data.status, 'synced');
  assert.equal(adminPeer.state.records.get(s.userId).fullName, 'Aarav Sharma');

  let cursor = null;
  let pages = 0;
  do {
    const page = await request.post('/api/internal/portal-students/resync').set(key).send({ mode: 'all', apply: true, limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    cursor = page.body.data.nextCursor;
    pages += 1;
  } while (cursor && pages < 50);
  assert.ok(pages > 1, 'paged');
  assert.ok(adminPeer.state.records.has(s.userId));
  assert.equal(adminPeer.state.records.size, await Enrollment.distinct('userId').then((ids) => ids.length), 'every enrolled student, once each');
});
