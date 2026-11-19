import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp, registerAndLogin, bearer } from './helpers/testApp.js';

/**
 * Backward compatibility of course videos on a production-shaped database.
 *
 * The catalogue is built the way production's was: PRARAMBH in the shape
 * src/seed/seed.js gives it (thirteen lessons, the capstone locked, every
 * lesson on the hosted /PRARAMBH.mp4), and GARUD and YODDHA by the real
 * journey and curriculum seeders - eighteen modules each, with their quizzes,
 * final assessments and assignments. Real students then enrol, complete
 * lessons and earn XP through the real endpoints.
 *
 * Everything is snapshotted, then every kind of video operation is run across
 * all three courses - lesson and module videos, drafts, publishes, URL changes,
 * unpublishes, removals, a refused stale save and a re-check pass - and the
 * snapshot is compared again. The only differences allowed are the videos
 * themselves and the hosted file a removal is documented to clear.
 */

const KEY = { 'X-Internal-Service-Key': 'test_internal_key' };
const IDS = ['dQw4w9WgXcQ', 'M7lc1UVf-VE', 'aqz-KE-bpKQ', 'ScMzIvxBSi4'];

let ctx;
let request;
let M; // models
let lessonVideo;
const students = [];
const removedLessons = new Set();

const PRARAMBH_MODULES = [
  ['mod-1', 'Module 1: Orientation & Foundations', [['l-1', '1.1 The Awakening'], ['l-2', '1.2 Learning Archetype'], ['l-3', '1.3 The 3 Pillars']]],
  ['mod-2', 'Module 2: Mindset & Self Growth', [['l-4', '2.1 Self-Doubt'], ['l-5', '2.2 Growth Mindset'], ['l-6', '2.3 Resilience']]],
  ['mod-3', 'Module 3: Communication Mastery', [['l-7', '3.1 Vocal Presence'], ['l-8', '3.2 Storytelling'], ['l-9', '3.3 Active Listening']]],
  ['mod-4', 'Module 4: Goal Setting & Productivity', [['l-10', '4.1 Vision Blueprint'], ['l-11', '4.2 Deep Work']]],
  ['mod-5', 'Module 5: Real-World Projects & Capstone', [['l-12', '5.1 Brainstorming', true], ['l-13', '5.2 Capstone Showcase', true]]],
].map(([moduleId, title, lessons], i) => ({
  moduleId,
  title,
  order: i + 1,
  lessons: lessons.map(([lessonId, t, isLocked], j) => ({ lessonId, title: t, duration: '20 mins', order: j + 1, videoUrl: '/PRARAMBH.mp4', isLocked: Boolean(isLocked) })),
}));

before(async () => {
  ctx = await bootTestApp();
  request = ctx.request;
  const load = async (name) => (await import(`../src/models/${name}.js`))[name];
  M = {};
  for (const n of ['Course', 'Enrollment', 'LessonProgress', 'XPEvent', 'ProgressionEvent', 'StudentProfile', 'Quiz', 'Task', 'Subject', 'Stage', 'Achievement']) M[n] = await load(n);
  lessonVideo = await import('../src/services/lessonVideo.service.js');
  lessonVideo.setOembedFetcherForTests(async (id) => ({ status: 200, body: { title: `YT ${id}` } }));

  const { DEFAULT_SUBJECTS } = await import('../src/models/Subject.js');
  const { DEFAULT_STAGES } = await import('../src/models/Stage.js');
  const { DEFAULT_ACHIEVEMENTS } = await import('../src/models/Achievement.js');
  await M.Subject.insertMany(DEFAULT_SUBJECTS.map((s) => ({ ...s })));
  await M.Achievement.insertMany(DEFAULT_ACHIEVEMENTS.map((a) => ({ ...a })));
  await M.Stage.insertMany(DEFAULT_STAGES.map((s) => ({ ...s })));

  await M.Course.create({
    slug: 'prarambh',
    title: 'PRARAMBH — The Awakening',
    description: 'Foundation',
    priceInPaise: 500000,
    isPublished: true,
    isPurchasable: true,
    pillar: 'communicate',
    videoUrl: '/PRARAMBH.mp4',
    modules: PRARAMBH_MODULES,
  });
  const journey = await import('../src/services/progression/journey.service.js');
  const curriculum = await import('../src/services/progression/curriculum.service.js');
  await journey.setupJourney({ apply: true });
  await curriculum.seedCurriculum({ apply: true });

  // Three students across the three courses, with real completions and XP.
  const courses = await M.Course.find({ slug: { $in: ['prarambh', 'garud', 'yoddha'] } }).lean();
  for (let i = 0; i < 3; i += 1) {
    const s = await registerAndLogin(request, { name: `Compat Student ${'ABC'[i]}`, email: `compat.${i}.${Date.now()}@example.com`, completeProfile: true });
    const userId = s.user.id || s.user._id;
    for (const c of courses) await M.Enrollment.create({ userId, courseId: c._id, status: 'active', enrollmentId: `ENR-2026-97${i}${c.slug.length}0${i}` });
    students.push({ ...s, userId });
    for (const c of courses) {
      const lessons = c.modules.flatMap((m) => m.lessons).filter((l) => !l.isLocked).slice(0, 2 + i);
      for (const l of lessons) {
        const r = await request.post(`/api/student/courses/lessons/${l.lessonId}/progress`).set(bearer(s.accessToken));
        assert.equal(r.status, 200, `${c.slug}/${l.lessonId}: ${JSON.stringify(r.body)}`);
      }
    }
  }
});

after(async () => {
  lessonVideo.setOembedFetcherForTests(null);
  await ctx.teardown();
});

/** Paths at which two JSON values differ (first few), so a failure names what changed. */
function diffPaths(a, b, path = '$', out = []) {
  if (out.length >= 8) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out);
  } else {
    out.push(`${path}: ${JSON.stringify(b)?.slice(0, 80)} -> ${JSON.stringify(a)?.slice(0, 80)}`);
  }
  return out;
}
const same = (actual, expected, what) => assert.deepEqual(diffPaths(actual, expected), [], what);

const strip = (obj, keys) => JSON.parse(JSON.stringify(obj, (k, v) => (keys.includes(k) ? undefined : v)));

async function snapshot() {
  const courses = await M.Course.find({ slug: { $in: ['prarambh', 'garud', 'yoddha'] } }).sort({ slug: 1 }).lean();
  const structure = courses.map((c) => ({
    ...strip(c, ['video', 'updatedAt', '__v']),
    modules: c.modules.map((m) => ({
      ...strip(m, ['video', 'lessons']),
      lessons: m.lessons.map((l) => strip(l, ['video'])),
    })),
  }));
  const views = [];
  for (const s of students) {
    for (const slug of ['garud', 'prarambh', 'yoddha']) {
      const r = await request.get(`/api/student/courses/${slug}/content`).set(bearer(s.accessToken));
      assert.equal(r.status, 200);
      views.push(strip({ ...r.body.data, modules: r.body.data.modules.map((m) => ({ ...m, lessons: m.lessons })) }, ['video', 'videoUrl', 'videoManaged']));
    }
  }
  const byId = (rows) => rows.map((r) => strip(r, ['__v'])).sort((a, b) => String(a._id).localeCompare(String(b._id)));
  return {
    structure,
    views,
    progress: byId(await M.LessonProgress.find({}).lean()),
    xp: byId(await M.XPEvent.find({}).lean()),
    progression: byId(await M.ProgressionEvent.find({}).lean()),
    profiles: byId(await M.StudentProfile.find({}).lean()).map((p) => strip(p, ['updatedAt'])),
    enrollments: byId(await M.Enrollment.find({}).lean()).map((e) => strip(e, ['updatedAt'])),
    quizzes: byId(await M.Quiz.find({}).lean()),
    tasks: byId(await M.Task.find({}).lean()),
  };
}

let baseline;

test('the production-shaped catalogue is in place, with progress and XP to protect', async () => {
  baseline = await snapshot();
  const counts = Object.fromEntries(baseline.structure.map((c) => [c.slug, { modules: c.modules.length, lessons: c.modules.flatMap((m) => m.lessons).length }]));
  assert.equal(counts.prarambh.lessons, 13);
  assert.equal(counts.garud.modules, 18);
  assert.equal(counts.yoddha.modules, 18);
  assert.ok(baseline.progress.length >= 18, `progress rows: ${baseline.progress.length}`);
  assert.ok(baseline.xp.length >= 18, `xp events: ${baseline.xp.length}`);
  assert.ok(baseline.quizzes.length >= 6 && baseline.tasks.length >= 16);
  // Lessons nobody has given a video behave exactly as before: PRARAMBH keeps
  // its hosted file, GARUD and YODDHA have none, and nobody sees a video object.
  const view = (await request.get('/api/student/courses/prarambh/content').set(bearer(students[0].accessToken))).body.data;
  assert.ok(view.modules.flatMap((m) => m.lessons).every((l) => l.videoUrl === '/PRARAMBH.mp4' && l.video === null && l.videoManaged === false));
  assert.equal(view.videoUrl, '/PRARAMBH.mp4');
});

test('every kind of video operation across all three courses changes nothing but videos', async () => {
  const put = (slug, kind, id, body) => request.put(`/api/internal/lesson-videos/courses/${slug}/${kind}/${id}`).set(KEY).send(body);
  const del = (slug, kind, id) => request.delete(`/api/internal/lesson-videos/courses/${slug}/${kind}/${id}`).set(KEY).send({ actor: { portal: 'admin', userId: 'compat' } });

  const courses = await M.Course.find({ slug: { $in: ['prarambh', 'garud', 'yoddha'] } }).lean();
  let n = 0;
  for (const c of courses) {
    for (const [mi, m] of c.modules.entries()) {
      const vid = () => IDS[n++ % IDS.length];
      if (mi % 3 === 0) assert.equal((await put(c.slug, 'modules', m.moduleId, { url: `https://youtu.be/${vid()}`, isPublished: true })).status, 200);
      for (const [li, l] of m.lessons.entries()) {
        if (li > 1) continue;
        const first = await put(c.slug, 'lessons', l.lessonId, { url: `https://www.youtube.com/watch?v=${vid()}`, isPublished: li === 0, expectedUpdatedAt: null });
        assert.equal(first.status, 200, JSON.stringify(first.body));
        // A second editor working from the same empty state is refused.
        assert.equal((await put(c.slug, 'lessons', l.lessonId, { url: `https://youtu.be/${vid()}`, expectedUpdatedAt: null })).status, 409);
        // The URL changes and it is (re)published.
        assert.equal(
          (await put(c.slug, 'lessons', l.lessonId, { url: `https://youtu.be/${vid()}`, isPublished: true, expectedUpdatedAt: first.body.data.video.updatedAt })).status,
          200
        );
      }
      if (mi % 4 === 1 && m.lessons[0]) {
        assert.equal((await put(c.slug, 'lessons', m.lessons[0].lessonId, { url: `https://youtu.be/${IDS[0]}`, isPublished: false })).status, 200);
      }
      if (mi % 5 === 2 && m.lessons[1]) {
        assert.equal((await del(c.slug, 'lessons', m.lessons[1].lessonId)).status, 200);
        removedLessons.add(m.lessons[1].lessonId);
      }
      if (mi % 6 === 3) assert.equal((await del(c.slug, 'modules', m.moduleId)).status, 200);
    }
  }
  await lessonVideo.revalidatePublishedVideos({ staleAfterMs: 0, limit: 500 });

  const now = await snapshot();
  // A removal clears that lesson's hosted file by design (checked in the next
  // test), so that one field is set aside on both sides before comparing.
  const withoutRemoved = (structure) =>
    structure.map((c) => ({
      ...c,
      modules: c.modules.map((m) => ({ ...m, lessons: m.lessons.map((l) => (removedLessons.has(l.lessonId) ? strip(l, ['videoUrl']) : l)) })),
    }));
  same(withoutRemoved(now.structure), withoutRemoved(baseline.structure), 'course, module and lesson fields (ids, order, titles, content, locks, subjects) are unchanged');
  same(now.progress, baseline.progress, 'every completion and its timestamp is unchanged');
  same(now.xp, baseline.xp, 'no XP was awarded or removed');
  same(now.progression, baseline.progression, 'no progression event was recorded');
  same(now.profiles, baseline.profiles, 'student profiles (XP totals, stats) are unchanged');
  same(now.enrollments, baseline.enrollments, 'enrolments and progress percentages are unchanged');
  same(now.quizzes, baseline.quizzes, 'quizzes and final assessments are unchanged');
  same(now.tasks, baseline.tasks, 'assignments and capstone tasks are unchanged');
  same(now.views, baseline.views, 'what students see, apart from videos, is unchanged');
  assert.ok(n > 40, `operations exercised: ${n}`);
});

test('removing a video cleared only the hosted file it is documented to clear', async () => {
  const prarambh = await M.Course.findOne({ slug: 'prarambh' }).lean();
  for (const l of prarambh.modules.flatMap((m) => m.lessons)) {
    if (removedLessons.has(l.lessonId)) assert.equal(l.videoUrl, '', l.lessonId);
    else assert.equal(l.videoUrl, '/PRARAMBH.mp4', l.lessonId);
  }
});

test('students now see published videos, never drafts, and still cannot complete locked lessons', async () => {
  const s = students[0];
  for (const slug of ['prarambh', 'garud', 'yoddha']) {
    const view = (await request.get(`/api/student/courses/${slug}/content`).set(bearer(s.accessToken))).body.data;
    const stored = await M.Course.findOne({ slug }).lean();
    for (const m of stored.modules) {
      const vm = view.modules.find((x) => x.moduleId === m.moduleId);
      assert.equal(Boolean(vm.video), Boolean(m.video?.isPublished), `${slug}/${m.moduleId} intro`);
      for (const l of m.lessons) {
        const vl = vm.lessons.find((x) => x.lessonId === l.lessonId);
        if (l.video?.isPublished) assert.equal(vl.video.videoId, l.video.videoId, `${slug}/${l.lessonId}`);
        if (l.video && !l.video.isPublished) assert.equal(vl.video, null, `${slug}/${l.lessonId} draft must be hidden`);
      }
    }
  }
  const locked = await request.post('/api/student/courses/lessons/l-12/progress').set(bearer(s.accessToken));
  assert.equal(locked.status, 403);
});
