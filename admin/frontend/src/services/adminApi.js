/**
 * Nalanda Nexus - Admin API Service
 * Talks to the real MongoDB-backed admin backend at http://localhost:5003/api/admin.
 * No dev-mode bypass token exists anymore — every request is either
 * unauthenticated (login) or carries a real JWT issued by /auth/login.
 */

const API_BASE = import.meta.env.VITE_ADMIN_API_URL || 'http://localhost:5003/api/admin';
export const SOCKET_URL = import.meta.env.VITE_ADMIN_SOCKET_URL || 'http://localhost:5003';

// Cross-portal navigation links (e.g. "Return to Faculty Portal" buttons) — env-driven so they resolve correctly once each portal has a real deployed URL, falling back to local dev ports.
export const TEACHER_PORTAL_URL = import.meta.env.VITE_TEACHER_PORTAL_URL || 'http://localhost:5174';
export const STUDENT_PORTAL_URL = import.meta.env.VITE_STUDENT_PORTAL_URL || 'http://localhost:3000';

/**
 * The session lives in an httpOnly cookie the backend sets at login, and every
 * request opts into sending it with `credentials: 'include'`.
 *
 * It used to be a JWT in localStorage with an Authorization header. That put a
 * SUPER_ADMIN token where any script on the page could read it, so a single XSS
 * anywhere in this bundle - or in a dependency - could lift full administrative
 * access and use it from anywhere. httpOnly removes it from JavaScript's reach
 * entirely, matching how the Student and Teacher portals already work.
 *
 * A token left over from the previous scheme is cleared once, on load, so it
 * does not sit in storage indefinitely after this deploys.
 */
const LEGACY_TOKEN_KEY = 'nalanda_admin_token';
try {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
} catch {
  // Private mode or blocked storage - nothing to clean up.
}

/** Course create/update carries an optional image file, so it goes as multipart, not JSON. */
function toCourseFormData(courseData) {
  const form = new FormData();
  Object.entries(courseData).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    form.append(key, value);
  });
  return form;
}

/** Resource create/update always carries a file (magazine PDF / event image), so it goes as multipart too. */
function toResourceFormData(resourceData) {
  const form = new FormData();
  Object.entries(resourceData).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    form.append(key, value);
  });
  return form;
}

/**
 * Every request carries a deadline, and every transport-level failure is
 * translated into a readable `Error` with a code.
 *
 * Two problems lived here before. `fetch` has no timeout of its own, so a
 * backend that accepts the connection and then never answers left the console
 * waiting forever - the promise never settled, so the pages' own `finally`
 * blocks never cleared their loading flags. And a connection that failed
 * outright rejected with a raw `TypeError: Failed to fetch`, which reached the
 * UI verbatim as the error message shown to an administrator.
 *
 * The session and sign-in calls get longer, because the API is hosted on an
 * instance that sleeps when idle and takes ~25s to answer the first request.
 */
const DEFAULT_TIMEOUT_MS = 20000;
const COLD_START_TIMEOUT_MS = 45000;
// Lesson-video calls are proxied to the student service, which sleeps when
// idle too, so they get the same budget as a cold sign-in.
const COLD_START_PATHS = ['/auth/me', '/auth/login', '/lesson-videos'];

function timeoutFor(path) {
  return COLD_START_PATHS.some((p) => path.startsWith(p)) ? COLD_START_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'CANCELLED';
}

async function fetchWithTimeout(url, options, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort);
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function transportError(message, code) {
  const error = new Error(message);
  error.status = 0;
  error.code = code;
  error.isRetryable = true;
  return error;
}

// A course video belongs to one lesson or one module.
function courseVideoPath(slug, target) {
  const node = target.moduleId ? `modules/${encodeURIComponent(target.moduleId)}` : `lessons/${encodeURIComponent(target.lessonId)}`;
  return `/lesson-videos/courses/${encodeURIComponent(slug)}/${node}`;
}

async function request(path, { method = 'GET', body, query, isFormData = false, signal } = {}) {
  const url = new URL(`${API_BASE}${path}`);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    });
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw transportError('You appear to be offline. Check your connection and try again.', 'OFFLINE');
  }

  let res;
  try {
    res = await fetchWithTimeout(
      url.toString(),
      {
        method,
        // Sends the httpOnly session cookie. The API is on a different origin, so
        // without this the browser omits it and every request is unauthenticated.
        credentials: 'include',
        headers: {
          // multipart/form-data needs its own auto-generated boundary — the
          // browser sets Content-Type itself when the body is a FormData.
          ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body !== undefined ? (isFormData ? body : JSON.stringify(body)) : undefined,
      },
      timeoutFor(path),
      signal
    );
  } catch (err) {
    // A caller-initiated abort means the UI moved on, not that anything failed.
    if (signal?.aborted) {
      const cancelled = new Error('Request cancelled.');
      cancelled.name = 'AbortError';
      cancelled.code = 'CANCELLED';
      throw cancelled;
    }
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw transportError('The server took too long to respond. Please try again.', 'TIMEOUT');
    }
    throw transportError(
      'Could not reach the Nalanda Admin server. Check your connection and that the backend is running.',
      'NETWORK_ERROR'
    );
  }

  if (res.status === 401) {
    // Session is gone (expired/revoked/never existed) — let the auth
    // context know so it can clear state and redirect to /login, without
    // adminApi importing the context module directly (avoids a cycle).
    window.dispatchEvent(new CustomEvent('nalanda-admin-unauthorized'));
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON response (e.g. CSV download handled separately) — ignore.
  }

  if (!res.ok) {
    // This API answers failures as { success: false, error: { code, message } },
    // so reading only the top-level `message` found nothing and every rejection
    // reached the UI as a generic "Request failed with status 409" - or, where a
    // caller printed the payload, as a raw JSON blob. Both shapes are read here.
    const detail = json?.error ?? json ?? {};
    const error = new Error(detail.message || `Request failed with status ${res.status}`);
    error.status = res.status;
    error.code = detail.code;
    error.errors = detail.details || detail.errors;
    // A server-side fault is worth offering a retry for; a 4xx is the caller's
    // to fix and retrying it unchanged would fail the same way.
    error.isRetryable = res.status >= 500;
    throw error;
  }

  return json;
}

export const adminApi = {
  // ── Auth ──────────────────────────────────────────────────────────────
  async login({ email, password }) {
    // The session arrives as an httpOnly cookie on this response; nothing to store.
    const json = await request('/auth/login', { method: 'POST', body: { email, password } });
    return json.data;
  },

  async logout() {
    // Only the server can clear an httpOnly cookie, so this request IS the logout.
    await request('/auth/logout', { method: 'POST' });
  },

  async getMe() {
    const json = await request('/auth/me');
    return json.data;
  },

  async changePassword({ currentPassword, newPassword }) {
    // Changing the password bumps tokenVersion and invalidates every other
    // session; the backend re-issues this browser's cookie on the same response.
    const json = await request('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
    return json.data;
  },

  // ── Dashboard ─────────────────────────────────────────────────────────
  async getOverview() {
    const json = await request('/overview');
    return json.data;
  },

  async getLeaderboard() {
    const json = await request('/leaderboard');
    return json.data;
  },

  // Real-time SSE Live Telemetry (aggregate counts only — see backend note
  // on why this can't carry an Authorization header).
  subscribeLiveTelemetry(onData, onError, onStatusChange) {
    let eventSource = null;
    let reconnectTimeout = null;
    let isExplicitlyClosed = false;

    function connect() {
      if (isExplicitlyClosed) return;

      onStatusChange?.('CONNECTING');
      try {
        eventSource = new EventSource(`${API_BASE}/live-telemetry`);

        eventSource.addEventListener('telemetry', (event) => {
          try {
            const data = JSON.parse(event.data);
            onStatusChange?.('LIVE');
            onData(data);
          } catch (e) {
            console.error('Error parsing SSE event:', e);
          }
        });

        eventSource.onopen = () => {
          onStatusChange?.('LIVE');
        };

        eventSource.onerror = (err) => {
          onStatusChange?.('DISCONNECTED');
          onError?.(err);
          eventSource.close();

          if (!isExplicitlyClosed) {
            reconnectTimeout = setTimeout(connect, 4000);
          }
        };
      } catch (e) {
        onStatusChange?.('DISCONNECTED');
        onError?.(e);
        if (!isExplicitlyClosed) {
          reconnectTimeout = setTimeout(connect, 5000);
        }
      }
    }

    connect();

    return () => {
      isExplicitlyClosed = true;
      clearTimeout(reconnectTimeout);
      if (eventSource) eventSource.close();
    };
  },

  // ── Teachers ──────────────────────────────────────────────────────────
  async getTeachers(params = {}) {
    const json = await request('/teachers', { query: params });
    return json.data || [];
  },

  async getTeacher(id) {
    const json = await request(`/teachers/${id}`);
    return json.data;
  },

  async createTeacher(teacherData) {
    return request('/teachers', { method: 'POST', body: teacherData });
  },

  async updateTeacher(id, updateData) {
    const json = await request(`/teachers/${id}`, { method: 'PUT', body: updateData });
    return json.data;
  },

  async deleteTeacher(id) {
    return request(`/teachers/${id}`, { method: 'DELETE' });
  },

  /** Replaces the courses assigned to a teacher (by catalogue slug). The Teacher Portal's student visibility follows. */
  async setTeacherCourses(id, courseSlugs) {
    return request(`/teachers/${id}/courses`, { method: 'PUT', body: { courseSlugs } });
  },

  /** Uploads a teacher's profile photo (stored durably server-side). */
  async uploadTeacherPhoto(id, file) {
    const form = new FormData();
    form.append('photo', file);
    return request(`/teachers/${id}/photo`, { method: 'POST', body: form, isFormData: true });
  },

  async resendInvite(id) {
    return request(`/teachers/${id}/resend-invite`, { method: 'POST' });
  },

  async resendCredentials(id) {
    return request(`/teachers/${id}/resend-credentials`, { method: 'POST' });
  },

  async revokeInvite(id) {
    return request(`/teachers/${id}/revoke-invite`, { method: 'POST' });
  },

  async suspendTeacher(id, reason) {
    const json = await request(`/teachers/${id}/suspend`, { method: 'POST', body: { reason } });
    return json.data;
  },

  async reactivateTeacher(id) {
    const json = await request(`/teachers/${id}/reactivate`, { method: 'POST' });
    return json.data;
  },

  async resetPassword(id) {
    return request(`/teachers/${id}/reset-password`, { method: 'POST' });
  },

  // Public teacher activation endpoints — no auth header needed/available.
  async verifyInviteToken(token) {
    try {
      const json = await request(`/teachers/invite/${token}`);
      return { valid: true, teacher: json.data };
    } catch (err) {
      return { valid: false, error: err.code, message: err.message };
    }
  },

  async activateTeacherAccount({ token, password }) {
    return request('/teachers/activate', { method: 'POST', body: { token, password } });
  },

  // ── Students ──────────────────────────────────────────────────────────
  async getStudents(params = {}) {
    const json = await request('/students', { query: params });
    return json.data || [];
  },

  /** Any student by enrollment number. Payment details arrive only for admins holding payments.view. */
  async findStudentByEnrollmentNumber(enrollmentNumber) {
    const json = await request(`/students/enrollment-number/${encodeURIComponent(enrollmentNumber)}`);
    return json.data;
  },

  /**
   * Resends portal students' records from the Student service. A dry run (a
   * count, nothing sent) unless `apply` is true. Needs students.update.
   */
  async syncPortalStudents(body) {
    const json = await request('/students/portal-sync', { method: 'POST', body });
    return json.data;
  },

  async createStudent(studentData) {
    const json = await request('/students', { method: 'POST', body: studentData });
    return json.data;
  },

  async updateStudent(id, updateData) {
    const json = await request(`/students/${id}`, { method: 'PUT', body: updateData });
    return json.data;
  },

  async deleteStudent(id) {
    return request(`/students/${id}`, { method: 'DELETE' });
  },

  // ── Batches ───────────────────────────────────────────────────────────
  // Batches live in the Teacher service; these endpoints proxy to it, so the
  // seat counts below are the same numbers capacity is enforced against rather
  // than anything this page computes.
  async getBatches(params = {}) {
    const json = await request('/batches', { query: params });
    return { batches: json.data || [], catalogAvailable: json.meta?.catalogAvailable !== false };
  },

  async getBatch(id) {
    const json = await request(`/batches/${id}`);
    return json.data;
  },

  async createBatch(payload) {
    const json = await request('/batches', { method: 'POST', body: payload });
    return json.data;
  },

  async updateBatch(id, payload) {
    const json = await request(`/batches/${id}`, { method: 'PATCH', body: payload });
    return json.data;
  },

  async reassignBatchTeacher(id, teacherEmail) {
    const json = await request(`/batches/${id}/teacher`, { method: 'PATCH', body: { teacherEmail } });
    return json.data;
  },

  async getBatchStudents(id) {
    const json = await request(`/batches/${id}/students`);
    return json.data || [];
  },

  // ── Coupons ───────────────────────────────────────────────────────────
  // Coupons live in the Student service; these endpoints proxy to it, so the
  // usage counts here are the same ones redemption is enforced against.
  async getCoupons(params = {}) {
    const json = await request('/coupons', { query: params });
    return { coupons: json.data || [], summary: json.meta?.summary || {} };
  },

  async createCampaign(payload) {
    const json = await request('/coupons/campaigns', { method: 'POST', body: payload });
    return json.data || { campaign: null, coupons: [] };
  },

  // ── Stage eligibility ─────────────────────────────────────────────────
  // The criteria that gate each stage. Nothing is evaluated on this side - the
  // builder posts a rule and the backend answers with a verdict.
  async listStageEligibility() {
    const json = await request('/progression/eligibility');
    return json.data || [];
  },

  async getStageEligibility(stage) {
    const json = await request(`/progression/eligibility/${encodeURIComponent(stage)}`);
    return json.data || null;
  },

  async saveStageEligibilityDraft(stage, payload) {
    const json = await request(`/progression/eligibility/${encodeURIComponent(stage)}/draft`, { method: 'PUT', body: payload });
    return json.data;
  },

  async validateStageEligibility(stage, payload) {
    const json = await request(`/progression/eligibility/${encodeURIComponent(stage)}/validate`, { method: 'POST', body: payload });
    return json.data;
  },

  async publishStageEligibility(stage) {
    const json = await request(`/progression/eligibility/${encodeURIComponent(stage)}/publish`, { method: 'POST', body: {} });
    return json.data;
  },

  async disableStageEligibility(stage) {
    const json = await request(`/progression/eligibility/${encodeURIComponent(stage)}/disable`, { method: 'POST', body: {} });
    return json.data;
  },

  async previewStageEligibility(payload) {
    const json = await request('/progression/eligibility/preview', { method: 'POST', body: payload });
    return json.data;
  },

  async getStudentEligibility(params = {}) {
    const json = await request('/progression/student-eligibility', { query: params });
    return { rows: json.data || [], meta: json.meta || {} };
  },

  // ── Progression control centre ────────────────────────────────────────
  // The rules the engine applies. Read and written here; never calculated on
  // this side.
  async getProgressionRules() {
    const json = await request('/progression/rules');
    return json.data || null;
  },

  async updateProgressionRules(payload) {
    const json = await request('/progression/rules', { method: 'PUT', body: payload });
    return json.data;
  },

  async updateProgressionStage(code, payload) {
    const json = await request(`/progression/stages/${encodeURIComponent(code)}`, { method: 'PATCH', body: payload });
    return json.data;
  },

  async updateProgressionAchievement(code, payload) {
    const json = await request(`/progression/achievements/${encodeURIComponent(code)}`, { method: 'PATCH', body: payload });
    return json.data;
  },

  async recalculateProgression(payload = {}) {
    const json = await request('/progression/recalculate', { method: 'POST', body: payload });
    return json.data;
  },

  async setupJourney(apply = false) {
    const json = await request('/progression/journey/setup', { method: 'POST', body: { apply } });
    return json.data;
  },

  async getProgressionAnalytics() {
    const json = await request('/progression/analytics');
    return json.data || null;
  },

  // ── Subject tagging ───────────────────────────────────────────────────
  // What an activity teaches decides which skill score it feeds, so these read
  // and write progression configuration, not cosmetic labels.
  async getCourseSubjects() {
    const json = await request('/course-content/subjects');
    return json.data || [];
  },

  async getCourseContent(slug) {
    const json = await request(`/course-content/${encodeURIComponent(slug)}/content`);
    return json.data || null;
  },

  async setCourseSubjects(slug, payload) {
    const json = await request(`/course-content/${encodeURIComponent(slug)}/subjects`, { method: 'PATCH', body: payload });
    return json.data;
  },

  // Lesson videos (YouTube). Proxied to the student service, which owns
  // lessons and validates every link; this portal gates and audits.
  async getLessonVideoCourses() {
    const json = await request('/lesson-videos/courses');
    return json.data || [];
  },

  async getLessonVideos(slug) {
    const json = await request(`/lesson-videos/courses/${encodeURIComponent(slug)}`);
    return json.data || null;
  },

  async inspectLessonVideo(url, { signal } = {}) {
    const json = await request('/lesson-videos/inspect', { method: 'POST', body: { url }, signal });
    return json.data || null;
  },

  // target is { lessonId } or { moduleId }.
  async saveCourseVideo(slug, target, payload) {
    const json = await request(courseVideoPath(slug, target), { method: 'PUT', body: payload });
    return json.data;
  },

  async removeCourseVideo(slug, target, payload = {}) {
    const json = await request(courseVideoPath(slug, target), { method: 'DELETE', body: payload });
    return json.data;
  },

  async getCampaigns(params = {}) {
    const json = await request('/coupons/campaigns', { query: params });
    return json.data || [];
  },

  async updateCoupon(id, payload) {
    const json = await request(`/coupons/${id}`, { method: 'PATCH', body: payload });
    return json.data;
  },

  async deleteCoupon(id) {
    await request(`/coupons/${id}`, { method: 'DELETE' });
  },

  // ── Courses ───────────────────────────────────────────────────────────
  async getCourses(params = {}) {
    const json = await request('/courses', { query: params });
    return json.data || [];
  },

  async createCourse(courseData) {
    const json = await request('/courses', { method: 'POST', body: toCourseFormData(courseData), isFormData: true });
    return json.data;
  },

  async updateCourse(id, courseData) {
    const json = await request(`/courses/${id}`, { method: 'PUT', body: toCourseFormData(courseData), isFormData: true });
    return json.data;
  },

  async updateCourseStatus(id, status, notes) {
    const json = await request(`/courses/${id}/status`, { method: 'PATCH', body: { status, notes } });
    return json.data;
  },

  // ── Resources (magazines, event photos, program materials) ─────────────
  async getResources(params = {}) {
    const json = await request('/resources', { query: params });
    return { items: json.data || [], meta: json.meta };
  },

  async createResource(resourceData) {
    const json = await request('/resources', { method: 'POST', body: toResourceFormData(resourceData), isFormData: true });
    return json;
  },

  async updateResource(id, resourceData) {
    const json = await request(`/resources/${id}`, { method: 'PUT', body: toResourceFormData(resourceData), isFormData: true });
    return json;
  },

  async deleteResource(id) {
    return request(`/resources/${id}`, { method: 'DELETE' });
  },

  // ── Enrollments ───────────────────────────────────────────────────────
  async getEnrollments(params = {}) {
    const json = await request('/enrollments', { query: params });
    return json.data || [];
  },

  async createEnrollment(data) {
    const json = await request('/enrollments', { method: 'POST', body: data });
    return json.data;
  },

  // ── Announcements ─────────────────────────────────────────────────────
  async getAnnouncements(params = {}) {
    const json = await request('/announcements', { query: params });
    return json.data || [];
  },

  async createAnnouncement(data) {
    const json = await request('/announcements', { method: 'POST', body: data });
    return json.data;
  },

  async getTeacherAnnouncements(params = {}) {
    const json = await request('/announcements/teachers', { query: params });
    return json.data || [];
  },

  // ── Audit Logs ────────────────────────────────────────────────────────
  async getAuditLogs(params = {}) {
    const json = await request('/audit-logs', { query: params });
    return json.data || [];
  },

  // ── Notifications ─────────────────────────────────────────────────────
  async getNotifications(params = {}) {
    const json = await request('/notifications', { query: params });
    return { items: json.data || [], meta: json.meta };
  },

  async markNotificationRead(id) {
    return request(`/notifications/${id}/read`, { method: 'POST' });
  },

  async markAllNotificationsRead() {
    return request('/notifications/read-all', { method: 'POST' });
  },

  // ── Payments ──────────────────────────────────────────────────────────
  async getPayments(params = {}) {
    const json = await request('/payments', { query: params });
    return { items: json.data || [], meta: json.meta };
  },

  async createPayment(data) {
    const json = await request('/payments', { method: 'POST', body: data });
    return json.data;
  },

  async updatePaymentStatus(id, status) {
    const json = await request(`/payments/${id}/status`, { method: 'PATCH', body: { status } });
    return json.data;
  },

  // ── Settings ──────────────────────────────────────────────────────────
  async getSettings() {
    const json = await request('/settings');
    return json.data;
  },

  async updateSettings(data) {
    const json = await request('/settings', { method: 'PUT', body: data });
    return json.data;
  },

  // ── Academics & System Health ─────────────────────────────────────────
  async getAcademicsOverview() {
    const json = await request('/academics/overview');
    return json.data;
  },

  async getAttendanceSummaries() {
    const json = await request('/academics/attendance-summaries');
    return json.data || [];
  },

  async getSystemHealth() {
    const json = await request('/system-health');
    return json.data || [];
  },

  // ── CSV downloads ─────────────────────────────────────────────────────
  // A plain <a href> can't carry the session, and putting a token in the URL
  // would write it into browser history and server access logs. So the CSV is
  // fetched as an authenticated blob and handed to a temporary link instead.
  //
  // `credentials: 'include'` is what carries the session here: the admin token
  // is an httpOnly cookie, so there is no header to attach and nothing for this
  // page to read. (This previously called an authHeaders() helper that no longer
  // exists, which made every download throw a ReferenceError.)
  async downloadCsv(path, filename) {
    const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.message || json.error?.message || 'Failed to generate the file');
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  },

  async downloadReport(type) {
    return adminApi.downloadCsv(`/reports/export?type=${encodeURIComponent(type)}`, `nalanda-${type}-report.csv`);
  },

  /**
   * Downloads one campaign's codes.
   *
   * The filename is server-chosen; this only needs a sensible fallback, and the
   * codes never touch the URL.
   */
  async downloadCampaignCodes(campaignId, campaignName) {
    const safe = String(campaignName || campaignId).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return adminApi.downloadCsv(`/coupons/campaigns/${campaignId}/export`, `nalanda-coupons-${safe}.csv`);
  },
};

export default adminApi;
