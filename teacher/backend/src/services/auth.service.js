import crypto from 'node:crypto';
import { User } from '../models/User.js';
import { Teacher } from '../models/Teacher.js';
import { ApiError } from '../utils/ApiError.js';
import { signAuthToken } from '../utils/tokens.js';
import { formatSequentialId } from '../utils/generateId.js';
import { logAudit } from './audit.service.js';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** The Teacher ID shape: TCH-0001. Also what a person may type into the login box in place of an email. */
export const TEACHER_ID_PATTERN = /^TCH-\d{4,}$/i;

/**
 * Verifies teacher credentials and issues a session token.
 * Deliberately returns a generic "invalid email or password" message on
 * every failure branch (unknown email, wrong password, wrong role) so the
 * response can't be used to enumerate valid faculty email addresses.
 */
export async function loginTeacher({ email, password, rememberMe, ip }) {
  const genericError = () => ApiError.unauthorized('Invalid email or password.', 'INVALID_CREDENTIALS');

  // The login box says "Faculty Email / Educator ID" and the onboarding email
  // hands out a Teacher ID, so both have to work. An ID resolves to the same
  // account an email would; nothing else about the check differs.
  const identifier = String(email || '').trim();
  let user;
  if (TEACHER_ID_PATTERN.test(identifier)) {
    const byId = await Teacher.findOne({ teacherId: identifier.toUpperCase() }).select('user').lean();
    user = byId ? await User.findById(byId.user).select('+passwordHash +tokenVersion') : null;
  } else {
    user = await User.findOne({ email: identifier.toLowerCase() }).select('+passwordHash +tokenVersion');
  }

  if (!user || user.role !== 'teacher') throw genericError();

  const passwordOk = await user.comparePassword(password);
  if (!passwordOk) throw genericError();

  // A temp password still authenticates normally - middleware/auth.js is
  // what actually blocks portal access until it's changed, not this check -
  // so a forced-reset teacher still gets a real session here, just one that
  // can only reach /api/teacher/auth/*.
  if (user.status !== 'active') {
    throw ApiError.forbidden('This account has been deactivated. Contact your administrator.', 'ACCOUNT_INACTIVE');
  }

  const teacher = await Teacher.findOne({ user: user._id });
  if (!teacher) throw ApiError.forbidden('No teacher profile is associated with this account.', 'TEACHER_PROFILE_MISSING');

  user.lastLoginAt = new Date();
  await user.save();

  const token = signAuthToken(
    { userId: user._id, teacherId: teacher._id, role: user.role, tokenVersion: user.tokenVersion },
    Boolean(rememberMe)
  );

  await logAudit({ actorId: teacher._id, action: 'auth.login', targetType: 'Teacher', targetId: teacher._id, ip });

  return { token, user, teacher };
}

export async function logoutTeacher({ teacherId, ip }) {
  if (teacherId) {
    await logAudit({ actorId: teacherId, action: 'auth.logout', targetType: 'Teacher', targetId: teacherId, ip });
  }
}

/** Bumps tokenVersion, which immediately invalidates every previously issued JWT for this user. */
export async function invalidateAllSessions(userId) {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

export async function changePassword({ userId, currentPassword, newPassword, ip, teacherId }) {
  // Must also select tokenVersion (also `select: false` on the schema) -
  // omitting it left `user.tokenVersion` undefined below, so `+= 1` produced
  // NaN and the save failed a Mongoose Number cast on every call (a
  // pre-existing bug this path had never actually been exercised by, found
  // live while testing the new forced-reset flow).
  const user = await User.findById(userId).select('+passwordHash +tokenVersion');
  if (!user) throw ApiError.notFound('Account not found.', 'ACCOUNT_NOT_FOUND');

  const ok = await user.comparePassword(currentPassword);
  if (!ok) throw ApiError.badRequest('Current password is incorrect.', 'INVALID_CURRENT_PASSWORD');

  user.passwordHash = await User.hashPassword(newPassword);
  user.tokenVersion += 1; // invalidate every other active session
  user.mustChangePassword = false; // the temp password, if any, is now permanently unusable
  await user.save();

  await logAudit({ actorId: teacherId, action: 'auth.password_changed', targetType: 'User', targetId: user._id, ip });

  return signAuthToken({ userId: user._id, teacherId, role: user.role, tokenVersion: user.tokenVersion }, false);
}

/**
 * Creates a brand-new teacher User + Teacher profile pair. Not exposed via
 * a public self-serve registration route (faculty onboarding is expected to
 * be an administrative action) — used by the seed script today, and left
 * here so an admin-invite flow can call it directly later without
 * duplicating the account-creation logic.
 */
export async function createTeacherAccount({
  name,
  email,
  password,
  phone = null,
  title,
  department,
  subject,
  tier = 'free',
  mustChangePassword = false,
  // The Teacher ID the Admin portal already showed its administrator. Honoured
  // when free; otherwise the next free one is issued and returned, because the
  // ID in the onboarding email has to be one the login actually accepts.
  requestedTeacherId = null,
  avatarUrl = null,
  // Present when the person will choose their own password through an emailed
  // link: the SHA-256 of the link's token and when it stops working. The
  // account is then given a random password nobody knows.
  setup = null,
}) {
  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) throw ApiError.conflict('An account with this email already exists.', 'EMAIL_TAKEN');

  if (!password && !setup) throw ApiError.badRequest('Either a password or a setup link is required.', 'CREDENTIAL_REQUIRED');

  // Nobody knows this password, and nothing is emailed: the only way in is the
  // setup link.
  const passwordHash = await User.hashPassword(password || crypto.randomBytes(32).toString('base64url'));
  const user = await User.create({
    name,
    email,
    phone,
    avatarUrl,
    passwordHash,
    role: 'teacher',
    mustChangePassword,
    ...(setup ? { setupTokenHash: setup.tokenHash, setupTokenExpiresAt: setup.expiresAt } : {}),
  });

  let teacher;
  for (let attempt = 0; attempt < 3 && !teacher; attempt += 1) {
    const teacherId = await allocateTeacherId(attempt === 0 ? requestedTeacherId : null);
    try {
      teacher = await Teacher.create({
        user: user._id,
        teacherId,
        title: title || 'Faculty',
        department: department || null,
        subject: subject || null,
        tier,
      });
    } catch (err) {
      // Two accounts being created at once can both pick the same free ID; the
      // unique index decides, and the loser simply takes the next one.
      if (err?.code !== 11000 || attempt === 2) {
        await User.deleteOne({ _id: user._id });
        throw err;
      }
    }
  }

  return { user, teacher };
}

/**
 * The first free Teacher ID, preferring `requested`.
 *
 * Counting documents and adding one is not enough: a deleted teacher or a
 * hand-numbered one leaves the count behind the highest ID in use, and the next
 * creation would collide on a unique index and fail.
 */
async function allocateTeacherId(requested) {
  if (requested && TEACHER_ID_PATTERN.test(requested)) {
    const wanted = requested.toUpperCase();
    if (!(await Teacher.exists({ teacherId: wanted }))) return wanted;
  }
  let next = (await Teacher.countDocuments()) + 1;
  // eslint-disable-next-line no-await-in-loop
  while (await Teacher.exists({ teacherId: formatSequentialId('TCH', next) })) next += 1;
  return formatSequentialId('TCH', next);
}

/**
 * Replaces the pending password-setup link of an EXISTING teacher.
 *
 * Only the new token's hash is stored, so the previous link stops working the
 * moment this runs. The password, sessions and everything else are left alone:
 * resending a link must not lock out a teacher who is already working, and a
 * link nobody uses changes nothing. It takes effect only when redeemed
 * (completePasswordSetup), which is also when sessions are revoked.
 */
export async function issuePasswordSetupLink({ email, tokenHash, expiresAt }) {
  const user = await User.findOne({ email: email.toLowerCase().trim(), role: 'teacher' }).select('+setupTokenHash +setupTokenExpiresAt');
  if (!user) throw ApiError.notFound('No teacher account exists for this email.', 'ACCOUNT_NOT_FOUND');

  const teacher = await Teacher.findOne({ user: user._id });
  if (!teacher) throw ApiError.forbidden('No teacher profile is associated with this account.', 'TEACHER_PROFILE_MISSING');

  user.setupTokenHash = tokenHash;
  user.setupTokenExpiresAt = expiresAt;
  await user.save();

  await logAudit({ actorId: teacher._id, action: 'auth.setup_link_issued', targetType: 'User', targetId: user._id, ip: null });
  return { user, teacher };
}

const INVALID_SETUP_LINK = () =>
  ApiError.badRequest('This link is invalid, has already been used, or has expired. Ask your administrator to send a new one.', 'SETUP_LINK_INVALID');

async function findBySetupToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const user = await User.findOne({
    setupTokenHash: sha256(token),
    setupTokenExpiresAt: { $gt: new Date() },
    role: 'teacher',
  }).select('+setupTokenHash +setupTokenExpiresAt');
  return user;
}

/** What the setup page may show before a password is chosen. Reveals nothing for a bad link. */
export async function inspectPasswordSetup(token) {
  const user = await findBySetupToken(token);
  if (!user) throw INVALID_SETUP_LINK();
  if (user.status !== 'active') throw ApiError.forbidden('This account has been deactivated. Contact your administrator.', 'ACCOUNT_INACTIVE');
  const teacher = await Teacher.findOne({ user: user._id }).select('teacherId').lean();
  return {
    name: user.name,
    email: user.email,
    teacherId: teacher?.teacherId || null,
    expiresAt: user.setupTokenExpiresAt,
  };
}

/**
 * Lets the holder of a valid link choose their password.
 *
 * Single use, enforced by the database: the match on the token and its expiry
 * and the clearing of both are one update, so two requests presenting the same
 * link cannot both succeed. Setting it revokes every session the account had
 * (tokenVersion) and clears any forced-change flag - the password the person
 * just chose is the one that counts.
 */
export async function completePasswordSetup({ token, password, ip }) {
  const user = await findBySetupToken(token);
  if (!user) throw INVALID_SETUP_LINK();
  if (user.status !== 'active') throw ApiError.forbidden('This account has been deactivated. Contact your administrator.', 'ACCOUNT_INACTIVE');

  const passwordHash = await User.hashPassword(password);
  const updated = await User.findOneAndUpdate(
    { _id: user._id, setupTokenHash: sha256(token), setupTokenExpiresAt: { $gt: new Date() } },
    {
      $set: { passwordHash, passwordSetAt: new Date(), mustChangePassword: false },
      $unset: { setupTokenHash: '', setupTokenExpiresAt: '' },
      $inc: { tokenVersion: 1 },
    },
    { new: true }
  );
  // Lost the race: another request used the same link between the check and here.
  if (!updated) throw INVALID_SETUP_LINK();

  const teacher = await Teacher.findOne({ user: user._id }).select('_id teacherId');
  if (teacher) await logAudit({ actorId: teacher._id, action: 'auth.password_set_via_link', targetType: 'User', targetId: user._id, ip });
  return { email: user.email, teacherId: teacher?.teacherId || null };
}

/**
 * Resets an EXISTING teacher's password to a new admin-issued temporary
 * one (the "Resend Credentials" flow) — unlike createTeacherAccount, this
 * expects the account to already exist and updates it in place rather than
 * conflicting on EMAIL_TAKEN. Mirrors changePassword's security posture:
 * bumps tokenVersion (any session authenticated with the old password is
 * immediately revoked, not just the password itself) and forces
 * mustChangePassword back to true so the new temp password only ever
 * grants the same restricted first-login state as a brand-new account.
 */
export async function resetCredentials({ email, newPassword }) {
  const user = await User.findOne({ email: email.toLowerCase().trim(), role: 'teacher' }).select('+passwordHash +tokenVersion');
  if (!user) throw ApiError.notFound('No teacher account exists for this email.', 'ACCOUNT_NOT_FOUND');

  const teacher = await Teacher.findOne({ user: user._id });
  if (!teacher) throw ApiError.forbidden('No teacher profile is associated with this account.', 'TEACHER_PROFILE_MISSING');

  user.passwordHash = await User.hashPassword(newPassword);
  user.mustChangePassword = true;
  user.tokenVersion += 1;
  await user.save();

  await logAudit({ actorId: teacher._id, action: 'auth.credentials_reset', targetType: 'User', targetId: user._id, ip: null });

  return { user, teacher };
}

/**
 * Deactivates (or reactivates) the real Teacher Portal login when admin
 * deletes/restores the teacher on its own side - the gap this closes: admin
 * deleting a teacher previously only soft-deleted its own governance
 * record, leaving the real portal account fully able to log in and use the
 * app indefinitely (confirmed live via a QA pass). Bumping tokenVersion
 * invalidates any already-issued session immediately, not just future
 * logins - mirrors resetCredentials' logout-everywhere behavior.
 */
export async function setAccountStatus({ email, status }) {
  const user = await User.findOne({ email: email.toLowerCase().trim(), role: 'teacher' }).select('+tokenVersion');
  if (!user) return { found: false };

  user.status = status;
  user.tokenVersion += 1;
  await user.save();

  await logAudit({ actorId: user._id, action: `auth.account_${status}`, targetType: 'User', targetId: user._id, ip: null });
  return { found: true, userId: user._id };
}

export default {
  loginTeacher,
  logoutTeacher,
  invalidateAllSessions,
  changePassword,
  createTeacherAccount,
  issuePasswordSetupLink,
  inspectPasswordSetup,
  completePasswordSetup,
  resetCredentials,
  setAccountStatus,
};
