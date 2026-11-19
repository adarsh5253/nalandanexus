import { Router } from 'express';
import multer from 'multer';
import * as teacherController from '../controllers/teacher.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { objectIdParam } from '../validators/common.js';
import {
  listTeachersQuery,
  createTeacherSchema,
  updateTeacherSchema,
  setTeacherCoursesSchema,
  suspendTeacherSchema,
  activateTeacherSchema,
} from '../validators/teacher.validator.js';

const router = Router();

// Held in memory only long enough to be checked and written to the database
// (services/fileStorage.service.js); never touches the container's disk.
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

// Public — part of the invitation-activation flow, reached before the
// invitee has any credentials at all.
router.get('/invite/:token', teacherController.verifyInvite);
router.post('/activate', validate(activateTeacherSchema), teacherController.activate);

router.use(authenticate);

router.get('/', requirePermission('teachers.read'), validate(listTeachersQuery), teacherController.list);
router.get('/:id', requirePermission('teachers.read'), validate({ params: objectIdParam() }), teacherController.getById);
router.post('/', requirePermission('teachers.create'), validate(createTeacherSchema), teacherController.create);
router.put('/:id', requirePermission('teachers.update'), validate({ params: objectIdParam(), ...updateTeacherSchema }), teacherController.update);
// The courses assigned to a teacher, which decide which students they can see.
router.put('/:id/courses', requirePermission('teachers.update'), validate({ params: objectIdParam(), ...setTeacherCoursesSchema }), teacherController.setCourses);
router.post('/:id/photo', requirePermission('teachers.update'), validate({ params: objectIdParam() }), photoUpload.single('photo'), teacherController.uploadPhoto);
router.delete('/:id', requirePermission('teachers.delete'), validate({ params: objectIdParam() }), teacherController.remove);

router.post('/:id/resend-invite', requirePermission('teachers.update'), validate({ params: objectIdParam() }), teacherController.resendInvite);
router.post('/:id/resend-credentials', requirePermission('teachers.update'), validate({ params: objectIdParam() }), teacherController.resendCredentials);
router.post('/:id/revoke-invite', requirePermission('teachers.delete'), validate({ params: objectIdParam() }), teacherController.revokeInvite);
router.post('/:id/suspend', requirePermission('teachers.update'), validate({ params: objectIdParam(), ...suspendTeacherSchema }), teacherController.suspend);
router.post('/:id/reactivate', requirePermission('teachers.update'), validate({ params: objectIdParam() }), teacherController.reactivate);
// A password can only be set through an emailed single-use link, so a reset is
// the same thing as sending a new one.
router.post('/:id/reset-password', requirePermission('teachers.update'), validate({ params: objectIdParam() }), teacherController.resendCredentials);

export default router;
