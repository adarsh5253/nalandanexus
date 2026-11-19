import { catchAsync } from '../utils/catchAsync.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import * as studentBridge from '../services/studentCourseBridge.service.js';
import { recordAuditLog } from '../services/auditLog.service.js';

/**
 * Lesson videos for any course - Prarambh, Garud, Yoddha and every bridged
 * course alike. Lessons live in the student service, so this is a proxy with
 * an audit trail: the student service validates the link and stores it, and
 * this portal records who did what.
 */

const actorOf = (req) => ({ portal: 'admin', userId: String(req.admin._id), name: req.admin.name || null });

export const listCourses = catchAsync(async (req, res) => {
  sendSuccess(res, { data: await studentBridge.listLessonVideoCourses() });
});

export const getCourse = catchAsync(async (req, res) => {
  sendSuccess(res, { data: await studentBridge.getLessonVideos(req.params.slug) });
});

export const inspect = catchAsync(async (req, res) => {
  sendSuccess(res, { data: await studentBridge.inspectLessonVideo(req.body.url) });
});

// A video belongs to one lesson or one module, named by the route.
const targetOf = (params) => (params.moduleId ? { moduleId: params.moduleId } : { lessonId: params.lessonId });

export const save = catchAsync(async (req, res) => {
  const { slug } = req.params;
  const target = targetOf(req.params);
  const result = await studentBridge.saveCourseVideo(slug, target, { ...req.body, actor: actorOf(req) });

  const video = result?.video;
  await recordAuditLog({
    actor: req.admin,
    action: video?.isPublished ? 'course.lesson_video.published' : 'course.lesson_video.saved',
    entityType: 'Course',
    entityId: slug,
    metadata: {
      slug,
      ...target,
      videoId: video?.videoId || null,
      previousVideoId: result?.previousVideoId || null,
      wasPublished: Boolean(result?.wasPublished),
      isPublished: Boolean(video?.isPublished),
      availability: video?.availability || null,
    },
    req,
  });

  sendSuccess(res, { message: video?.isPublished ? 'Video published' : 'Video saved as draft', data: result });
});

export const remove = catchAsync(async (req, res) => {
  const { slug } = req.params;
  const target = targetOf(req.params);
  const result = await studentBridge.removeCourseVideo(slug, target, {
    actor: actorOf(req),
    ...(req.body?.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: req.body.expectedUpdatedAt } : {}),
  });

  if (result?.removed) {
    await recordAuditLog({
      actor: req.admin,
      action: 'course.lesson_video.removed',
      entityType: 'Course',
      entityId: slug,
      metadata: { slug, ...target, previousVideoId: result.previousVideoId || null },
      req,
    });
  }

  sendSuccess(res, { message: result?.removed ? 'Video removed' : 'There was no video to remove', data: result });
});

export default { listCourses, getCourse, inspect, save, remove };
