import { AssignedCourse } from '../models/AssignedCourse.js';
import { User } from '../models/User.js';
import { Teacher } from '../models/Teacher.js';
import { emitToTeacher } from '../sockets/index.js';
import { notifyTeacher } from './notification.service.js';
import { grantAccess, revokeAccess, syncCourseRoster, listAccessibleCourses } from './courseRoster.service.js';

function shape(doc) {
  return {
    id: doc._id,
    sourceId: doc.sourceId,
    studentCourseSlug: doc.studentCourseSlug || null,
    title: doc.title,
    courseCode: doc.courseCode,
    description: doc.description,
    image: doc.image,
    priceInPaise: doc.priceInPaise,
    status: doc.status,
    assignedAt: doc.assignedAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Upserts an admin-pushed course assignment by `sourceId` (admin's Course
 * _id) — a single call handles create, field updates, AND reassignment to
 * a different teacher, since changing the `teacher` field on the same row
 * is all reassignment requires (the old teacher's list query simply no
 * longer matches it). Resolves the teacher by email because admin/backend
 * and this service have no shared ObjectId space for the same human.
 * Never throws — a missing/unmatched teacher is a legitimate outcome the
 * caller (admin's course.service.js) surfaces as a warning, not a crash.
 */
export async function assignCourse({ teacherEmail, sourceId, title, courseCode, description, image, priceInPaise, status, studentCourseSlug }) {
  const user = await User.findOne({ email: teacherEmail.toLowerCase().trim(), role: 'teacher' });
  if (!user) return { assigned: false, reason: 'TEACHER_NOT_FOUND' };

  const teacher = await Teacher.findOne({ user: user._id });
  if (!teacher) return { assigned: false, reason: 'TEACHER_PROFILE_MISSING' };

  const previous = await AssignedCourse.findOne({ sourceId }).select('teacher studentCourseSlug').lean();
  const isNew = !previous;
  const wasReassigned = Boolean(previous) && String(previous.teacher) !== String(teacher._id);
  const slug = studentCourseSlug ? String(studentCourseSlug).trim().toLowerCase() : null;

  const doc = await AssignedCourse.findOneAndUpdate(
    { sourceId },
    {
      teacher: teacher._id,
      title,
      courseCode: courseCode || null,
      description: description || '',
      image: image || null,
      priceInPaise: priceInPaise || 0,
      status: status || 'PENDING_REVIEW',
      studentCourseSlug: slug,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Being instructor of a course that is sold under a catalogue slug also gives
  // the teacher that course's students. The previous instructor loses them, and a
  // change of slug moves them, in the same step.
  if (previous?.studentCourseSlug && (wasReassigned || previous.studentCourseSlug !== slug)) {
    await revokeAccess(previous.teacher, { slug: previous.studentCourseSlug, source: 'course-instructor' });
  }
  if (slug) {
    const { created } = await grantAccess(teacher._id, { slug, title, source: 'course-instructor' });
    if (created) syncCourseRoster(slug).catch((err) => console.error('[assignedCourse] roster sync failed:', err.message));
  }

  emitToTeacher(teacher._id, 'course.assigned', shape(doc));

  // A teacher not connected at the exact moment admin assigns/reassigns a
  // course to them would otherwise never learn about it - the same
  // notification-persistence gap already fixed on every other bridge
  // ingest path in this project.
  if (isNew || wasReassigned) {
    await notifyTeacher(teacher._id, {
      type: 'system',
      title: 'New course assigned to you',
      message: `"${doc.title}"${doc.courseCode ? ` (${doc.courseCode})` : ''} has been assigned to you.`,
      relatedEntityType: 'AssignedCourse',
      relatedEntityId: doc._id,
    });
  }

  return { assigned: true, teacherId: String(teacher._id) };
}

export async function unassignCourse(sourceId) {
  const doc = await AssignedCourse.findOneAndDelete({ sourceId });
  if (doc?.studentCourseSlug) await revokeAccess(doc.teacher, { slug: doc.studentCourseSlug, source: 'course-instructor' });
  if (doc) emitToTeacher(doc.teacher, 'course.unassigned', { sourceId });
  return { removed: Boolean(doc) };
}

/**
 * Everything assigned to this teacher: the courses an administrator authored and
 * named them instructor of, and the catalogue courses (PRARAMBH, GARUD, YODDHA)
 * assigned to them directly. Each carries how many students are enrolled right
 * now, which is read from the course roster rather than copied onto the course.
 */
export async function listAssignedCourses(teacherId) {
  const [docs, access] = await Promise.all([
    AssignedCourse.find({ teacher: teacherId }).sort({ createdAt: -1 }).lean(),
    listAccessibleCourses(teacherId),
  ]);
  const accessBySlug = new Map(access.map((a) => [a.studentCourseSlug, a]));
  const covered = new Set();

  const authored = docs.map((d) => {
    const a = d.studentCourseSlug ? accessBySlug.get(d.studentCourseSlug) : null;
    if (a) covered.add(a.studentCourseSlug);
    return {
      ...shape(d),
      kind: 'authored',
      studentCount: a ? a.studentCount : null,
      rosterSyncStatus: a ? a.rosterSyncStatus : null,
    };
  });

  const catalogue = access
    .filter((a) => !covered.has(a.studentCourseSlug))
    .map((a) => ({
      id: a.id,
      sourceId: null,
      studentCourseSlug: a.studentCourseSlug,
      title: a.title,
      courseCode: a.courseCode,
      description: '',
      image: null,
      priceInPaise: 0,
      status: 'ASSIGNED',
      assignedAt: a.assignedAt,
      updatedAt: a.assignedAt,
      kind: 'catalogue',
      studentCount: a.studentCount,
      rosterSyncStatus: a.rosterSyncStatus,
      rosterSyncedAt: a.rosterSyncedAt,
      rosterSyncError: a.rosterSyncError,
    }));

  return [...catalogue, ...authored];
}

export default { assignCourse, unassignCourse, listAssignedCourses };
