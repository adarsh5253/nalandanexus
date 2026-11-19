import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { AppError } from '../utils/AppError.js';
import { Announcement } from '../models/Announcement.js';
import { Course } from '../models/Course.js';
import { Coupon } from '../models/Coupon.js';
import {
  createCampaign,
  summarizeCampaigns,
  shapeCampaignForAdmin,
  shapeCouponForAdmin,
} from '../services/coupon.service.js';
import { CouponCampaign } from '../models/CouponCampaign.js';
import { CourseMaterial } from '../models/CourseMaterial.js';
import { Resource } from '../models/Resource.js';
import { Faculty } from '../models/Faculty.js';
import { Task } from '../models/Task.js';
import { LiveClass } from '../models/LiveClass.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';
import { ProgressionEvent } from '../models/ProgressionEvent.js';
import { Quiz } from '../models/Quiz.js';
import { Enrollment } from '../models/Enrollment.js';
import { Notification } from '../models/Notification.js';
import { TaskSubmission } from '../models/TaskSubmission.js';
import { StudentProfile } from '../models/StudentProfile.js';
import { findStudentByEnrollmentNumber } from '../services/studentProfile.service.js';
import { resyncPortalStudents as runPortalResync } from '../services/portalSync.service.js';
import { createAnnouncement as createAnnouncementService } from '../services/announcement.service.js';

/**
 * Resolves a teacher-supplied `studentCourseSlug` to a real Course _id,
 * server-side — the bridge payload is trusted for WHAT to deliver (title,
 * file, etc.) but never for WHICH course, same as every other internal
 * endpoint here. Returns null (not an error) when the slug doesn't match
 * any published course, so a stale/typo'd link just silently doesn't
 * bridge rather than 500ing the caller's primary flow.
 */
async function resolveCourseIdFromSlug(slug) {
  if (!slug) return null;
  const course = await Course.findOne({ slug, isPublished: true }).select('_id');
  return course?._id || null;
}

/**
 * Receives a just-published announcement from the teacher backend's
 * cross-portal bridge (see teacher/backend/src/services/studentBridge.service.js)
 * and delivers it exactly the way a native admin-authored one is delivered
 * - persisted here, then pushed live to every connected student via the
 * same `createAnnouncement` service/socket path `POST /api/admin/announcements`
 * already uses. Idempotent on `sourceId` (the teacher portal's own
 * Announcement _id): a retried delivery must not create a duplicate.
 */
export const createBridgedAnnouncement = asyncHandler(async (req, res) => {
  const { title, content, type, publishAt, expiresAt, sourceId, authorName, courseSlugs, source } = req.body;
  const resolvedSource = source || 'teacher-portal';

  if (sourceId) {
    const existing = await Announcement.findOne({ source: resolvedSource, sourceId });
    if (existing) {
      return sendSuccess(res, { status: 200, message: 'Already delivered.', data: existing });
    }
  }

  const courseIds = (
    await Promise.all((courseSlugs || []).map((slug) => resolveCourseIdFromSlug(slug)))
  ).filter(Boolean);

  const announcement = await createAnnouncementService({
    title,
    content,
    type: type || 'general',
    publishAt,
    expiresAt: expiresAt || null,
    source: resolvedSource,
    sourceId: sourceId || null,
    externalAuthorName: authorName || null,
    courseIds,
  });

  return sendSuccess(res, { status: 201, message: 'Delivered to students.', data: announcement });
});

// A bridged announcement's sourceId is a real MongoDB ObjectId minted by
// whichever portal authored it (teacher or admin) - collision between the
// two is not a practical concern, so update/retract match on sourceId
// across BOTH bridged sources rather than requiring the caller to also
// name which one, which keeps this endpoint correct for admin-originated
// announcements too even though only teacher/backend calls it today.
const BRIDGED_SOURCES = ['teacher-portal', 'admin-portal'];

export const updateBridgedAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findOneAndUpdate(
    { source: { $in: BRIDGED_SOURCES }, sourceId: req.params.sourceId },
    { $set: req.body },
    { new: true }
  );
  if (!announcement) throw AppError.notFound('No bridged announcement with that source id.', 'ANNOUNCEMENT_NOT_FOUND');
  return sendSuccess(res, { message: 'Updated.', data: announcement });
});

/** Retracts (deletes) a bridged announcement — used when the teacher/admin archives or deletes the source. Idempotent: retracting twice is not an error. */
export const deleteBridgedAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findOneAndDelete({ source: { $in: BRIDGED_SOURCES }, sourceId: req.params.sourceId });
  if (!announcement) {
    return sendSuccess(res, { message: 'Already removed.', data: { sourceId: req.params.sourceId } });
  }
  return sendSuccess(res, { message: 'Removed.', data: { id: announcement._id } });
});

// --- Course materials (teacher-uploaded resources) ------------------------

/**
 * Receives a just-uploaded resource from the teacher backend's cross-portal
 * bridge (teacher/backend/src/services/studentBridge.service.js). Silently
 * no-ops (200, not delivered) when the class has no linked student course -
 * the teacher-side upload already succeeded and is the source of truth; a
 * missing link is a configuration gap, not a failure to report. Idempotent
 * on `sourceId` (the teacher portal's own Resource _id).
 */
export const createBridgedMaterial = asyncHandler(async (req, res) => {
  const { studentCourseSlug, title, moduleTitle, uploadedByName, fileUrl, fileName, fileType, fileSizeBytes, sourceId } = req.body;

  const existing = await CourseMaterial.findOne({ source: 'teacher-portal', sourceId });
  if (existing) {
    return sendSuccess(res, { status: 200, message: 'Already delivered.', data: existing });
  }

  const courseId = await resolveCourseIdFromSlug(studentCourseSlug);
  if (!courseId) {
    return sendSuccess(res, { status: 200, message: 'No matching student course - not delivered.', data: null });
  }

  const material = await CourseMaterial.create({
    courseId,
    title,
    moduleTitle,
    uploadedByName,
    fileUrl,
    fileName,
    fileType,
    fileSizeBytes,
    source: 'teacher-portal',
    sourceId,
  });

  try {
    const { emitToCourse } = await import('../sockets/index.js');
    emitToCourse(courseId, 'course:notes_added', { id: material._id, title: material.title, courseId: String(courseId) });
  } catch {
    // socket layer optional - never break the bridge delivery itself
  }

  await notifyEnrolledStudents(courseId, {
    title: `New resource: "${title}"`,
    description: uploadedByName ? `${uploadedByName} uploaded a new resource for your course.` : 'A new resource is available for your course.',
    link: '/student/notes',
  });

  return sendSuccess(res, { status: 201, message: 'Delivered to students.', data: material });
});

/** Retracts (deletes) a bridged material — used when the teacher deletes the source resource. Idempotent. */
export const deleteBridgedMaterial = asyncHandler(async (req, res) => {
  const material = await CourseMaterial.findOneAndDelete({ source: 'teacher-portal', sourceId: req.params.sourceId });
  if (!material) {
    return sendSuccess(res, { message: 'Already removed.', data: { sourceId: req.params.sourceId } });
  }
  return sendSuccess(res, { message: 'Removed.', data: { id: material._id } });
});

// --- Tasks (teacher-authored assignments) ---------------------------------

/**
 * Upserts a bridged task by `sourceId` (the teacher portal's Assignment
 * _id) — handles both first delivery and subsequent edits (title/dueDate
 * changes) with one idempotent call, unlike the announcement/material
 * bridges which split create vs update. `taskId` (this collection's own
 * unique human-readable key) is derived from `sourceId` since a bridged
 * task has no natural slug of its own.
 */
export const upsertBridgedTask = asyncHandler(async (req, res) => {
  const { studentCourseSlug, title, description, moduleTitle, dueDate, pointsReward, sourceId } = req.body;

  const courseId = await resolveCourseIdFromSlug(studentCourseSlug);
  if (!courseId) {
    return sendSuccess(res, { status: 200, message: 'No matching student course - not delivered.', data: null });
  }

  const isNew = !(await Task.exists({ source: 'teacher-portal', sourceId }));
  const task = await Task.findOneAndUpdate(
    { source: 'teacher-portal', sourceId },
    {
      taskId: `teacher-${sourceId}`,
      courseId,
      title,
      type: 'Task',
      description,
      moduleTitle,
      dueDate,
      pointsReward,
      isPublished: true,
      source: 'teacher-portal',
      sourceId,
    },
    { upsert: true, new: true }
  );

  if (isNew) {
    try {
      const { emitToCourse } = await import('../sockets/index.js');
      emitToCourse(courseId, 'course:task_created', { id: task._id, title: task.title, courseId: String(courseId) });
    } catch {
      // socket layer optional
    }
    await notifyEnrolledStudents(courseId, {
      title: `New assignment: "${task.title}"`,
      description: 'A new assignment has been posted for your course.',
      link: '/student/tasks',
    });
  }

  return sendSuccess(res, { status: isNew ? 201 : 200, message: isNew ? 'Delivered to students.' : 'Updated.', data: task });
});

/** Retracts (unpublishes) a bridged task — used when the teacher archives the source assignment. Idempotent. */
export const retractBridgedTask = asyncHandler(async (req, res) => {
  const task = await Task.findOneAndUpdate(
    { source: 'teacher-portal', sourceId: req.params.sourceId },
    { isPublished: false },
    { new: true }
  );
  if (!task) {
    return sendSuccess(res, { message: 'Already removed.', data: { sourceId: req.params.sourceId } });
  }
  return sendSuccess(res, { message: 'Removed.', data: { id: task._id } });
});

/**
 * Creates a real, persisted Notification for every actively-enrolled
 * student in a course and pushes it live — the shared helper behind both
 * the reschedule and cancellation paths below, so a student is actively
 * told about a real disruption to their schedule rather than just seeing
 * their dashboard silently re-render.
 */
async function notifyEnrolledStudents(courseId, { title, description, link }) {
  if (!courseId) return;
  const enrollments = await Enrollment.find({ courseId, status: 'active' }).select('userId').lean();
  if (!enrollments.length) return;
  const docs = enrollments.map((e) => ({ userId: e.userId, title, description, type: 'course', link: link || null }));
  const created = await Notification.insertMany(docs);
  try {
    const { emitNotificationCreated } = await import('../sockets/index.js');
    created.forEach((n) => emitNotificationCreated(n.userId, n));
  } catch {
    // socket layer optional
  }
}

// --- Live classes (YouTube lectures) ---------------------------------------

/** Delivers a newly-scheduled teacher-portal live session. Idempotent on `sourceId` (the ClassSession _id). */
export const createBridgedLiveClass = asyncHandler(async (req, res) => {
  const { studentCourseSlug, batchId, title, instructor, scheduledAt, durationMinutes, joinUrl, sourceId } = req.body;

  const existing = await LiveClass.findOne({ source: 'teacher-portal', sourceId });
  if (existing) {
    return sendSuccess(res, { status: 200, message: 'Already delivered.', data: existing });
  }

  const courseId = await resolveCourseIdFromSlug(studentCourseSlug);
  if (!courseId) {
    return sendSuccess(res, { status: 200, message: 'No matching student course - not delivered.', data: null });
  }

  const liveClass = await LiveClass.create({
    courseId,
    batchId: batchId || null,
    title,
    instructor,
    scheduledAt,
    durationMinutes,
    joinUrl,
    status: 'upcoming',
    isPublished: true,
    source: 'teacher-portal',
    sourceId,
  });

  try {
    const { emitToCourse } = await import('../sockets/index.js');
    emitToCourse(courseId, 'course:lecture_created', { id: liveClass._id, title: liveClass.title, courseId: String(courseId) });
  } catch {
    // socket layer optional
  }

  const when = new Date(liveClass.scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  await notifyEnrolledStudents(courseId, {
    title: `New live class: "${liveClass.title}"`,
    description: `Scheduled for ${when}.`,
    link: '/student/live-classes',
  });

  return sendSuccess(res, { status: 201, message: 'Delivered to students.', data: liveClass });
});

/**
 * Updates a previously-bridged live class in place — the reschedule path.
 * Deliberately a real update on the SAME document (never delete+recreate),
 * so the session's identity/history and any student notifications already
 * tied to its _id stay intact. A reschedule that doesn't explicitly pass
 * `status` resets it to 'upcoming' - the natural meaning of "this session
 * now has a new time" even if it had been 'cancelled' or 'completed'.
 */
export const updateBridgedLiveClass = asyncHandler(async (req, res) => {
  const { title, scheduledAt, durationMinutes, joinUrl, status } = req.body;

  const update = { status: status || 'upcoming' };
  if (title !== undefined) update.title = title;
  if (scheduledAt !== undefined) update.scheduledAt = scheduledAt;
  if (durationMinutes !== undefined) update.durationMinutes = durationMinutes;
  if (joinUrl !== undefined) update.joinUrl = joinUrl;

  const before = await LiveClass.findOne({ source: 'teacher-portal', sourceId: req.params.sourceId }).select('scheduledAt courseId').lean();
  if (!before) throw AppError.notFound('No bridged live class with that source id.', 'LIVE_CLASS_NOT_FOUND');
  const timeActuallyChanged = scheduledAt !== undefined && new Date(scheduledAt).getTime() !== new Date(before.scheduledAt).getTime();

  const liveClass = await LiveClass.findOneAndUpdate(
    { source: 'teacher-portal', sourceId: req.params.sourceId },
    update,
    { new: true }
  );

  try {
    const { emitToCourse } = await import('../sockets/index.js');
    emitToCourse(liveClass.courseId, 'course:lecture_rescheduled', {
      id: liveClass._id,
      title: liveClass.title,
      scheduledAt: liveClass.scheduledAt,
      status: liveClass.status,
      courseId: String(liveClass.courseId),
    });
  } catch {
    // socket layer optional
  }

  // A genuine time change is the one case students must be actively told
  // about (not just have their dashboard silently re-render).
  if (timeActuallyChanged) {
    const when = new Date(liveClass.scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    await notifyEnrolledStudents(liveClass.courseId, {
      title: `"${liveClass.title}" rescheduled`,
      description: `The live class has been moved to ${when}.`,
      link: '/student/live-classes',
    });
  }

  return sendSuccess(res, { message: 'Updated.', data: liveClass });
});

/** Cancels/removes a previously-bridged live class — used when the teacher cancels the source session. Idempotent. */
export const retractBridgedLiveClass = asyncHandler(async (req, res) => {
  const liveClass = await LiveClass.findOneAndUpdate(
    { source: 'teacher-portal', sourceId: req.params.sourceId },
    { status: 'cancelled' },
    { new: true }
  );
  if (!liveClass) {
    return sendSuccess(res, { message: 'Already removed.', data: { sourceId: req.params.sourceId } });
  }

  try {
    const { emitToCourse } = await import('../sockets/index.js');
    emitToCourse(liveClass.courseId, 'course:lecture_cancelled', { id: liveClass._id, courseId: String(liveClass.courseId) });
  } catch {
    // socket layer optional
  }

  await notifyEnrolledStudents(liveClass.courseId, {
    title: `"${liveClass.title}" cancelled`,
    description: 'This live class has been cancelled by your teacher.',
    link: '/student/live-classes',
  });

  return sendSuccess(res, { message: 'Cancelled.', data: { id: liveClass._id } });
});

// --- Quizzes (teacher-authored exams with real questions) -----------------

/**
 * Upserts a bridged quiz by `sourceId` (the teacher portal's Exam _id) —
 * handles both first delivery and subsequent edits (question changes,
 * duration changes) with one idempotent call, mirroring upsertBridgedTask.
 * `quizId` (this collection's own unique human-readable key) is derived
 * from `sourceId`.
 */
export const upsertBridgedQuiz = asyncHandler(async (req, res) => {
  const { studentCourseSlug, title, moduleTitle, timeLimitMins, questions, sourceId } = req.body;

  const courseId = await resolveCourseIdFromSlug(studentCourseSlug);
  if (!courseId) {
    return sendSuccess(res, { status: 200, message: 'No matching student course - not delivered.', data: null });
  }

  const isNew = !(await Quiz.exists({ source: 'teacher-portal', sourceId }));
  const quiz = await Quiz.findOneAndUpdate(
    { source: 'teacher-portal', sourceId },
    {
      quizId: `teacher-${sourceId}`,
      courseId,
      title,
      moduleTitle,
      timeLimitMins,
      questions,
      isPublished: true,
      source: 'teacher-portal',
      sourceId,
    },
    { upsert: true, new: true }
  );

  if (isNew) {
    try {
      const { emitToCourse } = await import('../sockets/index.js');
      emitToCourse(courseId, 'course:quiz_created', { id: quiz._id, title: quiz.title, courseId: String(courseId) });
    } catch {
      // socket layer optional
    }
    await notifyEnrolledStudents(courseId, {
      title: `New quiz: "${quiz.title}"`,
      description: 'A new quiz has been posted for your course.',
      link: '/student/quizzes',
    });
  }

  return sendSuccess(res, { status: isNew ? 201 : 200, message: isNew ? 'Delivered to students.' : 'Updated.', data: quiz });
});

/** Unpublishes a bridged quiz — used when the teacher deletes the source exam. Idempotent. */
export const retractBridgedQuiz = asyncHandler(async (req, res) => {
  const quiz = await Quiz.findOneAndUpdate(
    { source: 'teacher-portal', sourceId: req.params.sourceId },
    { isPublished: false },
    { new: true }
  );
  if (!quiz) {
    return sendSuccess(res, { message: 'Already removed.', data: { sourceId: req.params.sourceId } });
  }
  return sendSuccess(res, { message: 'Removed.', data: { id: quiz._id } });
});

// --- Enrolled students (read) — the "who is really enrolled" query --------

/**
 * Returns the REAL, currently-active enrolled students for a course, keyed
 * by the student portal's own `Enrollment` collection — the sole source of
 * truth for "has this person actually purchased/enrolled" (see
 * models/Enrollment.js). This is what lets teacher/backend distinguish a
 * genuinely paying/enrolled student from someone who merely has an account,
 * rather than trusting a locally-curated roster. Deliberately read-only and
 * course-scoped: never returns a student's payment/order details, only the
 * identity + enrollment fields a teacher legitimately needs.
 */
export const listEnrolledStudents = asyncHandler(async (req, res) => {
  const course = await Course.findOne({ slug: req.params.slug }).select('_id');
  if (!course) {
    return sendSuccess(res, { message: 'No matching student course.', data: [] });
  }

  // `batchId` scopes the answer to ONE batch of the course. A course runs
  // several batches, each with its own teacher and lectures, so an unscoped
  // answer would let every batch import every student of the course. The filter
  // is optional so an admin-side caller can still see the whole course.
  const filter = { courseId: course._id, status: 'active' };
  if (req.query.batchId) filter.batchId = req.query.batchId;

  const enrollments = await Enrollment.find(filter)
    .populate('userId', 'name email avatar')
    .sort({ enrolledAt: -1 })
    .lean();

  // The student's institution-wide number, so the teacher portal's course
  // roster shows the same identifier the student and the admin portal do.
  const profiles = await StudentProfile.find({ userId: { $in: enrollments.map((e) => e.userId?._id).filter(Boolean) } })
    .select('userId enrollmentNumber')
    .lean();
  const numberByUser = new Map(profiles.map((p) => [String(p.userId), p.enrollmentNumber || null]));

  const students = enrollments
    .filter((e) => e.userId) // drop any enrollment whose user was hard-deleted
    .map((e) => ({
      // The authoritative identity for cross-portal matching. Email changes;
      // this does not.
      enrollmentId: e.enrollmentId || null,
      // Which batch of the course this student was actually placed in. Null
      // means awaiting placement — a real state, and one no batch may claim.
      batchId: e.batchId || null,
      batchCode: e.batchCode || null,
      userId: String(e.userId._id),
      name: e.userId.name,
      email: e.userId.email,
      avatar: e.userId.avatar || null,
      enrollmentNumber: numberByUser.get(String(e.userId._id)) || null,
      enrolledAt: e.enrolledAt,
      progressPercent: e.progressPercent,
    }));

  return sendSuccess(res, { message: 'Enrolled students.', data: students });
});

// --- Messages (teacher -> student, the other bridge direction) -----------

/**
 * Delivers a teacher's reply into the student's own message thread and
 * pushes it live over this backend's own Socket.IO — the other half of the
 * bidirectional bridge (student -> teacher is
 * services/teacherBridge.service.js#pushMessageToTeacher).
 */
export const deliverTeacherMessage = asyncHandler(async (req, res) => {
  const { studentUserId, text, teacherName } = req.body;

  const user = await User.findById(studentUserId).select('_id');
  if (!user) {
    return sendSuccess(res, { status: 200, message: 'No matching student - not delivered.', data: null });
  }

  const message = await Message.create({
    userId: studentUserId,
    sender: 'teacher',
    body: text,
    teacherName: teacherName || null,
  });

  try {
    const { emitToUser, emitNotificationCreated } = await import('../sockets/index.js');
    emitToUser(studentUserId, 'message.created', message);

    const notification = await Notification.create({
      userId: studentUserId,
      title: `New message from ${teacherName || 'your teacher'}`,
      description: text.length > 140 ? `${text.slice(0, 140)}…` : text,
      type: 'message',
      link: '/student/messages',
    });
    emitNotificationCreated(studentUserId, notification);
  } catch {
    // socket/notification layer optional - never break message delivery itself
  }

  return sendSuccess(res, { status: 201, message: 'Delivered to student.', data: message });
});

// --- Courses (admin -> student, publishing the real purchasable catalog) --

/**
 * Publishes (creates or updates) a real purchasable course from an
 * admin-approved governance record. Never deletes on retraction (see
 * unpublishBridgedCourse) - a student may already own it. `modules` is
 * deliberately left empty on create: admin authors commerce metadata only,
 * not lesson/video content, which stays this backend's own separate,
 * already-existing authoring surface.
 */
export const upsertBridgedCourse = asyncHandler(async (req, res) => {
  const { sourceId, slug, title, description, features, priceInPaise, image } = req.body;

  const course = await Course.findOneAndUpdate(
    { source: 'admin-portal', sourceId },
    {
      $set: {
        slug,
        title,
        description: description || '',
        skills: features || [],
        priceInPaise: priceInPaise || 0,
        bannerImage: image || '',
        isPurchasable: true,
        isPublished: true,
        source: 'admin-portal',
        sourceId,
      },
      $setOnInsert: { modules: [] },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return sendSuccess(res, { status: 201, message: 'Published to catalog.', data: course });
});

/** Unpublishes (never deletes) a previously-bridged course when admin archives/rejects it. */
export const unpublishBridgedCourse = asyncHandler(async (req, res) => {
  const course = await Course.findOneAndUpdate(
    { source: 'admin-portal', sourceId: req.params.sourceId },
    { isPurchasable: false },
    { new: true }
  );
  if (!course) {
    return sendSuccess(res, { message: 'No matching bridged course.', data: { sourceId: req.params.sourceId } });
  }
  return sendSuccess(res, { message: 'Unpublished.', data: { id: course._id } });
});

// --- Task submission grading (teacher -> student, return leg of the task
// bridge) --------------------------------------------------------------

/**
 * Records a real teacher grade on a bridged TaskSubmission - the return leg
 * that never previously existed (see task.controller.js#submitTask, which
 * used to fabricate a fixed taskScore instead of waiting for this). Matches
 * by `:sourceId` = this submission's own _id, which was sent outbound in
 * pushTaskSubmission and stored by teacher/backend on its own Submission
 * doc. Recalculates the student's real averageTaskScore from the genuine
 * percentage, never a placeholder.
 */
export const gradeBridgedTaskSubmission = asyncHandler(async (req, res) => {
  const { score, maxScore, feedback } = req.body;

  const submission = await TaskSubmission.findByIdAndUpdate(
    req.params.sourceId,
    { teacherScore: score, teacherMaxScore: maxScore, teacherFeedback: feedback || null, gradedAt: new Date() },
    { new: true }
  );
  if (!submission) {
    return sendSuccess(res, { message: 'No matching submission - not recorded.', data: null });
  }

  const profile = await StudentProfile.findOne({ userId: submission.userId });
  if (profile) {
    // Computed fresh from every graded submission this user has, rather
    // than a stateful running-average - tasksCompleted increments at
    // SUBMISSION time (before any real score exists), so reusing it as the
    // running-average's "n" (as recalculateAverages does for quizzes, whose
    // score+completion always land in the same request) double-counts
    // ungraded tasks and dilutes the average. Confirmed via live QA: a
    // single 92/100 grade showed as 46% before this fix.
    const gradedSubmissions = await TaskSubmission.find({ userId: submission.userId, teacherScore: { $ne: null } })
      .select('teacherScore teacherMaxScore')
      .lean();
    const percentages = gradedSubmissions.map((s) => (s.teacherMaxScore > 0 ? (s.teacherScore / s.teacherMaxScore) * 100 : 0));
    profile.stats.averageTaskScore = percentages.length
      ? Math.round(percentages.reduce((a, b) => a + b, 0) / percentages.length)
      : 0;
    await profile.save();
  }

  const notification = await Notification.create({
    userId: submission.userId,
    title: 'Your assignment was graded',
    description: `You scored ${score}/${maxScore}${feedback ? ` — "${feedback.length > 100 ? `${feedback.slice(0, 100)}…` : feedback}"` : ''}.`,
    type: 'course',
    link: '/student/tasks',
  });
  try {
    const { emitToUser, emitNotificationCreated } = await import('../sockets/index.js');
    emitToUser(submission.userId, 'task.graded', { submissionId: String(submission._id), score, maxScore });
    emitNotificationCreated(submission.userId, notification);
  } catch {
    // socket layer optional
  }

  return sendSuccess(res, { message: 'Grade recorded.', data: submission });
});

// --- Resources (admin-uploaded magazines/events/program content) ---------

/**
 * Upserts a bridged resource by `sourceId` (admin/backend's Resource _id) -
 * one idempotent call handles both first delivery and edits, matching the
 * course bridge. Publishes on the public socket namespace immediately after
 * the write is confirmed, so the Landing Page's Resources section updates
 * live as admin uploads - see sockets/index.js#emitToPublic.
 */
export const upsertBridgedResource = asyncHandler(async (req, res) => {
  const { sourceId, title, description, type, fileUrl, fileName, fileType, fileSizeBytes, uploadedByName, isPublished } = req.body;

  const resource = await Resource.findOneAndUpdate(
    { source: 'admin-portal', sourceId },
    {
      $set: {
        title,
        description,
        type,
        fileUrl,
        fileName: fileName || null,
        fileType,
        fileSizeBytes,
        uploadedByName,
        isPublished,
        source: 'admin-portal',
        sourceId,
      },
      $setOnInsert: { publishedAt: new Date() },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  try {
    const { emitToPublic } = await import('../sockets/index.js');
    emitToPublic('resource.upserted', {
      id: String(resource._id),
      title: resource.title,
      type: resource.type,
      isPublished: resource.isPublished,
    });
  } catch {
    // socket layer optional - never break the bridge delivery itself
  }

  return sendSuccess(res, { status: 201, message: 'Published to Resources.', data: resource });
});

/** Retracts (deletes) a bridged resource - used when admin deletes the source upload. Idempotent. */
export const retractBridgedResource = asyncHandler(async (req, res) => {
  const resource = await Resource.findOneAndDelete({ source: 'admin-portal', sourceId: req.params.sourceId });
  if (!resource) {
    return sendSuccess(res, { message: 'Already removed.', data: { sourceId: req.params.sourceId } });
  }

  try {
    const { emitToPublic } = await import('../sockets/index.js');
    emitToPublic('resource.deleted', { id: String(resource._id) });
  } catch {
    // socket layer optional - never break the bridge delivery itself
  }

  return sendSuccess(res, { message: 'Removed.', data: { id: resource._id } });
});

// --- Faculty (admin -> student, the people the About page introduces) -----

/**
 * Publishes (creates or updates) one teacher's public profile.
 *
 * Keyed on the admin portal's own Teacher id, so the same teacher delivered
 * twice updates one record instead of adding another. Nothing in this service
 * edits faculty: the admin portal owns teacher identity and this is its
 * read-only projection, carrying only what a visitor may see.
 */
export const upsertBridgedFaculty = asyncHandler(async (req, res) => {
  const { sourceId, name, role, category, expertise, experience, avatar, order } = req.body;

  const faculty = await Faculty.findOneAndUpdate(
    { source: 'admin-portal', sourceId },
    {
      $set: {
        name,
        role: role || null,
        category: category || null,
        expertise: expertise || [],
        experience: experience || null,
        avatar: avatar || null,
        order,
        isPublished: true,
        source: 'admin-portal',
        sourceId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return sendSuccess(res, { status: 201, message: 'Published to the faculty list.', data: faculty });
});

/**
 * Removes a published profile - an admin turned it off, or suspended or deleted
 * the teacher. Idempotent: removing one that was never published is a success,
 * which is what lets the admin portal call it on every change without tracking
 * whether it is there.
 */
export const retractBridgedFaculty = asyncHandler(async (req, res) => {
  const faculty = await Faculty.findOneAndDelete({ source: 'admin-portal', sourceId: req.params.sourceId });
  if (!faculty) {
    return sendSuccess(res, { message: 'Already removed.', data: { sourceId: req.params.sourceId } });
  }
  return sendSuccess(res, { message: 'Removed.', data: { id: faculty._id } });
});

/**
 * Coupon administration for the Admin portal.
 *
 * Coupons live beside Course and Enrollment in this database, so Admin manages
 * them over the shared-secret bridge rather than owning a second copy - the same
 * arrangement batches use. Everything routes through coupon.service.js, so the
 * generator, the pricing rules and the shaped output are identical whichever
 * portal asked.
 *
 * `usedBy` carries real student names and emails, so these responses only ever
 * leave through this key-guarded router.
 */
export const adminListCoupons = asyncHandler(async (req, res) => {
  const { status, courseSlug, search, campaignId } = req.query;

  // The admin portal knows courses by slug, because its own course _ids belong
  // to a different database entirely. An unknown slug filters to nothing rather
  // than erroring - it is a view, not an instruction.
  let courseId = null;
  if (courseSlug) {
    const course = await Course.findOne({ slug: courseSlug }).select('_id').lean();
    courseId = course ? course._id : null;
    if (!courseId) {
      return sendSuccess(res, {
        data: [],
        meta: { total: 0, summary: { AVAILABLE: 0, USED: 0, EXPIRED: 0, INACTIVE: 0 } },
      });
    }
  }

  const filter = {};
  if (courseId) filter.courseId = courseId;
  if (campaignId) filter.campaignId = campaignId;
  if (search) {
    // Codes are stored grouped (NNX7-K4P9-X2), so a search typed without the
    // dashes has to match anyway - otherwise pasting half a code from a message
    // finds nothing. Separators are dropped from the term and made optional
    // between every character of the pattern.
    const chars = String(search).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (chars) filter.code = new RegExp(chars.split('').join('-?'));
  }

  const now = new Date();
  // Status is derived from three fields, so it is expressed as a query rather
  // than filtered in memory - otherwise paging would silently drop rows.
  if (status === 'INACTIVE') filter.isActive = false;
  else if (status === 'EXPIRED') {
    filter.isActive = true;
    filter.expiresAt = { $ne: null, $lte: now };
  } else if (status === 'USED') {
    filter.isActive = true;
    filter.$expr = { $gte: ['$usedCount', '$maxUses'] };
    // A coupon that ran out AND then expired displays as EXPIRED, so it must not
    // also answer the USED filter - otherwise the table shows rows whose badge
    // contradicts the filter that produced them.
    filter.$or = [{ expiresAt: null }, { expiresAt: { $gt: now } }];
  } else if (status === 'AVAILABLE') {
    filter.isActive = true;
    filter.$expr = { $lt: ['$usedCount', '$maxUses'] };
    filter.$or = [{ expiresAt: null }, { expiresAt: { $gt: now } }];
  }

  const coupons = await Coupon.find(filter)
    .populate('courseId', 'title slug priceInPaise')
    .populate('campaignId', 'name')
    .populate('usedBy.userId', 'name email')
    .sort({ createdAt: -1 })
    .limit(500);

  const shaped = coupons.map((c) => shapeCouponForAdmin(c));

  /**
   * The tiles answer "how many free seats are left", so they must count the
   * whole population - not the rows that survived the search box.
   *
   * Counting the shaped rows instead made the tiles agree with whatever was
   * being looked at: searching one code showed AVAILABLE 0, which reads as "the
   * giveaway is exhausted" rather than "you filtered it out". It also stopped at
   * the 500-row page limit, so the count silently went wrong at the exact size
   * where an operator would start relying on it.
   *
   * Course is the one filter kept, because "available in THIS course" is a real
   * question. Status and search are views of the population, not the population.
   */
  const summaryMatch = {};
  if (courseId) summaryMatch.courseId = new mongoose.Types.ObjectId(String(courseId));

  const grouped = await Coupon.aggregate([
    { $match: summaryMatch },
    {
      $group: {
        // Mirrors shapeCouponForAdmin's precedence exactly; if that changes,
        // this must change with it or the tiles will disagree with the badges.
        _id: {
          $switch: {
            branches: [
              { case: { $eq: ['$isActive', false] }, then: 'INACTIVE' },
              { case: { $and: [{ $ne: ['$expiresAt', null] }, { $lte: ['$expiresAt', now] }] }, then: 'EXPIRED' },
              { case: { $gte: ['$usedCount', '$maxUses'] }, then: 'USED' },
            ],
            default: 'AVAILABLE',
          },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const summary = grouped.reduce(
    (acc, row) => ({ ...acc, [row._id]: row.count }),
    { AVAILABLE: 0, USED: 0, EXPIRED: 0, INACTIVE: 0 }
  );

  return sendSuccess(res, { data: shaped, meta: { total: shaped.length, summary } });
});

export const adminCreateCampaign = asyncHandler(async (req, res) => {
  const {
    courseSlug,
    name,
    count,
    discountType,
    discountValue,
    maxUses,
    expiresAt,
    createdByEmail,
    createdByName,
  } = req.body;

  // Resolved here so the campaign and its coupons are bound to THIS database's
  // course document - the caller's own course _id means nothing on this side.
  const course = await Course.findOne({ slug: courseSlug }).select('_id').lean();
  if (!course) throw AppError.notFound(`No course found for "${courseSlug}".`, 'COURSE_NOT_FOUND');

  const { campaign, coupons } = await createCampaign({
    courseId: course._id,
    name,
    count,
    discountType,
    discountValue,
    maxUses,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    createdByEmail: createdByEmail || null,
    createdByName: createdByName || null,
  });

  // The only response that ever carries the codes themselves. Everything after
  // this returns them only through the guarded listing and export.
  return sendSuccess(res, {
    status: 201,
    message: `${coupons.length} coupon(s) created.`,
    data: {
      campaign: shapeCampaignForAdmin(campaign, { AVAILABLE: coupons.length }),
      coupons: coupons.map((c) => shapeCouponForAdmin(c)),
    },
  });
});

/**
 * Campaigns with their live statistics.
 *
 * One aggregation over the coupons, not one query per campaign - a page showing
 * a dozen campaigns should not cost a dozen round trips, and the counts have to
 * come from the coupons regardless.
 */
export const adminListCampaigns = asyncHandler(async (req, res) => {
  const { courseSlug } = req.query;

  const match = {};
  if (courseSlug) {
    const course = await Course.findOne({ slug: courseSlug }).select('_id').lean();
    if (!course) return sendSuccess(res, { data: [], meta: { total: 0 } });
    match.courseId = course._id;
  }

  const campaigns = await CouponCampaign.find(match)
    .populate('courseId', 'title slug priceInPaise')
    .sort({ createdAt: -1 })
    .limit(200);

  const grouped = await summarizeCampaigns(
    match.courseId ? { courseId: new mongoose.Types.ObjectId(String(match.courseId)) } : {}
  );

  const statsByCampaign = grouped.reduce((acc, row) => {
    const key = String(row._id.campaignId);
    return { ...acc, [key]: { ...(acc[key] || {}), [row._id.status]: row.count } };
  }, {});

  const shaped = campaigns.map((c) => shapeCampaignForAdmin(c, statsByCampaign[String(c._id)] || {}));
  return sendSuccess(res, { data: shaped, meta: { total: shaped.length } });
});

/**
 * Every code in one campaign, for the admin to export.
 *
 * Separate from the paged listing on purpose: an export that silently stopped at
 * the page limit would hand out a short list of a giveaway the operator believes
 * is complete. There is no page limit here, and the campaign bounds the size.
 */
export const adminExportCampaign = asyncHandler(async (req, res) => {
  const campaign = await CouponCampaign.findById(req.params.id).populate('courseId', 'title slug priceInPaise');
  if (!campaign) throw AppError.notFound('Campaign not found', 'CAMPAIGN_NOT_FOUND');

  const coupons = await Coupon.find({ campaignId: campaign._id })
    .populate('courseId', 'title slug priceInPaise')
    .populate('campaignId', 'name')
    .populate('usedBy.userId', 'name email')
    .sort({ createdAt: 1 });

  return sendSuccess(res, {
    data: {
      campaign: shapeCampaignForAdmin(campaign),
      coupons: coupons.map((c) => shapeCouponForAdmin(c)),
    },
  });
});

/**
 * Activate or deactivate a coupon.
 *
 * Deliberately narrow: only `isActive` and `expiresAt` can change. A coupon's
 * code, course, discount and recorded usage are history once issued - editing
 * them would rewrite what a student was given, and `usedCount` in particular is
 * the thing keeping a single-use code single-use.
 */
export const adminUpdateCoupon = asyncHandler(async (req, res) => {
  const updates = {};
  if (typeof req.body.isActive === 'boolean') updates.isActive = req.body.isActive;
  if ('expiresAt' in req.body) updates.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;

  const coupon = await Coupon.findByIdAndUpdate(req.params.id, updates, { new: true })
    .populate('courseId', 'title slug priceInPaise')
    .populate('usedBy.userId', 'name email');
  if (!coupon) throw AppError.notFound('Coupon not found', 'COUPON_NOT_FOUND');

  return sendSuccess(res, { message: 'Coupon updated.', data: shapeCouponForAdmin(coupon) });
});

/**
 * Removes an UNUSED coupon.
 *
 * A coupon that has been redeemed is the record of a real enrollment, so it is
 * refused here - deactivate it instead. Deleting it would leave an enrollment
 * nobody could account for.
 */
export const adminDeleteCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) throw AppError.notFound('Coupon not found', 'COUPON_NOT_FOUND');
  if (coupon.usedCount > 0) {
    throw AppError.conflict(
      'This coupon has been used and is part of an enrollment record. Deactivate it instead of deleting it.',
      'COUPON_ALREADY_USED'
    );
  }

  await coupon.deleteOne();
  return sendSuccess(res, { message: 'Coupon removed.', data: { id: String(coupon._id) } });
});

// --- Subject tagging (admin/teacher portal -> this catalogue) ----------------

/**
 * A course's content with the subject each activity currently resolves to.
 *
 * Returns both `subject` (what was explicitly set, possibly null) and
 * `resolvedSubject` (what the engine would actually credit). Showing only the
 * resolved value would hide whether a lesson is deliberately classified or
 * merely inheriting its course's pillar - which is the exact difference an
 * administrator is here to act on.
 */
export const adminGetCourseContent = asyncHandler(async (req, res) => {
  const { resolveSubject } = await import('../services/progression/subject.service.js');
  const course = await Course.findOne({ slug: req.params.slug }).lean();
  if (!course) throw AppError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const modules = [];
  for (const mod of course.modules || []) {
    const lessons = [];
    for (const lesson of mod.lessons || []) {
      lessons.push({
        lessonId: lesson.lessonId,
        title: lesson.title,
        order: lesson.order,
        isPublished: lesson.isPublished !== false,
        subject: lesson.subject || null,
        resolvedSubject: await resolveSubject({
          activitySubject: lesson.subject,
          moduleSubject: mod.subject,
          coursePillar: course.pillar,
        }),
        // Says where the resolved value came from, so "inherited" is visibly
        // different from "chosen".
        inherited: !lesson.subject,
      });
    }
    modules.push({
      moduleId: mod.moduleId,
      title: mod.title,
      order: mod.order,
      subject: mod.subject || null,
      lessons,
    });
  }

  const [quizzes, tasks] = await Promise.all([
    Quiz.find({ courseId: course._id }).select('quizId title subject').lean(),
    Task.find({ courseId: course._id }).select('taskId title subject').lean(),
  ]);

  return sendSuccess(res, {
    data: {
      slug: course.slug,
      title: course.title,
      pillar: course.pillar,
      modules,
      quizzes: quizzes.map((q) => ({ quizId: q.quizId, title: q.title, subject: q.subject || null })),
      tasks: tasks.map((t) => ({ taskId: t.taskId, title: t.title, subject: t.subject || null })),
    },
  });
});

/**
 * Sets the subject on specific activities.
 *
 * Takes a list of targeted changes rather than the whole course, so two
 * administrators editing different modules cannot overwrite each other by both
 * submitting a full document.
 *
 * Changing a subject affects what FUTURE activity is credited to. Existing
 * ProgressionEvents keep the subject they were recorded with - see that model's
 * comment - so this cannot silently restate a student's past scores.
 */
export const adminSetContentSubjects = asyncHandler(async (req, res) => {
  const { lessons = [], modules = [], quizzes = [], tasks = [] } = req.body;

  const course = await Course.findOne({ slug: req.params.slug });
  if (!course) throw AppError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const clean = (v) => (v === null || v === '' ? null : String(v).trim().toUpperCase());
  let changed = 0;

  for (const m of modules) {
    const mod = course.modules.find((x) => x.moduleId === m.moduleId);
    if (!mod) continue;
    mod.subject = clean(m.subject);
    changed += 1;
  }

  for (const l of lessons) {
    for (const mod of course.modules) {
      const lesson = (mod.lessons || []).find((x) => x.lessonId === l.lessonId);
      if (lesson) {
        lesson.subject = clean(l.subject);
        changed += 1;
        break;
      }
    }
  }

  if (modules.length || lessons.length) await course.save();

  for (const q of quizzes) {
    const r = await Quiz.updateOne({ quizId: q.quizId, courseId: course._id }, { $set: { subject: clean(q.subject) } });
    changed += r.modifiedCount || 0;
  }
  for (const t of tasks) {
    const r = await Task.updateOne({ taskId: t.taskId, courseId: course._id }, { $set: { subject: clean(t.subject) } });
    changed += r.modifiedCount || 0;
  }

  return sendSuccess(res, { message: `${changed} item(s) updated.`, data: { slug: course.slug, changed } });
});

/** The subjects an administrator may choose from. */
export const adminListSubjects = asyncHandler(async (req, res) => {
  const { Subject } = await import('../models/Subject.js');
  const { ensureProgressionConfig } = await import('../services/progression/rules.service.js');
  // A freshly-deployed service has no configuration until something creates it,
  // and an empty dropdown is a worse answer than the launch defaults.
  await ensureProgressionConfig();
  const subjects = await Subject.find({ enabled: true }).sort({ order: 1 }).lean();
  return sendSuccess(res, {
    data: subjects.map((s) => ({ code: s.code, name: s.name, color: s.color, icon: s.icon })),
  });
});

/**
 * Attendance, pushed from the service that records it.
 *
 * Attendance lives in the teacher database and skill/consistency scoring lives
 * here, so it crosses as events like every other activity rather than as a
 * second source of truth. Students are matched on the teacher service's
 * `linkedUserId`, which is the portal account it already holds - never on a
 * name, and never on an id the caller supplies without one.
 *
 * A correction is a NEW event, not an edit. The ledger is append-only, so
 * marking a student present and later absent for the same session leaves both
 * facts visible and the engine takes the latest as authoritative - which is
 * what makes a disputed attendance record answerable.
 */
export const adminRecordAttendance = asyncHandler(async (req, res) => {
  const { recordActivity } = await import('../services/progression/engine.service.js');
  const { records = [] } = req.body;

  const results = { recorded: 0, duplicate: 0, skipped: 0 };

  for (const r of records) {
    const user = await User.findById(r.userId).select('_id').lean();
    if (!user) {
      // A roster row whose portal account does not exist here is skipped rather
      // than guessed at; inventing a match would credit the wrong student.
      results.skipped += 1;
      continue;
    }

    const attended = r.status === 'present' || r.status === 'late';
    const dateKey = new Date(r.date).toISOString().slice(0, 10);
    // Late is carried as its own status so the configured partial credit
    // actually applies, rather than being rounded up to full attendance.
    const eventStatus = r.status === 'present' ? 'ATTENDED' : r.status === 'late' ? 'LATE' : 'MISSED';

    const outcome = await recordActivity({
      userId: user._id,
      activityType: attended ? 'CLASS_ATTENDED' : 'CLASS_MISSED',
      status: eventStatus,
      // One session, identified the same way on both sides.
      refId: `${r.classId}:${dateKey}`,
      courseId: r.courseId || null,
      subjectCode: r.subjectCode || null,
      source: 'teacher-bridge',
      createdBy: r.markedBy || null,
      occurredAt: new Date(r.date),
      // The status is part of the key, so a correction is a distinct event
      // rather than a duplicate that gets silently dropped.
      attemptId: r.status,
    });

    if (outcome.duplicate) results.duplicate += 1;
    else results.recorded += 1;
  }

  return sendSuccess(res, { message: `${results.recorded} attendance event(s) recorded.`, data: results });
});

/**
 * Progression snapshots for a set of students, in one request.
 *
 * Batched deliberately: a teacher's roster page needs a row per student, and a
 * call per student would make a class of forty into forty cross-service
 * round trips against a service that sleeps. The caller sends the portal user
 * ids it already holds and gets back only those that exist.
 *
 * Read-only. Nothing here lets another service write a score - a teacher can
 * see progression and cannot author it, which is the permission boundary the
 * whole feature rests on.
 */
export const adminGetStudentProgress = asyncHandler(async (req, res) => {
  const { StudentProfile } = await import('../models/StudentProfile.js');
  const { StudentAchievement } = await import('../models/StudentAchievement.js');
  const ids = [...new Set((req.body.userIds || []).map(String))];

  const [profiles, users, achievementCounts] = await Promise.all([
    StudentProfile.find({ userId: { $in: ids } }).lean(),
    User.find({ _id: { $in: ids } }).select('name email').lean(),
    StudentAchievement.aggregate([
      { $match: { userId: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]),
  ]);

  const userById = new Map(users.map((u) => [String(u._id), u]));
  const achievementsById = new Map(achievementCounts.map((a) => [String(a._id), a.count]));

  return sendSuccess(res, {
    data: profiles.map((profile) => {
      const p = profile.progression || {};
      const user = userById.get(String(profile.userId));
      return {
        userId: String(profile.userId),
        name: user?.name || null,
        email: user?.email || null,
        stageCode: p.currentStageCode || null,
        stageProgress: p.stageProgress || 0,
        level: profile.level || 1,
        rankCode: p.rankCode || null,
        xp: profile.xp || 0,
        skills: (p.skills || []).map((s) => ({ subjectCode: s.subjectCode, score: s.score, activityCount: s.activityCount })),
        attendanceScore: p.attendanceScore || 0,
        classesAttended: p.classesAttended || 0,
        classesConducted: p.classesConducted || 0,
        knowledgeScore: p.knowledgeScore || 0,
        consistencyScore: p.consistencyScore || 0,
        overallPower: p.overallPower || 0,
        currentStreak: profile.streak?.current || 0,
        achievementsUnlocked: achievementsById.get(String(profile.userId)) || 0,
        lessonsCompleted: profile.stats?.lessonsCompleted || 0,
        quizzesCompleted: profile.stats?.quizzesCompleted || 0,
        lastActivityAt: p.lastActivityAt || null,
        // Whether the student may move on, and why not. Computed here so a
        // teacher sees the same verdict the student does - including the
        // outstanding criteria, without which "why not" cannot be answered and
        // a teacher can only repeat the padlock back to the student.
        eligibility: (p.eligibility || []).map((e) => ({
          stageCode: e.stageCode,
          eligible: e.eligible,
          // STARTING_STAGE, NOT_CONFIGURED and NOT_ELIGIBLE are three different
          // situations that the boolean alone flattens into one.
          status: e.status || 'NOT_CONFIGURED',
          version: e.version ?? null,
          requirements: (e.requirements || []).map((r) => ({
            key: r.key,
            metric: r.metric,
            name: r.name,
            operator: r.operator,
            required: r.required,
            actual: r.actual,
            unit: r.unit,
            passed: r.passed,
            status: r.status,
          })),
        })),
      };
    }),
  });
});

/** One student's activity timeline, for a teacher's detail view. */
export const adminGetStudentActivity = asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const events = await ProgressionEvent.find({ userId: req.params.userId })
    .sort({ occurredAt: -1 })
    .limit(limit)
    .lean();

  return sendSuccess(res, {
    data: events.map((e) => ({
      activityType: e.activityType,
      status: e.status,
      subjectCode: e.subjectCode,
      score: e.score,
      xpAwarded: e.xpAwarded,
      refId: e.refId,
      occurredAt: e.occurredAt,
    })),
  });
});

// --- Progression configuration (admin portal) -------------------------------

/**
 * Everything an administrator can tune, in one response.
 *
 * Returned together because these rules only make sense beside each other: a
 * rank threshold is meaningless without the level curve, and a stage
 * requirement without the subjects it names. Fetching them separately would
 * invite a screen showing a consistent-looking mixture of two versions.
 */
export const adminGetProgressionRules = asyncHandler(async (req, res) => {
  const { getRules, ensureProgressionConfig } = await import('../services/progression/rules.service.js');
  const { Stage } = await import('../models/Stage.js');
  const { Subject } = await import('../models/Subject.js');
  const { Achievement } = await import('../models/Achievement.js');

  await ensureProgressionConfig();

  const [rules, stages, subjects, achievements] = await Promise.all([
    getRules({ fresh: true }),
    Stage.find({}).sort({ order: 1 }).lean(),
    Subject.find({}).sort({ order: 1 }).lean(),
    Achievement.find({}).sort({ order: 1 }).lean(),
  ]);

  return sendSuccess(res, { data: { rules, stages, subjects, achievements } });
});

/**
 * Replaces the tunable parts of the rules document.
 *
 * Only the sections an administrator owns are writable - the singleton key and
 * its timestamps are not, so a malformed body cannot orphan the document every
 * calculation depends on.
 *
 * Existing snapshots are deliberately NOT recalculated here. Changing a rule can
 * move thousands of students' scores, and doing that as a side effect of saving
 * a form is how an administrator finds out about the consequence afterwards.
 * Recalculation is its own explicit action.
 */
export const adminUpdateProgressionRules = asyncHandler(async (req, res) => {
  const { ProgressionRules } = await import('../models/ProgressionRules.js');
  const { invalidateRulesCache, ensureRules } = await import('../services/progression/rules.service.js');

  await ensureRules();
  const WRITABLE = ['xpRules', 'levels', 'ranks', 'skillWeights', 'knowledgeWeights', 'consistency', 'overallPower', 'attendance'];
  const updates = {};
  for (const key of WRITABLE) if (req.body[key] !== undefined) updates[key] = req.body[key];
  updates.updatedByEmail = req.body.updatedByEmail || null;

  const saved = await ProgressionRules.findOneAndUpdate(
    { key: 'GLOBAL' },
    { $set: updates },
    { new: true, runValidators: true }
  );
  invalidateRulesCache();

  return sendSuccess(res, { message: 'Progression rules updated.', data: saved });
});

/** Updates one stage's completion requirements. */
export const adminUpdateStage = asyncHandler(async (req, res) => {
  const { Stage } = await import('../models/Stage.js');
  const updates = {};
  for (const key of ['name', 'tagline', 'description', 'courseSlug', 'nextStageCode', 'enabled', 'requirements']) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const stage = await Stage.findOneAndUpdate(
    { code: String(req.params.code).toUpperCase() },
    { $set: updates },
    { new: true, runValidators: true }
  );
  if (!stage) throw AppError.notFound('Stage not found', 'STAGE_NOT_FOUND');
  return sendSuccess(res, { message: 'Stage updated.', data: stage });
});

/** Updates one achievement definition. */
export const adminUpdateAchievement = asyncHandler(async (req, res) => {
  const { Achievement } = await import('../models/Achievement.js');
  const updates = {};
  for (const key of ['name', 'description', 'icon', 'criteriaType', 'criteriaValue', 'subjectCode', 'activityType', 'stageCode', 'xpReward', 'enabled']) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const achievement = await Achievement.findOneAndUpdate(
    { code: String(req.params.code).toUpperCase() },
    { $set: updates },
    { new: true, runValidators: true }
  );
  if (!achievement) throw AppError.notFound('Achievement not found', 'ACHIEVEMENT_NOT_FOUND');
  return sendSuccess(res, { message: 'Achievement updated.', data: achievement });
});

/**
 * Rebuilds snapshots from the event ledger.
 *
 * The counterpart to not recalculating on every rule change: an administrator
 * decides when thousands of scores move, and this is the action that does it.
 * Bounded per call, so a recalculation cannot become an unbounded job that times
 * out halfway and leaves a cohort half-updated - the response says how many
 * remain, and repeated calls sweep the rest.
 */
export const adminRecalculateProgression = asyncHandler(async (req, res) => {
  const { rebuildSnapshot } = await import('../services/progression/engine.service.js');
  const { StudentProfile } = await import('../models/StudentProfile.js');

  if (req.body.userId) {
    await rebuildSnapshot(req.body.userId);
    return sendSuccess(res, { message: 'Recalculated.', data: { recalculated: 1, remaining: 0 } });
  }

  const limit = Math.min(500, Math.max(1, Number(req.body.limit) || 100));

  // Oldest snapshot first, so repeated calls sweep the whole cohort instead of
  // recomputing the same students each time.
  const profiles = await StudentProfile.find({})
    .sort({ 'progression.recalculatedAt': 1 })
    .limit(limit)
    .select('userId')
    .lean();

  for (const profile of profiles) await rebuildSnapshot(profile.userId);

  const total = await StudentProfile.countDocuments({});
  return sendSuccess(res, {
    message: `${profiles.length} student(s) recalculated.`,
    data: { recalculated: profiles.length, remaining: Math.max(0, total - profiles.length) },
  });
});

/** Platform-wide progression analytics. */
export const adminProgressionAnalytics = asyncHandler(async (req, res) => {
  const { StudentProfile } = await import('../models/StudentProfile.js');

  const rows = await StudentProfile.aggregate([
    {
      $group: {
        _id: '$progression.currentStageCode',
        students: { $sum: 1 },
        avgXP: { $avg: '$xp' },
        avgPower: { $avg: '$progression.overallPower' },
        avgAttendance: { $avg: '$progression.attendanceScore' },
        avgStageProgress: { $avg: '$progression.stageProgress' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const inactiveSince = new Date(Date.now() - 7 * 86400000);
  const [total, active, eligible] = await Promise.all([
    StudentProfile.countDocuments({}),
    StudentProfile.countDocuments({ 'progression.lastActivityAt': { $gte: inactiveSince } }),
    StudentProfile.countDocuments({
      $expr: {
        $gt: [
          {
            $size: {
              $filter: {
                input: { $ifNull: ['$progression.eligibility', []] },
                as: 'e',
                cond: {
                  $and: [
                    // ELIGIBLE is only set by a published rule the student
                    // passed; STARTING_STAGE and NOT_CONFIGURED are excluded by
                    // construction rather than by a second condition.
                    { $eq: ['$$e.status', 'ELIGIBLE'] },
                    { $ne: ['$$e.stageCode', '$progression.currentStageCode'] },
                  ],
                },
              },
            },
          },
          0,
        ],
      },
    }),
  ]);

  return sendSuccess(res, {
    data: {
      totals: { students: total, activeLast7Days: active, eligibleForNextStage: eligible },
      byStage: rows.map((r) => ({
        stageCode: r._id || 'UNASSIGNED',
        students: r.students,
        avgXP: Math.round(r.avgXP || 0),
        avgOverallPower: Math.round((r.avgPower || 0) * 10) / 10,
        avgAttendance: Math.round((r.avgAttendance || 0) * 10) / 10,
        avgStageProgress: Math.round((r.avgStageProgress || 0) * 10) / 10,
      })),
    },
  });
});

/**
 * Creates the journey courses, or reports what it would create.
 *
 * Deliberately an explicit action rather than something that happens on first
 * read like the progression config does. Configuration is invisible until
 * somebody looks at it; a course appears in the public catalogue, so bringing
 * one into existence should be a decision an administrator makes and an audit
 * entry records.
 *
 * Defaults to a dry run for the same reason.
 */
export const adminSetupJourney = asyncHandler(async (req, res) => {
  const { setupJourney } = await import('../services/progression/journey.service.js');
  const result = await setupJourney({ apply: req.body?.apply === true });

  return sendSuccess(res, {
    message: result.applied ? 'Journey courses are set up.' : 'Dry run - nothing was written.',
    data: result,
  });
});

/**
 * Seeds the GARUD and YODDHA curriculum, or reports what it would do.
 *
 * Exists for the same reason the journey setup does: the seed script needs
 * database access a managed deployment does not give you, so content defined in
 * code could otherwise never reach production. Dry by default - an operator
 * sees every decision before anything is written.
 *
 * Adds and never overwrites, and writes no student data of any kind.
 */
export const adminSeedCurriculum = asyncHandler(async (req, res) => {
  const { seedCurriculum } = await import('../services/progression/curriculum.service.js');
  const result = await seedCurriculum({
    apply: req.body?.apply === true,
    only: req.body?.only || null,
  });

  return sendSuccess(res, {
    message: result.applied ? 'Curriculum applied.' : 'Dry run - nothing was written.',
    data: result,
  });
});

/** What is actually in the database for the journey courses. Read-only. */
export const adminAuditCurriculum = asyncHandler(async (req, res) => {
  const { auditCurriculum } = await import('../services/progression/curriculum.service.js');
  return sendSuccess(res, { data: await auditCurriculum() });
});

/**
 * Task submissions for a given set of students.
 *
 * Grading a submission already worked - gradeBridgedTaskSubmission takes any
 * TaskSubmission by id - but only submissions that had been pushed outward from
 * a teacher-authored assignment were ever visible on that side. A task authored
 * as course content, which is what the GARUD and YODDHA assignments are, had no
 * route by which a teacher could find it, so in practice it could not be graded
 * at all.
 *
 * The caller supplies the student ids it is entitled to see; scoping to a
 * teacher's own roster happens on the teacher side, where the ownership records
 * actually live. This endpoint is behind the service key and returns nothing
 * for ids it is not given.
 */
export const adminListTaskSubmissions = asyncHandler(async (req, res) => {
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds.filter(mongoose.isValidObjectId) : [];
  const ungradedOnly = req.body?.ungradedOnly === true;
  if (!userIds.length) return sendSuccess(res, { data: [] });

  const filter = { userId: { $in: userIds } };
  if (ungradedOnly) filter.teacherScore = null;

  const submissions = await TaskSubmission.find(filter).sort({ completedAt: -1 }).limit(500).lean();
  if (!submissions.length) return sendSuccess(res, { data: [] });

  const [tasks, users] = await Promise.all([
    Task.find({ _id: { $in: submissions.map((s) => s.taskId) } }).select('taskId title subject type moduleTitle pointsReward courseId').lean(),
    User.find({ _id: { $in: submissions.map((s) => s.userId) } }).select('name email').lean(),
  ]);
  const courses = await Course.find({ _id: { $in: tasks.map((t) => t.courseId) } }).select('slug title').lean();

  const taskById = new Map(tasks.map((t) => [String(t._id), t]));
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const courseById = new Map(courses.map((c) => [String(c._id), c]));

  return sendSuccess(res, {
    data: submissions.map((sub) => {
      const task = taskById.get(String(sub.taskId));
      const course = task ? courseById.get(String(task.courseId)) : null;
      const user = userById.get(String(sub.userId));
      return {
        submissionId: String(sub._id),
        userId: String(sub.userId),
        studentName: user?.name || null,
        studentEmail: user?.email || null,
        taskId: task?.taskId || null,
        taskTitle: task?.title || null,
        taskType: task?.type || null,
        subject: task?.subject || null,
        moduleTitle: task?.moduleTitle || null,
        courseSlug: course?.slug || null,
        courseTitle: course?.title || null,
        submissionText: sub.submissionText || '',
        status: sub.status,
        submittedAt: sub.completedAt,
        graded: sub.teacherScore !== null && sub.teacherScore !== undefined,
        teacherScore: sub.teacherScore ?? null,
        teacherMaxScore: sub.teacherMaxScore ?? null,
        teacherFeedback: sub.teacherFeedback ?? null,
        gradedAt: sub.gradedAt || null,
      };
    }),
  });
});

export default {
  adminSetupJourney,
  adminListTaskSubmissions,
  adminSeedCurriculum,
  adminAuditCurriculum,
  adminGetProgressionRules,
  adminUpdateProgressionRules,
  adminUpdateStage,
  adminUpdateAchievement,
  adminRecalculateProgression,
  adminProgressionAnalytics,
  adminGetStudentProgress,
  adminGetStudentActivity,
  adminRecordAttendance,
  adminGetCourseContent,
  adminSetContentSubjects,
  adminListSubjects,
  adminListCoupons,
  adminCreateCampaign,
  adminListCampaigns,
  adminExportCampaign,
  adminUpdateCoupon,
  adminDeleteCoupon,
  createBridgedAnnouncement,
  updateBridgedAnnouncement,
  deleteBridgedAnnouncement,
  createBridgedMaterial,
  deleteBridgedMaterial,
  upsertBridgedTask,
  retractBridgedTask,
  createBridgedLiveClass,
  updateBridgedLiveClass,
  retractBridgedLiveClass,
  listEnrolledStudents,
  upsertBridgedQuiz,
  retractBridgedQuiz,
  deliverTeacherMessage,
  upsertBridgedCourse,
  unpublishBridgedCourse,
  upsertBridgedResource,
  retractBridgedResource,
  gradeBridgedTaskSubmission,
};

/**
 * POST /api/internal/students/lookup
 *
 * One student by enrollment number, for the teacher and admin portals.
 *
 * Answers 200 with null when there is no match - including a student outside
 * the teacher scope supplied - so the calling portal decides what its user
 * hears, and "not yours" is never distinguishable from "does not exist".
 */
export const lookupStudentByEnrollmentNumber = asyncHandler(async (req, res) => {
  const { enrollmentNumber, scope, includePayments } = req.body;
  const student = await findStudentByEnrollmentNumber(enrollmentNumber, {
    scope: scope || null,
    includePayments: includePayments === true,
  });
  return sendSuccess(res, { message: student ? 'Student found.' : 'No matching student.', data: student });
});

/**
 * POST /api/internal/portal-students/resync
 *
 * The admin portal's recovery for student records that did not reach it or the
 * teacher portal: one student by enrollment number, everyone still pending, or
 * every enrolled student a page at a time. A dry run unless `apply` is true, in
 * which case it reports what would be sent and sends nothing.
 */
export const resyncPortalStudents = asyncHandler(async (req, res) => {
  const { mode, enrollmentNumber, cursor, limit, apply } = req.body;
  const data = await runPortalResync({ mode, enrollmentNumber, cursor, limit, dryRun: !apply });
  return sendSuccess(res, { message: apply ? 'Student records resent.' : 'Dry run - nothing was sent.', data });
});
