import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp, registerAndLogin, bearer } from './helpers/testApp.js';

/**
 * The parts of course videos that only show up over time or under contention:
 * module introduction videos, two editors on the same video, YouTube changing
 * its answer after a save, YouTube being slow or rate-limiting, and a lesson
 * marked complete twice.
 */

const KEY = { 'X-Internal-Service-Key': 'test_internal_key' };
const ID_A = 'dQw4w9WgXcQ';
const ID_B = 'M7lc1UVf-VE';
const ID_PRIVATE = 'kYLlKasNbuk';
const ID_NOEMBED = 'NoEmbed0001';

let ctx;
let request;
let Course;
let Enrollment;
let LessonProgress;
let service;
let student;
let course;
let yt; // per-test stand-in for YouTube
let calls;

before(async () => {
  ctx = await bootTestApp();
  request = ctx.request;
  ({ Course } = await import('../src/models/Course.js'));
  ({ Enrollment } = await import('../src/models/Enrollment.js'));
  ({ LessonProgress } = await import('../src/models/LessonProgress.js'));
  service = await import('../src/services/lessonVideo.service.js');

  course = await Course.create({
    slug: 'garud',
    title: 'GARUD',
    priceInPaise: 0,
    isPublished: true,
    pillar: 'compute',
    modules: [
      { moduleId: 'g-mod-1', title: 'Flight', order: 1, lessons: [{ lessonId: 'g-1', title: 'Lift', order: 1 }, { lessonId: 'g-2', title: 'Drag', order: 2 }] },
      { moduleId: 'g-mod-2', title: 'Navigation', order: 2, lessons: [{ lessonId: 'g-3', title: 'Maps', order: 1 }] },
    ],
  });
  student = await registerAndLogin(request, { name: 'Resilience Student', email: `res.${Date.now()}@example.com`, completeProfile: true });
  await Enrollment.create({ userId: student.user.id || student.user._id, courseId: course._id, status: 'active', enrollmentId: 'ENR-2026-990101' });
});

after(async () => {
  service.setOembedFetcherForTests(null);
  await ctx.teardown();
});

beforeEach(() => {
  calls = [];
  // Mirrors what YouTube actually answered when checked live (see the
  // service's comment): 200 public, 403 + thumbnail 404 for a private video,
  // 401 + thumbnail 200 for a public video with embedding disabled.
  yt = async (id) => {
    calls.push(id);
    if (id === ID_PRIVATE) return { status: 403, body: null, thumbnailStatus: 404 };
    if (id === ID_NOEMBED) return { status: 401, body: null, thumbnailStatus: 200 };
    return { status: 200, body: { title: `Title ${id}` } };
  };
  service.setOembedFetcherForTests((id) => yt(id));
});

const putLesson = (lessonId, body) => request.put(`/api/internal/lesson-videos/courses/garud/lessons/${lessonId}`).set(KEY).send(body);
const putModule = (moduleId, body) => request.put(`/api/internal/lesson-videos/courses/garud/modules/${moduleId}`).set(KEY).send(body);
const delModule = (moduleId, body = {}) => request.delete(`/api/internal/lesson-videos/courses/garud/modules/${moduleId}`).set(KEY).send(body);
const view = async () => (await request.get('/api/student/courses/garud/content').set(bearer(student.accessToken))).body.data;
const code = (res) => res.body.error?.code || res.body.code;

// --- Module introduction videos -------------------------------------------

test('a module gets its own introduction video, published separately from its lessons', async () => {
  const draft = await putModule('g-mod-1', { url: `https://youtu.be/${ID_A}`, title: 'Welcome to Flight' });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.equal(draft.body.data.moduleId, 'g-mod-1');
  assert.equal((await view()).modules[0].video, null, 'a module draft is not sent');

  await putModule('g-mod-1', { url: `https://youtu.be/${ID_A}`, title: 'Welcome to Flight', isPublished: true });
  const v = await view();
  assert.equal(v.modules[0].video.videoId, ID_A);
  assert.equal(v.modules[0].video.title, 'Welcome to Flight');
  assert.equal(v.modules[1].video, null);
  assert.ok(v.modules[0].lessons.every((l) => l.video === null), 'lessons are untouched by a module video');

  const editor = await request.get('/api/internal/lesson-videos/courses/garud').set(KEY);
  assert.equal(editor.body.data.modules[0].video.isPublished, true);
  const cat = await request.get('/api/internal/lesson-videos/courses?slugs=garud').set(KEY);
  assert.equal(cat.body.data[0].moduleVideoCount, 1);
});

test('a module video is removed without touching the module or its lessons', async () => {
  const res = await delModule('g-mod-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.removed, true);
  const stored = (await Course.findOne({ slug: 'garud' }).lean()).modules[0];
  assert.equal(stored.video, undefined);
  assert.equal(stored.title, 'Flight');
  assert.deepEqual(stored.lessons.map((l) => l.lessonId), ['g-1', 'g-2']);
  assert.equal((await delModule('g-mod-1')).body.data.removed, false);
});

test('unknown module is a 404', async () => {
  const res = await putModule('nope', { url: `https://youtu.be/${ID_A}` });
  assert.equal(res.status, 404);
  assert.equal(code(res), 'MODULE_NOT_FOUND');
});

// --- Two editors, one video -------------------------------------------------

test('a save based on an outdated version is refused with the current one, not applied', async () => {
  // Editor 1 creates it, expecting there to be no video yet.
  const first = await putLesson('g-1', { url: `https://youtu.be/${ID_A}`, title: 'v1', expectedUpdatedAt: null, actor: { portal: 'admin', name: 'Admin One' } });
  assert.equal(first.status, 200);
  const v1 = first.body.data.video.updatedAt;

  // Editor 2 also opened the lesson when it had no video.
  const stale = await putLesson('g-1', { url: `https://youtu.be/${ID_B}`, title: 'other', expectedUpdatedAt: null });
  assert.equal(stale.status, 409);
  assert.equal(code(stale), 'VIDEO_CHANGED');
  assert.match(stale.body.error?.message || stale.body.message, /changed by Admin One/);
  assert.equal(stale.body.error?.details?.current?.title, 'v1');

  // Editor 1 saves again from the version they hold - accepted.
  const second = await putLesson('g-1', { url: `https://youtu.be/${ID_A}`, title: 'v2', expectedUpdatedAt: v1 });
  assert.equal(second.status, 200);

  // Re-using v1 now is stale too.
  const again = await putLesson('g-1', { url: `https://youtu.be/${ID_A}`, title: 'v3', expectedUpdatedAt: v1 });
  assert.equal(again.status, 409);

  const stored = (await Course.findOne({ slug: 'garud' }).lean()).modules[0].lessons[0].video;
  assert.equal(stored.title, 'v2');
  assert.equal(stored.videoId, ID_A);
});

test('a stale remove is refused too; omitting the version keeps the old behaviour', async () => {
  const res = await request
    .delete('/api/internal/lesson-videos/courses/garud/lessons/g-1')
    .set(KEY)
    .send({ expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(res.status, 409);
  assert.ok((await Course.findOne({ slug: 'garud' }).lean()).modules[0].lessons[0].video);

  const unchecked = await putLesson('g-1', { url: `https://youtu.be/${ID_B}`, title: 'unchecked' });
  assert.equal(unchecked.status, 200);
});

test('a malformed version is a validation error', async () => {
  const res = await putLesson('g-1', { url: `https://youtu.be/${ID_A}`, expectedUpdatedAt: 'yesterday' });
  assert.equal(res.status, 422);
});

// --- What YouTube says ------------------------------------------------------

test('a private or removed video (403, no thumbnail) is unavailable and cannot be published', async () => {
  const insp = await request.post('/api/internal/lesson-videos/inspect').set(KEY).send({ url: `https://youtu.be/${ID_PRIVATE}` });
  assert.equal(insp.body.data.availability, 'unavailable');
  const pub = await putLesson('g-2', { url: `https://youtu.be/${ID_PRIVATE}`, isPublished: true });
  assert.equal(pub.status, 422);
  assert.equal(code(pub), 'VIDEO_UNAVAILABLE');
});

test('a public video with embedding disabled (401, thumbnail present) is restricted but publishable', async () => {
  const pub = await putLesson('g-2', { url: `https://youtu.be/${ID_NOEMBED}`, isPublished: true });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.data.video.availability, 'restricted');
  const lesson = (await view()).modules[0].lessons[1];
  assert.equal(lesson.video.embeddable, false);
});

test('401/403 with an unknown thumbnail answer is treated as restricted, not unavailable', async () => {
  yt = async () => ({ status: 403, body: null, thumbnailStatus: undefined });
  const insp = await request.post('/api/internal/lesson-videos/inspect').set(KEY).send({ url: `https://youtu.be/${'D'.repeat(11)}` });
  assert.equal(insp.body.data.availability, 'restricted');
});

test('timeouts, network errors and 5xx are "unknown" and never block a save', async () => {
  for (const failure of [
    async () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    },
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => ({ status: 503, body: null }),
  ]) {
    yt = failure;
    const insp = await request.post('/api/internal/lesson-videos/inspect').set(KEY).send({ url: `https://youtu.be/${'E'.repeat(11)}` });
    assert.equal(insp.status, 200);
    assert.equal(insp.body.data.availability, 'unknown');
  }
  const save = await putLesson('g-3', { url: `https://youtu.be/${'E'.repeat(11)}`, isPublished: true });
  assert.equal(save.status, 200);
  assert.equal(save.body.data.video.availability, 'unknown');
});

test('a 429 pauses checking instead of hammering YouTube', async () => {
  yt = async (id) => {
    calls.push(id);
    return { status: 429, body: null };
  };
  const first = await request.post('/api/internal/lesson-videos/inspect').set(KEY).send({ url: `https://youtu.be/${'F'.repeat(11)}` });
  assert.equal(first.body.data.availability, 'unknown');
  const second = await request.post('/api/internal/lesson-videos/inspect').set(KEY).send({ url: `https://youtu.be/${'G'.repeat(11)}` });
  assert.equal(second.body.data.availability, 'unknown');
  assert.equal(calls.length, 1, 'no further request while paused');
  // Saving still works during the pause.
  assert.equal((await putLesson('g-3', { url: `https://youtu.be/${'G'.repeat(11)}`, isPublished: true })).status, 200);
});

// --- Re-checking after the fact --------------------------------------------

test('the re-check notices a video that was made private, without unpublishing it or clobbering edits', async () => {
  await putLesson('g-3', { url: `https://youtu.be/${ID_B}`, title: 'Maps', isPublished: true });
  // The owner later makes it private; YouTube now answers 403 with no thumbnail.
  yt = async (id) => (id === ID_B ? { status: 403, body: null, thumbnailStatus: 404 } : { status: 200, body: { title: 't' } });

  const fresh = await service.revalidatePublishedVideos({ staleAfterMs: 60 * 60 * 1000 });
  assert.equal(fresh.checked, 0, 'recently checked videos are left alone');

  const res = await service.revalidatePublishedVideos({ staleAfterMs: 0 });
  assert.ok(res.checked >= 1);
  assert.ok(res.changed >= 1);
  const stored = (await Course.findOne({ slug: 'garud' }).lean()).modules[1].lessons[0].video;
  assert.equal(stored.availability, 'unavailable');
  assert.equal(stored.isPublished, true, 'never unpublished automatically');
  assert.equal(stored.title, 'Maps');
});

test('the re-check leaves a record alone when YouTube gives no definite answer', async () => {
  const before = (await Course.findOne({ slug: 'garud' }).lean()).modules[1].lessons[0].video;
  yt = async () => {
    throw new TypeError('fetch failed');
  };
  await service.revalidatePublishedVideos({ staleAfterMs: 0 });
  const after = (await Course.findOne({ slug: 'garud' }).lean()).modules[1].lessons[0].video;
  assert.deepEqual(after, before);
});

test('the re-check does nothing when checks are disabled', async () => {
  service.setOembedFetcherForTests(null);
  const res = await service.revalidatePublishedVideos({ staleAfterMs: 0 });
  assert.equal(res.skipped, 'CHECKS_DISABLED');
});

// --- Completion timestamps ---------------------------------------------------

test('marking a lesson complete twice keeps the original completion time', async () => {
  const userId = student.user.id || student.user._id;
  const first = await request.post('/api/student/courses/lessons/g-1/progress').set(bearer(student.accessToken));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const original = (await LessonProgress.findOne({ userId, lessonId: 'g-1' }).lean()).completedAt;
  await new Promise((r) => setTimeout(r, 1100));
  const second = await request.post('/api/student/courses/lessons/g-1/progress').set(bearer(student.accessToken));
  assert.equal(second.body.data.xpAwarded, 0);
  const after = (await LessonProgress.findOne({ userId, lessonId: 'g-1' }).lean()).completedAt;
  assert.equal(after.getTime(), original.getTime());
});
