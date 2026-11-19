import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Publishing a teacher's public profile to the student site.
 *
 * This portal owns teacher identity, so the student site must learn about an
 * instructor from here rather than from hardcoded frontend data. These tests
 * run the real service path - create, edit, suspend, reactivate, delete - with
 * a stand-in student portal recording what actually left this service, which is
 * the only way to prove that contact details never do.
 */

let mongod;
let peer;
let peerState;
let Teacher;
let service;

const actor = { _id: '64b000000000000000000001', name: 'QA Admin', role: 'SUPER_ADMIN' };
const req = { ip: '127.0.0.1', headers: {} };
const uniq = () => crypto.randomBytes(4).toString('hex');

before(async () => {
  peerState = { calls: [], status: 201 };
  peer = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (c) => (raw += c));
    request.on('end', () => {
      peerState.calls.push({
        method: request.method,
        url: request.url,
        key: request.headers['x-internal-service-key'],
        raw,
        body: raw ? JSON.parse(raw) : null,
      });
      response.writeHead(peerState.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: peerState.status < 400, data: null }));
    });
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));

  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test_faculty_secret';
  process.env.CLIENT_URL = 'http://localhost:5175';
  process.env.STUDENT_BACKEND_URL = `http://127.0.0.1:${peer.address().port}`;
  process.env.STUDENT_BACKEND_SERVICE_KEY = 'faculty_key';
  // Teacher-portal provisioning is a separate concern; point it nowhere so the
  // tests exercise faculty publishing without depending on it.
  process.env.TEACHER_BACKEND_URL = 'http://127.0.0.1:1';
  process.env.TEACHER_BACKEND_SERVICE_KEY = 'unused';
  process.env.SENDGRID_API_KEY = 'unused-in-tests';

  const { connectDatabase } = await import('../src/config/db.js');
  await connectDatabase();
  ({ Teacher } = await import('../src/models/Teacher.js'));
  service = await import('../src/services/teacher.service.js');
});

after(async () => {
  await new Promise((r) => peer.close(r));
  const mongoose = (await import('mongoose')).default;
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(() => {
  peerState.calls = [];
  peerState.status = 201;
});

const facultyCalls = () => peerState.calls.filter((c) => c.url.startsWith('/api/internal/faculty'));

const sneha = (overrides = {}) => ({
  name: 'Sneha',
  email: `sneha.${uniq()}@nalanda.edu`,
  showOnWebsite: true,
  websiteRole: 'Communication Specialist',
  websiteCategory: 'Communication',
  expertise: ['Content Writer', 'Script Writer'],
  experienceNote: '5 years of national and international experience.',
  ...overrides,
});

test('a teacher created with a website profile is published, in the institution\'s own words', async () => {
  const { teacher } = await service.createTeacher(sneha(), actor, req);

  const calls = facultyCalls();
  assert.equal(calls.length, 1, JSON.stringify(peerState.calls.map((c) => c.url)));
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].key, 'faculty_key', 'the bridge carries the service key');
  assert.deepEqual(calls[0].body, {
    sourceId: String(teacher._id),
    name: 'Sneha',
    role: 'Communication Specialist',
    category: 'Communication',
    expertise: ['Content Writer', 'Script Writer'],
    experience: '5 years of national and international experience.',
    avatar: null,
    order: 0,
  });

  const stored = await Teacher.findById(teacher._id).lean();
  assert.equal(stored.facultySyncStatus, 'synced');
  assert.ok(stored.facultySyncedAt);
});

test('contact details and credentials never leave this service', async () => {
  const data = sneha({ name: 'Tanay', websiteRole: 'Cyber Specialist', websiteCategory: 'Cyber Security', expertise: ['Red Hat Hacker', 'Among Top 2% Worldwide'], experienceNote: null, phone: '+919876543210' });
  await service.createTeacher(data, actor, req);

  const sent = facultyCalls()[0].raw;
  for (const secret of [data.email, '+919876543210', 'passwordHash', 'INVITED', 'teacherId']) {
    assert.equal(sent.includes(secret), false, `${secret} must not be published`);
  }
});

test('a teacher created without a website profile publishes nothing', async () => {
  await service.createTeacher({ name: 'Private Teacher', email: `private.${uniq()}@nalanda.edu`, subject: 'Mathematics' }, actor, req);
  assert.equal(facultyCalls().length, 0);
});

test('switching the profile on publishes it; switching it off withdraws it', async () => {
  const { teacher } = await service.createTeacher({ name: 'Later Public', email: `later.${uniq()}@nalanda.edu` }, actor, req);
  assert.equal(facultyCalls().length, 0);

  await service.updateTeacher(String(teacher._id), { showOnWebsite: true, websiteRole: 'Cyber Specialist', expertise: ['Red Hat Hacker'] }, actor, req);
  let calls = facultyCalls();
  assert.equal(calls.at(-1).method, 'POST');
  assert.equal(calls.at(-1).body.role, 'Cyber Specialist');

  peerState.calls = [];
  await service.updateTeacher(String(teacher._id), { showOnWebsite: false }, actor, req);
  calls = facultyCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, `/api/internal/faculty/${teacher._id}`);
});

test('suspending withdraws the profile, reactivating restores it, deleting withdraws it', async () => {
  const { teacher } = await service.createTeacher(sneha({ name: 'Cycle Teacher' }), actor, req);
  const id = String(teacher._id);

  peerState.calls = [];
  await service.suspendTeacher(id, 'Administrative review', actor, req);
  assert.deepEqual(facultyCalls().map((c) => c.method), ['DELETE'], 'a suspended teacher is never introduced on the public page');

  peerState.calls = [];
  await service.reactivateTeacher(id, actor, req);
  assert.deepEqual(facultyCalls().map((c) => c.method), ['POST']);

  peerState.calls = [];
  await service.deleteTeacher(id, actor, req);
  assert.deepEqual(facultyCalls().map((c) => c.method), ['DELETE']);
});

test('an unreachable student portal is recorded, never hidden, and never fails the admin action', async () => {
  peerState.status = 500;
  const { teacher, warnings } = await service.createTeacher(sneha({ name: 'Unlucky Timing' }), actor, req);

  assert.ok(teacher._id, 'the teacher is still created');
  assert.ok(warnings.includes('WEBSITE_PROFILE_NOT_PUBLISHED'), JSON.stringify(warnings));
  const stored = await Teacher.findById(teacher._id).lean();
  assert.equal(stored.facultySyncStatus, 'failed');
  assert.equal(stored.showOnWebsite, true, 'the intent is kept, so saving again retries it');
});
