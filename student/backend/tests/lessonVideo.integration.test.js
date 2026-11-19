import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp, registerAndLogin, bearer } from './helpers/testApp.js';

/**
 * Lesson videos, end to end inside the student service: the service-key bridge
 * the Admin and Teacher portals write through, and the enrolled student's view
 * of the result.
 *
 * The properties that matter most are the ones a careless implementation would
 * break without any visible error: a draft never reaches a student, saving a
 * video never touches another lesson or another field of the same lesson, and
 * no amount of re-saving re-awards XP or undoes a completion.
 */

const KEY = { 'X-Internal-Service-Key': 'test_internal_key' };
const ID_A = 'dQw4w9WgXcQ';
const ID_B = 'M7lc1UVf-VE';
const ID_GONE = 'AAAAAAAAAAA';
const ID_NO_EMBED = 'BBBBBBBBBBB';

let ctx;
let request;
let Course;
let Enrollment;
let LessonProgress;
let XPEvent;
let lessonVideo;
let student;
let course;
const oembedCalls = [];

before(async () => {
  ctx = await bootTestApp();
  request = ctx.request;
  ({ Course } = await import('../src/models/Course.js'));
  ({ Enrollment } = await import('../src/models/Enrollment.js'));
  ({ LessonProgress } = await import('../src/models/LessonProgress.js'));
  ({ XPEvent } = await import('../src/models/XPEvent.js'));
  lessonVideo = await import('../src/services/lessonVideo.service.js');

  course = await Course.create({
    slug: 'prarambh',
    title: 'PRARAMBH',
    priceInPaise: 0,
    isPublished: true,
    pillar: 'communicate',
    videoUrl: '/PRARAMBH.mp4',
    modules: [
      {
        moduleId: 'mod-1',
        title: 'Awakening',
        order: 1,
        lessons: [
          { lessonId: 'l-1', title: 'Welcome', order: 1, videoUrl: '/PRARAMBH.mp4', summary: 'Hello', content: 'Read me' },
          { lessonId: 'l-2', title: 'Archetypes', order: 2 },
        ],
      },
      {
        moduleId: 'mod-2',
        title: 'Mindset',
        order: 2,
        lessons: [{ lessonId: 'l-3', title: 'Self-doubt', order: 1, videoUrl: `https://youtu.be/${ID_B}` }],
      },
    ],
  });
  await Course.create({ slug: 'garud', title: 'GARUD', priceInPaise: 0, isPublished: true, modules: [] });

  student = await registerAndLogin(request, { name: 'Video Student', email: `video.${Date.now()}@example.com`, completeProfile: true });
  await Enrollment.create({ userId: student.user.id || student.user._id, courseId: course._id, status: 'active', enrollmentId: 'ENR-2026-990001' });
});

after(async () => {
  lessonVideo.setOembedFetcherForTests(null);
  await ctx.teardown();
});

beforeEach(() => {
  oembedCalls.length = 0;
  // A stand-in for YouTube's oEmbed endpoint: one live video, one deleted,
  // one whose owner has disabled embedding.
  lessonVideo.setOembedFetcherForTests(async (id) => {
    oembedCalls.push(id);
    if (id === ID_GONE) return { status: 404, body: null };
    if (id === ID_NO_EMBED) return { status: 401, body: null };
    return { status: 200, body: { title: `YouTube title for ${id}`, author_name: 'Channel' } };
  });
});

const put = (slug, lessonId, body) =>
  request.put(`/api/internal/lesson-videos/courses/${slug}/lessons/${lessonId}`).set(KEY).send(body);
const del = (slug, lessonId, body = {}) =>
  request.delete(`/api/internal/lesson-videos/courses/${slug}/lessons/${lessonId}`).set(KEY).send(body);
const studentContent = async () => {
  const res = await request.get('/api/student/courses/prarambh/content').set(bearer(student.accessToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const lessonOf = (content, lessonId) => content.modules.flatMap((m) => m.lessons).find((l) => l.lessonId === lessonId);

test('the bridge refuses calls without the service key', async () => {
  const res = await request.put('/api/internal/lesson-videos/courses/prarambh/lessons/l-1').send({ url: `https://youtu.be/${ID_A}` });
  assert.equal(res.status, 401);
  const res2 = await request.get('/api/internal/lesson-videos/courses/prarambh');
  assert.equal(res2.status, 401);
});

test('inspect parses a link and reports what YouTube says, without saving', async () => {
  const res = await request.post('/api/internal/lesson-videos/inspect').set(KEY).send({ url: `https://www.youtube.com/shorts/${ID_A}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.videoId, ID_A);
  assert.equal(res.body.data.availability, 'available');
  assert.equal(res.body.data.embeddable, true);
  assert.equal(res.body.data.title, `YouTube title for ${ID_A}`);
  assert.equal(res.body.data.thumbnailUrl, `https://img.youtube.com/vi/${ID_A}/hqdefault.jpg`);
  assert.equal(res.body.data.thumbnailMaxUrl, `https://img.youtube.com/vi/${ID_A}/maxresdefault.jpg`);
  assert.equal(res.body.data.embedUrl.startsWith(`https://www.youtube-nocookie.com/embed/${ID_A}`), true);

  const bad = await request.post('/api/internal/lesson-videos/inspect').set(KEY).send({ url: 'https://vimeo.com/1' });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error?.code || bad.body.code, 'UNSUPPORTED_PROVIDER');

  const stored = await Course.findOne({ slug: 'prarambh' }).lean();
  assert.equal(stored.modules[0].lessons[0].video, undefined, 'inspect must not write');
});

test('invalid links are rejected with the parser code and nothing is written', async () => {
  for (const [url, code] of [
    ['', 'EMPTY_URL'],
    ['https://example.com/watch?v=dQw4w9WgXcQ', 'UNSUPPORTED_PROVIDER'],
    ['https://www.youtube.com/watch?v=bad', 'INVALID_VIDEO_ID'],
    ['not a url at all', 'INVALID_URL'],
  ]) {
    const res = await put('prarambh', 'l-2', { url });
    assert.equal(res.status, 422, url);
    assert.equal(res.body.error?.code || res.body.code, code, url);
  }
  const stored = await Course.findOne({ slug: 'prarambh' }).lean();
  assert.equal(stored.modules[0].lessons[1].video, undefined);
});

test('unknown course and lesson are 404s', async () => {
  assert.equal((await put('nope', 'l-1', { url: `https://youtu.be/${ID_A}` })).status, 404);
  const res = await put('prarambh', 'l-404', { url: `https://youtu.be/${ID_A}` });
  assert.equal(res.status, 404);
  assert.equal(res.body.error?.code || res.body.code, 'LESSON_NOT_FOUND');
});

test('a draft is stored with metadata but never reaches the student', async () => {
  const res = await put('prarambh', 'l-1', {
    url: `https://www.youtube.com/watch?v=${ID_A}&t=5`,
    title: '  <b>Welcome</b> to Nalanda  ',
    description: 'Intro',
    isPublished: false,
    actor: { portal: 'admin', userId: 'admin-1', name: 'Admin One' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const v = res.body.data.video;
  assert.equal(v.videoId, ID_A);
  assert.equal(v.title, 'Welcome to Nalanda', 'markup is stripped and whitespace trimmed');
  assert.equal(v.isPublished, false);
  assert.equal(v.availability, 'available');
  assert.equal(v.updatedBy.portal, 'admin');

  // Only facts are persisted - no computed URLs.
  const stored = (await Course.findOne({ slug: 'prarambh' }).lean()).modules[0].lessons[0];
  assert.equal(stored.video.videoId, ID_A);
  assert.equal(stored.video.embedUrl, undefined);
  assert.equal(stored.video.thumbnailUrl, undefined);
  // The rest of the lesson is untouched.
  assert.equal(stored.title, 'Welcome');
  assert.equal(stored.summary, 'Hello');
  assert.equal(stored.content, 'Read me');
  assert.equal(stored.videoUrl, '/PRARAMBH.mp4');

  const lesson = lessonOf(await studentContent(), 'l-1');
  assert.equal(lesson.video, null, 'a draft is not sent at all');
  assert.equal(lesson.videoManaged, true);
  assert.equal(lesson.videoUrl, '', 'a managed lesson does not fall back to its old file');
  assert.equal(JSON.stringify(lesson).includes(ID_A), false, 'not even the id of a draft leaks');
});

test('publishing makes the video visible to the enrolled student with derived URLs', async () => {
  const res = await put('prarambh', 'l-1', { url: `https://youtu.be/${ID_A}`, title: 'Welcome', isPublished: true });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.video.publishedAt);

  const lesson = lessonOf(await studentContent(), 'l-1');
  assert.equal(lesson.video.videoId, ID_A);
  assert.equal(lesson.video.title, 'Welcome');
  assert.equal(lesson.video.playbackMode, 'embed');
  assert.equal(lesson.video.embeddable, true);
  assert.equal(lesson.video.embedUrl.startsWith(`https://www.youtube-nocookie.com/embed/${ID_A}`), true);
  assert.equal(lesson.video.watchUrl, `https://www.youtube.com/watch?v=${ID_A}`);
  assert.equal(lesson.video.thumbnailUrl, `https://img.youtube.com/vi/${ID_A}/hqdefault.jpg`);
  // Editor-only fields stay with editors.
  assert.equal(lesson.video.updatedBy, undefined);
  assert.equal(lesson.video.originalUrl, undefined);
  // Other lessons are untouched.
  assert.equal(lessonOf(await studentContent(), 'l-2').video, null);
});

test('an empty title falls back to the title YouTube reports', async () => {
  const res = await put('prarambh', 'l-2', { url: `https://youtu.be/${ID_B}`, title: '', isPublished: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.video.title, `YouTube title for ${ID_B}`);
});

test('a video YouTube says does not exist can be drafted but not published', async () => {
  const pub = await put('prarambh', 'l-2', { url: `https://youtu.be/${ID_GONE}`, isPublished: true });
  assert.equal(pub.status, 422);
  assert.equal(pub.body.error?.code || pub.body.code, 'VIDEO_UNAVAILABLE');
  // The previously published video is still in place.
  assert.equal(lessonOf(await studentContent(), 'l-2').video.videoId, ID_B);

  const draft = await put('prarambh', 'l-2', { url: `https://youtu.be/${ID_GONE}`, isPublished: false });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.data.video.availability, 'unavailable');
});

test('embedding disabled is recorded and passed to the student as embeddable:false', async () => {
  const res = await put('prarambh', 'l-2', { url: `https://youtu.be/${ID_NO_EMBED}`, title: 'Restricted', isPublished: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.video.availability, 'restricted');
  const lesson = lessonOf(await studentContent(), 'l-2');
  assert.equal(lesson.video.embeddable, false);
  assert.equal(lesson.video.watchUrl, `https://www.youtube.com/watch?v=${ID_NO_EMBED}`);
});

test('an unreachable oEmbed check does not block saving, and keeps an earlier definite answer', async () => {
  lessonVideo.setOembedFetcherForTests(async () => {
    throw new Error('network down');
  });
  const res = await put('prarambh', 'l-2', { url: `https://youtu.be/${ID_NO_EMBED}`, title: 'Restricted', isPublished: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.video.availability, 'restricted', 'the earlier answer for the same video is kept');

  const other = await request.post('/api/internal/lesson-videos/inspect').set(KEY).send({ url: `https://youtu.be/${'C'.repeat(11)}` });
  assert.equal(other.body.data.availability, 'unknown');
  assert.equal(other.body.data.embeddable, null);
});

test('unpublishing hides the video again', async () => {
  const res = await put('prarambh', 'l-2', { url: `https://youtu.be/${ID_NO_EMBED}`, isPublished: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.video.publishedAt, null);
  assert.equal(lessonOf(await studentContent(), 'l-2').video, null);
});

test('a legacy YouTube videoUrl plays through the embed; a legacy file stays a file', async () => {
  const content = await studentContent();
  const legacyYt = lessonOf(content, 'l-3');
  assert.equal(legacyYt.video.videoId, ID_B);
  assert.equal(legacyYt.videoUrl, '');
  assert.equal(legacyYt.videoManaged, false);
  assert.equal(content.videoUrl, '/PRARAMBH.mp4', 'the course-level trailer is unchanged');
});

test('changing or re-saving a video never re-awards XP or resets completion', async () => {
  const done = await request.post('/api/student/courses/lessons/l-1/progress').set(bearer(student.accessToken));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.xpAwarded, 10, 'the first completion earns XP');
  const userId = student.user.id || student.user._id;
  const xpBefore = await XPEvent.countDocuments({ userId });
  const progressBefore = await LessonProgress.findOne({ userId, lessonId: 'l-1' }).lean();
  assert.equal(progressBefore.completed, true);

  // Admin swaps the URL, then a teacher re-publishes, then it is removed.
  assert.equal((await put('prarambh', 'l-1', { url: `https://youtu.be/${ID_B}`, isPublished: true })).status, 200);
  assert.equal(
    (await put('prarambh', 'l-1', { url: `https://youtu.be/${ID_A}`, isPublished: true, actor: { portal: 'teacher', userId: 't1' } })).status,
    200
  );
  let lesson = lessonOf(await studentContent(), 'l-1');
  assert.equal(lesson.video.videoId, ID_A);
  assert.equal(lesson.completed, true, 'completion survives a URL change');

  assert.equal((await del('prarambh', 'l-1', { actor: { portal: 'admin', userId: 'admin-1' } })).status, 200);
  lesson = lessonOf(await studentContent(), 'l-1');
  assert.equal(lesson.completed, true, 'completion survives removal');
  // Compared before marking again below: that endpoint (unchanged here)
  // refreshes completedAt on every call, which is not a video effect.
  const progressAfter = await LessonProgress.findOne({ userId, lessonId: 'l-1' }).lean();
  assert.equal(String(progressAfter.completedAt), String(progressBefore.completedAt), 'no video change touched the progress record');

  const again = await request.post('/api/student/courses/lessons/l-1/progress').set(bearer(student.accessToken));
  assert.equal(again.body.data.xpAwarded, 0, 'marking again awards nothing');
  assert.equal(await XPEvent.countDocuments({ userId }), xpBefore, 'no XP was awarded by any video change');
});

test('removing clears the video and the old directly-hosted file, and is idempotent', async () => {
  await put('prarambh', 'l-3', { url: `https://youtu.be/${ID_A}`, isPublished: true });
  const first = await del('prarambh', 'l-3');
  assert.equal(first.status, 200);
  assert.equal(first.body.data.removed, true);
  const stored = (await Course.findOne({ slug: 'prarambh' }).lean()).modules[1].lessons[0];
  assert.equal(stored.video, undefined);
  assert.equal(stored.videoUrl, '');
  assert.equal(stored.title, 'Self-doubt');

  const lesson = lessonOf(await studentContent(), 'l-3');
  assert.equal(lesson.video, null);
  assert.equal(lesson.videoManaged, false);

  const second = await del('prarambh', 'l-3');
  assert.equal(second.status, 200);
  assert.equal(second.body.data.removed, false);
});

test('the editor view lists every lesson with its draft state; the catalogue counts videos', async () => {
  await put('prarambh', 'l-2', { url: `https://youtu.be/${ID_B}`, isPublished: false });
  const res = await request.get('/api/internal/lesson-videos/courses/prarambh').set(KEY);
  assert.equal(res.status, 200);
  const lessons = res.body.data.modules.flatMap((m) => m.lessons);
  assert.deepEqual(lessons.map((l) => l.lessonId), ['l-1', 'l-2', 'l-3']);
  const l2 = lessons.find((l) => l.lessonId === 'l-2');
  assert.equal(l2.video.isPublished, false, 'editors see drafts');
  assert.equal(l2.video.originalUrl, `https://youtu.be/${ID_B}`);

  const cat = await request.get('/api/internal/lesson-videos/courses?slugs=prarambh').set(KEY);
  assert.equal(cat.status, 200);
  assert.equal(cat.body.data.length, 1);
  assert.equal(cat.body.data[0].lessonCount, 3);
  assert.equal(cat.body.data[0].videoCount, 1);
  assert.equal(cat.body.data[0].publishedVideoCount, 0);

  const all = await request.get('/api/internal/lesson-videos/courses').set(KEY);
  assert.deepEqual(all.body.data.map((c) => c.slug).sort(), ['garud', 'prarambh']);
});

test('a student who is not enrolled cannot read lesson videos', async () => {
  const outsider = await registerAndLogin(request, { name: 'Outsider', email: `outsider.${Date.now()}@example.com`, completeProfile: true });
  const res = await request.get('/api/student/courses/prarambh/content').set(bearer(outsider.accessToken));
  assert.equal(res.status, 403);
});
