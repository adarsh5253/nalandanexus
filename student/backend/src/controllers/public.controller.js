import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { AppError } from '../utils/AppError.js';
import { Course } from '../models/Course.js';
import { ContactMessage } from '../models/ContactMessage.js';
import { Enrollment } from '../models/Enrollment.js';
import { Announcement } from '../models/Announcement.js';
import { Resource } from '../models/Resource.js';
import { Faculty } from '../models/Faculty.js';
import { User } from '../models/User.js';
import { TaskSubmission } from '../models/TaskSubmission.js';
import { Post } from '../models/Post.js';
import { getPlatformSatisfaction } from '../services/review.service.js';

/**
 * The only posts an anonymous visitor may ever see - explicitly approved for
 * public display. Without this, any account that could register could publish
 * arbitrary text straight onto the institution's homepage.
 */
const PUBLIC_POST_FILTER = { isApprovedForPublic: true };

/**
 * Counts exactly the posts the public feed would actually render.
 *
 * The feed drops posts whose author no longer exists (populate yields null -
 * there is no cascade cleanup when a user is deleted), so a plain
 * countDocuments over the same filter over-reports: that mismatch is why the
 * Landing Page showed "2 Community Posts" directly above an empty section.
 * The $lookup applies the same author-exists rule the feed applies, so the
 * number and the content can no longer disagree.
 */
async function countDisplayablePublicPosts() {
  const [row] = await Post.aggregate([
    { $match: PUBLIC_POST_FILTER },
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'author' } },
    { $match: { 'author.0': { $exists: true } } },
    { $count: 'n' },
  ]);
  return row?.n || 0;
}

function toPublicCourse(course, enrolledCourseIds) {
  const obj = course.toObject ? course.toObject({ virtuals: true }) : course;
  return {
    id: String(obj._id),
    slug: obj.slug,
    title: obj.title,
    subtitle: obj.subtitle,
    tagline: obj.tagline,
    description: obj.description,
    category: obj.category,
    pillar: obj.pillar,
    rating: obj.rating,
    reviewsCount: obj.reviewsCount,
    grades: obj.grades,
    difficulty: obj.difficulty,
    duration: obj.duration,
    // The label is for display; these two are the real value. A client that
    // needs to compute with a duration - an enrolment window, a countdown -
    // cannot parse "9 Months" into arithmetic, and only the label was exposed.
    durationValue: obj.durationValue ?? null,
    durationUnit: obj.durationUnit ?? null,
    bannerImage: obj.bannerImage,
    priceInPaise: obj.priceInPaise,
    originalPriceInPaise: obj.originalPriceInPaise,
    currency: obj.currency,
    isPurchasable: obj.isPurchasable,
    isFeatured: obj.isFeatured,
    isPopular: obj.isPopular,
    instructor: obj.instructor,
    skills: obj.skills,
    totalLessons: obj.totalLessons,
    totalModules: (obj.modules || []).length,
    isEnrolled: enrolledCourseIds ? enrolledCourseIds.has(String(obj._id)) : false,
  };
}

/**
 * ?popular=true / ?featured=true filter on the real, admin-controlled
 * isPopular/isFeatured flags - never a client-supplied ranking, never a
 * frontend .slice() over arbitrary DB order. limit is capped so a caller
 * can't force an unbounded query.
 */
export const listCourses = asyncHandler(async (req, res) => {
  const filter = { isPublished: true };
  if (req.query.popular === 'true') filter.isPopular = true;
  if (req.query.featured === 'true') filter.isFeatured = true;

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 50) || 0;
  let query = Course.find(filter).sort({ createdAt: 1 });
  if (limit) query = query.limit(limit);
  const courses = await query;

  let enrolledCourseIds = null;
  if (req.user) {
    const enrollments = await Enrollment.find({ userId: req.user._id, status: 'active' }).select('courseId');
    enrolledCourseIds = new Set(enrollments.map((e) => String(e.courseId)));
  }

  return sendSuccess(res, { data: courses.map((c) => toPublicCourse(c, enrolledCourseIds)) });
});

export const getCourseBySlug = asyncHandler(async (req, res) => {
  const course = await Course.findOne({ slug: req.params.slug, isPublished: true });
  if (!course) throw AppError.notFound('Course not found', 'COURSE_NOT_FOUND');

  let enrolledCourseIds = null;
  let isEnrolled = false;
  if (req.user) {
    const enrollment = await Enrollment.findOne({ userId: req.user._id, courseId: course._id, status: 'active' });
    isEnrolled = Boolean(enrollment);
    enrolledCourseIds = new Set(isEnrolled ? [String(course._id)] : []);
  }

  const data = toPublicCourse(course, enrolledCourseIds);
  // Public detail view also exposes module/lesson titles (syllabus) but not video URLs unless enrolled.
  data.modules = course.modules.map((m) => ({
    moduleId: m.moduleId,
    title: m.title,
    order: m.order,
    lessons: m.lessons.map((l) => ({
      lessonId: l.lessonId,
      title: l.title,
      duration: l.duration,
      order: l.order,
      videoUrl: isEnrolled ? l.videoUrl : undefined,
    })),
  }));

  return sendSuccess(res, { data });
});

/**
 * Public, unauthenticated announcements for the Landing Page. Deliberately
 * scoped to institution-wide announcements only (courseIds empty) - a
 * course-specific announcement stays visible only to that course's actual
 * enrolled/authenticated audience via GET /api/student/announcements. The
 * backend decides this scoping; no query parameter can widen it (see
 * master doc's "never trust the browser for authorization").
 */
export const listPublicAnnouncements = asyncHandler(async (req, res) => {
  const now = new Date();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 20);

  const announcements = await Announcement.find({
    isPublished: true,
    publishAt: { $lte: now },
    courseIds: { $size: 0 },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .sort({ publishAt: -1 })
    .limit(limit)
    .select('title content type publishAt externalAuthorName source')
    .lean();

  return sendSuccess(res, {
    data: announcements.map((a) => ({
      id: String(a._id),
      title: a.title,
      content: a.content,
      type: a.type,
      publishAt: a.publishAt,
      authorName: a.externalAuthorName || 'Nalanda Nexus',
    })),
  });
});

/**
 * Public, unauthenticated resources (magazines, event photos, program
 * materials) for the Landing Page's Resources section - bridged in from
 * admin/backend uploads via POST /api/internal/resources. Real server-side
 * pagination and search (no client-side slicing), matching the "no fake
 * data" convention used by listCourses/listPublicAnnouncements above.
 */
export const listPublicResources = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 12, 1), 50);

  const filter = { isPublished: true };
  if (['magazine', 'event', 'program'].includes(req.query.type)) filter.type = req.query.type;
  if (req.query.search) filter.$text = { $search: String(req.query.search).slice(0, 200) };

  const [items, total] = await Promise.all([
    Resource.find(filter)
      .sort({ publishedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .select('title description type fileUrl fileName fileType fileSizeBytes uploadedByName publishedAt')
      .lean(),
    Resource.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    data: items.map((r) => ({
      id: String(r._id),
      title: r.title,
      description: r.description,
      type: r.type,
      fileUrl: r.fileUrl,
      fileName: r.fileName,
      fileType: r.fileType,
      fileSizeBytes: r.fileSizeBytes,
      uploadedByName: r.uploadedByName,
      publishedAt: r.publishedAt,
    })),
    meta: { page, pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1) },
  });
});

/**
 * Real, aggregated platform-wide stats for the Landing Page's stat strip -
 * every number here is a genuine count/average from the database, never a
 * hardcoded marketing figure. "Expert Mentors" and "Tasks Completed" are
 * honestly named after what's actually tracked (distinct course instructors,
 * completed task submissions) rather than inventing an unbacked concept like
 * "Projects" or "Countries" just to match a marketing label.
 */
export const listPublicStats = asyncHandler(async (req, res) => {
  const [activeLearners, courses, mentors, tasksCompleted, satisfaction, communityPosts] = await Promise.all([
    User.countDocuments({ role: 'student', isActive: true }),
    Course.find({ isPublished: true }).select('modules instructor.name').lean(),
    Course.distinct('instructor.name', { isPublished: true, 'instructor.name': { $nin: [null, ''] } }),
    TaskSubmission.countDocuments({ isCompleted: true }),
    // Averaged over real Review documents, not over Course.rating. Those
    // course fields used to be seeded marketing numbers (4.7-5.0 across every
    // course), which meant this "Learner Satisfaction" figure was derived
    // entirely from data no student had ever entered.
    getPlatformSatisfaction(),
    countDisplayablePublicPosts(),
  ]);

  const totalModules = courses.reduce((sum, c) => sum + (c.modules?.length || 0), 0);

  return sendSuccess(res, {
    data: {
      activeLearners,
      totalCourses: courses.length,
      totalModules,
      expertMentors: mentors.length,
      tasksCompleted,
      // null until there are enough genuine reviews to say anything honest -
      // the Landing Page hides the tile rather than publishing a percentage
      // computed from one or two votes. Never a fallback constant.
      avgRatingPercent: satisfaction.percent,
      satisfactionReviewsCount: satisfaction.reviewsCount,
      communityPosts,
    },
  });
});

/**
 * Real community posts (the same feed Community.jsx shows to logged-in
 * students) surfaced on the Landing Page as genuine "impact stories" -
 * replaces a set of fabricated named testimonials with actual student
 * content. Only the author's first name is shown publicly (no email, no
 * full identity exposed to anonymous visitors).
 */
export const listPublicHighlights = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 10);
  const posts = await Post.find(PUBLIC_POST_FILTER)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('userId', 'name avatar')
    .select('body createdAt userId')
    .lean();

  return sendSuccess(res, {
    data: posts
      .filter((p) => p.userId)
      .map((p) => ({
        id: String(p._id),
        quote: p.body,
        author: p.userId.name?.split(' ')[0] || 'A learner',
        avatar: p.userId.avatar || null,
      })),
  });
});

/**
 * The teaching faculty, for the About page, in the institution's own order.
 *
 * Published from the admin portal (models/Faculty.js), so introducing an
 * instructor is an administrative act rather than a deploy - the page used to
 * read a hardcoded list. Only published profiles are returned, and the
 * collection holds nothing that is not public in the first place.
 */
export const listPublicFaculty = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

  const items = await Faculty.find({ isPublished: true })
    .sort({ order: 1, name: 1 })
    .limit(limit)
    .select('name role category expertise experience avatar order')
    .lean();

  return sendSuccess(res, {
    data: items.map((f) => ({
      id: String(f._id),
      name: f.name,
      role: f.role || null,
      category: f.category || 'Faculty',
      expertise: f.expertise || [],
      experience: f.experience || null,
      avatar: f.avatar || null,
      order: f.order ?? 0,
    })),
  });
});

export const submitContactMessage = asyncHandler(async (req, res) => {
  const { name, email, phone, subject, message } = req.body;
  const record = await ContactMessage.create({ name, email, phone, subject, message });
  return sendSuccess(res, {
    status: 201,
    message: 'Thanks for reaching out! Our team will get back to you soon.',
    data: { id: record._id },
  });
});
