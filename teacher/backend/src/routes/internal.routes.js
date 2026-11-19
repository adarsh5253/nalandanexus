import { Router } from 'express';
import * as internalController from '../controllers/internal.controller.js';
import { requireInternalServiceKey } from '../middleware/internalService.js';
import { validate } from '../middleware/validate.js';
import { objectIdParam } from '../validators/common.js';
import {
  teacherForCourseValidator,
  placeEnrollmentValidator,
  adminCreateBatchValidator,
  adminUpdateBatchValidator,
  adminReassignBatchValidator,
  adminListBatchesValidator,
  deliverMessageValidator,
  provisionTeacherValidator,
  resetCredentialsValidator,
  setTeacherCoursesValidator,
  setAccountStatusValidator,
  assignCourseValidator,
  sourceIdParamValidator,
  adminAnnouncementValidator,
  receiveSubmissionValidator,
  receiveQuizResultValidator,
  portalStudentValidator,
} from '../validators/internal.validators.js';

// Service-to-service only - authenticated by a shared secret
// (requireInternalServiceKey), never a user session. Mounted at /api/internal
// directly (see app.js), NOT under /api/teacher, so it is never subject to
// that group's user-session `authenticate` middleware.
const router = Router();
router.use(requireInternalServiceKey);

router.get('/teacher-for-course/:studentCourseSlug', teacherForCourseValidator, validate, internalController.getTeacherForCourse);
router.post('/batches/place', placeEnrollmentValidator, validate, internalController.placeEnrollmentInBatch);
// A student's current record from the student portal, applied to the rows placement created.
router.put('/portal-students/:userId', portalStudentValidator, validate, internalController.applyPortalStudentRecord);

// Batch administration for the Admin portal. Batches live in this database, so
// Admin manages them through here rather than owning a competing model.
router.get('/batches', adminListBatchesValidator, validate, internalController.adminListBatches);
router.post('/batches', adminCreateBatchValidator, validate, internalController.adminCreateBatch);
router.get('/batches/:id', objectIdParam('id'), validate, internalController.adminGetBatch);
router.patch('/batches/:id', objectIdParam('id'), adminUpdateBatchValidator, validate, internalController.adminUpdateBatch);
// Reassignment is admin-only and explicit: a teacher moving their own batch to
// someone else is exactly the mass-assignment hole the update allow-list closes.
router.patch('/batches/:id/teacher', objectIdParam('id'), adminReassignBatchValidator, validate, internalController.adminReassignBatchTeacher);
router.get('/batches/:id/students', objectIdParam('id'), validate, internalController.adminListBatchStudents);
router.post('/messages', deliverMessageValidator, validate, internalController.deliverMessage);
router.post('/teachers', provisionTeacherValidator, validate, internalController.provisionTeacher);
router.patch('/teachers/credentials', resetCredentialsValidator, validate, internalController.resetTeacherCredentials);
// The full set of courses assigned to one teacher (replaces). Visibility of each course's students follows from it.
router.put('/teachers/courses', setTeacherCoursesValidator, validate, internalController.setCoursesForTeacher);
router.patch('/teachers/status', setAccountStatusValidator, validate, internalController.setTeacherAccountStatus);
router.put('/courses/:sourceId', sourceIdParamValidator, assignCourseValidator, validate, internalController.upsertAssignedCourse);
router.delete('/courses/:sourceId', sourceIdParamValidator, validate, internalController.removeAssignedCourse);
router.post('/admin-announcements', adminAnnouncementValidator, validate, internalController.upsertAdminAnnouncement);
router.delete('/admin-announcements/:sourceId', sourceIdParamValidator, validate, internalController.removeAdminAnnouncement);
router.post('/submissions', receiveSubmissionValidator, validate, internalController.receiveSubmission);
router.post('/quiz-results', receiveQuizResultValidator, validate, internalController.receiveQuizResult);

export default router;
