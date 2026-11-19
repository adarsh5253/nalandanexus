import { catchAsync } from '../utils/catchAsync.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import * as lessonVideos from '../services/lessonVideo.service.js';
import { logAudit } from '../services/audit.service.js';

/**
 * Lesson videos, for assigned courses only. Every route that names a course
 * checks the teacher's CourseAccess first - on the server, on every request -
 * so hiding a course in the UI is never what keeps a teacher out of it.
 */

const actorOf = (req) => ({ portal: 'teacher', userId: String(req.user._id), name: req.user.name || null });

export const listCourses = catchAsync(async (req, res) => {
  sendSuccess(res, { data: await lessonVideos.listManageableCourses(req.teacher._id) });
});

export const getCourse = catchAsync(async (req, res) => {
  const slug = await lessonVideos.assertCourseAccess(req.teacher._id, req.params.slug);
  sendSuccess(res, { data: await lessonVideos.getCourseVideos(slug) });
});

export const inspect = catchAsync(async (req, res) => {
  // Reads nothing of any course - it only describes a pasted link - so it needs
  // a teacher session but no particular assignment.
  sendSuccess(res, { data: await lessonVideos.inspectLink(req.body.url) });
});

// A video belongs to one lesson or one module, named by the route.
const targetOf = (params) => (params.moduleId ? { moduleId: params.moduleId } : { lessonId: params.lessonId });

export const save = catchAsync(async (req, res) => {
  const slug = await lessonVideos.assertCourseAccess(req.teacher._id, req.params.slug);
  const target = targetOf(req.params);
  const { url, title, description, playbackMode, isPublished, expectedUpdatedAt } = req.body;
  const result = await lessonVideos.saveCourseVideo(slug, target, {
    url,
    title: title ?? '',
    description: description ?? '',
    playbackMode: playbackMode || 'embed',
    isPublished: Boolean(isPublished),
    ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
    actor: actorOf(req),
  });

  const video = result?.video;
  await logAudit({
    actorId: req.user._id,
    action: video?.isPublished ? 'course.lesson_video.published' : 'course.lesson_video.saved',
    targetType: 'Course',
    targetId: null,
    metadata: {
      slug,
      ...target,
      videoId: video?.videoId || null,
      previousVideoId: result?.previousVideoId || null,
      isPublished: Boolean(video?.isPublished),
    },
    ip: req.ip,
  });

  sendSuccess(res, { message: video?.isPublished ? 'Video published' : 'Video saved as draft', data: result });
});

export const remove = catchAsync(async (req, res) => {
  const slug = await lessonVideos.assertCourseAccess(req.teacher._id, req.params.slug);
  const target = targetOf(req.params);
  const result = await lessonVideos.removeCourseVideo(slug, target, {
    actor: actorOf(req),
    ...(req.body?.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: req.body.expectedUpdatedAt } : {}),
  });

  if (result?.removed) {
    await logAudit({
      actorId: req.user._id,
      action: 'course.lesson_video.removed',
      targetType: 'Course',
      targetId: null,
      metadata: { slug, ...target, previousVideoId: result.previousVideoId || null },
      ip: req.ip,
    });
  }

  sendSuccess(res, { message: result?.removed ? 'Video removed' : 'There was no video to remove', data: result });
});

export default { listCourses, getCourse, inspect, save, remove };
