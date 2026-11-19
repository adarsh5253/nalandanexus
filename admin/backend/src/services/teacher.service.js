import crypto from 'node:crypto';
import { Teacher } from '../models/Teacher.js';
import { Course } from '../models/Course.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, buildPaginationMeta, parseSort } from '../utils/pagination.js';
import { generateSecureToken, hashToken } from '../utils/tokens.js';
import { withIds } from '../utils/serialize.js';
import { recordAuditLog } from './auditLog.service.js';
import { notifyAllAdmins } from './notification.service.js';
import { emitEvent } from '../sockets/index.js';
import * as emailService from './email.service.js';
import { provisionTeacherAccount, issueTeacherSetupLink, setTeacherCoursesOnPortal, setTeacherAccountStatus } from './teacherBridge.service.js';
import { fetchStudentCourseCatalog } from './studentCourseBridge.service.js';
import { publishFacultyToStudents, retractFacultyFromStudents } from './studentFacultyBridge.service.js';
import { env } from '../config/env.js';

const SORTABLE_FIELDS = ['name', 'email', 'department', 'status', 'rating', 'createdAt', 'lastActive'];
const INVITATION_TTL_HOURS = 24;
/** A second "resend" inside this window is almost certainly a double click, and each one invalidates the link just sent. */
const RESEND_COOLDOWN_MS = 30 * 1000;

function teacherIdFor(sequence) {
  return `TCH-${String(sequence).padStart(4, '0')}`;
}

async function nextTeacherId() {
  const count = await Teacher.countDocuments();
  let id = teacherIdFor(count + 1);
  // Guard against a rare id collision (e.g. after a deletion) by probing forward.
  // eslint-disable-next-line no-await-in-loop
  while (await Teacher.exists({ teacherId: id })) {
    id = teacherIdFor(parseInt(id.split('-')[1], 10) + 1);
  }
  return id;
}

/** A teacher as it may be broadcast: never the password hash, which a freshly created document still carries. */
function publicShape(teacher) {
  const { passwordHash, ...rest } = teacher.toObject ? teacher.toObject() : teacher;
  return rest;
}

/**
 * Puts the teacher's public profile on the student site, or takes it down.
 *
 * Called after every change that could affect what the About page shows. A
 * teacher who is suspended, deactivated or deleted is withdrawn whatever the
 * flag says - a public page must never introduce somebody who no longer teaches
 * here. Best-effort like the other bridges, with the real outcome recorded on
 * the teacher rather than assumed; the caller still has to save.
 */
async function syncFacultyProfile(teacher) {
  const shouldShow = Boolean(teacher.showOnWebsite) && teacher.status === 'ACTIVE' && !teacher.deletedAt;
  const result = shouldShow
    ? await publishFacultyToStudents(teacher)
    : await retractFacultyFromStudents(String(teacher._id));

  teacher.facultySyncedAt = new Date();
  // NOT_CONFIGURED is not a failure: this deployment simply has no student
  // portal wired up, and claiming "failed" would be a false alarm.
  teacher.facultySyncStatus = result.synced ? 'synced' : result.reason === 'NOT_CONFIGURED' ? null : 'failed';
  return result;
}

export async function listTeachers(query) {
  const { page, limit, skip } = parsePagination(query);
  const sort = parseSort(query.sort, SORTABLE_FIELDS);

  const filter = { deletedAt: null };
  if (query.status) filter.status = query.status;
  if (query.department) filter.department = new RegExp(escapeRegex(query.department), 'i');
  if (query.subject) filter.subject = new RegExp(escapeRegex(query.subject), 'i');
  if (query.course) filter['assignedCourses.slug'] = String(query.course).toLowerCase();
  if (query.search) filter.$text = { $search: query.search };

  const [items, total] = await Promise.all([
    Teacher.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Teacher.countDocuments(filter),
  ]);

  return { items: withIds(items), meta: buildPaginationMeta({ page, limit, total }) };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getTeacherById(id) {
  const teacher = await Teacher.findOne({ _id: id, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Teacher not found', 'TEACHER_NOT_FOUND');
  return teacher;
}

/**
 * Checks a set of course slugs against the live student catalogue - the one
 * place PRARAMBH, GARUD and YODDHA actually exist - and returns them with their
 * titles.
 *
 * A catalogue that cannot be reached is an error, not "no courses": a teacher
 * must never be created or assigned against courses nobody could check, and
 * accepting unverified slugs would let a typo silently grant access to nothing.
 */
async function resolveCourses(slugs) {
  const wanted = [...new Set((slugs || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return [];

  const catalog = await fetchStudentCourseCatalog();
  if (!catalog.ok) {
    throw ApiError.serviceUnavailable(
      'The course catalogue could not be reached, so the courses could not be verified. Nothing was changed - please try again in a moment.',
      'COURSE_CATALOG_UNAVAILABLE'
    );
  }
  const bySlug = new Map((catalog.courses || []).map((c) => [String(c.slug).toLowerCase(), c]));
  const unknown = wanted.filter((slug) => !bySlug.has(slug));
  if (unknown.length) {
    throw ApiError.badRequest(`Unknown course: ${unknown.join(', ')}. Choose from the course list.`, 'COURSE_NOT_FOUND', { unknown });
  }
  return wanted.map((slug) => ({ slug, title: bySlug.get(slug).title, assignedAt: new Date() }));
}

/** A fresh single-use setup link. Only the hash leaves this process (to the Teacher Portal); the raw token lives in one email. */
function newSetupLink() {
  const token = generateSecureToken(32);
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + env.teacherSetupLinkTtlHours * 60 * 60 * 1000),
  };
}

/** The Teacher Portal's own address: an explicit override, else what it reported, else what we last learned. */
function portalBase(teacher, reported) {
  const known = env.teacherPortalUrl || reported || (teacher.portalLoginUrl ? teacher.portalLoginUrl.replace(/\/login$/, '') : '');
  return String(known || '').replace(/\/+$/, '');
}

/** Records the outcome of an email attempt on the teacher exactly as it happened. The caller saves. */
function recordEmailOutcome(teacher, result) {
  teacher.emailLastAttemptAt = new Date();
  teacher.emailAttempts = (teacher.emailAttempts || 0) + 1;
  teacher.credentialEmailSent = Boolean(result.delivered);
  if (result.delivered) {
    teacher.credentialEmailSentAt = new Date();
    teacher.emailDeliveryStatus = 'sent';
    teacher.emailDeliveryError = null;
    teacher.emailProviderMessageId = result.messageId || null;
  } else {
    teacher.emailDeliveryStatus = result.stubbed ? 'stubbed' : result.notSent ? 'not_sent' : 'failed';
    teacher.emailDeliveryError = String(result.detail || result.reason || 'The email could not be sent.').slice(0, 400);
    teacher.emailProviderMessageId = null;
  }
}

/** Builds the onboarding email for a teacher and sends it. Returns the provider outcome, or a not-sent one if there is nowhere to link to. */
async function sendOnboardingEmail(teacher, link, base, { isResend }) {
  if (!base) {
    return { delivered: false, notSent: true, reason: 'PORTAL_URL_UNKNOWN', detail: 'The Teacher Portal address is not known, so there is no page to link to. Set TEACHER_PORTAL_URL or check the Teacher service.' };
  }
  const { subject, text, html } = emailService.teacherOnboardingEmail({
    name: teacher.name,
    teacherId: teacher.teacherId,
    loginUrl: `${base}/login`,
    setupUrl: `${base}/setup-password?token=${link.token}`,
    expiresAt: link.expiresAt,
    courses: teacher.assignedCourses || [],
    isResend,
  });
  return emailService.send({ to: teacher.email, subject, text, html });
}

/** Pushes the teacher's assigned set to the Teacher Portal and records whether it was accepted. The caller saves. */
async function syncCoursesToPortal(teacher, warnings) {
  const result = await setTeacherCoursesOnPortal({
    email: teacher.email,
    courses: (teacher.assignedCourses || []).map((c) => ({ slug: c.slug, title: c.title })),
  });
  teacher.courseSyncedAt = new Date();
  teacher.courseSyncStatus = result.applied ? 'synced' : 'failed';
  teacher.courseSyncError = result.applied ? null : String(result.error || result.reason || 'The Teacher Portal did not accept the courses.').slice(0, 300);
  if (!result.applied) warnings.push('COURSE_SYNC_FAILED');
  return result;
}

/**
 * Creates a teacher: a governance record here, a real working login on
 * teacher/backend (a separate service - see teacherBridge.service.js), the
 * courses they were assigned, and a onboarding email with a link to set their
 * own password.
 *
 * No password is generated, shown, stored in plain text or emailed. The account
 * is created with a random one nobody knows; the emailed single-use link is the
 * only way to choose the real one. Every step that can fail records exactly what
 * happened and is returned as a warning, because a failure on any of them means
 * the teacher cannot get in or sees nothing yet (master doc §41) - none is
 * best-effort-and-silent.
 *
 * `courseSlugs` are verified against the live catalogue BEFORE anything is
 * created, so a bad course leaves no half-made teacher behind.
 */
export async function createTeacher(data, actor, req) {
  const { courseSlugs, ...fields } = data;

  const existing = await Teacher.findOne({ email: fields.email.toLowerCase() });
  if (existing) throw ApiError.conflict('A teacher with this email already exists', 'TEACHER_EMAIL_EXISTS');

  const courses = await resolveCourses(courseSlugs);

  const teacherId = await nextTeacherId();
  const link = newSetupLink();

  const teacher = await Teacher.create({
    ...fields,
    email: fields.email.toLowerCase(),
    teacherId,
    status: 'ACTIVE',
    // Nobody knows this: it is random and never leaves this function. The
    // teacher sets their own through the emailed link.
    passwordHash: await Teacher.hashPassword(crypto.randomBytes(32).toString('base64url')),
    assignedCourses: courses,
    setupLinkExpiresAt: link.expiresAt,
  });

  const warnings = [];

  const provisionResult = await provisionTeacherAccount({
    name: teacher.name,
    email: teacher.email,
    phone: teacher.phone,
    title: teacher.designation,
    department: teacher.department,
    subject: teacher.subject,
    teacherId: teacher.teacherId,
    avatarUrl: teacher.avatar || undefined,
    setupTokenHash: link.tokenHash,
    setupTokenExpiresAt: link.expiresAt.toISOString(),
  });
  teacher.portalProvisioned = provisionResult.provisioned;
  if (!provisionResult.provisioned) warnings.push('PORTAL_PROVISIONING_FAILED');

  if (provisionResult.provisioned && provisionResult.portalUrl) teacher.portalLoginUrl = `${provisionResult.portalUrl}/login`;

  // The Teacher ID in the email must be one the login accepts. The Teacher
  // Portal keeps the one asked for unless it was already taken there.
  if (provisionResult.provisioned && provisionResult.teacherCode && provisionResult.teacherCode !== teacher.teacherId) {
    const clash = await Teacher.exists({ teacherId: provisionResult.teacherCode, _id: { $ne: teacher._id } });
    if (clash) warnings.push('TEACHER_ID_MISMATCH');
    else teacher.teacherId = provisionResult.teacherCode;
  }

  await recordAuditLog({
    actor,
    action: 'teacher.provisioned',
    entityType: 'Teacher',
    entityId: teacher._id,
    metadata: { email: teacher.email, provisioned: provisionResult.provisioned, reason: provisionResult.reason },
    result: provisionResult.provisioned ? 'SUCCESS' : 'FAILURE',
    req,
  });

  // Only a teacher who actually has a login can use the courses and the link; a
  // later "resend" retries both.
  let emailResult;
  if (provisionResult.provisioned) {
    if (courses.length) await syncCoursesToPortal(teacher, warnings);
    emailResult = await sendOnboardingEmail(teacher, link, portalBase(teacher, provisionResult.portalUrl), { isResend: false });
  } else {
    emailResult = { delivered: false, notSent: true, reason: 'PORTAL_PROVISIONING_FAILED', detail: 'The Teacher Portal login could not be created, so no email was sent (its link would lead nowhere). Use Resend once the Teacher Portal is reachable.' };
    if (courses.length) {
      teacher.courseSyncStatus = 'failed';
      teacher.courseSyncError = 'Not sent: the Teacher Portal login could not be created.';
    }
  }
  recordEmailOutcome(teacher, emailResult);
  if (!emailResult.delivered && provisionResult.provisioned) warnings.push('EMAIL_DELIVERY_FAILED');

  // Only if the admin asked for it - a new teacher is not public by default.
  if (teacher.showOnWebsite) {
    const facultyResult = await syncFacultyProfile(teacher);
    if (!facultyResult.synced && facultyResult.reason !== 'NOT_CONFIGURED') warnings.push('WEBSITE_PROFILE_NOT_PUBLISHED');
  }

  await teacher.save();

  await recordAuditLog({
    actor,
    action: 'teacher.created',
    entityType: 'Teacher',
    entityId: teacher._id,
    metadata: {
      email: teacher.email,
      teacherId: teacher.teacherId,
      courses: courses.map((c) => c.slug),
      portalProvisioned: teacher.portalProvisioned,
      emailDeliveryStatus: teacher.emailDeliveryStatus,
      courseSyncStatus: teacher.courseSyncStatus,
    },
    req,
  });
  emitEvent.teacherCreated(publicShape(teacher));

  return { teacher, warnings, setupLinkExpiresAt: link.expiresAt };
}

/**
 * Sends a teacher a NEW password-setup link: the one used when the original
 * email never arrived, expired, or was lost, and the one behind "reset password".
 *
 * Replaces the pending link on the Teacher Portal, so any earlier one stops
 * working; changes nothing else - a teacher who is already working is not
 * locked out and keeps their password until they actually use the new link. If
 * the Teacher Portal login was never created (the original creation could not
 * reach it), this creates it. If the course set was not accepted last time, it
 * is sent again. Never reveals or generates a password. Same honesty contract
 * as creation: every outcome is recorded and surfaced, never assumed.
 */
export async function resendCredentials(id, actor, req) {
  const teacher = await Teacher.findOne({ _id: id, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Teacher not found', 'TEACHER_NOT_FOUND');
  if (teacher.status === 'SUSPENDED') throw ApiError.badRequest('Cannot resend credentials to a suspended teacher.', 'TEACHER_SUSPENDED');

  const sinceLast = teacher.emailLastAttemptAt ? Date.now() - teacher.emailLastAttemptAt.getTime() : Infinity;
  if (sinceLast < RESEND_COOLDOWN_MS) {
    throw ApiError.tooMany('A setup email was only just sent. Please wait a few seconds before sending another.', 'RESEND_TOO_SOON');
  }

  const warnings = [];
  const link = newSetupLink();

  let portal = await issueTeacherSetupLink({ email: teacher.email, setupTokenHash: link.tokenHash, setupTokenExpiresAt: link.expiresAt.toISOString() });
  let reachedPortal = portal.issued;
  let reportedUrl = portal.portalUrl;

  // No account there yet (creation could not reach the Teacher Portal): make it.
  if (!portal.issued && portal.status === 404) {
    const created = await provisionTeacherAccount({
      name: teacher.name,
      email: teacher.email,
      phone: teacher.phone,
      title: teacher.designation,
      department: teacher.department,
      subject: teacher.subject,
      teacherId: teacher.teacherId,
      avatarUrl: teacher.avatar || undefined,
      setupTokenHash: link.tokenHash,
      setupTokenExpiresAt: link.expiresAt.toISOString(),
    });
    portal = created;
    reachedPortal = created.provisioned;
    reportedUrl = created.portalUrl;
    if (created.provisioned && created.teacherCode && created.teacherCode !== teacher.teacherId) {
      const clash = await Teacher.exists({ teacherId: created.teacherCode, _id: { $ne: teacher._id } });
      if (clash) warnings.push('TEACHER_ID_MISMATCH');
      else teacher.teacherId = created.teacherCode;
    }
  }

  teacher.portalProvisioned = reachedPortal;
  await recordAuditLog({
    actor,
    action: 'teacher.provisioned',
    entityType: 'Teacher',
    entityId: teacher._id,
    metadata: { email: teacher.email, provisioned: reachedPortal, reason: portal.reason, resend: true },
    result: reachedPortal ? 'SUCCESS' : 'FAILURE',
    req,
  });

  let emailResult;
  if (reachedPortal) {
    teacher.setupLinkExpiresAt = link.expiresAt;
    if (reportedUrl) teacher.portalLoginUrl = `${reportedUrl}/login`;
    if (teacher.courseSyncStatus !== 'synced' && (teacher.assignedCourses || []).length) await syncCoursesToPortal(teacher, warnings);
    emailResult = await sendOnboardingEmail(teacher, link, portalBase(teacher, reportedUrl), { isResend: true });
    if (!emailResult.delivered) warnings.push('EMAIL_DELIVERY_FAILED');
  } else {
    warnings.push('PORTAL_PROVISIONING_FAILED');
    emailResult = { delivered: false, notSent: true, reason: 'PORTAL_UNREACHABLE', detail: 'The Teacher Portal could not be reached, so no new link was issued and no email was sent. Nothing was changed - please try again in a moment.' };
  }
  recordEmailOutcome(teacher, emailResult);
  await teacher.save();

  await recordAuditLog({
    actor,
    action: 'teacher.credentials.resent',
    entityType: 'Teacher',
    entityId: teacher._id,
    metadata: { email: teacher.email, portalProvisioned: teacher.portalProvisioned, emailDeliveryStatus: teacher.emailDeliveryStatus },
    result: emailResult.delivered ? 'SUCCESS' : 'FAILURE',
    req,
  });
  emitEvent.teacherUpdated(publicShape(teacher));

  return { teacher, warnings, setupLinkExpiresAt: reachedPortal ? link.expiresAt : null };
}

/**
 * Replaces the full set of courses assigned to a teacher.
 *
 * Several teachers may hold the same course, and a teacher may hold any number.
 * Taking a course away also takes its students out of that teacher's portal in
 * the same step. The outcome of telling the Teacher Portal is recorded and
 * returned - if it was not accepted, the teacher would see the wrong students,
 * and saying so is the whole point - and sending the same set again is always
 * safe, which is what "Retry" does.
 */
export async function setTeacherCourses(id, slugs, actor, req) {
  const teacher = await Teacher.findOne({ _id: id, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Teacher not found', 'TEACHER_NOT_FOUND');

  const courses = await resolveCourses(slugs);
  const before = new Set((teacher.assignedCourses || []).map((c) => c.slug));
  const kept = new Map((teacher.assignedCourses || []).map((c) => [c.slug, c.assignedAt]));
  teacher.assignedCourses = courses.map((c) => ({ ...c, assignedAt: kept.get(c.slug) || c.assignedAt }));

  const warnings = [];
  if (teacher.portalProvisioned) {
    await syncCoursesToPortal(teacher, warnings);
  } else {
    teacher.courseSyncedAt = new Date();
    teacher.courseSyncStatus = 'failed';
    teacher.courseSyncError = 'The Teacher Portal login has not been created yet. Send the setup email first; the courses are sent with it.';
    warnings.push('COURSE_SYNC_FAILED');
  }
  await teacher.save();

  const after = new Set(courses.map((c) => c.slug));
  await recordAuditLog({
    actor,
    action: 'teacher.courses.updated',
    entityType: 'Teacher',
    entityId: teacher._id,
    metadata: {
      added: [...after].filter((s) => !before.has(s)),
      removed: [...before].filter((s) => !after.has(s)),
      courseSyncStatus: teacher.courseSyncStatus,
    },
    result: teacher.courseSyncStatus === 'synced' ? 'SUCCESS' : 'FAILURE',
    req,
  });
  emitEvent.teacherUpdated(publicShape(teacher));

  return { teacher, warnings };
}

/** Courses an administrator authored and named this teacher instructor of - separate from the catalogue courses assigned above. */
export async function getTeacherAuthoredCourses(teacherId) {
  return Course.find({ instructor: teacherId, deletedAt: null }).select('title code slug status').lean();
}

export async function updateTeacher(id, data, actor, req) {
  const teacher = await Teacher.findOne({ _id: id, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Teacher not found', 'TEACHER_NOT_FOUND');

  Object.assign(teacher, data);
  await teacher.save();

  // The public profile follows what the admin just set - including being taken
  // down when they switch it off.
  await syncFacultyProfile(teacher);
  await teacher.save();

  await recordAuditLog({ actor, action: 'teacher.updated', entityType: 'Teacher', entityId: teacher._id, metadata: { fields: Object.keys(data) }, req });
  emitEvent.teacherUpdated(teacher);
  return teacher;
}

export async function deleteTeacher(id, actor, req) {
  const teacher = await Teacher.findOne({ _id: id, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Teacher not found', 'TEACHER_NOT_FOUND');

  // Soft delete — preserves historical class/course/audit references instead
  // of orphaning them, per the "preserve academic history" requirement.
  teacher.deletedAt = new Date();
  teacher.status = 'INACTIVE';
  await teacher.save();

  // Deleting the governance record must also lock the REAL Teacher Portal
  // login - confirmed live via a QA pass that without this, a "deleted"
  // teacher could still log in and use the app indefinitely.
  const portalSync = await setTeacherAccountStatus({ email: teacher.email, status: 'inactive' });
  await syncFacultyProfile(teacher);
  await teacher.save();
  await recordAuditLog({
    actor,
    action: 'teacher.deleted',
    entityType: 'Teacher',
    entityId: teacher._id,
    result: portalSync.updated ? 'SUCCESS' : 'FAILURE',
    req,
  });
  emitEvent.teacherDeleted(teacher._id);
  return teacher;
}

export async function resendInvite(id, actor, req) {
  const teacher = await Teacher.findOne({ _id: id, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Teacher not found', 'TEACHER_NOT_FOUND');
  if (teacher.status !== 'INVITED') throw ApiError.badRequest('Teacher has already activated their account', 'ALREADY_ACTIVE');

  const rawToken = generateSecureToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_HOURS * 60 * 60 * 1000);
  teacher.invitation = { tokenHash: hashToken(rawToken), createdAt: now, expiresAt, isUsed: false };
  await teacher.save();

  const activationUrl = `${env.clientUrl}/activate?token=${rawToken}`;
  const { subject, text } = emailService.teacherInvitationEmail({ name: teacher.name, activationUrl, expiresAt });
  await emailService.send({ to: teacher.email, subject, text });

  await recordAuditLog({ actor, action: 'teacher.invite.resent', entityType: 'Teacher', entityId: teacher._id, req });
  return teacher;
}

export async function revokeInvite(id, actor, req) {
  const teacher = await Teacher.findOne({ _id: id, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Teacher not found', 'TEACHER_NOT_FOUND');
  if (teacher.status !== 'INVITED') throw ApiError.badRequest('Only pending invitations can be revoked', 'NOT_INVITED');

  teacher.deletedAt = new Date();
  teacher.status = 'INACTIVE';
  await teacher.save();

  await recordAuditLog({ actor, action: 'teacher.invite.revoked', entityType: 'Teacher', entityId: teacher._id, req });
  emitEvent.teacherDeleted(teacher._id);
  return teacher;
}

export async function suspendTeacher(id, reason, actor, req) {
  const teacher = await Teacher.findOne({ _id: id, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Teacher not found', 'TEACHER_NOT_FOUND');

  teacher.status = 'SUSPENDED';
  teacher.suspensionReason = reason;
  await teacher.save();

  // Locks the REAL Teacher Portal login too, not just admin's own
  // governance record - see teacherBridge.service.js#setTeacherAccountStatus.
  const portalSync = await setTeacherAccountStatus({ email: teacher.email, status: 'suspended' });
  await syncFacultyProfile(teacher);
  await teacher.save();
  await recordAuditLog({
    actor,
    action: 'teacher.suspended',
    entityType: 'Teacher',
    entityId: teacher._id,
    metadata: { reason },
    result: portalSync.updated ? 'SUCCESS' : 'FAILURE',
    req,
  });
  await notifyAllAdmins({
    excludeAdminId: actor._id,
    type: 'TEACHER_STATUS',
    title: 'Teacher account suspended',
    message: `${teacher.name} (${teacher.teacherId}) was suspended: ${reason}`,
    relatedEntityType: 'Teacher',
    relatedEntityId: teacher._id,
  });
  emitEvent.teacherStatusChanged(teacher);
  return teacher;
}

export async function reactivateTeacher(id, actor, req) {
  const teacher = await Teacher.findOne({ _id: id, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Teacher not found', 'TEACHER_NOT_FOUND');

  teacher.status = 'ACTIVE';
  teacher.suspensionReason = undefined;
  await teacher.save();

  const portalSync = await setTeacherAccountStatus({ email: teacher.email, status: 'active' });
  await syncFacultyProfile(teacher);
  await teacher.save();
  await recordAuditLog({
    actor,
    action: 'teacher.reactivated',
    entityType: 'Teacher',
    entityId: teacher._id,
    result: portalSync.updated ? 'SUCCESS' : 'FAILURE',
    req,
  });
  emitEvent.teacherStatusChanged(teacher);
  return teacher;
}

export async function verifyInviteToken(token) {
  const tokenHash = hashToken(token);
  const teacher = await Teacher.findOne({ 'invitation.tokenHash': tokenHash, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Invitation not found', 'INVITE_NOT_FOUND');
  if (teacher.invitation.isUsed) throw ApiError.conflict('This invitation has already been used', 'INVITE_ALREADY_USED');
  if (teacher.invitation.expiresAt < new Date()) throw ApiError.badRequest('This invitation has expired', 'INVITE_EXPIRED');

  return { name: teacher.name, email: teacher.email, department: teacher.department };
}

export async function activateTeacherAccount({ token, password }) {
  const tokenHash = hashToken(token);
  const teacher = await Teacher.findOne({ 'invitation.tokenHash': tokenHash, deletedAt: null });
  if (!teacher) throw ApiError.notFound('Invitation not found', 'INVITE_NOT_FOUND');
  if (teacher.invitation.isUsed) throw ApiError.conflict('This invitation has already been used', 'INVITE_ALREADY_USED');
  if (teacher.invitation.expiresAt < new Date()) throw ApiError.badRequest('This invitation has expired', 'INVITE_EXPIRED');

  teacher.passwordHash = await Teacher.hashPassword(password);
  teacher.status = 'ACTIVE';
  teacher.invitation.isUsed = true;
  teacher.invitation.usedAt = new Date();
  await teacher.save();

  emitEvent.teacherStatusChanged(teacher);
  return { email: teacher.email, name: teacher.name };
}

export default {
  listTeachers,
  getTeacherById,
  getTeacherAuthoredCourses,
  createTeacher,
  resendCredentials,
  setTeacherCourses,
  updateTeacher,
  deleteTeacher,
  resendInvite,
  revokeInvite,
  suspendTeacher,
  reactivateTeacher,
  verifyInviteToken,
  activateTeacherAccount,
};
