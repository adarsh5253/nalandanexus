import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bootTestApp } from './helpers/testApp.js';

/**
 * The faculty the About page introduces.
 *
 * The admin portal owns teacher identity and publishes the public part of it
 * here; this service only stores and serves it. So what matters is that a
 * profile delivered twice updates one record, that anybody may read the list
 * without a session, and that nothing which is not public can get into the
 * collection even if the sender includes it.
 */

let ctx;
let request;
let Faculty;

const KEY = { 'X-Internal-Service-Key': 'test_internal_key' };
const uniq = () => crypto.randomBytes(4).toString('hex');

before(async () => {
  ctx = await bootTestApp();
  request = ctx.request;
  ({ Faculty } = await import('../src/models/Faculty.js'));
  await Faculty.init();
});

after(async () => {
  await ctx.teardown();
});

const profile = (overrides = {}) => ({
  sourceId: `teacher-${uniq()}`,
  name: 'Sneha',
  role: 'Communication Specialist',
  category: 'Communication',
  expertise: ['Content Writer', 'Script Writer'],
  experience: '5 years of national and international experience.',
  avatar: null,
  order: 1,
  ...overrides,
});

const publish = (body, headers = KEY) => request.post('/api/internal/faculty').set(headers).send(body);
const retract = (sourceId, headers = KEY) => request.delete(`/api/internal/faculty/${sourceId}`).set(headers);
const publicList = () => request.get('/api/public/faculty');

test('a published profile appears on the public list, with the institution\'s own wording', async () => {
  const body = profile();
  const res = await publish(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const list = await publicList();
  assert.equal(list.status, 200, 'the About page is public: no session needed');
  const found = (list.body.data || []).find((f) => f.name === 'Sneha');
  assert.ok(found, 'the published profile is served');
  assert.equal(found.role, 'Communication Specialist');
  assert.equal(found.category, 'Communication');
  assert.deepEqual(found.expertise, ['Content Writer', 'Script Writer']);
  assert.equal(found.experience, '5 years of national and international experience.');
});

test('delivering the same profile twice updates one record', async () => {
  const body = profile({ name: 'Tanay', role: 'Cyber Specialist', category: 'Cyber Security', expertise: ['Red Hat Hacker', 'Among Top 2% Worldwide'], experience: null });
  assert.equal((await publish(body)).status, 201);
  assert.equal((await publish({ ...body, role: 'Cyber Security Specialist' })).status, 201);

  assert.equal(await Faculty.countDocuments({ sourceId: body.sourceId }), 1);
  const stored = await Faculty.findOne({ sourceId: body.sourceId }).lean();
  assert.equal(stored.role, 'Cyber Security Specialist', 'the newest wording stands');
  assert.deepEqual(stored.expertise, ['Red Hat Hacker', 'Among Top 2% Worldwide']);
});

test('nothing but public fields can enter the collection', async () => {
  const body = { ...profile({ name: 'Private Fields' }), email: 'teacher@example.com', phone: '+919876543210', passwordHash: 'x', status: 'ACTIVE' };
  assert.equal((await publish(body)).status, 201);

  const stored = await Faculty.findOne({ sourceId: body.sourceId }).lean();
  for (const field of ['email', 'phone', 'passwordHash', 'status']) {
    assert.equal(field in stored, false, `${field} must never be stored on a public profile`);
  }

  const found = (await publicList()).body.data.find((f) => f.name === 'Private Fields');
  assert.deepEqual(Object.keys(found).sort(), ['avatar', 'category', 'experience', 'expertise', 'id', 'name', 'order', 'role']);
});

test('only the admin portal may publish, and only a well-formed profile', async () => {
  assert.equal((await publish(profile(), {})).status, 401);
  assert.equal((await retract('whatever', {})).status, 401);

  assert.equal((await publish({ ...profile(), name: '' })).status, 422);
  assert.equal((await publish({ name: 'No Source Id' })).status, 422);
  assert.equal((await publish({ ...profile(), expertise: Array.from({ length: 20 }, (_, i) => `Skill ${i}`) })).status, 422);
  assert.equal((await publish({ ...profile(), order: 'first' })).status, 422);
});

test('withdrawing removes it from the page, and withdrawing again is still a success', async () => {
  const body = profile({ name: `Temporary ${uniq()}` });
  await publish(body);
  assert.ok((await publicList()).body.data.some((f) => f.name === body.name));

  const first = await retract(body.sourceId);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((await publicList()).body.data.some((f) => f.name === body.name), false);

  const second = await retract(body.sourceId);
  assert.equal(second.status, 200, 'idempotent: the admin portal withdraws on every change');
  assert.match(second.body.message, /Already removed/);
});

test('the list is served in the institution\'s order', async () => {
  await Faculty.deleteMany({});
  await publish(profile({ name: 'Third', order: 3 }));
  await publish(profile({ name: 'First', order: 1 }));
  await publish(profile({ name: 'Second', order: 2 }));

  const names = (await publicList()).body.data.map((f) => f.name);
  assert.deepEqual(names, ['First', 'Second', 'Third']);
});
