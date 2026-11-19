import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * One student's enrolment in one course, as the student portal reports it - the
 * course-wide roster a teacher assigned that course can see.
 *
 * Separate from `Student`, which is a roster row owned by ONE batch's teacher and
 * carries that teacher's grades, attendance and risk metrics. A course runs
 * several batches, and a teacher who has the course but not a particular batch
 * is allowed to see who is enrolled - not to grade or mark attendance for them -
 * so this record holds identity only and has no metrics to edit. Keeping the two
 * apart is what stops "can see" from quietly becoming "can grade".
 *
 * Keyed on the student portal's enrollmentId, which never changes, so a student
 * who edits their email is the same row afterwards. `portalSyncedAt` is when the
 * source record was read there: an older one arriving late cannot overwrite a
 * newer one.
 *
 * Access is not stored here. Whether a given teacher may see a row is decided at
 * read time from CourseAccess, so removing an assignment takes the students away
 * immediately without touching these rows.
 */
const courseEnrollmentSchema = new Schema(
  {
    enrollmentId: { type: String, required: true, trim: true, uppercase: true },
    studentCourseSlug: { type: String, required: true, trim: true, lowercase: true, index: true },

    userId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, default: null, trim: true, lowercase: true },
    avatarUrl: { type: String, default: null },
    enrollmentNumber: { type: String, trim: true, uppercase: true },
    grade: { type: String, default: null, trim: true },

    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
    enrolledAt: { type: Date, default: Date.now },

    // The batch of the course the student sits in, if placed - information, not
    // permission.
    batchId: { type: String, default: null },
    batchCode: { type: String, default: null, trim: true },

    portalSyncedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

courseEnrollmentSchema.index({ enrollmentId: 1 }, { unique: true });
courseEnrollmentSchema.index({ studentCourseSlug: 1, status: 1, name: 1 });
courseEnrollmentSchema.index({ userId: 1 });

export const CourseEnrollment = mongoose.model('CourseEnrollment', courseEnrollmentSchema);
export default CourseEnrollment;
