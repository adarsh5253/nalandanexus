import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Bridges an APPROVED admin-authored course into student/backend's real
 * purchasable Course catalog — a separate service/database. Mirrors
 * studentBridge.service.js's announcement bridge exactly (shared-secret
 * auth, idempotent on sourceId), reusing the same STUDENT_BACKEND_* config.
 *
 * Non-destructive by design: this never deletes a course on the student
 * side (students may already have paid for it) — "retract" unpublishes it
 * (isPurchasable/isPublished: false) rather than removing it.
 */

function isConfigured() {
  return Boolean(env.studentBridge.url && env.studentBridge.serviceKey);
}

/**
 * Bounded retry with escalating timeouts.
 *
 * The student service sleeps on Render, and a first request after idle spends
 * 30-60s waking up. A flat 8s budget therefore turned every cold start into
 * "the Student service is unavailable" - for coupon campaign creation, the
 * campaign and coupon lists, the CSV export and course publishing alike - even
 * when the operation went on to succeed.
 *
 * This is the same shape teacherBridge.service.js already uses for the same
 * reason: three attempts, never a loop, first one short so a genuinely dead
 * peer fails fast and the later two long enough to outlast a cold start.
 *
 * Only transport failures and 5xx are retried. A 4xx is the peer answering
 * clearly - CAMPAIGN_EXISTS, COURSE_NOT_FOUND - and repeating it would just be
 * slower. That is also what keeps a retry safe after an attempt that actually
 * succeeded: the retry hits the unique index, comes back 409 CAMPAIGN_EXISTS,
 * and is returned as-is rather than being retried into a third state.
 */
const ATTEMPT_TIMEOUTS_MS = [8000, 35000, 35000];
const RETRY_BACKOFF_MS = [1000, 3000];

class BridgeError extends Error {
  constructor(message, { status = 0, retryable = false, body } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.retryable = retryable;
    // The whole response body. The message keeps a short excerpt for logs;
    // callers that unwrap a 4xx read this, so a long answer is not cut mid-JSON.
    this.body = body;
  }
}

async function attempt(path, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.studentBridge.url}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': env.studentBridge.serviceKey, ...options.headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new BridgeError(`Student backend returned ${res.status}: ${body.slice(0, 200)}`, {
        status: res.status,
        body,
        // 5xx and 429 are the peer struggling; 4xx is the peer answering.
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    return res.json();
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    // Abort (cold start outran the budget) or a network-level failure.
    throw new BridgeError(err.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : err.message, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

/** Drives one operation through the escalating budget. Shared so every call to this peer retries identically. */
async function withRetry(run, label = 'request') {
  let last;
  for (let i = 0; i < ATTEMPT_TIMEOUTS_MS.length; i += 1) {
    try {
      return await run(ATTEMPT_TIMEOUTS_MS[i]);
    } catch (err) {
      last = err;
      const more = i < ATTEMPT_TIMEOUTS_MS.length - 1;
      if (!err.retryable || !more) break;
      console.warn(`[studentCourseBridge] ${label} attempt ${i + 1} failed (${err.message}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[i]));
    }
  }
  throw last;
}

async function call(path, options) {
  return withRetry((timeoutMs) => attempt(path, options, timeoutMs), path);
}


/**
 * The live student course catalogue, read-only.
 *
 * Courses seeded natively in the student service (Prarambh among them) have no
 * record in this portal's own database - the bridge only ever runs the other
 * way, admin -> student. That is why the admin course list came back holding
 * nothing but this portal's own courses while students could see six.
 *
 * They are read here rather than copied in, so the student service stays the one
 * place a native course's price is defined. A mirrored copy would be a second
 * price to drift, and the figure the coupon screen quotes has to be the figure
 * checkout actually charges.
 *
 * Uses the public catalogue endpoint, exactly as teacher/backend does for its
 * own course picker. Never throws: an unreachable catalogue means the admin sees
 * their own courses and a flag saying the rest could not be loaded, which is
 * better than a course list that fails to render at all.
 */
export async function fetchStudentCourseCatalog() {
  if (!env.studentBridge.url) return { ok: false, reason: 'NOT_CONFIGURED', courses: [] };
  try {
    // Same escalating budget as every other call to this peer. A flat timeout
    // here meant the first admin page load after the student service went to
    // sleep showed an empty course list - which reads as "there are no courses"
    // rather than "the catalogue is still waking up".
    const body = await withRetry(async (timeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${env.studentBridge.url}/api/public/courses`, { signal: controller.signal });
        if (!res.ok) {
          throw new BridgeError(`Student catalogue returned ${res.status}`, {
            status: res.status,
            retryable: res.status >= 500 || res.status === 429,
          });
        }
        return res.json();
      } catch (err) {
        if (err instanceof BridgeError) throw err;
        throw new BridgeError(err.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : err.message, { retryable: true });
      } finally {
        clearTimeout(timer);
      }
    });
    {
      const courses = (body?.data || [])
        .filter((c) => c && typeof c.slug === 'string' && c.slug)
        .map((c) => ({
          studentCourseId: String(c.id || ''),
          slug: c.slug,
          title: c.title,
          category: c.category || null,
          description: c.description || '',
          priceInPaise: typeof c.priceInPaise === 'number' ? c.priceInPaise : 0,
          image: c.bannerImage || null,
          isPurchasable: Boolean(c.isPurchasable),
          instructorName: c.instructor?.name || null,
        }));
      return { ok: true, courses };
    }
  } catch (err) {
    return { ok: false, reason: 'REQUEST_FAILED', error: err.message, courses: [] };
  }
}

/** Publishes (creates or updates) a course in the real student catalog. Never throws; returns a real status. */
export async function publishCourseToStudents(course) {
  if (!isConfigured()) return { synced: false, reason: 'NOT_CONFIGURED' };
  try {
    await call('/api/internal/courses', {
      method: 'POST',
      body: JSON.stringify({
        sourceId: String(course._id),
        slug: course.slug,
        title: course.title,
        description: course.description || '',
        features: course.features || [],
        priceInPaise: course.priceInPaise || 0,
        // Resolved to an absolute URL here (this backend already serves
        // /uploads statically) - student backend just stores whatever it's
        // given, no extra config needed on that side, mirroring how
        // teacher/backend's resource bridge resolves its own file URLs.
        image: course.image ? `${env.serverUrl}${course.image}` : null,
      }),
    });
    return { synced: true };
  } catch (err) {
    console.error('[studentCourseBridge] Failed to publish course to student catalog:', err.message);
    return { synced: false, reason: 'REQUEST_FAILED', error: err.message };
  }
}

/** Unpublishes a previously-bridged course (status left ARCHIVED/REJECTED here). Never deletes — existing enrollments must stay resolvable. */
export async function unpublishCourseFromStudents(sourceId) {
  if (!isConfigured()) return { synced: false, reason: 'NOT_CONFIGURED' };
  try {
    await call(`/api/internal/courses/${sourceId}/unpublish`, { method: 'PATCH' });
    return { synced: true };
  } catch (err) {
    console.error('[studentCourseBridge] Failed to unpublish course from student catalog:', err.message);
    return { synced: false, reason: 'REQUEST_FAILED', error: err.message };
  }
}

/**
 * Coupon administration, proxied to the student service.
 *
 * Unlike the publish/unpublish bridges above - which are best-effort side
 * channels - these THROW on failure. An admin pressing "Generate" needs to know
 * whether 25 free places now exist, and a swallowed error there would be
 * answered by silence.
 */
function couponsUnavailable() {
  return ApiError.serviceUnavailable(
    'The Student service is unavailable, so coupons cannot be managed right now. Nothing was changed - please try again in a moment.',
    'STUDENT_SERVICE_UNAVAILABLE'
  );
}

async function couponCall(path, options) {
  if (!isConfigured()) throw couponsUnavailable();
  try {
    return await call(path, options);
  } catch (err) {
    // A 4xx is the student service rejecting this on its merits (unknown
    // course, a campaign name already in use); that judgement is the useful
    // one and must reach the admin rather than being flattened into
    // "unavailable".
    //
    // Its body is unwrapped rather than passed through: `call` puts the whole
    // JSON payload into the error message, and forwarding that verbatim put a
    // raw {"success":false,...} blob on screen where a sentence belonged.
    const match = /returned (\d{3}):\s*([\s\S]*)$/.exec(err.message);
    const status = Number(match?.[1]);
    if (status >= 400 && status < 500) {
      let message = typeof err.body === 'string' && err.body ? err.body : match?.[2] || err.message;
      // This leg is shared by coupons, progression config and eligibility, so
      // the fallback names the transport rather than one of its passengers -
      // "COUPON_REJECTED" on a stage-eligibility call was simply wrong.
      let code = 'STUDENT_SERVICE_REJECTED';
      let details;
      try {
        const body = JSON.parse(message);
        message = body?.error?.message || body?.message || message;
        code = body?.error?.code || body?.code || code;
        // Carried through so a caller can act on it - e.g. a 409 naming the
        // version of a lesson video that is current now.
        details = body?.error?.details;
      } catch {
        // Not JSON - the raw text is still better than nothing.
      }
      // The upstream status is carried through rather than flattened to 422.
      // The student service already decided whether this was a bad request, a
      // missing record or a refusal, and collapsing all three lost a
      // distinction the caller can act on - a 404 and a validation failure need
      // different handling, and only the code survived to tell them apart.
      throw new ApiError(status, message, code, details);
    }
    console.error('[studentCourseBridge] Coupon administration failed:', err.message);
    throw couponsUnavailable();
  }
}

/**
 * Subject tagging, proxied to the service that owns the content.
 *
 * Native student courses have no record in this portal's database, so their
 * modules and lessons cannot be edited through the ordinary course routes -
 * which is precisely why tagging needs its own leg across the bridge.
 */
/**
 * Progression configuration, proxied to the service that owns the engine.
 *
 * The rules live beside the data they are applied to rather than in this
 * portal's database, so there is exactly one definition of what a level or a
 * rank threshold means.
 */
export async function getProgressionRules() {
  const body = await couponCall('/api/internal/progression/rules', { method: 'GET' });
  return body?.data || null;
}

export async function updateProgressionRules(payload) {
  const body = await couponCall('/api/internal/progression/rules', { method: 'PUT', body: JSON.stringify(payload) });
  return body?.data || null;
}

export async function updateStage(code, payload) {
  const body = await couponCall(`/api/internal/progression/stages/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return body?.data || null;
}

export async function updateAchievement(code, payload) {
  const body = await couponCall(`/api/internal/progression/achievements/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return body?.data || null;
}

export async function recalculateProgression(payload) {
  const body = await couponCall('/api/internal/progression/recalculate', { method: 'POST', body: JSON.stringify(payload) });
  return body?.data || null;
}

/**
 * Stage eligibility configuration, proxied to the service that evaluates it.
 *
 * The rules live with the engine that applies them, so an administrator edits
 * one definition rather than a copy that could drift out of step with what
 * students are actually measured against.
 */
export async function listEligibility() {
  const body = await couponCall('/api/internal/progression/eligibility', { method: 'GET' });
  return body?.data || [];
}

export async function getEligibility(stage) {
  const body = await couponCall(`/api/internal/progression/eligibility/${encodeURIComponent(stage)}`, { method: 'GET' });
  return body?.data || null;
}

export async function saveEligibilityDraft(stage, payload) {
  const body = await couponCall(`/api/internal/progression/eligibility/${encodeURIComponent(stage)}/draft`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return body?.data || null;
}

export async function validateEligibility(stage, payload) {
  const body = await couponCall(`/api/internal/progression/eligibility/${encodeURIComponent(stage)}/validate`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
  return body?.data || null;
}

export async function publishEligibility(stage, payload) {
  const body = await couponCall(`/api/internal/progression/eligibility/${encodeURIComponent(stage)}/publish`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
  return body?.data || null;
}

export async function disableEligibility(stage) {
  const body = await couponCall(`/api/internal/progression/eligibility/${encodeURIComponent(stage)}/disable`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return body?.data || null;
}

export async function previewEligibility(payload) {
  const body = await couponCall('/api/internal/progression/eligibility/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return body?.data || null;
}

export async function studentEligibilityOverview(query = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, v);
  const qs = params.toString();
  const body = await couponCall(`/api/internal/progression/student-eligibility${qs ? `?${qs}` : ''}`, { method: 'GET' });
  return { rows: body?.data || [], meta: body?.meta || {} };
}

export async function setupJourney(payload) {
  const body = await couponCall('/api/internal/progression/journey/setup', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
  return body?.data || null;
}

/**
 * Curriculum content for the journey courses, proxied to the service that owns
 * the content. Dry unless the payload says apply.
 */
export async function seedCurriculum(payload) {
  const body = await couponCall('/api/internal/progression/curriculum/seed', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
  return body?.data || null;
}

export async function auditCurriculum() {
  const body = await couponCall('/api/internal/progression/curriculum/audit', { method: 'GET' });
  return body?.data || [];
}

export async function getProgressionAnalytics() {
  const body = await couponCall('/api/internal/progression/analytics', { method: 'GET' });
  return body?.data || null;
}

export async function getCourseContent(slug) {
  const body = await couponCall(`/api/internal/courses/${encodeURIComponent(slug)}/content`, { method: 'GET' });
  return body?.data || null;
}

export async function setContentSubjects(slug, payload) {
  const body = await couponCall(`/api/internal/courses/${encodeURIComponent(slug)}/subjects`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return body?.data || null;
}

/**
 * Lesson videos, proxied to the service that owns lessons.
 *
 * The student service validates every link itself (one parser, one set of
 * error codes) and its 4xx answers - an unsupported link, an unknown lesson, a
 * video YouTube says does not exist - reach the admin unchanged. Only a
 * transport failure becomes 503, worded for videos rather than coupons.
 */
async function videoCall(path, options) {
  try {
    return await couponCall(path, options);
  } catch (err) {
    if (err?.code === 'STUDENT_SERVICE_UNAVAILABLE') {
      throw ApiError.serviceUnavailable(
        'The Student service is unavailable, so lesson videos cannot be loaded or saved right now. Nothing was changed - please try again in a moment.',
        'STUDENT_SERVICE_UNAVAILABLE'
      );
    }
    throw err;
  }
}

// A video belongs to one lesson or one module: { lessonId } or { moduleId }.
const videoPath = (slug, target) =>
  `/api/internal/lesson-videos/courses/${encodeURIComponent(slug)}/${
    target.moduleId ? `modules/${encodeURIComponent(target.moduleId)}` : `lessons/${encodeURIComponent(target.lessonId)}`
  }`;

export async function listLessonVideoCourses() {
  const body = await videoCall('/api/internal/lesson-videos/courses', { method: 'GET' });
  return body?.data || [];
}

export async function getLessonVideos(slug) {
  const body = await videoCall(`/api/internal/lesson-videos/courses/${encodeURIComponent(slug)}`, { method: 'GET' });
  return body?.data || null;
}

export async function inspectLessonVideo(url) {
  const body = await videoCall('/api/internal/lesson-videos/inspect', { method: 'POST', body: JSON.stringify({ url }) });
  return body?.data || null;
}

export async function saveCourseVideo(slug, target, payload) {
  const body = await videoCall(videoPath(slug, target), { method: 'PUT', body: JSON.stringify(payload) });
  return body?.data || null;
}

export async function removeCourseVideo(slug, target, payload) {
  const body = await videoCall(videoPath(slug, target), { method: 'DELETE', body: JSON.stringify(payload) });
  return body?.data || null;
}

export async function listSubjects() {
  const body = await couponCall('/api/internal/subjects', { method: 'GET' });
  return body?.data || [];
}

export async function listCoupons(query = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '' && v !== 'ALL') params.set(k, v);
  const qs = params.toString();
  const body = await couponCall(`/api/internal/coupons${qs ? `?${qs}` : ''}`, { method: 'GET' });
  return { coupons: body?.data || [], summary: body?.meta?.summary || {} };
}

export async function createCampaign(payload) {
  const body = await couponCall('/api/internal/coupon-campaigns', { method: 'POST', body: JSON.stringify(payload) });
  return body?.data || { campaign: null, coupons: [] };
}

export async function listCampaigns(query = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, v);
  const qs = params.toString();
  const body = await couponCall(`/api/internal/coupon-campaigns${qs ? `?${qs}` : ''}`, { method: 'GET' });
  return body?.data || [];
}

export async function exportCampaign(id) {
  const body = await couponCall(`/api/internal/coupon-campaigns/${encodeURIComponent(id)}/export`, { method: 'GET' });
  return body?.data || { campaign: null, coupons: [] };
}

export async function updateCoupon(id, payload) {
  const body = await couponCall(`/api/internal/coupons/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
  return body?.data || null;
}

export async function deleteCoupon(id) {
  await couponCall(`/api/internal/coupons/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export default {
  fetchStudentCourseCatalog,
  getProgressionRules,
  updateProgressionRules,
  updateStage,
  updateAchievement,
  recalculateProgression,
  getProgressionAnalytics,
  setupJourney,
  seedCurriculum,
  auditCurriculum,
  listEligibility,
  getEligibility,
  saveEligibilityDraft,
  validateEligibility,
  publishEligibility,
  disableEligibility,
  previewEligibility,
  studentEligibilityOverview,
  getCourseContent,
  setContentSubjects,
  listSubjects,
  listCoupons,
  createCampaign,
  listCampaigns,
  exportCampaign,
  updateCoupon,
  deleteCoupon, publishCourseToStudents, unpublishCourseFromStudents };

/**
 * One student by enrollment number, from the service that owns student identity.
 *
 * Throws on failure, like the coupon calls: an admin searching for a student
 * must be told the service is unavailable, not shown an empty result that reads
 * as "no such student".
 */
export async function lookupStudentByEnrollmentNumber(enrollmentNumber, { includePayments = false } = {}) {
  try {
    const body = await couponCall('/api/internal/students/lookup', {
      method: 'POST',
      body: JSON.stringify({ enrollmentNumber, includePayments }),
    });
    return body?.data || null;
  } catch (err) {
    // The shared transport's own message is about coupons; say what failed here.
    if (err?.code === 'STUDENT_SERVICE_UNAVAILABLE') {
      throw ApiError.serviceUnavailable(
        'The Student service is unavailable, so students cannot be looked up right now. Please try again in a moment.',
        'STUDENT_SERVICE_UNAVAILABLE'
      );
    }
    throw err;
  }
}

/**
 * Asks the student service to send portal students' records here and to the
 * teacher portal again - the recovery for a delivery that failed. A dry run
 * unless `apply` is true.
 */
export async function resyncPortalStudents(payload) {
  try {
    const body = await couponCall('/api/internal/portal-students/resync', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return body?.data || null;
  } catch (err) {
    if (err?.code === 'STUDENT_SERVICE_UNAVAILABLE') {
      throw ApiError.serviceUnavailable(
        'The Student service is unavailable, so student records cannot be resent right now. Please try again in a moment.',
        'STUDENT_SERVICE_UNAVAILABLE'
      );
    }
    throw err;
  }
}
