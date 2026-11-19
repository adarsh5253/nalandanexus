import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const { Schema } = mongoose;

const invitationSchema = new Schema(
  {
    tokenHash: { type: String },
    createdAt: { type: Date },
    expiresAt: { type: Date },
    isUsed: { type: Boolean, default: false },
    usedAt: { type: Date },
  },
  { _id: false }
);

const teacherSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    phone: { type: String, trim: true },
    passwordHash: { type: String, select: false },
    teacherId: { type: String, required: true, unique: true },
    department: { type: String, trim: true },
    subject: { type: String, trim: true },
    qualification: { type: String, trim: true },
    status: { type: String, enum: ['INVITED', 'ACTIVE', 'SUSPENDED', 'INACTIVE'], default: 'INVITED', index: true },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    studentsCount: { type: Number, default: 0 },
    coursesCount: { type: Number, default: 0 },
    lastActive: { type: Date },
    avatar: { type: String },

    // --- public profile, shown on the student site's About page -------------
    //
    // Published to the student portal by services/studentFacultyBridge.service.js
    // while `showOnWebsite` is on and the teacher is active, and withdrawn as
    // soon as it is off or they are suspended or deleted. Only these fields ever
    // leave this database: email, phone, credentials and governance state do not
    // belong on a public page.
    showOnWebsite: { type: Boolean, default: false, index: true },
    websiteRole: { type: String, trim: true, maxlength: 160, default: null },
    websiteCategory: { type: String, trim: true, maxlength: 80, default: null },
    expertise: { type: [String], default: [] },
    experienceNote: { type: String, trim: true, maxlength: 240, default: null },
    websiteOrder: { type: Number, default: 0 },
    facultySyncedAt: { type: Date, default: null },
    facultySyncStatus: { type: String, enum: ['synced', 'failed', null], default: null },

    invitation: { type: invitationSchema, default: undefined },
    suspensionReason: { type: String },
    resetTokenHash: { type: String, select: false },
    resetTokenExpiresAt: { type: Date, select: false },
    // Set on creation: whether the real Teacher Portal login (a separate
    // service/database - see services/teacherBridge.service.js) was
    // successfully provisioned, and whether the onboarding email actually
    // went out. Never silently claim success on either — see spec item 41.
    portalProvisioned: { type: Boolean, default: false },
    credentialEmailSent: { type: Boolean, default: false },
    credentialEmailSentAt: { type: Date, default: null },
    // 'sent' means the email provider ACCEPTED the message - not that it reached
    // an inbox; that is not tracked. 'failed' carries why in emailDeliveryError,
    // 'stubbed' means no provider is configured, 'not_sent' means nothing was
    // attempted (the Teacher Portal login could not be created, so a link would
    // lead nowhere).
    emailDeliveryStatus: { type: String, enum: ['sent', 'failed', 'stubbed', 'not_sent', null], default: null },
    emailDeliveryError: { type: String, default: null, maxlength: 400 },
    emailLastAttemptAt: { type: Date, default: null },
    emailAttempts: { type: Number, default: 0 },
    emailProviderMessageId: { type: String, default: null },

    // The password-setup link last issued. Only WHEN it stops working is kept
    // here: the token itself is never stored in this database (only the Teacher
    // Portal holds its hash), and the email is the only place it exists.
    setupLinkExpiresAt: { type: Date, default: null },
    // Where the teacher signs in, as the Teacher Portal reported it.
    portalLoginUrl: { type: String, default: null },

    // --- what they teach ----------------------------------------------------
    // The courses an administrator assigned, by the student catalogue's slug
    // (prarambh, garud, yoddha). A teacher sees the students enrolled in exactly
    // these. Several teachers can hold the same course. The title is a snapshot
    // for display; the slug is the identity.
    assignedCourses: {
      type: [
        {
          _id: false,
          slug: { type: String, required: true, lowercase: true, trim: true },
          title: { type: String, trim: true },
          assignedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    // Whether the Teacher Portal last accepted that set. A failure is recorded
    // and shown, not assumed away - the teacher would see no students.
    courseSyncStatus: { type: String, enum: ['synced', 'failed', null], default: null },
    courseSyncedAt: { type: Date, default: null },
    courseSyncError: { type: String, default: null, maxlength: 300 },

    designation: { type: String, trim: true, maxlength: 160 },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

teacherSchema.index({ name: 'text', email: 'text', department: 'text', subject: 'text' });

teacherSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.passwordHash);
};

teacherSchema.statics.hashPassword = function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
};

// Soft-delete aware query helpers — default reads exclude soft-deleted records
// unless a caller explicitly opts in via `.where('deletedAt').ne(undefined)`.
teacherSchema.query.notDeleted = function notDeleted() {
  return this.where({ deletedAt: null });
};

export const Teacher = mongoose.model('Teacher', teacherSchema);
export default Teacher;
