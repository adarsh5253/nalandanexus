import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import * as lessonVideos from '../services/lessonVideo.service.js';

/**
 * Lesson video management, reached only over the service-key bridge (see
 * routes/internal.routes.js). The Admin portal calls it for any course; the
 * Teacher portal calls it only for courses its own records say the signed-in
 * teacher is assigned to. Neither portal can reach these routes with a user
 * session, and no student can reach them at all.
 */

export const listVideoCatalog = asyncHandler(async (req, res) => {
  const slugs = req.query.slugs
    ? req.query.slugs
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : undefined;
  return sendSuccess(res, { data: await lessonVideos.listVideoCatalog({ slugs }) });
});

export const getCourseVideos = asyncHandler(async (req, res) => {
  return sendSuccess(res, { data: await lessonVideos.getCourseVideos(req.params.slug) });
});

export const inspectVideo = asyncHandler(async (req, res) => {
  return sendSuccess(res, { data: await lessonVideos.inspectYoutubeLink(req.body.url) });
});

const targetOf = (params) => (params.moduleId ? { moduleId: params.moduleId } : { lessonId: params.lessonId });

/** PUT .../lessons/:lessonId and .../modules/:moduleId. */
export const upsertVideo = asyncHandler(async (req, res) => {
  const { actor, ...input } = req.body;
  const data = await lessonVideos.upsertVideo(req.params.slug, targetOf(req.params), input, actor);
  return sendSuccess(res, { message: data.video.isPublished ? 'Video published' : 'Video saved as draft', data });
});

/** DELETE .../lessons/:lessonId and .../modules/:moduleId. */
export const removeVideo = asyncHandler(async (req, res) => {
  const data = await lessonVideos.removeVideo(req.params.slug, targetOf(req.params), req.body?.actor, {
    expectedUpdatedAt: req.body?.expectedUpdatedAt,
  });
  return sendSuccess(res, { message: data.removed ? 'Video removed' : 'This had no video', data });
});
