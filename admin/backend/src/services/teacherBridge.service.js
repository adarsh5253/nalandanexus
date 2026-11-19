import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Provisions a REAL Teacher Portal login when Admin creates a teacher.
 * admin/backend's own `Teacher` document is a governance/roster record only
 * — it cannot authenticate anyone into teacher/backend, a separate
 * service with a structurally different Teacher/User schema in a separate
 * database. This calls teacher/backend's internal
 * `createTeacherAccount()` (already existed, was never wired to a caller)
 * via the same shared-secret `X-Internal-Service-Key` pattern already
 * proven for the announcement bridge.
 *
 * Unlike the announcement bridge, this is NOT swallow-and-log: a failure
 * here means the teacher literally cannot log in, so the caller
 * (teacher.service.js#createTeacher) must surface it as a real warning
 * rather than a silently-dropped side effect.
 */

function isConfigured() {
  return Boolean(env.teacherBridge.url && env.teacherBridge.serviceKey);
}

/**
 * Cross-service call sizing, and why it is what it is.
 *
 * Both services run on Render's free tier, which stops an instance after ~15
 * minutes idle; the next request pays a cold start that was measured at 22-32
 * seconds against all three of our backends. The original 8-second budget was
 * therefore shorter than a routine cold start, so any admin action taken while
 * the teacher portal happened to be asleep failed - and, for course assignment,
 * failed silently and permanently.
 *
 * Keeping the peer awake was the obvious answer and does not hold: the
 * scheduled keep-warm workflow asks for a ping every 10 minutes and GitHub
 * actually delivered 7 runs in 32 hours, with gaps up to 8.6 hours. Scheduled
 * Actions are best-effort and heavily throttled, so warmth cannot be a
 * correctness dependency - at best it makes the cold path rarer.
 *
 * So the call itself absorbs a cold start: one short attempt (a warm peer
 * answers in well under a second, and the common case must stay fast), then two
 * further attempts with a budget long enough to cover the boot, spaced to let it
 * finish. Worst case is roughly 75 seconds before a real, reported failure -
 * acceptable for an admin-triggered background sync, and far better than losing
 * the assignment. It is BOUNDED: three attempts, never a loop.
 *
 * Only transport failures and 5xx are retried. A 4xx is the peer answering
 * clearly ("no such teacher"), and repeating it would just be slower.
 */
const ATTEMPT_TIMEOUTS_MS = [8000, 35000, 35000];
const RETRY_BACKOFF_MS = [1000, 3000];

class BridgeError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.retryable = retryable;
  }
}

async function attempt(path, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.teacherBridge.url}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': env.teacherBridge.serviceKey, ...options.headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new BridgeError(`Teacher backend returned ${res.status}: ${body.slice(0, 200)}`, {
        status: res.status,
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

async function call(path, options) {
  let last;
  for (let i = 0; i < ATTEMPT_TIMEOUTS_MS.length; i += 1) {
    try {
      return await attempt(path, options, ATTEMPT_TIMEOUTS_MS[i]);
    } catch (err) {
      last = err;
      const more = i < ATTEMPT_TIMEOUTS_MS.length - 1;
      if (!err.retryable || !more) break;
      console.warn(`[teacherBridge] ${path} attempt ${i + 1} failed (${err.message}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[i]));
    }
  }
  throw last;
}

/**
 * Creates the real teacher/backend login. Returns a real status — never throws,
 * never silently succeeds.
 *
 * No password is sent. What crosses is the SHA-256 of a setup-link token and
 * when it expires: the Teacher Portal creates the account with a random
 * password nobody knows, and the person sets their own through the link. On
 * success the answer carries the Teacher ID that was actually issued (the one
 * asked for, unless it was taken) and the address of the Teacher Portal's login
 * page, so the email links to somewhere real.
 */
export async function provisionTeacherAccount({ name, email, phone, title, department, subject, teacherId, avatarUrl, setupTokenHash, setupTokenExpiresAt }) {
  if (!isConfigured()) return { provisioned: false, reason: 'NOT_CONFIGURED' };
  try {
    const result = await call('/api/internal/teachers', {
      method: 'POST',
      body: JSON.stringify({ name, email, phone, title, department, subject, teacherId, avatarUrl, setupTokenHash, setupTokenExpiresAt }),
    });
    return { provisioned: true, teacherCode: result?.data?.teacherCode || null, portalUrl: result?.data?.portalUrl || null };
  } catch (err) {
    console.error('[teacherBridge] Failed to provision Teacher Portal account:', err.message);
    return { provisioned: false, reason: 'REQUEST_FAILED', error: err.message };
  }
}

/**
 * Replaces a teacher's pending password-setup link on the Teacher Portal - the
 * backend leg of "resend". The old link stops working; the password and any
 * sessions are untouched until the new link is actually used. Same honesty
 * contract as provisioning: a real status is always returned.
 */
export async function issueTeacherSetupLink({ email, setupTokenHash, setupTokenExpiresAt }) {
  if (!isConfigured()) return { issued: false, reason: 'NOT_CONFIGURED' };
  try {
    const result = await call('/api/internal/teachers/credentials', {
      method: 'PATCH',
      body: JSON.stringify({ email, setupTokenHash, setupTokenExpiresAt }),
    });
    return { issued: true, teacherCode: result?.data?.teacherCode || null, portalUrl: result?.data?.portalUrl || null };
  } catch (err) {
    console.error('[teacherBridge] Failed to issue Teacher Portal setup link:', err.message);
    return { issued: false, reason: 'REQUEST_FAILED', error: err.message, status: err.status };
  }
}

/**
 * Tells the Teacher Portal the full set of courses this teacher is assigned.
 * Visibility of each course's students follows from it, so a failure here is
 * surfaced rather than swallowed: the teacher would simply see no students.
 * Sent as a set every time, so a retry is always safe.
 */
export async function setTeacherCoursesOnPortal({ email, courses }) {
  if (!isConfigured()) return { applied: false, reason: 'NOT_CONFIGURED' };
  try {
    const result = await call('/api/internal/teachers/courses', {
      method: 'PUT',
      body: JSON.stringify({ teacherEmail: email, courses }),
    });
    if (result?.data?.updated === false) return { applied: false, reason: result.data.reason || 'NOT_APPLIED' };
    return { applied: true };
  } catch (err) {
    console.error('[teacherBridge] Failed to set Teacher Portal courses:', err.message);
    return { applied: false, reason: 'REQUEST_FAILED', error: err.message };
  }
}

/**
 * Pushes an admin-authored course assignment into the assigned teacher's
 * Teacher Portal — best-effort (never throws), matching the academics
 * read-model bridge already proven for assignment/quiz/attendance data.
 * `sourceId` is admin's own Course _id (string), resolved on the teacher
 * side by email since the two services share no ObjectId space.
 */
export async function pushCourseAssignment({ sourceId, teacherEmail, title, courseCode, description, image, priceInPaise, status, studentCourseSlug }) {
  if (!isConfigured()) return { assigned: false, reason: 'NOT_CONFIGURED' };
  try {
    const result = await call(`/api/internal/courses/${encodeURIComponent(sourceId)}`, {
      method: 'PUT',
      // The slug is what lets the Teacher Portal show the instructor the students
      // enrolled in a course sold under it.
      body: JSON.stringify({ teacherEmail, title, courseCode, description, image, priceInPaise, status, studentCourseSlug: studentCourseSlug || undefined }),
    });
    return { assigned: Boolean(result?.data?.assigned), reason: result?.data?.reason };
  } catch (err) {
    console.error('[teacherBridge] Failed to push course assignment:', err.message);
    return { assigned: false, reason: 'REQUEST_FAILED', error: err.message };
  }
}

/**
 * Pushes an Admin-broadcast announcement (audience 'ALL' or 'TEACHERS') to
 * every teacher — the receiving leg that never existed before (announcements
 * only ever reached students). Best-effort, never throws.
 */
export async function pushAnnouncementToTeachers({ sourceId, title, content, priority, authorName, publishedAt }) {
  if (!isConfigured()) return { delivered: false, reason: 'NOT_CONFIGURED' };
  try {
    await call('/api/internal/admin-announcements', {
      method: 'POST',
      body: JSON.stringify({ sourceId, title, content, priority, authorName, publishedAt }),
    });
    return { delivered: true };
  } catch (err) {
    console.error('[teacherBridge] Failed to push announcement to teachers:', err.message);
    return { delivered: false, reason: 'REQUEST_FAILED', error: err.message };
  }
}

/**
 * Deactivates (or reactivates) the real Teacher Portal login - the gap this
 * closes: deleting a teacher on admin's side previously only soft-deleted
 * admin's own governance record, leaving the real portal account fully
 * able to log in and use the app indefinitely (confirmed live via a QA
 * pass). Best-effort like the rest of this bridge, but the caller should
 * still treat a failure here as worth surfacing - unlike a missed
 * announcement, a teacher who should be locked out but isn't is a real
 * access-control gap, not a cosmetic delivery miss.
 */
export async function setTeacherAccountStatus({ email, status }) {
  if (!isConfigured()) return { updated: false, reason: 'NOT_CONFIGURED' };
  try {
    await call('/api/internal/teachers/status', {
      method: 'PATCH',
      body: JSON.stringify({ email, status }),
    });
    return { updated: true };
  } catch (err) {
    console.error('[teacherBridge] Failed to update Teacher Portal account status:', err.message);
    return { updated: false, reason: 'REQUEST_FAILED', error: err.message };
  }
}

export async function removeCourseAssignment(sourceId) {
  if (!isConfigured()) return { removed: false, reason: 'NOT_CONFIGURED' };
  try {
    await call(`/api/internal/courses/${encodeURIComponent(sourceId)}`, { method: 'DELETE' });
    return { removed: true };
  } catch (err) {
    console.error('[teacherBridge] Failed to remove course assignment:', err.message);
    return { removed: false, reason: 'REQUEST_FAILED', error: err.message };
  }
}

/**
 * Batch administration, proxied to the teacher service.
 *
 * Batches live in that service's database and there is deliberately no copy
 * here - a second Batch model would be two answers to "how many seats are
 * taken", and capacity is enforced against the counter over there. These calls
 * inherit the bounded cold-start retry in call() above, so an admin managing
 * batches while the teacher backend is asleep waits rather than fails.
 *
 * Unlike the fire-and-forget bridges, these THROW on failure: an admin pressing
 * Save needs to know the batch was not created, not be told it worked.
 */
function bridgeUnavailable() {
  return ApiError.serviceUnavailable(
    'The Teacher service is unavailable, so batches cannot be managed right now. Nothing was changed - please try again in a moment.',
    'TEACHER_SERVICE_UNAVAILABLE'
  );
}

async function batchCall(path, options) {
  if (!isConfigured()) throw bridgeUnavailable();
  try {
    return await call(path, options);
  } catch (err) {
    // A 4xx is the teacher service rejecting the request on its merits
    // (unknown course, unknown teacher, bad capacity); that message is the
    // useful one and must reach the admin rather than being flattened into
    // "service unavailable".
    if (err?.status >= 400 && err.status < 500) {
      throw ApiError.unprocessable(err.message.replace(/^Teacher backend returned \d+:\s*/, ''), 'BATCH_REJECTED');
    }
    console.error('[teacherBridge] Batch administration call failed:', err.message);
    throw bridgeUnavailable();
  }
}

export async function listBatches(query = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, v);
  const qs = params.toString();
  const body = await batchCall(`/api/internal/batches${qs ? `?${qs}` : ''}`, { method: 'GET' });
  return { batches: body?.data || [], catalogAvailable: body?.meta?.catalogAvailable !== false };
}

export async function getBatch(id) {
  const body = await batchCall(`/api/internal/batches/${encodeURIComponent(id)}`, { method: 'GET' });
  return body?.data || null;
}

export async function createBatch(payload) {
  const body = await batchCall('/api/internal/batches', { method: 'POST', body: JSON.stringify(payload) });
  return body?.data || null;
}

export async function updateBatch(id, payload) {
  const body = await batchCall(`/api/internal/batches/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
  return body?.data || null;
}

export async function reassignBatchTeacher(id, payload) {
  const body = await batchCall(`/api/internal/batches/${encodeURIComponent(id)}/teacher`, { method: 'PATCH', body: JSON.stringify(payload) });
  return body?.data || null;
}

export async function listBatchStudents(id) {
  const body = await batchCall(`/api/internal/batches/${encodeURIComponent(id)}/students`, { method: 'GET' });
  return body?.data || [];
}

export default {
  listBatches,
  getBatch,
  createBatch,
  updateBatch,
  reassignBatchTeacher,
  listBatchStudents,
  provisionTeacherAccount,
  issueTeacherSetupLink,
  setTeacherCoursesOnPortal,
  setTeacherAccountStatus,
  pushCourseAssignment,
  removeCourseAssignment,
  pushAnnouncementToTeachers,
};
