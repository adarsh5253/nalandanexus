import { Router } from 'express';
import { body, param } from 'express-validator';
import * as controller from '../controllers/lessonVideo.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

/**
 * YouTube videos on the lessons of a teacher's assigned courses. Shape is
 * checked here, course assignment in the controller (CourseAccess), and the
 * link itself by the student service that stores it.
 */
const router = Router();
router.use(authenticate, requireRole('teacher'));

const slugParam = param('slug').trim().matches(/^[a-z0-9-]{1,100}$/i).withMessage('Invalid course.');
const lessonParam = param('lessonId').trim().isLength({ min: 1, max: 120 }).withMessage('Invalid lesson.');
const moduleParam = param('moduleId').trim().isLength({ min: 1, max: 120 }).withMessage('Invalid module.');
const urlBody = body('url').isString().withMessage('Paste a YouTube link.').isLength({ max: 2048 });
// The version of the video the editor loaded: an ISO timestamp, or null for "there was no video".
const expectedBody = body('expectedUpdatedAt')
  .optional({ values: 'undefined' })
  .custom((v) => v === null || (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v))))
  .withMessage('Invalid version.');

const saveFields = [
  urlBody,
  body('title').optional().isString().isLength({ max: 200 }),
  body('description').optional().isString().isLength({ max: 2000 }),
  body('playbackMode').optional().isIn(['embed', 'external']),
  body('isPublished').optional().isBoolean({ strict: true }),
  expectedBody,
];

router.get('/courses', controller.listCourses);
router.get('/courses/:slug', slugParam, validate, controller.getCourse);
router.post('/inspect', urlBody, validate, controller.inspect);
router.put('/courses/:slug/lessons/:lessonId', slugParam, lessonParam, ...saveFields, validate, controller.save);
router.delete('/courses/:slug/lessons/:lessonId', slugParam, lessonParam, expectedBody, validate, controller.remove);
router.put('/courses/:slug/modules/:moduleId', slugParam, moduleParam, ...saveFields, validate, controller.save);
router.delete('/courses/:slug/modules/:moduleId', slugParam, moduleParam, expectedBody, validate, controller.remove);

export default router;
