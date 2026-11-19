import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * A course an administrator has assigned to a teacher, keyed by the student
 * portal's course slug (prarambh, garud, yoddha).
 *
 * This is the teacher's authorisation to see the students enrolled in that
 * course - nothing else grants it. It is deliberately a separate record from
 * `AssignedCourse`, which mirrors a course authored in the Admin portal and has
 * exactly one teacher: PRARAMBH, GARUD and YODDHA are owned by the student
 * catalogue and have no Admin record, and several teachers can teach the same
 * one, so the assignment has to be (teacher, slug) rather than one owner per
 * course.
 *
 * A teacher can read and never write it. Rows arrive only from the Admin portal
 * over the service-key-authenticated bridge (controllers/internal.controller.js).
 */
const courseAccessSchema = new Schema(
  {
    teacher: { type: Schema.Types.ObjectId, ref: 'Teacher', required: true, index: true },
    studentCourseSlug: { type: String, required: true, trim: true, lowercase: true },
    title: { type: String, default: null, trim: true, maxlength: 200 },
    assignedAt: { type: Date, default: Date.now },

    // Why this teacher has the course. 'teacher-assignment' is an administrator
    // assigning it to the teacher; 'course-instructor' is the teacher being named
    // instructor of an Admin-authored course that is sold under this slug. Both
    // can hold at once, and the row goes away only when the last one does -
    // otherwise removing one would quietly revoke the other.
    sources: { type: [{ type: String, enum: ['teacher-assignment', 'course-instructor'] }], default: [] },

    // Whether the enrolled students were last read from the student portal
    // successfully. The roster is kept current by pushes as students enrol, so
    // this describes the initial load and any recovery - and says so plainly
    // when it did not work, instead of an empty roster looking like "nobody".
    rosterSyncStatus: { type: String, enum: ['pending', 'synced', 'failed'], default: 'pending' },
    rosterSyncedAt: { type: Date, default: null },
    rosterSyncError: { type: String, default: null, maxlength: 300 },
  },
  { timestamps: true }
);

courseAccessSchema.index({ teacher: 1, studentCourseSlug: 1 }, { unique: true });
courseAccessSchema.index({ studentCourseSlug: 1 });

export const CourseAccess = mongoose.model('CourseAccess', courseAccessSchema);
export default CourseAccess;
