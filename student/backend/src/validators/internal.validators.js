import { z } from 'zod';

export const createBridgedAnnouncementSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(4000),
    type: z.enum(['general', 'course', 'urgent']).optional().default('general'),
    publishAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional().nullable(),
    sourceId: z.string().trim().min(1),
    authorName: z.string().trim().max(160).optional().nullable(),
    // Resolved server-side to real courseIds - empty/omitted = institution-wide broadcast.
    courseSlugs: z.array(z.string().trim().min(1)).optional().default([]),
    source: z.enum(['teacher-portal', 'admin-portal']).optional().default('teacher-portal'),
  }),
});

export const updateBridgedAnnouncementSchema = z.object({
  params: z.object({
    sourceId: z.string().trim().min(1),
  }),
  body: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().trim().min(1).max(4000).optional(),
    type: z.enum(['general', 'course', 'urgent']).optional(),
    isPublished: z.boolean().optional(),
    publishAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional().nullable(),
  }),
});

export const createBridgedMaterialSchema = z.object({
  body: z.object({
    studentCourseSlug: z.string().trim().min(1),
    title: z.string().trim().min(1).max(200),
    moduleTitle: z.string().trim().max(200).optional().default(''),
    uploadedByName: z.string().trim().max(160).optional().default(''),
    fileUrl: z.string().trim().url(),
    fileName: z.string().trim().max(300).optional().nullable(),
    fileType: z.string().trim().max(30).optional().default('other'),
    fileSizeBytes: z.number().int().min(0).optional().default(0),
    sourceId: z.string().trim().min(1),
  }),
});

export const upsertBridgedTaskSchema = z.object({
  body: z.object({
    studentCourseSlug: z.string().trim().min(1),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional().default(''),
    moduleTitle: z.string().trim().max(200).optional().default(''),
    dueDate: z.coerce.date(),
    pointsReward: z.number().int().min(0).max(1000).optional().default(30),
    sourceId: z.string().trim().min(1),
  }),
});

export const createBridgedLiveClassSchema = z.object({
  body: z.object({
    studentCourseSlug: z.string().trim().min(1),
    // The teacher portal's SchoolClass._id. Optional: a lecture with no batch
    // is a course-wide session every batch attends.
    batchId: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, 'batchId must be a valid identifier')
      .nullish(),
    title: z.string().trim().min(1).max(200),
    instructor: z.string().trim().min(1).max(160),
    scheduledAt: z.coerce.date(),
    durationMinutes: z.number().int().min(5).max(600).optional().default(60),
    joinUrl: z.string().trim().url(),
    sourceId: z.string().trim().min(1),
  }),
});

export const updateBridgedLiveClassSchema = z.object({
  params: z.object({
    sourceId: z.string().trim().min(1),
  }),
  body: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    scheduledAt: z.coerce.date().optional(),
    durationMinutes: z.number().int().min(5).max(600).optional(),
    joinUrl: z.string().trim().url().optional(),
    // A reschedule explicitly un-cancels/un-completes a session back to
    // 'upcoming' by default (see controller) - only pass this to instead
    // mark it 'live'/'completed' from the teacher-portal side.
    status: z.enum(['upcoming', 'live', 'completed', 'cancelled']).optional(),
  }),
});

export const enrolledStudentsQuerySchema = z.object({
  params: z.object({
    slug: z.string().trim().min(1),
  }),
  // batchId is the teacher portal's own SchoolClass._id arriving as a string
  // across the service boundary. Shape-checked here so an arbitrary value can
  // never reach the enrollment query - declaring `query` at all also makes the
  // middleware replace req.query with just these keys.
  query: z.object({
    batchId: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, 'batchId must be a valid identifier')
      .optional(),
  }),
});

export const upsertBridgedQuizSchema = z.object({
  body: z.object({
    studentCourseSlug: z.string().trim().min(1),
    title: z.string().trim().min(1).max(200),
    moduleTitle: z.string().trim().max(200).optional().default(''),
    timeLimitMins: z.number().int().min(1).max(600).optional().default(30),
    questions: z
      .array(
        z.object({
          questionId: z.string().trim().min(1),
          question: z.string().trim().min(1).max(2000),
          options: z.array(z.string().trim().min(1).max(300)).min(2).max(6),
          correctIndex: z.number().int().min(0),
          explanation: z.string().trim().max(2000).optional().default(''),
        })
      )
      .min(1),
    sourceId: z.string().trim().min(1),
  }),
});

export const deliverTeacherMessageSchema = z.object({
  body: z.object({
    studentUserId: z.string().trim().min(1),
    text: z.string().trim().min(1).max(4000),
    teacherName: z.string().trim().max(160).optional().nullable(),
  }),
});

export const upsertBridgedCourseSchema = z.object({
  body: z.object({
    sourceId: z.string().trim().min(1),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9-]+$/i, 'Invalid slug'),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional().default(''),
    features: z.array(z.string().trim().max(200)).optional().default([]),
    priceInPaise: z.number().int().min(0).max(100000000).optional().default(0),
    image: z.string().trim().url().optional().nullable(),
  }),
});

export const unpublishBridgedCourseSchema = z.object({
  params: z.object({
    sourceId: z.string().trim().min(1),
  }),
});

export const upsertBridgedResourceSchema = z.object({
  body: z.object({
    sourceId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().default(''),
    type: z.enum(['magazine', 'event', 'program']),
    fileUrl: z.string().trim().url(),
    fileName: z.string().trim().max(300).optional().nullable(),
    fileType: z.string().trim().max(30).optional().default('other'),
    fileSizeBytes: z.number().int().min(0).optional().default(0),
    uploadedByName: z.string().trim().max(160).optional().default(''),
    isPublished: z.boolean().optional().default(true),
  }),
});

export const retractBridgedResourceSchema = z.object({
  params: z.object({
    sourceId: z.string().trim().min(1),
  }),
});

/**
 * A teacher's public profile, published by the admin portal. Every field is one
 * a visitor may read; there is deliberately nowhere here to put an email
 * address, a phone number or an account status.
 */
export const upsertBridgedFacultySchema = z.object({
  body: z.object({
    sourceId: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().max(160).optional().nullable(),
    category: z.string().trim().max(80).optional().nullable(),
    expertise: z.array(z.string().trim().min(1).max(160)).max(12).optional().default([]),
    experience: z.string().trim().max(240).optional().nullable(),
    avatar: z.string().trim().max(2000).optional().nullable(),
    order: z.coerce.number().int().min(0).max(9999).optional().default(0),
  }),
});

export const retractBridgedFacultySchema = z.object({
  params: z.object({
    sourceId: z.string().trim().min(1).max(64),
  }),
});

export const gradeBridgedTaskSubmissionSchema = z.object({
  params: z.object({
    sourceId: z.string().trim().min(1),
  }),
  body: z.object({
    score: z.number().min(0),
    maxScore: z.number().min(1),
    feedback: z.string().trim().max(2000).optional().nullable(),
  }),
});

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');

/**
 * Admin coupon administration.
 *
 * `count` is capped so a mistyped figure cannot mint thousands of free places in
 * one click, and `maxUses` is capped because a "single-use" giveaway with an
 * accidental 10000 is the same mistake wearing a different hat.
 */
/**
 * Courses are addressed by SLUG across this boundary, never by _id.
 *
 * The admin portal keeps its own course collection in its own database, so an
 * admin-side course _id is a meaningless string here - it resolved to nothing,
 * which made the course filter return an empty table and coupon creation fail
 * with COURSE_NOT_FOUND. The slug is the identifier both databases agree on, and
 * the one every other cross-service call already uses.
 */
export const adminListCouponsSchema = z.object({
  query: z.object({
    status: z.enum(['ALL', 'AVAILABLE', 'USED', 'EXPIRED', 'INACTIVE']).optional(),
    courseSlug: z.string().trim().max(120).optional(),
    campaignId: objectId.optional(),
    search: z.string().trim().max(64).optional(),
  }),
});

const subjectAssignment = z.object({
  subject: z.string().trim().max(32).nullish(),
});

export const adminProgressionRulesSchema = z.object({
  // Passthrough on the nested rule shapes: the Mongoose schema validates them
  // with runValidators, and duplicating those constraints here would give two
  // definitions of a valid rule that could disagree.
  body: z.object({
    xpRules: z.array(z.record(z.any())).max(200).optional(),
    levels: z.record(z.any()).optional(),
    ranks: z.array(z.record(z.any())).max(50).optional(),
    skillWeights: z.record(z.any()).optional(),
    knowledgeWeights: z.record(z.any()).optional(),
    consistency: z.record(z.any()).optional(),
    overallPower: z.record(z.any()).optional(),
    attendance: z.record(z.any()).optional(),
    updatedByEmail: z.string().trim().email().max(160).nullish(),
  }),
});

export const adminStageUpdateSchema = z.object({
  params: z.object({ code: z.string().trim().min(1).max(32) }),
  body: z.object({
    name: z.string().trim().max(120).optional(),
    tagline: z.string().trim().max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    courseSlug: z.string().trim().max(120).nullish(),
    nextStageCode: z.string().trim().max(32).nullish(),
    enabled: z.boolean().optional(),
    requirements: z.record(z.any()).optional(),
  }),
});

export const adminAchievementUpdateSchema = z.object({
  params: z.object({ code: z.string().trim().min(1).max(64) }),
  body: z.record(z.any()),
});

export const adminRecalculateSchema = z.object({
  body: z.object({
    userId: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }),
});

export const adminStudentProgressSchema = z.object({
  // Batched: a roster page is one request, not one per student.
  body: z.object({ userIds: z.array(objectId).min(1).max(500) }),
});

export const adminStudentActivitySchema = z.object({
  params: z.object({ userId: objectId }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
});

export const adminRecordAttendanceSchema = z.object({
  body: z.object({
    records: z
      .array(
        z.object({
          userId: objectId,
          classId: z.string().trim().min(1).max(64),
          date: z.coerce.date(),
          status: z.enum(['present', 'absent', 'late']),
          courseId: objectId.nullish(),
          subjectCode: z.string().trim().max(32).nullish(),
          markedBy: z.string().trim().max(120).nullish(),
        })
      )
      .min(1)
      .max(500),
  }),
});

export const adminCourseSlugSchema = z.object({
  params: z.object({ slug: z.string().trim().min(1).max(120) }),
});

export const adminSetSubjectsSchema = z.object({
  params: z.object({ slug: z.string().trim().min(1).max(120) }),
  // Targeted changes only - never the whole course document - so two editors
  // working on different modules cannot clobber one another.
  body: z.object({
    modules: z.array(subjectAssignment.extend({ moduleId: z.string().trim().min(1) })).max(200).optional(),
    lessons: z.array(subjectAssignment.extend({ lessonId: z.string().trim().min(1) })).max(500).optional(),
    quizzes: z.array(subjectAssignment.extend({ quizId: z.string().trim().min(1) })).max(500).optional(),
    tasks: z.array(subjectAssignment.extend({ taskId: z.string().trim().min(1) })).max(500).optional(),
  }),
});

export const adminListCampaignsSchema = z.object({
  query: z.object({
    courseSlug: z.string().trim().max(120).optional(),
  }),
});

export const adminCampaignIdSchema = z.object({
  params: z.object({ id: objectId }),
});

export const adminCreateCampaignSchema = z.object({
  body: z.object({
    // Slug, not _id - see the note on adminListCouponsSchema.
    courseSlug: z.string().trim().min(1).max(120),
    // Names the giveaway, and doubles as the idempotency key: one campaign of a
    // given name per course, so re-running generation cannot mint a second set.
    name: z.string().trim().min(1, 'Give the campaign a name').max(120),
    count: z.coerce.number().int().min(1, 'Create at least one').max(500, 'No more than 500 at a time'),
    discountType: z.enum(['FULL', 'PERCENT', 'FIXED']).optional().default('FULL'),
    discountValue: z.coerce.number().min(0).max(100000000).optional().default(100),
    maxUses: z.coerce.number().int().min(1).max(1000).optional().default(1),
    expiresAt: z.coerce.date().nullish(),
    createdByEmail: z.string().trim().email().max(160).nullish(),
    createdByName: z.string().trim().max(120).nullish(),
  }),
});

export const adminUpdateCouponSchema = z.object({
  params: z.object({ id: objectId }),
  // Only these two. Code, course, discount and usage are history once issued.
  body: z.object({
    isActive: z.boolean().optional(),
    expiresAt: z.coerce.date().nullish(),
  }),
});

export const adminCouponIdSchema = z.object({
  params: z.object({ id: objectId }),
});

export default {
  adminListCouponsSchema,
  adminCreateCampaignSchema,
  adminProgressionRulesSchema,
  adminStageUpdateSchema,
  adminAchievementUpdateSchema,
  adminRecalculateSchema,
  adminStudentProgressSchema,
  adminStudentActivitySchema,
  adminRecordAttendanceSchema,
  adminCourseSlugSchema,
  adminSetSubjectsSchema,
  adminListCampaignsSchema,
  adminCampaignIdSchema,
  adminUpdateCouponSchema,
  adminCouponIdSchema,
  createBridgedAnnouncementSchema,
  updateBridgedAnnouncementSchema,
  createBridgedMaterialSchema,
  upsertBridgedTaskSchema,
  createBridgedLiveClassSchema,
  updateBridgedLiveClassSchema,
  enrolledStudentsQuerySchema,
  upsertBridgedQuizSchema,
  deliverTeacherMessageSchema,
  upsertBridgedCourseSchema,
  unpublishBridgedCourseSchema,
  upsertBridgedResourceSchema,
  retractBridgedResourceSchema,
  upsertBridgedFacultySchema,
  retractBridgedFacultySchema,
  gradeBridgedTaskSubmissionSchema,
};

/**
 * One student by enrollment number, for the teacher and admin portals.
 *
 * `scope` is how the teacher portal asks: the ids on the requesting teacher's own
 * roster. An admin lookup carries no scope. Every element is typed and bounded,
 * so nothing but plain strings reaches a query.
 */
export const lookupStudentSchema = z.object({
  body: z
    .object({
      enrollmentNumber: z.string().trim().min(1).max(40),
      scope: z
        .object({
          userIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).max(5000).default([]),
          enrollmentIds: z.array(z.string().trim().min(1).max(40)).max(5000).default([]),
          courseSlugs: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
        })
        .strict()
        .nullable()
        .optional(),
      includePayments: z.boolean().optional().default(false),
    })
    .strict(),
});

/**
 * Resending student records to the admin and teacher portals. `mode` says whose:
 * one student (by enrollment number), everyone still pending, or all enrolled
 * students from `cursor`, `limit` at a time.
 */
export const resyncPortalStudentsSchema = z.object({
  body: z
    .object({
      mode: z.enum(['one', 'pending', 'all']).optional().default('pending'),
      enrollmentNumber: z.string().trim().min(1).max(40).optional(),
      cursor: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
      limit: z.number().int().min(1).max(100).optional().default(50),
      apply: z.boolean().optional().default(false),
    })
    .strict()
    .refine((b) => b.mode !== 'one' || Boolean(b.enrollmentNumber), {
      message: 'enrollmentNumber is required to resync one student.',
      path: ['enrollmentNumber'],
    }),
});
