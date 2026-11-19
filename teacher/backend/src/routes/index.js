import { Router } from 'express';
import authRoutes from './auth.routes.js';
import teacherRoutes from './teacher.routes.js';
import classRoutes from './class.routes.js';
import studentRoutes from './student.routes.js';
import assignmentRoutes from './assignment.routes.js';
import submissionRoutes from './submission.routes.js';
import courseAssignmentRoutes from './courseAssignments.routes.js';
import attendanceRoutes from './attendance.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import analyticsRoutes from './analytics.routes.js';
import notificationRoutes from './notification.routes.js';
import courseRoutes from './course.routes.js';
import lessonVideoRoutes from './lessonVideo.routes.js';
import examRoutes from './exam.routes.js';
import resourceRoutes from './resource.routes.js';
import messageRoutes from './message.routes.js';
import searchRoutes from './search.routes.js';
import scheduleRoutes from './schedule.routes.js';
import announcementRoutes from './announcement.routes.js';
import timetableRoutes from './timetable.routes.js';
import reportRoutes from './report.routes.js';

// All mounted beneath /api/teacher (see app.js) to stay backward-compatible
// with the frontend's existing VITE_TEACHER_API_URL default.
const router = Router();

router.use('/auth', authRoutes);
// Mounted at bare '/' so its routes read as /api/teacher/profile (not /api/teacher/teacher/profile).
// Side effect worth knowing: teacherRoutes applies `authenticate` at its own
// root, and because it's mounted at '/' it is checked for every path under
// /api/teacher/*. That means an UNAUTHENTICATED request to a typo'd/unknown
// route (e.g. GET /api/teacher/nonsense) gets 401 here rather than falling
// through to the 404 handler below — auth is checked before route existence.
// This is intentional-by-effect and fail-safe (no anonymous route probing),
// not a bug: an AUTHENTICATED request to an unknown route still correctly
// falls through this router (no matching path) to the routers below it and
// ultimately to notFoundHandler -> 404. See src/seed/smokeTest.js for the
// test that documents/verifies this.
router.use('/', teacherRoutes); // /profile, /profile/preferences, /profile/avatar
router.use('/classes', classRoutes);
router.use('/students', studentRoutes);
router.use('/assignments', assignmentRoutes);
router.use('/submissions', submissionRoutes);
// Assignments that are part of the course content rather than teacher-authored.
// Submissions live in the student portal; ownership is enforced against this
// teacher's own roster before anything is read or graded.
router.use('/course-assignments', courseAssignmentRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/notifications', notificationRoutes);
router.use('/courses', courseRoutes);
// YouTube videos on the lessons of a teacher's assigned courses.
router.use('/lesson-videos', lessonVideoRoutes);
router.use('/exams', examRoutes);
router.use('/resources', resourceRoutes);
router.use('/messages', messageRoutes);
router.use('/search', searchRoutes);
router.use('/schedule', scheduleRoutes);
router.use('/announcements', announcementRoutes);
router.use('/timetable', timetableRoutes);
router.use('/reports', reportRoutes);

export default router;
