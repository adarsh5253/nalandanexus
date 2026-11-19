import { z } from 'zod';

/**
 * Lesson video bridge requests. Shape only - whether the URL is a real YouTube
 * link is decided by utils/youtube.js inside the service, so there is one rule
 * and one set of error codes, not a regex here that could disagree with it.
 */

const slug = z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/i, 'Invalid course');
const lessonId = z.string().trim().min(1).max(120);
const moduleId = z.string().trim().min(1).max(120);

// The version of the video the editor loaded: an ISO timestamp, or null for
// "there was no video". Omitted means "do not check" (older callers).
const expectedUpdatedAt = z.union([z.string().datetime({ offset: true }), z.null()]).optional();

const actor = z
  .object({
    portal: z.enum(['admin', 'teacher']),
    userId: z.string().trim().max(64).nullish(),
    name: z.string().trim().max(120).nullish(),
  })
  .optional();

export const videoCatalogSchema = z.object({
  query: z.object({ slugs: z.string().trim().max(2000).optional() }),
});

export const courseVideosSchema = z.object({
  params: z.object({ slug }),
});

export const inspectVideoSchema = z.object({
  body: z.object({ url: z.string().max(2048) }),
});

const upsertBody = z.object({
  url: z.string().max(2048),
  title: z.string().max(200).optional().default(''),
  description: z.string().max(2000).optional().default(''),
  playbackMode: z.enum(['embed', 'external']).optional().default('embed'),
  isPublished: z.boolean().optional().default(false),
  expectedUpdatedAt,
  actor,
});
const removeBody = z.object({ actor, expectedUpdatedAt }).optional().default({});

export const upsertLessonVideoSchema = z.object({ params: z.object({ slug, lessonId }), body: upsertBody });
export const removeLessonVideoSchema = z.object({ params: z.object({ slug, lessonId }), body: removeBody });
export const upsertModuleVideoSchema = z.object({ params: z.object({ slug, moduleId }), body: upsertBody });
export const removeModuleVideoSchema = z.object({ params: z.object({ slug, moduleId }), body: removeBody });
