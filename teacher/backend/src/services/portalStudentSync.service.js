import { Student } from '../models/Student.js';
import { emitToTeacher } from '../sockets/index.js';
import { applyPortalRecordToRoster } from './courseRoster.service.js';

/**
 * Applies a student's record from the student portal to the rosters here.
 *
 * When a student buys a course the student portal asks this service to place
 * the enrolment in a batch, and placement creates a roster row - but with only
 * the name the account had at that moment, a placeholder email and no link to
 * the student's account. The teacher's Students list shows only linked rows, so
 * the new student stayed invisible until a teacher pressed Sync on the batch,
 * and a name completed or corrected afterwards never arrived at all.
 *
 * The student portal now sends the student's current record after every
 * enrolment and profile change (student/backend/src/services/portalSync.service.js).
 * This finds the roster rows placed for that student's enrolments - by
 * enrollment ID, which placement set and which never changes - or already linked
 * to their account, and brings them up to date:
 *
 *   - the link follows the enrolment it was placed for: active verifies the row,
 *     revoked withdraws it, exactly as the manual batch sync does;
 *   - name, email, photo, enrollment number, class, guardian and phone are the
 *     student portal's to set - the same details a teacher already sees for their
 *     own students through the enrollment-number search;
 *   - attendance, grades, metrics, roll number, guardian contact details, the
 *     batch and the row's status are this portal's and are never touched.
 *
 * Nothing is created here. Rows exist only where placement put them, so a record
 * can never put a student into a batch, or in front of a teacher, that placement
 * did not. A record older than the one a row already reflects is ignored, and
 * the same record applied twice changes nothing the second time.
 */

const COMPARED = ['name', 'email', 'avatarUrl', 'phone', 'guardianName', 'grade', 'enrollmentNumber', 'linkedUserId'];

const isEmailConflict = (err) => err?.code === 11000 && Boolean(err.keyPattern?.email || /email/.test(err.message || ''));

function log(entry) {
  console.log('[portalStudentSync]', JSON.stringify({ source: 'student-portal', destination: 'teacher', at: new Date().toISOString(), ...entry }));
}

export async function applyPortalStudent(record) {
  const userId = String(record.userId);
  const email = String(record.email).toLowerCase();
  const syncedAt = new Date(record.sourceUpdatedAt);
  const statusById = new Map(
    (record.enrollments || []).filter((e) => e.enrollmentId).map((e) => [String(e.enrollmentId).toUpperCase(), e.status])
  );

  const match = [{ linkedUserId: userId }];
  if (statusById.size) match.push({ enrollmentId: { $in: [...statusById.keys()] } });
  const rows = await Student.find({ $or: match }).lean();

  const outcome = { matched: rows.length, updated: 0, linked: 0, unlinked: 0, unchanged: 0, stale: 0, skipped: 0 };
  const changedByTeacher = new Map();

  for (const row of rows) {
    const enrollmentStatus = row.enrollmentId ? statusById.get(row.enrollmentId) : undefined;
    if (row.enrollmentId && enrollmentStatus === undefined) {
      // Linked to this account, but placed for an enrolment that is not theirs -
      // a link an earlier email match made. Not this record's to change.
      outcome.skipped += 1;
      log({ event: 'student.portal_sync', status: 'skipped', userId, studentId: String(row._id), reason: 'ENROLLMENT_NOT_THIS_STUDENTS' });
      continue;
    }

    const set = { name: record.fullName, portalSyncedAt: syncedAt };
    if (row.email !== email) set.email = email; // replaces the placement placeholder
    if (record.avatar) set.avatarUrl = record.avatar;
    if (record.phone) set.phone = record.phone;
    if (record.guardianName) set.guardianName = record.guardianName;
    if (record.grade) set.grade = record.grade;
    if (record.enrollmentNumber) set.enrollmentNumber = record.enrollmentNumber;
    if (enrollmentStatus === 'active') set.linkedUserId = userId;
    else if (enrollmentStatus) set.linkedUserId = null;

    // The age check and the write are one operation, so an older record cannot
    // land after a newer one.
    const filter = { _id: row._id, $or: [{ portalSyncedAt: null }, { portalSyncedAt: { $lte: syncedAt } }] };
    let after = null;
    for (let i = 0; i < 2; i += 1) {
      try {
        after = await Student.findOneAndUpdate(filter, { $set: set }, { new: true, runValidators: true }).lean();
        break;
      } catch (err) {
        if (!isEmailConflict(err) || !set.email) throw err;
        // A row the teacher typed in by hand already holds this address in the
        // batch. Keep the existing address rather than fail the whole record.
        log({ event: 'student.portal_sync', status: 'email_conflict', userId, studentId: String(row._id), classId: String(row.class) });
        delete set.email;
      }
    }

    if (!after) {
      outcome.stale += 1;
      continue;
    }

    const changed = COMPARED.filter((key) => String(row[key] ?? '') !== String(after[key] ?? ''));
    if (!changed.length) {
      outcome.unchanged += 1;
      continue;
    }

    outcome.updated += 1;
    if (changed.includes('linkedUserId')) {
      if (after.linkedUserId) outcome.linked += 1;
      else outcome.unlinked += 1;
    }
    log({
      event: 'student.portal_sync',
      status: 'updated',
      userId,
      studentId: String(after._id),
      classId: String(after.class),
      enrollmentId: after.enrollmentId || null,
      enrollmentNumber: after.enrollmentNumber || null,
      changed,
    });

    const teacherId = String(after.teacher);
    if (!changedByTeacher.has(teacherId)) changedByTeacher.set(teacherId, []);
    changedByTeacher.get(teacherId).push({ studentId: String(after._id), classId: String(after.class) });
  }

  // Each teacher hears only about rows on their own roster, so an open Students
  // or Classes page refreshes without anybody reloading it.
  for (const [teacherId, students] of changedByTeacher) emitToTeacher(teacherId, 'student.synced', { students });

  // The course-wide roster a teacher assigned the course can see. Separate from
  // the batch rows above: it needs no placement, so a student appears the moment
  // they enrol. A failure here fails the record, so the student portal marks it
  // pending and sends it again - the roster is never silently left behind.
  outcome.roster = await applyPortalRecordToRoster(record);

  return outcome;
}

export default { applyPortalStudent };
