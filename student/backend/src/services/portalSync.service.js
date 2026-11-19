import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { StudentProfile } from '../models/StudentProfile.js';
import { Enrollment } from '../models/Enrollment.js';
import { Course } from '../models/Course.js';
import { evaluateProfile, ensureEnrollmentNumber, normalizeEnrollmentNumber } from './studentProfile.service.js';
import { assignEnrollmentToBatch } from './enrollment.service.js';
import { logger } from '../utils/logger.js';

/**
 * Keeps the admin and teacher portals' student records in step with this one.
 *
 * Student identity lives here - the account, the profile, the enrolments - but
 * the admin portal lists students from its own `students` collection and a
 * teacher lists the roster rows in theirs. Before this, nothing ever told either
 * of them who had enrolled: the admin portal received a payment ledger row and
 * nothing else, and the roster row placement created stayed a nameless,
 * unverified placeholder until a teacher happened to press Sync. So a student
 * could buy a course and never appear on either list.
 *
 * Every change that affects what those portals show - an enrolment, a completed
 * or edited profile, a new photo - ends in `syncStudentToPortals`, which sends
 * the student's CURRENT record, read fresh from this database, to both. Sending
 * the whole record rather than the change is what makes it safe to repeat: a
 * retried payment, a replayed webhook or the retry sweep all deliver the same
 * thing, and the receivers key it on the student's user id, so a repeat updates
 * one record and never creates a second.
 *
 * A student's course is never held back by it. Failure is recorded on the
 * profile as pending, logged, and retried by jobs/portalSyncSweep.job.js; an
 * admin can also force it (POST /api/internal/portal-students/resync).
 */

const PUSH_TIMEOUT_MS = 5000;

/** After this many failed attempts in a row the sweep stops trying; an admin resync starts again. */
export const MAX_SYNC_ATTEMPTS = 12;

const DESTINATIONS = [
  { name: 'admin', bridge: () => env.adminBridge },
  { name: 'teacher', bridge: () => env.teacherBridge },
];

const isConfigured = (bridge) => Boolean(bridge.url && bridge.serviceKey);

/**
 * The student as the other portals should show them, or null when there is
 * nothing for them to show (not a student, or never enrolled in anything).
 *
 * Built from the database at the moment of sending, never from the request
 * that triggered it, so it can only ever describe the current state.
 */
export async function buildPortalStudentRecord(userId) {
  const user = await User.findById(userId).select('name email phone avatar role').lean();
  if (!user || user.role !== 'student') return null;

  const enrollments = await Enrollment.find({ userId }).sort({ enrolledAt: 1 }).lean();
  if (!enrollments.length) return null;

  const [profile, courses] = await Promise.all([
    StudentProfile.findOne({ userId }).select('guardianName grade enrollmentNumber profileCompletedAt portalSync').lean(),
    Course.find({ _id: { $in: enrollments.map((e) => e.courseId) } }).select('slug title').lean(),
  ]);
  const courseById = new Map(courses.map((c) => [String(c._id), c]));
  const { complete } = evaluateProfile(user, profile);

  return {
    userId: String(user._id),
    enrollmentNumber: profile?.enrollmentNumber || null,
    fullName: user.name,
    email: user.email,
    phone: user.phone || null,
    // A URL. Anything longer is not one the other portals could store, and
    // sending it would fail the whole record there on a photo.
    avatar: user.avatar && user.avatar.length <= 2000 ? user.avatar : null,
    guardianName: profile?.guardianName || null,
    grade: profile?.grade || null,
    profileComplete: complete,
    profileCompletedAt: profile?.profileCompletedAt || null,
    enrollments: enrollments.map((e) => {
      const course = courseById.get(String(e.courseId));
      return {
        enrollmentId: e.enrollmentId || null,
        courseSlug: course?.slug || null,
        courseTitle: course?.title || null,
        status: e.status,
        enrolledAt: e.enrolledAt,
        endsAt: e.endsAt || null,
        batchId: e.batchId || null,
        batchCode: e.batchCode || null,
      };
    }),
    // When this record was read. Receivers ignore a record older than the one
    // they already hold, so two syncs arriving out of order cannot put an old
    // name back.
    sourceUpdatedAt: new Date().toISOString(),
  };
}

/**
 * What the teacher portal receives: identity, and each enrolment's id, status,
 * batch and course slug - enough to update and verify the roster rows placement
 * created, and to place the student on the course-wide roster of any teacher
 * assigned that course. Never a course title or what anything cost.
 *
 * The slug is catalogue information (it is in every public course URL), and the
 * teacher portal keeps an enrolment only for a course it has a teacher assigned
 * to - it drops the rest on arrival. It is sent for every enrolment because this
 * portal cannot know which courses a teacher has been given.
 */
function forTeacher(record) {
  return {
    ...record,
    enrollments: record.enrollments
      .filter((e) => e.enrollmentId)
      .map((e) => ({
        enrollmentId: e.enrollmentId,
        status: e.status,
        batchId: e.batchId,
        batchCode: e.batchCode,
        courseSlug: e.courseSlug,
        enrolledAt: e.enrolledAt,
      })),
  };
}

async function push(destination, record) {
  const bridge = destination.bridge();
  if (!isConfigured(bridge)) return { destination: destination.name, status: 'skipped', reason: 'NOT_CONFIGURED' };

  const body = destination.name === 'teacher' ? forTeacher(record) : record;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(`${bridge.url}/api/internal/portal-students/${encodeURIComponent(record.userId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': bridge.serviceKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { destination: destination.name, status: 'failed', error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = await res.json().catch(() => null);
    return { destination: destination.name, status: 'synced', result: json?.data || null };
  } catch (err) {
    const error = err.name === 'AbortError' ? `Timed out after ${PUSH_TIMEOUT_MS}ms` : err.message;
    return { destination: destination.name, status: 'failed', error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gives an active enrolment that never got a batch another try.
 *
 * Placement happens at purchase and is best-effort: if the teacher portal was
 * asleep then, the enrolment was left unplaced and nothing ever tried again, so
 * the student reached no teacher at all. Each sync retries it first, so the
 * roster row exists by the time the record arrives to fill it in.
 */
async function placeUnplacedEnrollments(userId, studentName) {
  const unplaced = await Enrollment.find({ userId, status: 'active', batchId: null, enrollmentId: { $exists: true, $ne: null } });
  for (const enrollment of unplaced) {
    const course = await Course.findById(enrollment.courseId).select('slug').lean();
    if (!course?.slug) continue;
    await assignEnrollmentToBatch(enrollment, course.slug, { studentName }).catch((err) => {
      logger.warn('[PortalSync] Batch placement retry failed', { userId: String(userId), enrollmentId: enrollment.enrollmentId, error: err.message });
    });
  }
}

/** Marks the student as owing a sync, and returns the revision this attempt answers to. */
async function markPending(userId, now) {
  const profile = await StudentProfile.findOneAndUpdate(
    { userId },
    { $inc: { 'portalSync.revision': 1 } },
    { new: true }
  )
    .select('portalSync')
    .lean();
  if (!profile) return null;
  await StudentProfile.updateOne({ userId, 'portalSync.pendingSince': null }, { $set: { 'portalSync.pendingSince': now } });
  return profile.portalSync.revision;
}

/**
 * Sends the student's current record to the admin and teacher portals.
 *
 * Never throws: the enrolment, payment or profile save that called it has
 * already happened and must stand. Returns what happened at each destination.
 */
export async function syncStudentToPortals(userId, { reason = 'unspecified', retryPlacement = true } = {}) {
  const startedAt = new Date();
  const id = String(userId);
  try {
    if (!DESTINATIONS.some((d) => isConfigured(d.bridge()))) return { status: 'skipped', reason: 'NOT_CONFIGURED' };
    if (!(await Enrollment.exists({ userId }))) return { status: 'skipped', reason: 'NO_ENROLLMENT' };

    // The number is part of what the other portals show; make sure it exists.
    // Also creates the profile if an old enrolment never had one.
    if (await Enrollment.exists({ userId, status: 'active' })) {
      await ensureEnrollmentNumber(userId).catch((err) => {
        logger.warn('[PortalSync] Enrollment number not issued before sync', { userId: id, error: err.message });
      });
    }

    const revision = await markPending(userId, startedAt);
    if (revision === null) return { status: 'skipped', reason: 'NO_PROFILE' };

    // createEnrollment has just tried placement itself and says so; trying again
    // a moment later would only wait out the same timeout twice.
    if (retryPlacement) {
      const student = await User.findById(userId).select('name').lean();
      await placeUnplacedEnrollments(userId, student?.name || null);
    }

    const record = await buildPortalStudentRecord(userId);
    if (!record) return { status: 'skipped', reason: 'NO_ENROLLMENT' };

    const results = await Promise.all(DESTINATIONS.map((d) => push(d, record)));
    const failures = results.filter((r) => r.status === 'failed');

    for (const r of results) {
      const entry = {
        event: 'student.portal_sync',
        status: r.status,
        source: 'student-portal',
        destination: r.destination,
        userId: id,
        enrollmentNumber: record.enrollmentNumber,
        enrollmentIds: record.enrollments.map((e) => e.enrollmentId).filter(Boolean),
        courseSlugs: record.enrollments.map((e) => e.courseSlug).filter(Boolean),
        reason,
        revision,
        error: r.error || r.reason || null,
        at: new Date().toISOString(),
      };
      if (r.status === 'failed') logger.error('[PortalSync]', entry);
      else logger.info('[PortalSync]', entry);
    }

    const finishedAt = new Date();
    if (failures.length) {
      await StudentProfile.updateOne(
        { userId },
        {
          $set: {
            'portalSync.lastAttemptAt': finishedAt,
            'portalSync.lastError': failures.map((f) => `${f.destination}: ${f.error}`).join('; ').slice(0, 500),
          },
          $inc: { 'portalSync.attempts': 1 },
        }
      );
      return { status: 'failed', revision, results };
    }

    // Cleared only if nothing newer asked for a sync while this one was running;
    // otherwise that request is still owed and stays pending.
    await StudentProfile.updateOne(
      { userId, 'portalSync.revision': revision },
      {
        $set: {
          'portalSync.pendingSince': null,
          'portalSync.lastAttemptAt': finishedAt,
          'portalSync.lastSyncedAt': finishedAt,
          'portalSync.lastError': null,
          'portalSync.attempts': 0,
        },
      }
    );
    return { status: 'synced', revision, results };
  } catch (err) {
    logger.error('[PortalSync]', {
      event: 'student.portal_sync',
      status: 'failed',
      source: 'student-portal',
      destination: 'all',
      userId: id,
      reason,
      error: err.message,
      at: new Date().toISOString(),
    });
    await StudentProfile.updateOne(
      { userId },
      { $set: { 'portalSync.lastAttemptAt': new Date(), 'portalSync.lastError': err.message.slice(0, 500) }, $inc: { 'portalSync.attempts': 1 } }
    ).catch(() => {});
    return { status: 'failed', error: err.message };
  }
}

/** Seconds to wait before retrying after `attempts` failures: 1, 2, 4 ... capped at an hour. */
export function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Retries the syncs that failed. Only students this code marked pending are
 * considered - a student who has not changed since before it existed is not
 * swept up by a deploy.
 */
export async function retryPendingPortalSyncs({ limit = 20, now = new Date(), ignoreBackoff = false } = {}) {
  const candidates = await StudentProfile.find({
    'portalSync.pendingSince': { $ne: null },
    // `$not $gte` rather than `$lt`, so a profile whose attempt count was never
    // written (an attempt interrupted before it failed) still counts as due.
    ...(ignoreBackoff ? {} : { 'portalSync.attempts': { $not: { $gte: MAX_SYNC_ATTEMPTS } } }),
  })
    .sort({ 'portalSync.pendingSince': 1 })
    .limit(limit * 5)
    .select('userId portalSync')
    .lean();

  const due = candidates
    .filter((p) => {
      if (ignoreBackoff) return true;
      const last = p.portalSync?.lastAttemptAt ? new Date(p.portalSync.lastAttemptAt).getTime() : 0;
      return now.getTime() - last >= retryDelayMs(p.portalSync?.attempts || 0);
    })
    .slice(0, limit);

  const outcome = { considered: due.length, synced: 0, failed: 0 };
  for (const p of due) {
    const result = await syncStudentToPortals(p.userId, { reason: 'retry' });
    if (result.status === 'synced') outcome.synced += 1;
    else if (result.status === 'failed') outcome.failed += 1;
  }
  return outcome;
}

/**
 * An administrator's recovery: one student, everyone still pending, or every
 * enrolled student a page at a time. `dryRun` reports what would be sent and
 * sends nothing.
 */
export async function resyncPortalStudents({ mode = 'pending', enrollmentNumber = null, cursor = null, limit = 50, dryRun = false } = {}) {
  if (mode === 'one') {
    const number = normalizeEnrollmentNumber(enrollmentNumber);
    const profile = number ? await StudentProfile.findOne({ enrollmentNumber: number }).select('userId').lean() : null;
    if (!profile) return { mode, found: false, dryRun };
    if (dryRun) return { mode, found: true, dryRun, wouldSync: 1 };
    await StudentProfile.updateOne({ _id: profile._id }, { $set: { 'portalSync.attempts': 0 } });
    const result = await syncStudentToPortals(profile.userId, { reason: 'admin.resync' });
    return { mode, found: true, dryRun, status: result.status, results: result.results || null };
  }

  if (mode === 'pending') {
    const pending = await StudentProfile.countDocuments({ 'portalSync.pendingSince': { $ne: null } });
    if (dryRun) return { mode, dryRun, pending };
    return { mode, dryRun, pending, ...(await retryPendingPortalSyncs({ limit, ignoreBackoff: true })) };
  }

  // mode === 'all'
  const match = cursor ? { userId: { $gt: new mongoose.Types.ObjectId(cursor) } } : {};
  if (dryRun) {
    const [{ total = 0 } = {}] = await Enrollment.aggregate([{ $group: { _id: '$userId' } }, { $count: 'total' }]);
    return { mode, dryRun, total };
  }
  const page = await Enrollment.aggregate([{ $match: match }, { $group: { _id: '$userId' } }, { $sort: { _id: 1 } }, { $limit: limit }]);
  const outcome = { mode, dryRun, processed: page.length, synced: 0, failed: 0, skipped: 0 };
  for (const { _id: userId } of page) {
    const result = await syncStudentToPortals(userId, { reason: 'admin.resync' });
    if (result.status === 'synced') outcome.synced += 1;
    else if (result.status === 'failed') outcome.failed += 1;
    else outcome.skipped += 1;
  }
  outcome.nextCursor = page.length === limit ? String(page[page.length - 1]._id) : null;
  return outcome;
}

export default { buildPortalStudentRecord, syncStudentToPortals, retryPendingPortalSyncs, resyncPortalStudents, retryDelayMs, MAX_SYNC_ATTEMPTS };
