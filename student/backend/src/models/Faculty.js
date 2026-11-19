import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * A member of the teaching faculty, as the public site presents them.
 *
 * Published here by the admin portal, which owns teacher identity (see
 * admin/backend/src/services/studentFacultyBridge.service.js). This database
 * has no teacher of its own, so this is a read-only projection: nothing in this
 * service edits it, and it carries only what a visitor may see - no email, no
 * phone number, no login. The About page used to hold this list as hardcoded
 * frontend data, which meant a new instructor needed a deploy.
 *
 * Keyed on `sourceId`, the admin Teacher's own id, so republishing updates the
 * one record rather than adding another. Deliberately NO `default: null` on it:
 * the unique index below is sparse, and a sparse index only skips a document
 * whose field is genuinely absent.
 */
const facultySchema = new Schema(
  {
    sourceId: { type: String },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // What the card calls them, e.g. "Communication Specialist".
    role: { type: String, trim: true, default: null, maxlength: 160 },
    // Groups the faculty into tabs on the About page, e.g. "Communication".
    category: { type: String, trim: true, default: null, maxlength: 80 },
    // The bullet points under the name, e.g. "Content Writer", "Script Writer".
    expertise: { type: [String], default: [] },
    // One line, as written by the institution, e.g. "5 years of national and
    // international experience."
    experience: { type: String, trim: true, default: null, maxlength: 240 },
    avatar: { type: String, default: null },
    order: { type: Number, default: 0 },
    isPublished: { type: Boolean, default: true, index: true },
    source: { type: String, default: 'admin-portal' },
  },
  { timestamps: true }
);

facultySchema.index({ sourceId: 1 }, { unique: true, sparse: true });
// The public list's own query: published faculty in the institution's order.
facultySchema.index({ isPublished: 1, order: 1, name: 1 });

export const Faculty = mongoose.model('Faculty', facultySchema);
export default Faculty;
