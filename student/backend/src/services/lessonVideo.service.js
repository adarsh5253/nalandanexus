import { Course } from '../models/Course.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { stripHtml } from '../utils/sanitize.js';
import {
  parseYoutubeUrl,
  isValidYoutubeVideoId,
  youtubeEmbedUrl,
  youtubeWatchUrl,
  youtubeThumbnailUrls,
} from '../utils/youtube.js';

/**
 * Course videos: the one place a lesson's or a module's YouTube video is
 * written.
 *
 * Lessons and modules live here, inside Course.modules[] (and their
 * lessons[]), and nowhere else - the Admin and Teacher portals reach this
 * service over the service-key bridge rather than keeping a copy. Admin may
 * manage any course; the teacher portal decides which courses a teacher may
 * manage (its own CourseAccess record) and only ever forwards requests for
 * those.
 *
 * What this never touches: LessonProgress, XPEvent, ProgressionEvent,
 * Enrollment. Attaching, replacing or removing a video changes what a lesson
 * shows, not whether anyone has completed it. Every write is a targeted
 * update of one `video` path, so a concurrent edit to a lesson's title, its
 * subject or another lesson's video cannot be overwritten by this one; and an
 * editor may name the version they loaded (`expectedUpdatedAt`) so two people
 * editing the SAME video find out instead of silently overwriting each other.
 */

// --- YouTube availability (oEmbed) -----------------------------------------

/*
 * YouTube's public oEmbed endpoint needs no API key and is the documented way
 * to ask about a video without scraping its page. Observed answers (checked
 * live, 2026-11-11):
 *   200      public or unlisted, embeddable - with the title;
 *   401/403  embedding disabled OR not publicly viewable (private, removed);
 *   400/404  no such video.
 * 401/403 is ambiguous on its own, so the video's hqdefault thumbnail settles
 * it: a public video always has one, a private or removed one answers 404.
 * Anything else - 429, 5xx, a timeout, no network - is "unknown": the save
 * still goes through and the student's player keeps its Open-on-YouTube
 * fallback. A 429 also pauses checking for a minute so this service does not
 * keep knocking while YouTube is asking it to stop.
 */
const OEMBED_TIMEOUT_MS = 4000;
const OEMBED_CACHE_TTL_MS = 10 * 60 * 1000;
const OEMBED_CACHE_MAX = 500;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const oembedCache = new Map();
let pausedUntil = 0;

async function timedFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OEMBED_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function defaultOembedFetcher(videoId) {
  const target = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(youtubeWatchUrl(videoId))}`;
  const res = await timedFetch(target, { headers: { Accept: 'application/json' } });
  const body = res.ok ? await res.json().catch(() => null) : null;
  let thumbnailStatus;
  if (res.status === 401 || res.status === 403) {
    try {
      thumbnailStatus = (await timedFetch(youtubeThumbnailUrls(videoId).hq, { method: 'HEAD' })).status;
    } catch {
      thumbnailStatus = undefined;
    }
  }
  return { status: res.status, body, thumbnailStatus };
}

// Tests run without network access to YouTube; they install their own fetcher.
let oembedFetcher = process.env.NODE_ENV === 'test' ? null : defaultOembedFetcher;

/** Test seam: replaces the oEmbed transport (null disables the check). */
export function setOembedFetcherForTests(fn) {
  oembedFetcher = fn;
  oembedCache.clear();
  pausedUntil = 0;
}

const UNKNOWN = Object.freeze({ availability: 'unknown', title: null, authorName: null });

export async function checkYoutubeAvailability(videoId, { bypassCache = false } = {}) {
  if (!isValidYoutubeVideoId(videoId)) return { availability: 'unavailable', title: null, authorName: null };

  const cached = oembedCache.get(videoId);
  if (!bypassCache && cached && Date.now() - cached.at < OEMBED_CACHE_TTL_MS) return cached.result;
  if (!oembedFetcher || Date.now() < pausedUntil) return UNKNOWN;

  let result = UNKNOWN;
  try {
    const { status, body, thumbnailStatus } = await oembedFetcher(videoId);
    if (status === 200) {
      result = {
        availability: 'available',
        title: typeof body?.title === 'string' ? body.title.slice(0, 200) : null,
        authorName: typeof body?.author_name === 'string' ? body.author_name.slice(0, 120) : null,
      };
    } else if (status === 401 || status === 403) {
      result = { availability: thumbnailStatus === 404 ? 'unavailable' : 'restricted', title: null, authorName: null };
    } else if (status === 400 || status === 404) {
      result = { availability: 'unavailable', title: null, authorName: null };
    } else if (status === 429) {
      pausedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      logger.warn(`[lessonVideo] YouTube oEmbed rate-limited this service; pausing checks for ${RATE_LIMIT_COOLDOWN_MS / 1000}s`);
    }
  } catch (err) {
    logger.warn(`[lessonVideo] oEmbed check failed for ${videoId}: ${err.message}`);
  }

  // "unknown" is not cached: it describes this attempt, not the video.
  if (result.availability !== 'unknown') {
    if (oembedCache.size >= OEMBED_CACHE_MAX) oembedCache.delete(oembedCache.keys().next().value);
    oembedCache.set(videoId, { at: Date.now(), result });
  }
  return result;
}

const embeddableOf = (availability) => (availability === 'restricted' ? false : availability === 'available' ? true : null);

// --- Shapes ------------------------------------------------------------------

function derivedUrls(videoId) {
  const thumbs = youtubeThumbnailUrls(videoId);
  return {
    embedUrl: youtubeEmbedUrl(videoId),
    watchUrl: youtubeWatchUrl(videoId),
    thumbnailUrl: thumbs.hq,
    thumbnailMaxUrl: thumbs.maxres,
  };
}

/** Everything an editor needs, including draft state. Never sent to students. */
export function shapeVideoForEditor(video) {
  if (!video || !isValidYoutubeVideoId(video.videoId)) return null;
  return {
    provider: video.provider || 'youtube',
    videoId: video.videoId,
    originalUrl: video.originalUrl,
    title: video.title || '',
    description: video.description || '',
    playbackMode: video.playbackMode || 'embed',
    isPublished: Boolean(video.isPublished),
    publishedAt: video.publishedAt || null,
    availability: video.availability || 'unknown',
    embeddable: embeddableOf(video.availability),
    checkedAt: video.checkedAt || null,
    updatedAt: video.updatedAt || null,
    updatedBy: video.updatedBy?.portal ? { portal: video.updatedBy.portal, name: video.updatedBy.name || null } : null,
    ...derivedUrls(video.videoId),
  };
}

/** The student-safe projection of a published managed video. */
function publishedVideoForStudent(managed) {
  return {
    provider: 'youtube',
    videoId: managed.videoId,
    title: managed.title || '',
    description: managed.description || '',
    playbackMode: managed.playbackMode || 'embed',
    embeddable: embeddableOf(managed.availability),
    ...derivedUrls(managed.videoId),
  };
}

/**
 * What a student may see of a lesson's video.
 *
 * A managed video reaches a student only once published; a draft is not sent
 * at all, not even its id. Lessons nobody has managed keep their legacy
 * `videoUrl` - and when that legacy value is itself a YouTube link (pasted
 * before this feature existed), it is played through the same embed rather
 * than handed to a <video> tag that cannot play it.
 */
export function shapeLessonVideoForStudent(lesson) {
  const managed = lesson.video && isValidYoutubeVideoId(lesson.video.videoId) ? lesson.video : null;

  if (managed) {
    if (!managed.isPublished) return { video: null, videoUrl: '', videoManaged: true };
    return { video: publishedVideoForStudent(managed), videoUrl: '', videoManaged: true };
  }

  const legacy = lesson.videoUrl || '';
  const parsed = legacy ? parseYoutubeUrl(legacy) : null;
  if (parsed?.ok) {
    return {
      video: { provider: 'youtube', videoId: parsed.videoId, title: '', description: '', playbackMode: 'embed', embeddable: null, ...derivedUrls(parsed.videoId) },
      videoUrl: '',
      videoManaged: false,
    };
  }
  return { video: null, videoUrl: legacy, videoManaged: false };
}

/** A module's introduction video, published only; null otherwise. */
export function shapeModuleVideoForStudent(mod) {
  const managed = mod.video && isValidYoutubeVideoId(mod.video.videoId) ? mod.video : null;
  return managed?.isPublished ? publishedVideoForStudent(managed) : null;
}

// --- Reads -------------------------------------------------------------------

/** Every course with lessons, including unpublished ones (GARUD/YODDHA are not on the public catalogue's purchase path). */
export async function listVideoCatalog({ slugs } = {}) {
  const filter = slugs ? { slug: { $in: slugs } } : {};
  const courses = await Course.find(filter).select('slug title subtitle isPublished modules').sort({ createdAt: 1 }).lean();
  return courses.map((c) => {
    let lessonCount = 0;
    let videoCount = 0;
    let publishedCount = 0;
    let moduleVideoCount = 0;
    for (const m of c.modules || []) {
      if (m.video?.videoId) moduleVideoCount += 1;
      for (const l of m.lessons || []) {
        lessonCount += 1;
        if (l.video?.videoId) {
          videoCount += 1;
          if (l.video.isPublished) publishedCount += 1;
        }
      }
    }
    return {
      slug: c.slug,
      title: c.title,
      subtitle: c.subtitle || '',
      isPublished: c.isPublished !== false,
      moduleCount: (c.modules || []).length,
      lessonCount,
      videoCount,
      publishedVideoCount: publishedCount,
      moduleVideoCount,
    };
  });
}

export async function getCourseVideos(slug) {
  const course = await Course.findOne({ slug }).select('slug title isPublished modules').lean();
  if (!course) throw AppError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const modules = [...(course.modules || [])]
    .sort((a, b) => a.order - b.order)
    .map((m) => ({
      moduleId: m.moduleId,
      title: m.title,
      order: m.order,
      video: shapeVideoForEditor(m.video),
      lessons: [...(m.lessons || [])]
        .sort((a, b) => a.order - b.order)
        .map((l) => ({
          lessonId: l.lessonId,
          title: l.title,
          order: l.order,
          duration: l.duration || '',
          isPublished: l.isPublished !== false,
          isLocked: Boolean(l.isLocked),
          video: shapeVideoForEditor(l.video),
          // Shown to the editor so "Remove" is not a surprise: removing a video
          // also clears this older directly-hosted file.
          legacyVideoUrl: l.video?.videoId ? '' : l.videoUrl || '',
        })),
    }));

  return { slug: course.slug, title: course.title, isPublished: course.isPublished !== false, modules };
}

/** Parses a pasted link and asks YouTube about it, without saving anything. */
export async function inspectYoutubeLink(url) {
  const parsed = parseYoutubeUrl(url);
  if (!parsed.ok) throw AppError.unprocessable(parsed.message, parsed.code);
  const check = await checkYoutubeAvailability(parsed.videoId);
  return {
    videoId: parsed.videoId,
    canonicalUrl: parsed.canonicalUrl,
    ...derivedUrls(parsed.videoId),
    availability: check.availability,
    embeddable: embeddableOf(check.availability),
    title: check.title,
    authorName: check.authorName,
  };
}

// --- Targets -----------------------------------------------------------------

/*
 * A target is one lesson ({ lessonId }) or one module ({ moduleId }). Both are
 * located on a fresh read, then written by position-independent arrayFilters,
 * so reordering lessons between the read and the write cannot misdirect it.
 */
async function locate(slug, target) {
  const course = await Course.findOne({ slug }).select('_id slug modules.moduleId modules.video modules.lessons').lean();
  if (!course) throw AppError.notFound('Course not found', 'COURSE_NOT_FOUND');
  if (target.moduleId) {
    const mod = (course.modules || []).find((m) => m.moduleId === target.moduleId);
    if (!mod) throw AppError.notFound('Module not found in this course', 'MODULE_NOT_FOUND');
    return { course, moduleId: mod.moduleId, node: mod, label: `module ${mod.moduleId}` };
  }
  for (const m of course.modules || []) {
    const lesson = (m.lessons || []).find((l) => l.lessonId === target.lessonId);
    if (lesson) return { course, moduleId: m.moduleId, node: lesson, label: target.lessonId };
  }
  throw AppError.notFound('Lesson not found in this course', 'LESSON_NOT_FOUND');
}

function paths(target) {
  if (target.moduleId) {
    return { video: 'modules.$[m].video', videoUrl: null, arrayFilters: (moduleId) => [{ 'm.moduleId': moduleId }] };
  }
  return {
    video: 'modules.$[m].lessons.$[l].video',
    videoUrl: 'modules.$[m].lessons.$[l].videoUrl',
    arrayFilters: (moduleId) => [{ 'm.moduleId': moduleId }, { 'l.lessonId': target.lessonId }],
  };
}

/**
 * The write filter. With no `expectedUpdatedAt` it matches the course; with
 * one, it matches only while the target's video is still the version the
 * editor loaded (null meaning "had no video"). A miss is a 409, not a write.
 */
function guardFilter(courseId, moduleId, target, expectedUpdatedAt) {
  if (expectedUpdatedAt === undefined) return { _id: courseId };
  const cond =
    expectedUpdatedAt === null ? { 'video.videoId': { $exists: false } } : { 'video.updatedAt': new Date(expectedUpdatedAt) };
  if (target.moduleId) return { _id: courseId, modules: { $elemMatch: { moduleId, ...cond } } };
  return { _id: courseId, modules: { $elemMatch: { moduleId, lessons: { $elemMatch: { lessonId: target.lessonId, ...cond } } } } };
}

async function conflict(slug, target) {
  const { node } = await locate(slug, target);
  const current = shapeVideoForEditor(node.video);
  const who = current?.updatedBy?.name ? ` by ${current.updatedBy.name}` : '';
  return new AppError(
    `This video was changed${who} since you opened it. Reload to see the current version before saving.`,
    409,
    'VIDEO_CHANGED',
    { current }
  );
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Control characters (other than newlines in a description) never belong in
  // a title, and markup is stripped on the way in like every other free text.
  return stripHtml(value.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')).slice(0, max);
}

async function notifyStudents(course, target) {
  try {
    // Imported lazily, as every other caller does, so this service never
    // drags the socket server into a context that has none (scripts, tests).
    const { emitToCourse } = await import('../sockets/index.js');
    emitToCourse(course._id, 'course:content_updated', {
      courseId: String(course._id),
      slug: course.slug,
      lessonId: target.lessonId || null,
      moduleId: target.moduleId || null,
    });
  } catch {
    // The socket layer is optional; students also refetch when they return to the page.
  }
}

// --- Writes ------------------------------------------------------------------

/**
 * Creates or replaces the video on one lesson or module.
 *
 * `isPublished` is the editor's decision, but a link YouTube says is not a
 * public video is never published - students would get a dead player.
 */
export async function upsertVideo(slug, target, input, actor) {
  const parsed = parseYoutubeUrl(input.url);
  if (!parsed.ok) throw AppError.unprocessable(parsed.message, parsed.code);

  const { course, moduleId, node } = await locate(slug, target);
  const previous = node.video?.videoId ? node.video : null;

  const check = await checkYoutubeAvailability(parsed.videoId);
  // A failed check does not erase a definite earlier answer for the same video.
  const availability =
    check.availability === 'unknown' && previous?.videoId === parsed.videoId ? previous.availability || 'unknown' : check.availability;

  const isPublished = Boolean(input.isPublished);
  if (isPublished && availability === 'unavailable') {
    throw AppError.unprocessable(
      'YouTube reports that this video does not exist or is not public, so it cannot be published.',
      'VIDEO_UNAVAILABLE'
    );
  }

  const now = new Date();
  const video = {
    provider: 'youtube',
    videoId: parsed.videoId,
    originalUrl: input.url.trim().slice(0, 2048),
    title: cleanText(input.title, 200) || check.title || '',
    description: cleanText(input.description, 2000),
    playbackMode: input.playbackMode === 'external' ? 'external' : 'embed',
    isPublished,
    publishedAt: isPublished ? (previous?.isPublished && previous.publishedAt ? previous.publishedAt : now) : null,
    availability,
    checkedAt: check.availability === 'unknown' ? previous?.checkedAt || null : now,
    updatedAt: now,
    updatedBy: {
      portal: actor?.portal === 'teacher' ? 'teacher' : 'admin',
      userId: actor?.userId ? String(actor.userId).slice(0, 64) : null,
      name: actor?.name ? String(actor.name).slice(0, 120) : null,
    },
  };

  const p = paths(target);
  const result = await Course.updateOne(
    guardFilter(course._id, moduleId, target, input.expectedUpdatedAt),
    { $set: { [p.video]: video } },
    { arrayFilters: p.arrayFilters(moduleId), runValidators: true }
  );
  if (!result.matchedCount) throw await conflict(slug, target);

  const label = target.moduleId ? `module ${target.moduleId}` : target.lessonId;
  logger.info(
    `[lessonVideo] ${video.updatedBy.portal}:${video.updatedBy.userId || '?'} set ${slug}/${label} -> ${parsed.videoId} (published=${isPublished}, availability=${availability})`
  );
  await notifyStudents(course, target);

  return {
    lessonId: target.lessonId || null,
    moduleId: target.moduleId || moduleId,
    video: shapeVideoForEditor(video),
    previousVideoId: previous?.videoId || null,
    wasPublished: Boolean(previous?.isPublished),
  };
}

/**
 * Removes the video from one lesson or module. On a lesson the older
 * directly-hosted `videoUrl` goes too, so "remove" leaves the lesson without a
 * video of its own rather than quietly bringing back whatever file it had.
 */
export async function removeVideo(slug, target, actor, { expectedUpdatedAt } = {}) {
  const { course, moduleId, node } = await locate(slug, target);
  const hadVideo = Boolean(node.video?.videoId) || Boolean(!target.moduleId && node.videoUrl);
  if (!hadVideo) return { lessonId: target.lessonId || null, moduleId: target.moduleId || moduleId, removed: false, previousVideoId: null };

  const p = paths(target);
  const update = { $unset: { [p.video]: '' } };
  if (p.videoUrl) update.$set = { [p.videoUrl]: '' };
  const result = await Course.updateOne(guardFilter(course._id, moduleId, target, expectedUpdatedAt), update, {
    arrayFilters: p.arrayFilters(moduleId),
  });
  if (!result.matchedCount) throw await conflict(slug, target);

  const label = target.moduleId ? `module ${target.moduleId}` : target.lessonId;
  logger.info(`[lessonVideo] ${actor?.portal || 'admin'}:${actor?.userId || '?'} removed video from ${slug}/${label}`);
  await notifyStudents(course, target);
  return { lessonId: target.lessonId || null, moduleId: target.moduleId || moduleId, removed: true, previousVideoId: node.video?.videoId || null };
}

// Lesson-named wrappers, kept because they read naturally at the call sites.
export const upsertLessonVideo = (slug, lessonId, input, actor) => upsertVideo(slug, { lessonId }, input, actor);
export const removeLessonVideo = (slug, lessonId, actor, opts) => removeVideo(slug, { lessonId }, actor, opts);

// --- Re-validation -------------------------------------------------------------

/**
 * Re-asks YouTube about published videos whose last answer is older than
 * `staleAfterMs`, a bounded batch at a time.
 *
 * Owners change things after a video is saved - they disable embedding, make
 * it private, delete it. This keeps the stored availability (and so the
 * student's embeddable flag) close to the truth without anyone re-saving.
 *
 * It only ever changes `availability` and `checkedAt`, and only on a definite
 * answer: an unknown result leaves the record exactly as it was. It never
 * unpublishes - a video that has become unavailable is reported in the log and
 * shown to editors, who decide. Students in the meantime get the player's own
 * fallback, which reads the same flag.
 */
export async function revalidatePublishedVideos({ staleAfterMs = 24 * 60 * 60 * 1000, limit = 40 } = {}) {
  if (!oembedFetcher) return { checked: 0, changed: 0, skipped: 'CHECKS_DISABLED' };
  const cutoff = new Date(Date.now() - staleAfterMs);
  const stale = (v) => v?.videoId && v.isPublished && (!v.checkedAt || new Date(v.checkedAt) < cutoff);

  const courses = await Course.find({
    $or: [{ 'modules.video.isPublished': true }, { 'modules.lessons.video.isPublished': true }],
  })
    .select('_id slug modules.moduleId modules.video modules.lessons.lessonId modules.lessons.video')
    .lean();

  const due = [];
  for (const c of courses) {
    for (const m of c.modules || []) {
      if (stale(m.video)) due.push({ course: c, moduleId: m.moduleId, target: { moduleId: m.moduleId }, video: m.video });
      for (const l of m.lessons || []) {
        if (stale(l.video)) due.push({ course: c, moduleId: m.moduleId, target: { lessonId: l.lessonId }, video: l.video });
      }
    }
  }
  due.sort((a, b) => new Date(a.video.checkedAt || 0) - new Date(b.video.checkedAt || 0));

  let checked = 0;
  let changed = 0;
  for (const item of due.slice(0, limit)) {
    if (Date.now() < pausedUntil) break;
    const { availability } = await checkYoutubeAvailability(item.video.videoId, { bypassCache: true });
    checked += 1;
    if (availability === 'unknown') continue;

    const p = paths(item.target);
    const base = p.video;
    // Matched on the same updatedAt it was read with, so an editor's save in
    // the meantime is never overwritten by this background answer.
    const res = await Course.updateOne(
      guardFilter(item.course._id, item.moduleId, item.target, item.video.updatedAt),
      { $set: { [`${base}.availability`]: availability, [`${base}.checkedAt`]: new Date() } },
      { arrayFilters: p.arrayFilters(item.moduleId) }
    );
    if (res.modifiedCount && availability !== item.video.availability) {
      changed += 1;
      const label = item.target.moduleId ? `module ${item.target.moduleId}` : item.target.lessonId;
      logger.warn(`[lessonVideo] ${item.course.slug}/${label}: YouTube now reports "${availability}" (was "${item.video.availability}")`);
      await notifyStudents(item.course, item.target);
    }
  }
  return { checked, changed, due: due.length };
}

export default {
  listVideoCatalog,
  getCourseVideos,
  inspectYoutubeLink,
  upsertVideo,
  removeVideo,
  upsertLessonVideo,
  removeLessonVideo,
  revalidatePublishedVideos,
  shapeLessonVideoForStudent,
  shapeModuleVideoForStudent,
  shapeVideoForEditor,
  checkYoutubeAvailability,
};
