import { Router } from 'express';
import { param } from 'express-validator';
import * as courseController from '../controllers/course.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { objectIdParam } from '../validators/common.js';
import { createCourseValidator, updateCourseValidator } from '../validators/course.validators.js';

const slugParam = param('slug').trim().matches(/^[a-z0-9-]{1,100}$/i).withMessage('Invalid course.');

const router = Router();
router.use(authenticate, requireRole('teacher'));

router.get('/', courseController.listCourses);
router.get('/assigned', courseController.listAssigned);
router.get('/assigned/:slug/students', slugParam, validate, courseController.listAssignedCourseStudents);
router.post('/assigned/:slug/refresh', slugParam, validate, courseController.refreshAssignedCourseStudents);
router.post('/', createCourseValidator, validate, courseController.createCourse);
router.patch('/:id', objectIdParam('id'), updateCourseValidator, validate, courseController.updateCourse);
router.delete('/:id', objectIdParam('id'), validate, courseController.archiveCourse);

export default router;
