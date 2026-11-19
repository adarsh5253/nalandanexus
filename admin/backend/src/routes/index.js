import { Router } from 'express';
import authRoutes from './auth.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import teacherRoutes from './teacher.routes.js';
import studentRoutes from './student.routes.js';
import courseRoutes from './course.routes.js';
import batchRoutes from './batch.routes.js';
import couponRoutes from './coupon.routes.js';
import courseSubjectRoutes from './courseSubject.routes.js';
import lessonVideoRoutes from './lessonVideo.routes.js';
import progressionRoutes from './progression.routes.js';
import resourceRoutes from './resource.routes.js';
import enrollmentRoutes from './enrollment.routes.js';
import announcementRoutes from './announcement.routes.js';
import auditLogRoutes from './auditLog.routes.js';
import notificationRoutes from './notification.routes.js';
import paymentRoutes from './payment.routes.js';
import settingsRoutes from './settings.routes.js';
import reportRoutes from './report.routes.js';
import systemHealthRoutes from './systemHealth.routes.js';
import academicsRoutes from './academics.routes.js';
import fileRoutes from './file.routes.js';

const router = Router();

router.use('/auth', authRoutes);
// Uploaded images (teacher photos), stored in the database. Public by design -
// see routes/file.routes.js.
router.use('/files', fileRoutes);
router.use('/', dashboardRoutes); // /overview, /leaderboard, /live-telemetry (kept flat for frontend compatibility)
router.use('/teachers', teacherRoutes);
router.use('/students', studentRoutes);
router.use('/courses', courseRoutes);
// Batches live in the teacher service; these routes proxy to it (see
// controllers/batch.controller.js) rather than duplicating the model here.
router.use('/batches', batchRoutes);
// Coupons live in the student service beside the courses they discount; these
// routes proxy to it (see controllers/coupon.controller.js).
router.use('/coupons', couponRoutes);
// Subject tagging lives beside courses but proxies to the student service,
// which is the only place a native course's modules and lessons exist.
router.use('/course-content', courseSubjectRoutes);
// YouTube videos on lessons - also proxied to the student service, which owns
// lessons and validates every link.
router.use('/lesson-videos', lessonVideoRoutes);
// The progression control centre: every configurable number the engine
// consults, edited in one place rather than scattered across controllers.
router.use('/progression', progressionRoutes);
router.use('/resources', resourceRoutes);
router.use('/enrollments', enrollmentRoutes);
router.use('/announcements', announcementRoutes);
router.use('/audit-logs', auditLogRoutes);
router.use('/notifications', notificationRoutes);
router.use('/payments', paymentRoutes);
router.use('/settings', settingsRoutes);
router.use('/reports', reportRoutes);
router.use('/system-health', systemHealthRoutes);
router.use('/academics', academicsRoutes);

export default router;
