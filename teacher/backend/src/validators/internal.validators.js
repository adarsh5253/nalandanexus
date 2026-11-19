import { body, param, query } from 'express-validator';

export const teacherForCourseValidator = [
  param('studentCourseSlug').trim().notEmpty(),
  // The caller's batch, so a student gets THEIR batch's teacher rather than
  // whichever batch of the course was created first.
  query('batchId').optional().trim().matches(/^[a-f\d]{24}$/i).withMessage('batchId must be a valid identifier'),
];

export const deliverMessageValidator = [
  body('studentCourseSlug').trim().notEmpty(),
  body('externalStudentId').trim().notEmpty(),
  body('externalStudentName').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('text').trim().notEmpty().isLength({ max: 4000 }),
];

// A setup link is identified across the service boundary by the SHA-256 of its
// token (64 hex characters) and its expiry - never the token itself.
const setupLinkRules = [
  body('setupTokenHash').optional().isString().matches(/^[a-f0-9]{64}$/).withMessage('setupTokenHash must be a SHA-256 hex digest'),
  body('setupTokenExpiresAt')
    .optional()
    .isISO8601()
    .withMessage('setupTokenExpiresAt must be a date')
    .custom((value) => new Date(value) > new Date())
    .withMessage('setupTokenExpiresAt must be in the future'),
];

export const provisionTeacherValidator = [
  body('name').trim().notEmpty().isLength({ max: 120 }),
  body('email').trim().isEmail().normalizeEmail(),
  body('phone').optional({ nullable: true }).trim().isLength({ max: 20 }),
  // Legacy: an administrator-issued temporary password. New callers send a setup
  // link instead; one of the two is required.
  body('tempPassword').optional().isString().isLength({ min: 8, max: 100 }),
  ...setupLinkRules,
  body().custom((value) => {
    if (value.tempPassword) return true;
    if (value.setupTokenHash && value.setupTokenExpiresAt) return true;
    throw new Error('Either a setup link (setupTokenHash and setupTokenExpiresAt) or a tempPassword is required.');
  }),
  body('teacherId').optional({ nullable: true }).trim().matches(/^TCH-\d{4,}$/i).withMessage('teacherId must look like TCH-0001'),
  body('avatarUrl').optional({ nullable: true }).trim().isLength({ max: 2000 }),
  body('title').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('department').optional({ nullable: true }).trim().isLength({ max: 120 }),
  body('subject').optional({ nullable: true }).trim().isLength({ max: 120 }),
];

export const resetCredentialsValidator = [
  body('email').trim().isEmail().normalizeEmail(),
  // Legacy: reset to an administrator-issued temporary password.
  body('newPassword').optional().isString().isLength({ min: 8, max: 100 }),
  ...setupLinkRules,
  body().custom((value) => {
    if (value.newPassword) return true;
    if (value.setupTokenHash && value.setupTokenExpiresAt) return true;
    throw new Error('Either a setup link (setupTokenHash and setupTokenExpiresAt) or a newPassword is required.');
  }),
];

/**
 * The full set of courses an administrator has assigned to one teacher,
 * identified by EMAIL (the identity both services share) and by the student
 * catalogue's course slug. Sent as a set every time, so it replaces.
 */
export const setTeacherCoursesValidator = [
  body('teacherEmail').trim().isEmail().normalizeEmail(),
  body('courses').isArray({ max: 50 }),
  body('courses.*.slug').isString().trim().matches(/^[a-z0-9-]{1,100}$/i).withMessage('A course slug is required'),
  body('courses.*.title').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
];

export const setAccountStatusValidator = [
  body('email').trim().isEmail().normalizeEmail(),
  body('status').isIn(['active', 'inactive', 'suspended']),
];

export const sourceIdParamValidator = [param('sourceId').trim().notEmpty().isLength({ max: 64 })];

export const assignCourseValidator = [
  body('teacherEmail').trim().isEmail().normalizeEmail(),
  body('title').trim().notEmpty().isLength({ max: 200 }),
  body('courseCode').optional({ nullable: true }).trim().isLength({ max: 40 }),
  body('description').optional({ nullable: true }).trim().isLength({ max: 4000 }),
  body('image').optional({ nullable: true }).trim().isLength({ max: 500 }),
  body('priceInPaise').optional({ nullable: true }).isInt({ min: 0 }),
  body('status').optional({ nullable: true }).trim().isLength({ max: 40 }),
  // The student catalogue slug this course is sold under, when it has one - what
  // lets the teacher see the students enrolled in it.
  body('studentCourseSlug').optional({ nullable: true }).trim().matches(/^[a-z0-9-]{1,100}$/i),
];

export const adminAnnouncementValidator = [
  body('sourceId').trim().notEmpty().isLength({ max: 64 }),
  body('title').trim().notEmpty().isLength({ max: 200 }),
  body('content').trim().notEmpty(),
  body('priority').optional({ nullable: true }).isIn(['LOW', 'MEDIUM', 'HIGH']),
  body('authorName').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('publishedAt').optional({ nullable: true }).isISO8601(),
];

export const receiveSubmissionValidator = [
  body('assignmentSourceId').trim().notEmpty(),
  body('studentUserId').trim().notEmpty(),
  body('studentName').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('studentEmail').optional({ nullable: true }).trim().isEmail().normalizeEmail(),
  body('submissionText').optional({ nullable: true }).trim().isLength({ max: 10000 }),
  body('isLate').optional().isBoolean().toBoolean(),
  body('submissionSourceId').optional({ nullable: true }).trim().isLength({ max: 100 }),
];

export const receiveQuizResultValidator = [
  body('examSourceId').trim().notEmpty(),
  body('studentUserId').trim().notEmpty(),
  body('studentName').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('studentEmail').optional({ nullable: true }).trim().isEmail().normalizeEmail(),
  body('scorePercentage').isFloat({ min: 0, max: 100 }).toFloat(),
  body('correctCount').isInt({ min: 0 }).toInt(),
  body('totalCount').isInt({ min: 0 }).toInt(),
];

/**
 * A placement request from the student portal. `enrollmentId` is the student
 * portal's business identifier (ENR-YYYY-NNNNNN), not one of our ObjectIds -
 * shape-checked here so an arbitrary string can never become a roster identity.
 */
export const placeEnrollmentValidator = [
  body('studentCourseSlug').trim().notEmpty().withMessage('studentCourseSlug is required').isLength({ max: 200 }).matches(/^[a-z0-9-]+$/i),
  body('enrollmentId').trim().notEmpty().withMessage('enrollmentId is required').isLength({ max: 40 }).matches(/^[A-Z0-9-]+$/i).withMessage('Invalid enrollment identifier.'),
  body('studentName').optional({ nullable: true }).trim().isLength({ max: 120 }),
];

/**
 * A student's current record from the student portal. The email is checked but
 * not normalised: normalising would rewrite a real address (dots in a Gmail
 * local part) into one the student does not use.
 */
export const portalStudentValidator = [
  param('userId').isMongoId().withMessage('userId must be a valid identifier.'),
  body('userId').isMongoId().withMessage('userId must be a valid identifier.'),
  body('fullName').isString().trim().notEmpty().isLength({ max: 120 }),
  body('email').isString().trim().isEmail().isLength({ max: 200 }),
  body('enrollmentNumber').optional({ nullable: true }).isString().trim().matches(/^NN\d{2}-\d{6,9}$/),
  body('phone').optional({ nullable: true }).isString().isLength({ max: 20 }),
  body('avatar').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  body('guardianName').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('grade').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('enrollments').isArray({ max: 200 }),
  body('enrollments.*.enrollmentId').isString().trim().notEmpty().isLength({ max: 40 }).matches(/^[A-Z0-9-]+$/i),
  body('enrollments.*.status').isIn(['active', 'revoked']),
  body('enrollments.*.batchId').optional({ nullable: true }).isString().isLength({ max: 40 }),
  // Which course the enrolment is in, so the course-wide roster can place it.
  // The slug is catalogue information; no title or price is sent.
  body('enrollments.*.courseSlug').optional({ nullable: true }).isString().trim().matches(/^[a-z0-9-]{1,100}$/i),
  body('enrollments.*.batchCode').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('enrollments.*.enrolledAt').optional({ nullable: true }).isISO8601(),
  body('sourceUpdatedAt').isISO8601(),
];

/**
 * Admin batch administration. The teacher is identified by EMAIL, the identity
 * shared across services - never by one of this database's ObjectIds, which
 * Admin has no way to know and must not be able to guess at.
 */
const emailRule = (field) => body(field).trim().notEmpty().isEmail().withMessage('A valid teacher email is required').normalizeEmail();

export const adminCreateBatchValidator = [
  body('courseSlug').trim().notEmpty().withMessage('A course is required').isLength({ max: 200 }).matches(/^[a-z0-9-]+$/i),
  body('name').trim().notEmpty().withMessage('A batch name is required').isLength({ max: 120 }),
  emailRule('teacherEmail'),
  body('capacity').optional().isInt({ min: 1, max: 500 }).withMessage('Capacity must be between 1 and 500').toInt(),
  body('room').optional({ nullable: true }).trim().isLength({ max: 60 }),
  body('schedule').optional({ nullable: true }).trim().isLength({ max: 200 }),
  body('actorEmail').optional({ nullable: true }).trim().isLength({ max: 160 }),
];

export const adminUpdateBatchValidator = [
  body('name').optional().trim().notEmpty().isLength({ max: 120 }),
  body('capacity').optional().isInt({ min: 1, max: 500 }).withMessage('Capacity must be between 1 and 500').toInt(),
  body('status').optional().isIn(['active', 'archived']),
  body('room').optional({ nullable: true }).trim().isLength({ max: 60 }),
  body('schedule').optional({ nullable: true }).trim().isLength({ max: 200 }),
  body('studentCourseSlug').optional().trim().notEmpty().isLength({ max: 200 }).matches(/^[a-z0-9-]+$/i),
  body('actorEmail').optional({ nullable: true }).trim().isLength({ max: 160 }),
];

export const adminReassignBatchValidator = [
  emailRule('teacherEmail'),
  body('actorEmail').optional({ nullable: true }).trim().isLength({ max: 160 }),
];

export const adminListBatchesValidator = [
  query('courseSlug').optional().trim().isLength({ max: 200 }).matches(/^[a-z0-9-]+$/i),
  query('teacherEmail').optional().trim().isEmail().normalizeEmail(),
  query('status').optional().isIn(['all', 'active', 'archived']),
  query('search').optional().trim().isLength({ max: 120 }),
];

export default {
  adminCreateBatchValidator,
  adminUpdateBatchValidator,
  adminReassignBatchValidator,
  adminListBatchesValidator,
  placeEnrollmentValidator,
  portalStudentValidator,
  teacherForCourseValidator,
  deliverMessageValidator,
  provisionTeacherValidator,
  resetCredentialsValidator,
  setTeacherCoursesValidator,
  setAccountStatusValidator,
  sourceIdParamValidator,
  assignCourseValidator,
  adminAnnouncementValidator,
  receiveSubmissionValidator,
};
