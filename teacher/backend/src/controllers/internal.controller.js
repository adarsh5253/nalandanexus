import { catchAsync } from '../utils/catchAsync.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { resolveTeacherForCourseSlug, deliverExternalStudentMessage } from '../services/externalMessage.service.js';
import { placeEnrollment } from '../services/batchPlacement.service.js';
import * as adminBatch from '../services/adminBatch.service.js';
import { createTeacherAccount, issuePasswordSetupLink, resetCredentials, setAccountStatus } from '../services/auth.service.js';
import { setTeacherCourses } from '../services/courseRoster.service.js';
import { env } from '../config/env.js';
import { assignCourse, unassignCourse } from '../services/assignedCourse.service.js';
import { AdminAnnouncement } from '../models/AdminAnnouncement.js';
import { Teacher } from '../models/Teacher.js';
import { Notification } from '../models/Notification.js';
import { emitToAllTeachers, emitToTeacher } from '../sockets/index.js';
import { receiveBridgedSubmission } from '../services/submission.service.js';
import { receiveBridgedQuizResult } from '../services/exam.service.js';
import { applyPortalStudent } from '../services/portalStudentSync.service.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Persists a real, per-teacher Notification for every active teacher — the
 * `announcement:admin` socket broadcast alone only reaches a teacher who
 * happens to be connected at that exact instant; a teacher who logs in
 * later would otherwise never learn the announcement existed. Mirrors
 * notifyEnrolledStudents on the student-portal side (built for the same
 * "resource upload never notified anyone" gap).
 */
async function notifyAllTeachersOfAdminAnnouncement(announcement) {
  const teacherIds = await Teacher.find({ accountStatus: 'active' }).distinct('_id');
  if (!teacherIds.length) return;

  const docs = teacherIds.map((recipient) => ({
    recipient,
    type: 'announcement',
    title: `New announcement: "${announcement.title}"`,
    message: announcement.content.length > 140 ? `${announcement.content.slice(0, 140)}…` : announcement.content,
    relatedEntityType: 'AdminAnnouncement',
    relatedEntityId: announcement._id,
  }));
  const created = await Notification.insertMany(docs);

  created.forEach((n) => {
    emitToTeacher(n.recipient, 'notification.created', {
      id: n._id,
      type: n.type,
      title: n.title,
      message: n.message,
      isRead: n.isRead,
      relatedEntityType: n.relatedEntityType,
      relatedEntityId: n.relatedEntityId,
      createdAt: n.createdAt,
    });
  });
}

export const getTeacherForCourse = catchAsync(async (req, res) => {
  const resolved = await resolveTeacherForCourseSlug(req.params.studentCourseSlug, { batchId: req.query.batchId });
  sendSuccess(res, { data: resolved });
});

/**
 * Called by admin/backend right after it creates its own governance Teacher
 * record, to actually provision the real login here.
 *
 * Admin sends the SHA-256 of a setup-link token and its expiry; no password
 * travels at all, and the account is given a random one nobody knows. The
 * person chooses their own through the emailed link (auth.service.js
 * #completePasswordSetup). The older `tempPassword` form is still accepted so an
 * Admin deployment that has not been updated keeps working; `mustChangePassword`
 * is derived here, never client-supplied, so that path can only ever create a
 * forced-reset account.
 */
export const provisionTeacher = catchAsync(async (req, res) => {
  const { name, email, phone, tempPassword, title, department, subject, teacherId: requestedTeacherId, avatarUrl, setupTokenHash, setupTokenExpiresAt } = req.body;
  const setup = setupTokenHash ? { tokenHash: setupTokenHash, expiresAt: new Date(setupTokenExpiresAt) } : null;
  const { user, teacher } = await createTeacherAccount({
    name,
    email,
    // With a setup link the account is given a random password nobody knows and
    // the person chooses their own; the legacy temp-password path still forces a
    // change at first login.
    password: setup ? undefined : tempPassword,
    phone,
    title,
    department,
    subject,
    requestedTeacherId,
    avatarUrl,
    setup,
    mustChangePassword: !setup,
  });
  sendSuccess(res, {
    statusCode: 201,
    message: 'Teacher account provisioned.',
    // The Teacher ID actually issued (it can differ from the one requested) and
    // where this portal lives, so the onboarding email links to the real login
    // page rather than to this API.
    data: { userId: user._id, teacherId: teacher._id, teacherCode: teacher.teacherId, portalUrl: portalUrl() },
  });
});

/** The Teacher Portal's own address - CLIENT_URL here is the origin its frontend is served from. */
function portalUrl() {
  return String(env.clientUrl || '').split(',')[0].trim().replace(/\/+$/, '') || null;
}

/**
 * Replaces the set of courses an administrator has assigned to one teacher, and
 * starts loading the students enrolled in any newly added course. A teacher who
 * is not found is an outcome, not an error - Admin reports it as a warning.
 */
export const setCoursesForTeacher = catchAsync(async (req, res) => {
  const result = await setTeacherCourses({ teacherEmail: req.body.teacherEmail, courses: req.body.courses });
  sendSuccess(res, { message: result.updated ? 'Courses assigned.' : 'Not assigned.', data: result });
});

export const deliverMessage = catchAsync(async (req, res) => {
  const result = await deliverExternalStudentMessage(req.body);
  if (!result) {
    return sendSuccess(res, { statusCode: 200, message: 'No matching teacher for this course - not delivered.', data: null });
  }
  sendSuccess(res, { statusCode: 201, message: 'Delivered to teacher.', data: result });
});

/**
 * The "Resend Credentials" backend leg — called by admin/backend when an
 * admin resends a teacher's login credentials. Resets the REAL password on
 * this backend's own User record (the one that actually authenticates
 * Teacher Portal logins); admin's own Teacher.passwordHash is a separate,
 * cosmetic governance-record copy that admin updates on its own side.
 */
export const resetTeacherCredentials = catchAsync(async (req, res) => {
  const { email, newPassword, setupTokenHash, setupTokenExpiresAt } = req.body;
  // A setup link replaces the pending one and changes nothing else; the legacy
  // temp-password reset is kept only so an older Admin deployment still works.
  const { user, teacher } = setupTokenHash
    ? await issuePasswordSetupLink({ email, tokenHash: setupTokenHash, expiresAt: new Date(setupTokenExpiresAt) })
    : await resetCredentials({ email, newPassword });
  sendSuccess(res, {
    message: setupTokenHash ? 'Password setup link issued.' : 'Teacher credentials reset.',
    data: { userId: user._id, teacherId: teacher._id, teacherCode: teacher.teacherId, portalUrl: portalUrl() },
  });
});

/**
 * Deactivates or reactivates the real Teacher Portal login - called when
 * admin deletes/restores a teacher on its own side (see
 * auth.service.js#setAccountStatus's doc-comment for the gap this closes).
 * Never throws on a not-found account - admin may delete a teacher whose
 * portal account was never fully provisioned.
 */
export const setTeacherAccountStatus = catchAsync(async (req, res) => {
  const { email, status } = req.body;
  const result = await setAccountStatus({ email, status });
  sendSuccess(res, { message: result.found ? `Account ${status}.` : 'No matching account.', data: result });
});

/**
 * Upserts a lightweight, read-only mirror of an admin-authored commerce
 * course into THIS teacher's "assigned to me" list, resolved by email since
 * admin/backend and teacher/backend have no shared ObjectId space for
 * teachers (see models/AssignedCourse.js). Never throws to the caller on a
 * missing teacher — that's a legitimate, expected outcome (e.g. the admin
 * assigned a teacher whose email doesn't match an active Teacher Portal
 * account yet), not a server error.
 */
export const upsertAssignedCourse = catchAsync(async (req, res) => {
  const result = await assignCourse({ ...req.body, sourceId: req.params.sourceId });
  sendSuccess(res, { statusCode: 200, message: result.assigned ? 'Course assigned.' : 'Not assigned.', data: result });
});

export const removeAssignedCourse = catchAsync(async (req, res) => {
  await unassignCourse(req.params.sourceId);
  sendSuccess(res, { message: 'Course unassigned.', data: null });
});

/**
 * Receives an Admin-broadcast announcement (audience 'ALL' or 'TEACHERS')
 * into the read-only AdminAnnouncement mirror and pushes it live to every
 * connected teacher — the receiving leg that never existed before (admin
 * could previously only broadcast to students, never to teachers).
 * Idempotent on `sourceId` (admin's own Announcement _id).
 */
export const upsertAdminAnnouncement = catchAsync(async (req, res) => {
  const { sourceId, title, content, priority, authorName, publishedAt } = req.body;

  const existing = await AdminAnnouncement.findOne({ sourceId });
  if (existing) {
    return sendSuccess(res, { statusCode: 200, message: 'Already delivered.', data: existing });
  }

  const announcement = await AdminAnnouncement.create({
    sourceId,
    title,
    content,
    priority: priority || 'MEDIUM',
    authorName: authorName || null,
    publishedAt: publishedAt || new Date(),
  });

  emitToAllTeachers('announcement:admin', announcement);
  await notifyAllTeachersOfAdminAnnouncement(announcement);

  sendSuccess(res, { statusCode: 201, message: 'Delivered to teachers.', data: announcement });
});

export const removeAdminAnnouncement = catchAsync(async (req, res) => {
  const announcement = await AdminAnnouncement.findOneAndDelete({ sourceId: req.params.sourceId });
  if (!announcement) {
    return sendSuccess(res, { message: 'Already removed.', data: { sourceId: req.params.sourceId } });
  }
  emitToAllTeachers('announcement:admin_removed', { sourceId: req.params.sourceId });
  sendSuccess(res, { message: 'Removed.', data: { id: announcement._id } });
});

/**
 * Receives a real student submission for a bridged assignment (Task on the
 * student side) - the missing return leg of the task bridge (see
 * submission.service.js#receiveBridgedSubmission's doc-comment). Never
 * throws to the caller on a not-found assignment - a stale/retracted
 * assignment is a legitimate, expected outcome, not a server error.
 */
export const receiveSubmission = catchAsync(async (req, res) => {
  const result = await receiveBridgedSubmission(req.body);
  sendSuccess(res, { statusCode: result.recorded ? 201 : 200, message: result.recorded ? 'Submission recorded.' : 'Not recorded.', data: result });
});

/**
 * Receives a real, server-graded quiz result for a bridged exam - the
 * missing return leg of the quiz bridge (see exam.service.js
 * #receiveBridgedQuizResult's doc-comment). Never throws on a not-found
 * exam - a stale/retracted exam is a legitimate outcome, not a server error.
 */
export const receiveQuizResult = catchAsync(async (req, res) => {
  const result = await receiveBridgedQuizResult(req.body);
  sendSuccess(res, { statusCode: result.recorded ? 201 : 200, message: result.recorded ? 'Result recorded.' : 'Not recorded.', data: result });
});

/**
 * Places a paid enrollment into a batch of its course.
 *
 * Called by the student portal at purchase time: it owns the enrollment but not
 * the batches, their capacity, or their teachers, all of which live here.
 *
 * A course with no batch that has room returns 200 with `data: null`, not an
 * error - "every batch is full, open another one" is a real business state, and
 * a student who has already paid must not see their purchase fail because of it.
 */
export const placeEnrollmentInBatch = catchAsync(async (req, res) => {
  const placement = await placeEnrollment({
    studentCourseSlug: req.body.studentCourseSlug,
    enrollmentId: req.body.enrollmentId,
    studentName: req.body.studentName,
  });
  sendSuccess(res, {
    message: placement ? 'Enrollment placed in a batch.' : 'No batch of this course has room right now.',
    data: placement,
  });
});

/**
 * PUT /api/internal/portal-students/:userId
 *
 * A student's current record from the student portal, sent after they enrol and
 * whenever their profile changes. Updates - and verifies or withdraws - the
 * roster rows placement created for their enrolments; never creates one.
 */
export const applyPortalStudentRecord = catchAsync(async (req, res) => {
  if (req.body.userId !== req.params.userId) {
    throw ApiError.badRequest('The student in the body does not match the address.', 'USER_ID_MISMATCH');
  }
  const result = await applyPortalStudent(req.body);
  sendSuccess(res, {
    message: result.matched ? 'Roster updated from the student portal.' : 'This student is on no roster here yet.',
    data: result,
  });
});

/**
 * Batch administration for the Admin portal.
 *
 * Batches live in this service's database, so Admin reaches them over the same
 * shared-secret bridge it already uses. Every mutation delegates to the service
 * layer a teacher's own requests go through, so course validation, the update
 * allow-list and the audit trail are identical whichever portal called.
 */
export const adminListBatches = catchAsync(async (req, res) => {
  const { batches, catalogAvailable } = await adminBatch.listAllBatches(req.query);
  sendSuccess(res, { data: batches, meta: { catalogAvailable } });
});

export const adminGetBatch = catchAsync(async (req, res) => {
  sendSuccess(res, { data: await adminBatch.getBatchForAdmin(req.params.id) });
});

export const adminCreateBatch = catchAsync(async (req, res) => {
  const batch = await adminBatch.createBatchForAdmin(req.body, { adminEmail: req.body.actorEmail, ip: req.ip });
  sendSuccess(res, { statusCode: 201, message: 'Batch created.', data: batch });
});

export const adminUpdateBatch = catchAsync(async (req, res) => {
  const { actorEmail, ...updates } = req.body;
  const batch = await adminBatch.updateBatchForAdmin(req.params.id, updates, { adminEmail: actorEmail, ip: req.ip });
  sendSuccess(res, { message: 'Batch updated.', data: batch });
});

export const adminReassignBatchTeacher = catchAsync(async (req, res) => {
  const batch = await adminBatch.reassignBatchTeacher(req.params.id, req.body.teacherEmail, {
    adminEmail: req.body.actorEmail,
    ip: req.ip,
  });
  sendSuccess(res, { message: 'Batch reassigned.', data: batch });
});

export const adminListBatchStudents = catchAsync(async (req, res) => {
  sendSuccess(res, { data: await adminBatch.listBatchStudentsForAdmin(req.params.id) });
});

export default {
  adminListBatches,
  adminGetBatch,
  adminCreateBatch,
  adminUpdateBatch,
  adminReassignBatchTeacher,
  adminListBatchStudents,
  placeEnrollmentInBatch,
  applyPortalStudentRecord,
  getTeacherForCourse,
  deliverMessage,
  resetTeacherCredentials,
  setTeacherAccountStatus,
  upsertAssignedCourse,
  removeAssignedCourse,
  upsertAdminAnnouncement,
  receiveSubmission,
  receiveQuizResult,
  removeAdminAnnouncement,
};
