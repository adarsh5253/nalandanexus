import { Router } from 'express';
import * as publicController from '../controllers/public.controller.js';
import * as reviewController from '../controllers/review.controller.js';
import { attachUserIfPresent } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { contactSchema } from '../validators/contact.validators.js';

const router = Router();

router.get('/courses', attachUserIfPresent, publicController.listCourses);
router.get('/courses/:slug', attachUserIfPresent, publicController.getCourseBySlug);
// Anyone may READ a course's reviews (a prospective student deciding whether
// to buy); only enrolled students may write one - see routes/courses.routes.js.
router.get('/courses/:slug/reviews', reviewController.listCourseReviews);
router.get('/announcements', publicController.listPublicAnnouncements);
router.get('/resources', publicController.listPublicResources);
// The faculty the About page introduces, published by the admin portal.
router.get('/faculty', publicController.listPublicFaculty);
router.get('/stats', publicController.listPublicStats);
router.get('/highlights', publicController.listPublicHighlights);
router.post('/contact', validate(contactSchema), publicController.submitContactMessage);

export default router;
