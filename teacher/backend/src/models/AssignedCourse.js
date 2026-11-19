import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * A lightweight, read-only mirror of a commerce course Admin has assigned
 * to this teacher — NOT the same concept as `Course.js` (a teacher-authored
 * curriculum module, full CRUD, linked to SchoolClass). Admin's Course is
 * the real source of truth; this collection only ever receives pushed
 * snapshots from admin/backend via the shared-secret-authenticated
 * `/api/internal/courses/:sourceId` bridge (see controllers/internal.controller.js),
 * upserted by `sourceId` (admin's own Course _id). A teacher can view but
 * never create/edit/delete rows here — there is deliberately no
 * teacher-facing write route for this model.
 */
const assignedCourseSchema = new Schema(
  {
    teacher: { type: Schema.Types.ObjectId, ref: 'Teacher', required: true, index: true },

    // admin's Course _id, as a string (cross-database — never a real
    // ObjectId ref in this database). No `default` deliberately: a sparse
    // unique index only excludes a document when the field is genuinely
    // ABSENT, not merely null — the same bug class fixed repeatedly
    // elsewhere in this project when a default was present.
    sourceId: { type: String, required: true },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    courseCode: { type: String, default: null, trim: true },
    description: { type: String, default: '', trim: true, maxlength: 4000 },
    image: { type: String, default: null },
    priceInPaise: { type: Number, default: 0, min: 0 },
    status: { type: String, default: 'PENDING_REVIEW', trim: true },

    // The student catalogue slug this course is sold under, when it has one. Being
    // its instructor then also gives this teacher its enrolled students (see
    // services/courseRoster.service.js). No default: absent means "not sold under
    // a slug".
    studentCourseSlug: { type: String, trim: true, lowercase: true },

    assignedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

assignedCourseSchema.index({ sourceId: 1 }, { unique: true });
assignedCourseSchema.index({ teacher: 1, createdAt: -1 });

export const AssignedCourse = mongoose.model('AssignedCourse', assignedCourseSchema);
export default AssignedCourse;
