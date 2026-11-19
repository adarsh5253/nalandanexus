import { env } from '../config/env.js';

/**
 * Publishes a teacher's public profile to the student portal's About page.
 *
 * Teacher identity is owned here; the student portal holds a read-only
 * projection (see student/backend/src/models/Faculty.js). Before this, the
 * mentors on that page were hardcoded frontend data, so adding an instructor
 * meant a deploy and the two sides could disagree.
 *
 * Only what a visitor may see crosses: name, role, category, expertise,
 * experience and photo. Email, phone, credentials, status and every other
 * governance field stay in this database - a public page is the last place
 * they belong.
 *
 * Mirrors studentResourceBridge.service.js: shared-secret auth, idempotent on
 * sourceId, best-effort and never throws, with the outcome returned so the
 * caller can record it on the teacher rather than claim success.
 */

function isConfigured() {
  return Boolean(env.studentBridge.url && env.studentBridge.serviceKey);
}

async function call(path, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${env.studentBridge.url}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': env.studentBridge.serviceKey, ...options.headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Student backend returned ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The public shape of a teacher. `category` falls back to the subject and then
 * the department, so a teacher an admin fills in normally still lands under a
 * sensible tab without a second thing to remember.
 */
export function publicProfileOf(teacher) {
  return {
    sourceId: String(teacher._id),
    name: teacher.name,
    role: teacher.websiteRole || teacher.subject || teacher.qualification || null,
    category: teacher.websiteCategory || teacher.subject || teacher.department || 'Faculty',
    expertise: (teacher.expertise || []).filter(Boolean),
    experience: teacher.experienceNote || null,
    avatar: teacher.avatar || null,
    order: Number.isFinite(teacher.websiteOrder) ? teacher.websiteOrder : 0,
  };
}

/** Publishes (creates or updates) a teacher's public profile. Never throws; returns a real status. */
export async function publishFacultyToStudents(teacher) {
  if (!isConfigured()) return { synced: false, reason: 'NOT_CONFIGURED' };
  try {
    await call('/api/internal/faculty', { method: 'POST', body: JSON.stringify(publicProfileOf(teacher)) });
    return { synced: true };
  } catch (err) {
    console.error('[studentFacultyBridge] Failed to publish faculty profile to the student portal:', err.message);
    return { synced: false, reason: 'REQUEST_FAILED', error: err.message };
  }
}

/**
 * Removes a teacher's public profile - when an admin turns the profile off,
 * suspends the teacher, or deletes the record. Idempotent: removing one that
 * was never published is a success, which is what makes it safe to call on
 * every change without tracking whether it is there.
 */
export async function retractFacultyFromStudents(sourceId) {
  if (!isConfigured()) return { synced: false, reason: 'NOT_CONFIGURED' };
  try {
    await call(`/api/internal/faculty/${encodeURIComponent(sourceId)}`, { method: 'DELETE' });
    return { synced: true };
  } catch (err) {
    console.error('[studentFacultyBridge] Failed to retract faculty profile from the student portal:', err.message);
    return { synced: false, reason: 'REQUEST_FAILED', error: err.message };
  }
}

export default { publishFacultyToStudents, retractFacultyFromStudents, publicProfileOf };
