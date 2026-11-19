import { env } from '../config/env.js';
import { Course } from '../models/Course.js';
import { Teacher } from '../models/Teacher.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, buildPaginationMeta, parseSort } from '../utils/pagination.js';
import { withIds } from '../utils/serialize.js';
import { recordAuditLog } from './auditLog.service.js';
import { notifyAllAdmins } from './notification.service.js';
import { emitEvent } from '../sockets/index.js';
import {
  publishCourseToStudents,
  unpublishCourseFromStudents,
  fetchStudentCourseCatalog,
} from './studentCourseBridge.service.js';
import { pushCourseAssignment, removeCourseAssignment } from './teacherBridge.service.js';

const SORTABLE_FIELDS = ['title', 'code', 'department', 'status', 'rating', 'completionRate', 'createdAt'];

/** One feature per line from the multipart text field — see validators/course.validator.js. */
function parseFeatures(raw) {
  if (raw === undefined) return undefined;
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function uniqueSlugFor(title, excludeId) {
  const base = slugify(title) || 'course';
  let slug = base;
  let suffix = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await Course.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })) {
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
  return slug;
}

/** Publishes to the real student catalog when a course is APPROVED with a real price - never silently claims success. */
async function syncToStudentCatalog(course) {
  const result = await publishCourseToStudents(course);
  course.catalogSyncedAt = new Date();
  course.catalogSyncStatus = result.synced ? 'synced' : 'failed';
  await course.save();
  return result;
}

/**
 * Pushes the current course state into its assigned teacher's Teacher
 * Portal — best-effort, called on every create/update/status-change while
 * an instructor is set (not gated on governance status: the teacher needs
 * to see a course is assigned to them, even in DRAFT/PENDING_REVIEW,
 * independent of whether it is yet publicly purchasable — that gate only
 * applies to the student catalog bridge above).
 */
async function syncToAssignedTeacher(course) {
  if (!course.instructor) return undefined;
  const teacher = await Teacher.findById(course.instructor).select('email').lean();
  if (!teacher) return undefined;
  return pushCourseAssignment({
    sourceId: String(course._id),
    teacherEmail: teacher.email,
    title: course.title,
    courseCode: course.code,
    description: course.description,
    // Resolved to an absolute URL here, same as studentCourseBridge.service.js
    // does for the student-catalog leg — sending the bare relative path left
    // Teacher Portal's assigned-course image broken (course.service.js audit).
    image: course.image ? `${env.serverUrl}${course.image}` : null,
    priceInPaise: course.priceInPaise,
    status: course.status,
    // Lets the instructor see the students enrolled in a course sold under this
    // slug, the same as one assigned to them from the teacher's own profile.
    studentCourseSlug: course.slug || undefined,
  });
}

/**
 * Courses this portal owns, plus the ones the student service owns.
 *
 * Native student courses - Prarambh among them - have never had a record here:
 * the catalogue bridge only runs admin -> student, so a course seeded on the
 * student side is invisible to every admin screen that reads this collection.
 * That is the whole reason the course list, the course pickers and the coupon
 * campaign dropdown showed nothing but this portal's own courses.
 *
 * They are merged in live rather than copied, so the student service remains the
 * single definition of a native course's price. They are marked readOnly, since
 * this portal has no record to edit and editing the projection would be a lie.
 *
 * Merging happens before pagination, which means the owned set is read up to a
 * cap rather than a page at a time. At this deployment's scale (single-digit
 * courses) that is the honest trade; the cap is here so it degrades rather than
 * unbounded-reads if that ever stops being true.
 */
const MERGE_SCAN_CAP = 500;

export async function listCourses(query) {
  const { page, limit } = parsePagination(query);
  const sort = parseSort(query.sort, SORTABLE_FIELDS);

  const filter = { deletedAt: null };
  if (query.status) filter.status = query.status;
  if (query.department) filter.department = new RegExp(escapeRegex(query.department), 'i');
  if (query.instructor) filter.instructor = query.instructor;
  if (query.search) filter.$text = { $search: query.search };

  const [owned, catalog] = await Promise.all([
    Course.find(filter).sort(sort).limit(MERGE_SCAN_CAP).populate('instructor', 'name email').lean(),
    fetchStudentCourseCatalog(),
  ]);

  const ownedItems = withIds(owned).map((c) => ({ ...c, origin: 'admin-portal', readOnly: false }));

  // A slug this portal already owns is its own course; the student entry is that
  // course's projection, not a second course.
  const ownedSlugs = new Set(ownedItems.map((c) => c.slug).filter(Boolean));

  const isFiltered = Boolean(query.status || query.department || query.instructor);
  const search = String(query.search || '').trim().toLowerCase();

  const catalogItems = (catalog.courses || [])
    .filter((c) => !ownedSlugs.has(c.slug))
    // A status/department/instructor filter is asking about this portal's own
    // workflow fields, which a student-owned course does not have. Rather than
    // inventing values for it, it drops out of those filtered views.
    .filter(() => !isFiltered)
    .filter((c) => !search || `${c.title} ${c.slug}`.toLowerCase().includes(search))
    .map((c) => ({
      // Addressed by slug: this portal has no _id for it, and the slug is the
      // identifier both services already agree on.
      id: `student:${c.slug}`,
      _id: `student:${c.slug}`,
      code: c.slug.toUpperCase().slice(0, 24),
      title: c.title,
      slug: c.slug,
      category: c.category,
      description: c.description,
      priceInPaise: c.priceInPaise,
      image: c.image,
      // Review state and sale state are different axes. A course can be fully
      // approved and simply not open for enrolment yet - which is exactly what
      // GARUD and YODDHA are - and calling that ARCHIVED reads as "retired".
      status: 'APPROVED',
      isPurchasable: c.isPurchasable,
      instructor: c.instructorName ? { name: c.instructorName, email: null } : null,
      studentCourseId: c.studentCourseId,
      origin: 'student-catalog',
      readOnly: true,
      deletedAt: null,
    }));

  const merged = [...ownedItems, ...catalogItems];
  const total = merged.length;
  const start = (page - 1) * limit;

  return {
    items: merged.slice(start, start + limit),
    meta: {
      ...buildPaginationMeta({ page, limit, total }),
      // Says plainly that part of the list is missing rather than letting a
      // student-service outage look like "there are no other courses".
      catalogAvailable: catalog.ok !== false,
      catalogError: catalog.ok === false ? catalog.reason : undefined,
    },
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Slug-addressed id for a course this portal does not own - see listCourses. */
const STUDENT_ID_PREFIX = 'student:';

export async function getCourseById(id) {
  // A merged catalogue entry has no document here, so it is resolved from the
  // student service instead of 404ing the details page it appears on.
  if (String(id).startsWith(STUDENT_ID_PREFIX)) {
    const slug = String(id).slice(STUDENT_ID_PREFIX.length);
    const catalog = await fetchStudentCourseCatalog();
    if (!catalog.ok) {
      throw ApiError.serviceUnavailable(
        'The student course catalogue is unavailable right now, so this course cannot be loaded. Please try again in a moment.',
        'COURSE_CATALOG_UNAVAILABLE'
      );
    }
    const found = (catalog.courses || []).find((c) => c.slug === slug);
    if (!found) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');
    return {
      id, _id: id,
      code: found.slug.toUpperCase().slice(0, 24),
      title: found.title,
      slug: found.slug,
      category: found.category,
      description: found.description,
      priceInPaise: found.priceInPaise,
      image: found.image,
      status: 'APPROVED',
      isPurchasable: found.isPurchasable,
      instructor: found.instructorName ? { name: found.instructorName, email: null } : null,
      studentCourseId: found.studentCourseId,
      origin: 'student-catalog',
      readOnly: true,
    };
  }

  const course = await Course.findOne({ _id: id, deletedAt: null }).populate('instructor', 'name email department');
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');
  return course;
}

export async function createCourse(data, actor, req) {
  const existing = await Course.findOne({ code: data.code.toUpperCase() });
  if (existing) throw ApiError.conflict('A course with this code already exists', 'COURSE_CODE_EXISTS');

  if (data.instructor) {
    const teacher = await Teacher.findOne({ _id: data.instructor, deletedAt: null }).select('status').lean();
    if (!teacher) throw ApiError.badRequest('Invalid instructor reference', 'INVALID_TEACHER_REF');
    if (teacher.status !== 'ACTIVE') throw ApiError.badRequest('Assigned teacher is not an active faculty account', 'TEACHER_NOT_ACTIVE');
  }

  const slug = await uniqueSlugFor(data.title);
  const course = await Course.create({
    ...data,
    features: parseFeatures(data.features) || [],
    slug,
    status: 'PENDING_REVIEW',
    submittedAt: new Date(),
  });
  if (data.instructor) await Teacher.updateOne({ _id: data.instructor }, { $inc: { coursesCount: 1 } });

  await recordAuditLog({ actor, action: 'course.created', entityType: 'Course', entityId: course._id, req });
  if (course.image) {
    await recordAuditLog({ actor, action: 'course.imageUploaded', entityType: 'Course', entityId: course._id, metadata: { image: course.image }, req });
  }
  await notifyAllAdmins({
    excludeAdminId: actor._id,
    type: 'COURSE_SUBMITTED',
    title: 'New course awaiting review',
    message: `"${course.title}" (${course.code}) was submitted for governance approval.`,
    relatedEntityType: 'Course',
    relatedEntityId: course._id,
  });
  emitEvent.courseCreated(course);

  const teacherAssignment = await syncToAssignedTeacher(course);
  if (data.instructor && !teacherAssignment?.assigned) {
    await recordAuditLog({
      actor,
      action: 'course.teacherAssigned',
      entityType: 'Course',
      entityId: course._id,
      metadata: { reason: teacherAssignment?.reason || 'UNKNOWN' },
      result: 'FAILURE',
      req,
    });
  } else if (teacherAssignment?.assigned) {
    await recordAuditLog({ actor, action: 'course.teacherAssigned', entityType: 'Course', entityId: course._id, req });
  }

  return { course, teacherAssignment };
}

/**
 * Refuses a write aimed at a course this portal does not own.
 *
 * These appear in the list so they can be seen and selected; they are not
 * editable here because there is no record to edit. Accepting the write and
 * silently doing nothing would be worse than saying so.
 */
function assertOwnedCourse(id) {
  if (String(id).startsWith(STUDENT_ID_PREFIX)) {
    throw ApiError.badRequest(
      'This course is defined in the student catalogue and cannot be edited from the admin portal.',
      'COURSE_NOT_EDITABLE_HERE'
    );
  }
}

export async function updateCourse(id, data, actor, req) {
  assertOwnedCourse(id);
  const course = await Course.findOne({ _id: id, deletedAt: null });
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const instructorRemoved = data.instructor !== undefined && !data.instructor && course.instructor;
  if (data.instructor !== undefined && String(data.instructor) !== String(course.instructor || '')) {
    if (data.instructor) {
      const teacher = await Teacher.findOne({ _id: data.instructor, deletedAt: null }).select('status').lean();
      if (!teacher) throw ApiError.badRequest('Invalid instructor reference', 'INVALID_TEACHER_REF');
      if (teacher.status !== 'ACTIVE') throw ApiError.badRequest('Assigned teacher is not an active faculty account', 'TEACHER_NOT_ACTIVE');
      await Teacher.updateOne({ _id: data.instructor }, { $inc: { coursesCount: 1 } });
    }
    if (course.instructor) await Teacher.updateOne({ _id: course.instructor }, { $inc: { coursesCount: -1 } });
  }

  const { features, ...rest } = data;
  const imageChanged = data.image !== undefined && data.image !== course.image;
  Object.assign(course, rest);
  if (features !== undefined) course.features = parseFeatures(features);
  await course.save();

  await recordAuditLog({ actor, action: 'course.updated', entityType: 'Course', entityId: course._id, metadata: { fields: Object.keys(data) }, req });
  if (imageChanged) {
    await recordAuditLog({ actor, action: 'course.imageUploaded', entityType: 'Course', entityId: course._id, metadata: { image: course.image }, req });
  }
  emitEvent.courseUpdated(course);

  // Keep an already-live catalog listing in sync (price/description/image
  // edits after approval) - a no-op if it was never approved/synced.
  if (course.status === 'APPROVED' && course.catalogSyncStatus === 'synced') {
    await syncToStudentCatalog(course);
  }

  // Keep the assigned teacher's Teacher Portal view in sync — either a
  // fresh/updated assignment (new teacher or unchanged teacher with edited
  // fields), or an explicit removal when the instructor was cleared.
  //
  // The result is RETURNED, not discarded. This previously called the bridge
  // and threw the answer away, so an admin who re-saved a course to retry a
  // failed assignment got an unqualified success either way - no audit entry,
  // no message, no way to tell whether the teacher had actually received it.
  // The local save is deliberately kept: the course edit genuinely succeeded,
  // and rolling it back would lose real work over a downstream outage. The
  // caller reports the two outcomes separately.
  let teacherAssignment;
  if (course.instructor) {
    teacherAssignment = await syncToAssignedTeacher(course);
    if (!teacherAssignment?.assigned) {
      await recordAuditLog({
        actor,
        action: 'course.teacherAssigned',
        entityType: 'Course',
        entityId: course._id,
        metadata: { reason: teacherAssignment?.reason || 'UNKNOWN' },
        result: 'FAILURE',
        req,
      });
    }
  } else if (instructorRemoved) {
    await removeCourseAssignment(String(course._id));
  }

  return { course, teacherAssignment };
}

export async function setCourseStatus(id, { status, notes }, actor, req) {
  assertOwnedCourse(id);
  const course = await Course.findOne({ _id: id, deletedAt: null });
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const wasSynced = course.catalogSyncStatus === 'synced';
  course.status = status;
  if (notes) course.notes = notes;
  course.reviewedAt = new Date();
  course.reviewedBy = actor?._id;
  await course.save();

  await recordAuditLog({ actor, action: `course.status.${status.toLowerCase()}`, entityType: 'Course', entityId: course._id, metadata: { notes }, req });
  await notifyAllAdmins({
    excludeAdminId: actor._id,
    type: 'COURSE_STATUS',
    title: `Course ${status.toLowerCase().replace('_', ' ')}`,
    message: `"${course.title}" (${course.code}) was marked ${status.toLowerCase().replace('_', ' ')}.`,
    relatedEntityType: 'Course',
    relatedEntityId: course._id,
  });

  let catalogSync;
  if (status === 'APPROVED') {
    catalogSync = await syncToStudentCatalog(course);
    emitEvent.coursePublished(course);
  } else if (wasSynced) {
    // Never delete on the student side (students may already own it) - only unpublish it from new purchases.
    await unpublishCourseFromStudents(String(course._id));
    course.catalogSyncStatus = null;
    await course.save();
  }
  emitEvent.courseUpdated(course);

  // The assigned teacher should see the real governance status too (e.g.
  // still PENDING_REVIEW vs. now APPROVED), independent of the student
  // catalog gate above.
  if (course.instructor) await syncToAssignedTeacher(course);

  return { course, catalogSync };
}

export async function deleteCourse(id, actor, req) {
  assertOwnedCourse(id);
  const course = await Course.findOne({ _id: id, deletedAt: null });
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const wasSynced = course.catalogSyncStatus === 'synced';
  course.deletedAt = new Date();
  course.status = 'ARCHIVED';
  await course.save();
  if (course.instructor) {
    await Teacher.updateOne({ _id: course.instructor }, { $inc: { coursesCount: -1 } });
    await removeCourseAssignment(String(course._id));
  }

  // A course deleted directly (not via the status-change path) must not
  // stay live/purchasable on the student catalog forever — never delete on
  // that side (students may already own it), only unpublish new purchases,
  // same as setCourseStatus's non-APPROVED transition above.
  if (wasSynced) {
    await unpublishCourseFromStudents(String(course._id));
    course.catalogSyncStatus = null;
    await course.save();
  }

  await recordAuditLog({ actor, action: 'course.deleted', entityType: 'Course', entityId: course._id, req });
  emitEvent.courseDeleted(course._id);
  return course;
}

export default { listCourses, getCourseById, createCourse, updateCourse, setCourseStatus, deleteCourse };
