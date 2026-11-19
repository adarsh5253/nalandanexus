import { CourseAccess } from '../models/CourseAccess.js';
import { CourseEnrollment } from '../models/CourseEnrollment.js';
import { User } from '../models/User.js';
import { Teacher } from '../models/Teacher.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { emitToTeacher } from '../sockets/index.js';
import { fetchEnrollmentSnapshot } from './studentBridge.service.js';
import { notifyTeacher } from './notification.service.js';
import { logAudit } from './audit.service.js';

/**
 * Course-wise student visibility.
 *
 * A teacher an administrator has assigned a course to can see every student
 * enrolled in it, whichever batch that student sits in. Three things keep that
 * true without anyone pressing Sync:
 *
 *   1. Assigning the course loads the students already enrolled (syncCourseRoster).
 *   2. Every enrolment, edit or revocation the student portal reports afterwards
 *      is applied here as it arrives (applyPortalRecordToRoster), because that
 *      portal already sends the student's whole record after each one.
 *   3. If either path was missed - the other portal asleep, a delivery that
 *      failed - the next sync (assignment, or the refresh a teacher can press)
 *      reconciles against the student portal's own answer.
 *
 * The roster is read-only identity. Grades, attendance and risk belong to the
 * batch's own teacher and live on `Student` rows; seeing a student here never
 * lets a teacher change any of that.
 *
 * Who may see a row is decided on every read from CourseAccess, so taking a
 * course away from a teacher takes its students away in the same moment.
 */

const SLUG = /^[a-z0-9-]{1,100}$/;
const normSlug = (s) => String(s || '').trim().toLowerCase();

function log(entry) {
  console.log('[courseRoster]', JSON.stringify({ at: new Date().toISOString(), ...entry }));
}

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function resolveTeacherByEmail(email) {
  const user = await User.findOne({ email: String(email).toLowerCase().trim(), role: 'teacher' }).select('_id name').lean();
  if (!user) return null;
  const teacher = await Teacher.findOne({ user: user._id });
  return teacher ? { user, teacher } : null;
}

/** Records one reason this teacher has this course. Returns whether the teacher had no access to it before. */
export async function grantAccess(teacherId, { slug, title, source }) {
  const studentCourseSlug = normSlug(slug);
  const existing = await CourseAccess.findOne({ teacher: teacherId, studentCourseSlug });
  if (!existing) {
    await CourseAccess.create({ teacher: teacherId, studentCourseSlug, title: title || null, sources: [source] });
    return { created: true };
  }
  const set = {};
  if (title) set.title = title;
  await CourseAccess.updateOne(
    { _id: existing._id },
    { $addToSet: { sources: source }, ...(Object.keys(set).length ? { $set: set } : {}) }
  );
  return { created: false };
}

/** Removes one reason; the access ends - and the stored students nobody may now see are dropped - when none is left. */
export async function revokeAccess(teacherId, { slug, source }) {
  const studentCourseSlug = normSlug(slug);
  const row = await CourseAccess.findOneAndUpdate({ teacher: teacherId, studentCourseSlug }, { $pull: { sources: source } }, { new: true });
  if (!row) return { removed: false };
  if (row.sources.length > 0) return { removed: false, stillHeldVia: row.sources };

  await CourseAccess.deleteOne({ _id: row._id });
  // Nobody may see this course's students any more, so there is no reason to
  // keep a copy of them here. Reassigning the course loads them again.
  if (!(await CourseAccess.exists({ studentCourseSlug }))) {
    await CourseEnrollment.deleteMany({ studentCourseSlug });
  }
  return { removed: true };
}

/**
 * Makes a teacher's administrator-assigned courses exactly `courses`.
 *
 * The Admin portal sends the full set every time, so this is a replacement, not
 * an append: a course left out is taken away. Returns what changed, and starts
 * loading the students of any newly added course in the background - the
 * student portal can take a minute to wake, and an administrator saving a
 * teacher should not wait on that.
 */
export async function setTeacherCourses({ teacherEmail, courses }) {
  const found = await resolveTeacherByEmail(teacherEmail);
  if (!found) return { updated: false, reason: 'TEACHER_NOT_FOUND' };
  const { teacher } = found;

  const desired = new Map();
  for (const c of courses || []) {
    const slug = normSlug(c.slug);
    if (SLUG.test(slug)) desired.set(slug, c.title || null);
  }

  const current = await CourseAccess.find({ teacher: teacher._id, sources: 'teacher-assignment' }).select('studentCourseSlug').lean();
  const currentSlugs = new Set(current.map((r) => r.studentCourseSlug));

  const added = [];
  const removed = [];
  for (const [slug, title] of desired) {
    const { created } = await grantAccess(teacher._id, { slug, title, source: 'teacher-assignment' });
    if (!currentSlugs.has(slug)) added.push(slug);
    if (created) {
      // Only a teacher who did not already have the course by another route
      // is told it is new.
      await notifyTeacher(teacher._id, {
        type: 'system',
        title: 'New course assigned to you',
        message: `${title || slug.toUpperCase()} has been assigned to you. Its enrolled students are now in your course roster.`,
        relatedEntityType: 'CourseAccess',
        relatedEntityId: null,
      }).catch(() => {});
    }
  }
  for (const slug of currentSlugs) {
    if (!desired.has(slug)) {
      await revokeAccess(teacher._id, { slug, source: 'teacher-assignment' });
      removed.push(slug);
    }
  }

  if (added.length || removed.length) {
    await logAudit({ actorId: teacher._id, action: 'course.access_changed', targetType: 'Teacher', targetId: teacher._id, metadata: { added, removed } });
    emitToTeacher(teacher._id, 'course.access_changed', { added, removed });
  }

  // Not awaited. Each one records its own outcome on the access row.
  for (const slug of added) {
    syncCourseRoster(slug).catch((err) => log({ event: 'sync_crashed', slug, error: err.message }));
  }

  return { updated: true, teacherId: String(teacher._id), added, removed, courses: [...desired.keys()] };
}

function snapshotKey(e) {
  // An enrolment that predates enrollment ids is still a student the teacher
  // must see; a stable synthetic key keeps it from being dropped or duplicated.
  return String(e.enrollmentId || `NOID-${e.userId}`).toUpperCase();
}

/**
 * Brings the stored roster of one course in line with the student portal's own
 * answer to "who is enrolled".
 *
 * Reads everyone, not one batch: this is the course-wide view. A student who is
 * stored as active but missing from an answer we really received has left the
 * course (refund, revocation) and is marked revoked. A failed read changes
 * nothing - an unreachable student portal is not an empty course, and treating
 * it as one would hide every student.
 */
export async function syncCourseRoster(slugInput) {
  const slug = normSlug(slugInput);
  const startedAt = new Date();
  const snapshot = await fetchEnrollmentSnapshot(slug);

  if (!snapshot.ok) {
    const error = `${snapshot.reason || 'FAILED'}${snapshot.error ? `: ${snapshot.error}` : ''}`.slice(0, 300);
    await CourseAccess.updateMany({ studentCourseSlug: slug }, { rosterSyncStatus: 'failed', rosterSyncError: error });
    log({ event: 'sync_failed', slug, error });
    return { ok: false, reason: snapshot.reason };
  }

  const students = (snapshot.students || []).filter((e) => e && e.userId && e.name);
  const keys = students.map(snapshotKey);
  const existing = await CourseEnrollment.find({ enrollmentId: { $in: keys } }).select('enrollmentId portalSyncedAt').lean();
  const existingByKey = new Map(existing.map((r) => [r.enrollmentId, r]));

  const ops = [];
  for (const e of students) {
    const key = snapshotKey(e);
    const row = existingByKey.get(key);
    // A push that arrived while we were reading is newer than this answer.
    if (row?.portalSyncedAt && row.portalSyncedAt >= startedAt) continue;

    const fields = {
      studentCourseSlug: slug,
      userId: String(e.userId),
      name: e.name,
      email: e.email ? String(e.email).toLowerCase() : null,
      avatarUrl: e.avatar || null,
      status: 'active',
      enrolledAt: e.enrolledAt || new Date(),
      batchId: e.batchId || null,
      batchCode: e.batchCode || null,
      portalSyncedAt: startedAt,
    };
    if (e.enrollmentNumber) fields.enrollmentNumber = e.enrollmentNumber;

    ops.push({ updateOne: { filter: { enrollmentId: key }, update: { $set: fields }, upsert: true } });
  }
  if (ops.length) await CourseEnrollment.bulkWrite(ops, { ordered: false });

  const revoked = await CourseEnrollment.updateMany(
    { studentCourseSlug: slug, status: 'active', enrollmentId: { $nin: keys }, $or: [{ portalSyncedAt: null }, { portalSyncedAt: { $lt: startedAt } }] },
    { status: 'revoked' }
  );

  await CourseAccess.updateMany({ studentCourseSlug: slug }, { rosterSyncStatus: 'synced', rosterSyncedAt: new Date(), rosterSyncError: null });

  const teachers = await CourseAccess.distinct('teacher', { studentCourseSlug: slug });
  for (const t of teachers) emitToTeacher(t, 'course.roster_updated', { slugs: [slug] });

  log({ event: 'sync_ok', slug, students: students.length, upserted: ops.length, revoked: revoked.modifiedCount });
  return { ok: true, students: students.length, revoked: revoked.modifiedCount };
}

/**
 * Applies a student's record from the student portal to the course roster.
 *
 * Runs for every record that portal sends - after each purchase, coupon, free
 * enrolment and profile edit - and acts only on courses a teacher here has been
 * assigned: a course nobody teaches here has no roster, so nothing is stored.
 * The record carries the course slug and the enrolment's own id, so a repeat or
 * a reordered pair updates one row and an older record cannot undo a newer one.
 */
export async function applyPortalRecordToRoster(record) {
  const outcome = { considered: 0, upserted: 0, stale: 0 };
  const wanted = (record.enrollments || []).filter((e) => e.courseSlug);
  if (!wanted.length) return outcome;

  const slugs = [...new Set(wanted.map((e) => normSlug(e.courseSlug)))];
  const covered = new Set(await CourseAccess.distinct('studentCourseSlug', { studentCourseSlug: { $in: slugs } }));
  if (!covered.size) return outcome;

  const syncedAt = new Date(record.sourceUpdatedAt);
  const touched = new Set();

  for (const e of wanted) {
    const slug = normSlug(e.courseSlug);
    if (!covered.has(slug)) continue;
    outcome.considered += 1;

    const key = snapshotKey({ enrollmentId: e.enrollmentId, userId: record.userId });
    const fields = {
      studentCourseSlug: slug,
      userId: String(record.userId),
      name: record.fullName,
      email: record.email ? String(record.email).toLowerCase() : null,
      status: e.status,
      enrolledAt: e.enrolledAt || new Date(),
      batchId: e.batchId || null,
      batchCode: e.batchCode || null,
      portalSyncedAt: syncedAt,
      grade: record.grade || null,
    };
    if (record.avatar) fields.avatarUrl = record.avatar;
    if (record.enrollmentNumber) fields.enrollmentNumber = record.enrollmentNumber;

    try {
      const res = await CourseEnrollment.updateOne(
        { enrollmentId: key, $or: [{ portalSyncedAt: null }, { portalSyncedAt: { $lte: syncedAt } }] },
        { $set: fields },
        { upsert: true }
      );
      if (res.upsertedCount || res.modifiedCount) {
        outcome.upserted += 1;
        touched.add(slug);
      }
    } catch (err) {
      // The row exists and holds a newer record, so the guard matched nothing
      // and the upsert tried to insert it again.
      if (err?.code === 11000) outcome.stale += 1;
      else throw err;
    }
  }

  if (touched.size) {
    const teachers = await CourseAccess.distinct('teacher', { studentCourseSlug: { $in: [...touched] } });
    for (const t of teachers) emitToTeacher(t, 'course.roster_updated', { slugs: [...touched] });
  }
  return outcome;
}

async function activeCountsBySlug(slugs) {
  if (!slugs.length) return new Map();
  const rows = await CourseEnrollment.aggregate([
    { $match: { studentCourseSlug: { $in: slugs }, status: 'active' } },
    { $group: { _id: '$studentCourseSlug', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.count]));
}

/** The courses this teacher has been assigned, with how many students each has right now. */
export async function listAccessibleCourses(teacherId) {
  const rows = await CourseAccess.find({ teacher: teacherId }).sort({ assignedAt: 1 }).lean();
  const counts = await activeCountsBySlug(rows.map((r) => r.studentCourseSlug));
  return rows.map((r) => ({
    id: String(r._id),
    studentCourseSlug: r.studentCourseSlug,
    title: r.title || r.studentCourseSlug.toUpperCase(),
    courseCode: r.studentCourseSlug.toUpperCase(),
    sources: r.sources,
    assignedAt: r.assignedAt,
    studentCount: counts.get(r.studentCourseSlug) || 0,
    rosterSyncStatus: r.rosterSyncStatus,
    rosterSyncedAt: r.rosterSyncedAt,
    rosterSyncError: r.rosterSyncError,
  }));
}

function avatarFor(name) {
  return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}&backgroundColor=22355e,ab5236,5c7a5e`;
}

/**
 * The students enrolled in one course, for a teacher assigned to it.
 *
 * A course the teacher was not assigned answers exactly as one that does not
 * exist, so the response cannot be used to learn which courses exist or who is
 * enrolled in them.
 */
export async function listCourseStudents(teacherId, slugInput, { search, page, limit, status } = {}) {
  const slug = normSlug(slugInput);
  const access = await CourseAccess.findOne({ teacher: teacherId, studentCourseSlug: slug }).lean();
  if (!access) throw ApiError.notFound('Course not found.', 'COURSE_NOT_ASSIGNED');

  const { page: p, limit: l, skip } = parsePagination({ page, limit });
  const filter = { studentCourseSlug: slug, status: status === 'revoked' ? 'revoked' : 'active' };
  if (search && String(search).trim()) {
    const q = new RegExp(escapeRegex(String(search).trim()), 'i');
    filter.$or = [{ name: q }, { email: q }, { enrollmentNumber: q }, { enrollmentId: q }];
  }

  const [rows, total, activeTotal] = await Promise.all([
    CourseEnrollment.find(filter).sort({ name: 1 }).skip(skip).limit(l).lean(),
    CourseEnrollment.countDocuments(filter),
    CourseEnrollment.countDocuments({ studentCourseSlug: slug, status: 'active' }),
  ]);

  return {
    course: {
      studentCourseSlug: slug,
      title: access.title || slug.toUpperCase(),
      studentCount: activeTotal,
      rosterSyncStatus: access.rosterSyncStatus,
      rosterSyncedAt: access.rosterSyncedAt,
      rosterSyncError: access.rosterSyncError,
    },
    students: rows.map((r) => ({
      id: String(r._id),
      enrollmentId: r.enrollmentId.startsWith('NOID-') ? null : r.enrollmentId,
      enrollmentNumber: r.enrollmentNumber || null,
      name: r.name,
      email: r.email,
      avatar: r.avatarUrl || avatarFor(r.name),
      grade: r.grade || null,
      enrolledAt: r.enrolledAt,
      batchCode: r.batchCode || null,
      status: r.status,
    })),
    meta: buildPaginationMeta({ page: p, limit: l, total }),
  };
}

/** Recovery: re-reads one assigned course from the student portal. Only for a course the teacher has. */
export async function refreshCourseRoster(teacherId, slugInput) {
  const slug = normSlug(slugInput);
  if (!(await CourseAccess.exists({ teacher: teacherId, studentCourseSlug: slug }))) {
    throw ApiError.notFound('Course not found.', 'COURSE_NOT_ASSIGNED');
  }
  const result = await syncCourseRoster(slug);
  if (!result.ok) {
    throw ApiError.serviceUnavailable(
      'Could not reach the student portal right now. Your roster was left exactly as it was - please try again in a moment.',
      'ENROLLMENT_SOURCE_UNAVAILABLE'
    );
  }
  return result;
}

export default {
  grantAccess,
  revokeAccess,
  setTeacherCourses,
  syncCourseRoster,
  applyPortalRecordToRoster,
  listAccessibleCourses,
  listCourseStudents,
  refreshCourseRoster,
};
