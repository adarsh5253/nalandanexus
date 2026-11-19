/**
 * Real HTTP client for the Nalanda Teacher backend (see backend/API_DOCUMENTATION.md).
 *
 * Every method here hits a real endpoint and returns real, live-computed data
 * — there is no mock/demo fallback baked in. If the backend is unreachable or
 * returns an error, callers get a rejected promise carrying an `ApiClientError`
 * (with `.status` / `.code` / `.details`) so the UI can show a real error or
 * empty state instead of silently substituting fake data.
 */

const API_BASE_URL = import.meta.env.VITE_TEACHER_API_URL || 'http://localhost:5002/api/teacher';

// Cross-portal navigation links shown in the teacher UI (e.g. "Other Nalanda Portals").
export const ADMIN_PORTAL_URL = import.meta.env.VITE_ADMIN_PORTAL_URL || 'http://localhost:5175';
export const STUDENT_PORTAL_URL = import.meta.env.VITE_STUDENT_PORTAL_URL || 'http://localhost:3000';

export class ApiClientError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status ?? 0; // 0 = network-level failure (no response at all)
    this.code = code || 'UNKNOWN_ERROR';
    this.details = details;
  }

  /** True when retrying the same request could plausibly succeed. */
  get isRetryable() {
    return this.code === 'TIMEOUT' || this.code === 'NETWORK_ERROR' || this.code === 'OFFLINE' || this.status >= 500;
  }
}

/** Raised when a caller aborted the request itself (component unmounted, newer request started). */
export class ApiAbortError extends Error {
  constructor() {
    super('Request cancelled.');
    this.name = 'ApiAbortError';
    this.code = 'CANCELLED';
  }
}

export function isAbortError(err) {
  return err instanceof ApiAbortError || err?.name === 'AbortError' || err?.code === 'CANCELLED';
}

/**
 * Every request carries a deadline.
 *
 * `fetch` has no timeout of its own, so a request to a backend that accepts
 * the connection and then never answers never settles - no `catch`, no
 * `finally`, and a page left spinning until the tab is closed. An
 * AbortController bounds every request, and an expired deadline arrives as an
 * ordinary `ApiClientError` with a retryable code.
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

/**
 * One place that decides "the session is no longer valid" so every page
 * doesn't have to special-case 401s itself. TeacherAuthContext registers
 * itself here on mount.
 */
let sessionExpiredHandler = null;
export function onSessionExpired(handler) {
  sessionExpiredHandler = handler;
}

async function request(path, { method = 'GET', body, query, isFormData = false, signal } = {}) {
  let url = `${API_BASE_URL}${path}`;
  if (query && Object.keys(query).length) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, value);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiClientError('You appear to be offline. Check your connection and try again.', {
      status: 0,
      code: 'OFFLINE',
    });
  }

  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method,
        credentials: 'include', // send/receive the httpOnly session cookie
        headers: isFormData ? undefined : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? (isFormData ? body : JSON.stringify(body)) : undefined,
      },
      timeoutFor(path),
      signal
    );
  } catch (networkErr) {
    // A caller-initiated abort means the UI moved on, not that anything failed.
    if (signal?.aborted) throw new ApiAbortError();
    if (networkErr?.name === 'TimeoutError' || networkErr?.name === 'AbortError') {
      throw new ApiClientError('The server took too long to respond. Please try again.', {
        status: 0,
        code: 'TIMEOUT',
      });
    }
    throw new ApiClientError(
      'Could not reach the Nalanda Teacher server. Check your connection and that the backend is running.',
      { status: 0, code: 'NETWORK_ERROR' }
    );
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON response (e.g. a proxy error page) — fall through, handled below.
  }

  if (!res.ok) {
    const message = json?.message || `Request failed with status ${res.status}.`;
    const code = json?.error?.code || 'HTTP_ERROR';
    if (res.status === 401 && sessionExpiredHandler) {
      sessionExpiredHandler(code);
    }
    throw new ApiClientError(message, { status: res.status, code, details: json?.error?.details });
  }

  return json; // { success, message, data, meta? }
}

const get = (path, query, signal) => request(path, { method: 'GET', query, signal });
const post = (path, body, signal) => request(path, { method: 'POST', body: body ?? {}, signal });
const patch = (path, body) => request(path, { method: 'PATCH', body: body ?? {} });
const put = (path, body) => request(path, { method: 'PUT', body: body ?? {} });
const del = (path) => request(path, { method: 'DELETE' });
const postForm = (path, formData) => request(path, { method: 'POST', body: formData, isFormData: true });

// A course video belongs to one lesson or one module.
function courseVideoPath(slug, target) {
  const node = target.moduleId ? `modules/${encodeURIComponent(target.moduleId)}` : `lessons/${encodeURIComponent(target.lessonId)}`;
  return `/lesson-videos/courses/${encodeURIComponent(slug)}/${node}`;
}

class TeacherApiService {
  // ---- Auth ----
  login(email, password, rememberMe) {
    return post('/auth/login', { email, password, rememberMe }).then((r) => r.data);
  }
  logout() {
    return post('/auth/logout').then((r) => r.data);
  }
  logoutAllSessions() {
    return post('/auth/logout-all').then((r) => r.data);
  }
  me() {
    return get('/auth/me').then((r) => r.data);
  }
  changePassword(currentPassword, newPassword) {
    return post('/auth/change-password', { currentPassword, newPassword }).then((r) => r.data);
  }
  /** Public: who an emailed password-setup link is for. Rejects with SETUP_LINK_INVALID for any bad link. */
  inspectPasswordSetup(token) {
    return get(`/auth/setup-password/${encodeURIComponent(token)}`).then((r) => r.data);
  }
  /** Public: redeems a single-use link and sets the password. Does not sign anyone in. */
  completePasswordSetup(token, password) {
    return post('/auth/setup-password', { token, password }).then((r) => r.data);
  }

  // ---- Profile ----
  getProfile() {
    return get('/profile').then((r) => r.data);
  }
  updateProfile(updates) {
    return patch('/profile', updates).then((r) => r.data);
  }
  updatePreferences(preferences) {
    return patch('/profile/preferences', preferences).then((r) => r.data);
  }
  uploadAvatar(file) {
    const form = new FormData();
    form.append('avatar', file);
    return postForm('/profile/avatar', form).then((r) => r.data);
  }

  // ---- Dashboard ----
  /** `signal` lets the caller cancel this on unmount - it is the portal's most expensive query. */
  getDashboardOverview(signal) {
    return get('/dashboard/overview', undefined, signal).then((r) => r.data);
  }

  // ---- Classes ----
  getClasses(status) {
    return get('/classes', { status }).then((r) => r.data);
  }
  getClassById(classId) {
    return get(`/classes/${classId}`).then((r) => r.data);
  }
  createClass(payload) {
    return post('/classes', payload).then((r) => r.data);
  }
  updateClass(classId, updates) {
    return patch(`/classes/${classId}`, updates).then((r) => r.data);
  }
  archiveClass(classId) {
    return del(`/classes/${classId}`).then((r) => r.data);
  }
  getClassStudents(classId, params = {}) {
    return get(`/classes/${classId}/students`, params).then((r) => r);
  }
  getClassLeaderboard(classId, params = {}) {
    return get(`/classes/${classId}/leaderboard`, params).then((r) => r.data);
  }
  /**
   * Returns the whole envelope, not just `data`. `meta.catalogAvailable` says
   * whether the student catalogue actually answered - an empty list alone
   * cannot distinguish "no courses published yet" from "the catalogue is
   * down", and the Classes page has to tell the teacher which one it is.
   */
  getStudentCourseOptions() {
    return get('/classes/course-options').then((r) => ({
      courses: r.data || [],
      catalogAvailable: r.meta?.catalogAvailable !== false,
    }));
  }
  syncClassEnrollment(classId) {
    return post(`/classes/${classId}/sync-enrollment`).then((r) => r.data);
  }

  // ---- Students ----
  getStudents(filters = {}) {
    return get('/students', filters).then((r) => r);
  }

  /**
   * Student progression. Read-only: this portal can see every figure and
   * author none of them - XP, rank, skills and eligibility are produced by the
   * student service's engine from recorded activity.
   */
  getStudentProgress(params = {}) {
    return get('/students/progress', params).then((r) => r);
  }

  /**
   * Coursework from the three stages, submitted in the student portal. The
   * roster check is on the server; this is only the transport.
   */
  listCourseAssignments(params = {}) {
    return get('/course-assignments', params).then((r) => r);
  }
  gradeCourseAssignment(submissionId, payload) {
    return patch(`/course-assignments/${submissionId}/grade`, payload).then((r) => r.data);
  }

  getStudentProgressDetail(studentId, params = {}) {
    return get(`/students/progress/${studentId}`, params).then((r) => r.data);
  }
  getStudentById(studentId) {
    return get(`/students/${studentId}`).then((r) => r.data);
  }
  createStudent(payload) {
    return post('/students', payload).then((r) => r.data);
  }
  updateStudent(studentId, updates) {
    return patch(`/students/${studentId}`, updates).then((r) => r.data);
  }
  archiveStudent(studentId) {
    return del(`/students/${studentId}`).then((r) => r.data);
  }

  // ---- Assignments ----
  getAssignments(params = {}) {
    return get('/assignments', params).then((r) => r.data);
  }
  getAssignmentById(assignmentId) {
    return get(`/assignments/${assignmentId}`).then((r) => r.data);
  }
  createAssignment(payload) {
    return post('/assignments', payload).then((r) => r.data);
  }
  updateAssignment(assignmentId, updates) {
    return patch(`/assignments/${assignmentId}`, updates).then((r) => r.data);
  }
  archiveAssignment(assignmentId) {
    return del(`/assignments/${assignmentId}`).then((r) => r.data);
  }
  getAssignmentSubmissions(assignmentId) {
    return get(`/assignments/${assignmentId}/submissions`).then((r) => r.data);
  }

  // ---- Submissions ----
  getSubmission(submissionId) {
    return get(`/submissions/${submissionId}`).then((r) => r.data);
  }
  recordSubmission(submissionId, payload) {
    return patch(`/submissions/${submissionId}/record`, payload).then((r) => r.data);
  }
  gradeSubmission(submissionId, score, feedback) {
    return patch(`/submissions/${submissionId}/grade`, { score, feedback }).then((r) => r.data);
  }

  // ---- Schedule ----
  getSchedule(date) {
    return get('/schedule', { date }).then((r) => r.data);
  }
  createSession(payload) {
    return post('/schedule', payload).then((r) => r.data);
  }
  updateSession(sessionId, updates) {
    return patch(`/schedule/${sessionId}`, updates).then((r) => r.data);
  }
  cancelSession(sessionId) {
    return del(`/schedule/${sessionId}`).then((r) => r.data);
  }
  getLiveSession() {
    return get('/schedule/live').then((r) => r.data);
  }
  getTimetable(params = {}) {
    return get('/timetable', params).then((r) => r.data);
  }

  // ---- Attendance ----
  getAttendance(params = {}) {
    return get('/attendance', params).then((r) => r.data);
  }
  markAttendance(classId, date, records) {
    return post('/attendance', { classId, date, records }).then((r) => r.data);
  }
  getAttendanceAnalytics(classId, days) {
    return get(`/attendance/analytics/${classId}`, { days }).then((r) => r.data);
  }

  // ---- Analytics ----
  getAvgScoreBreakdown() {
    return get('/analytics/avg-score-breakdown').then((r) => r.data);
  }
  getConceptPerformance() {
    return get('/analytics/concepts').then((r) => r.data);
  }
  getGradebook(classId) {
    return get('/analytics/gradebook', { classId }).then((r) => r.data);
  }
  getPerformanceTrend(params = {}) {
    const query = { ...params };
    if (Array.isArray(query.studentIds)) query.studentIds = query.studentIds.join(',');
    return get('/analytics/performance-trend', query).then((r) => r.data);
  }

  // ---- Notifications ----
  getNotifications(params = {}) {
    return get('/notifications', params).then((r) => ({ notifications: r.data || [], unreadCount: r.meta?.unreadCount ?? 0, meta: r.meta }));
  }
  getUnreadNotificationCount() {
    return get('/notifications/unread-count').then((r) => r.data.count);
  }
  markNotificationRead(notificationId) {
    return patch(`/notifications/${notificationId}/read`).then((r) => r.data);
  }
  markAllNotificationsRead() {
    return patch('/notifications/read-all').then((r) => r.data);
  }
  deleteNotification(notificationId) {
    return del(`/notifications/${notificationId}`).then((r) => r.data);
  }

  // ---- Courses ----
  getCourses() {
    return get('/courses').then((r) => r.data);
  }
  getAssignedCourses() {
    return get('/courses/assigned').then((r) => r.data);
  }
  /**
   * The students enrolled in one course the teacher has been assigned.
   * Returns the whole envelope ({ data: { course, students }, meta }) so the page
   * can page through it. A course that was not assigned answers 404, exactly as
   * one that does not exist.
   */
  getAssignedCourseStudents(slug, params = {}) {
    return get(`/courses/assigned/${encodeURIComponent(slug)}/students`, params);
  }
  /** Recovery only: the roster keeps itself current. Re-reads one assigned course from the student portal. */
  refreshAssignedCourseStudents(slug) {
    return post(`/courses/assigned/${encodeURIComponent(slug)}/refresh`).then((r) => r.data);
  }
  createCourse(payload) {
    return post('/courses', payload).then((r) => r.data);
  }
  updateCourse(courseId, updates) {
    return patch(`/courses/${courseId}`, updates).then((r) => r.data);
  }
  archiveCourse(courseId) {
    return del(`/courses/${courseId}`).then((r) => r.data);
  }

  // ---- Lesson videos (assigned courses only; enforced by the backend) ----
  getLessonVideoCourses() {
    return get('/lesson-videos/courses').then((r) => r.data || []);
  }
  getLessonVideos(slug) {
    return get(`/lesson-videos/courses/${encodeURIComponent(slug)}`).then((r) => r.data);
  }
  inspectLessonVideo(url, { signal } = {}) {
    return post('/lesson-videos/inspect', { url }, signal).then((r) => r.data);
  }
  // target is { lessonId } or { moduleId }.
  saveCourseVideo(slug, target, payload) {
    return put(courseVideoPath(slug, target), payload).then((r) => r.data);
  }
  removeCourseVideo(slug, target, payload = {}) {
    return request(courseVideoPath(slug, target), { method: 'DELETE', body: payload }).then((r) => r.data);
  }

  // ---- Exams ----
  getExams() {
    return get('/exams').then((r) => r.data);
  }
  createExam(payload) {
    return post('/exams', payload).then((r) => r.data);
  }
  updateExam(examId, updates) {
    return patch(`/exams/${examId}`, updates).then((r) => r.data);
  }
  deleteExam(examId) {
    return del(`/exams/${examId}`).then((r) => r.data);
  }

  // ---- Resources ----
  getResources() {
    return get('/resources').then((r) => r.data);
  }
  uploadResource({ title, subject, classId }, file) {
    const form = new FormData();
    form.append('file', file);
    form.append('title', title);
    if (subject) form.append('subject', subject);
    if (classId) form.append('classId', classId);
    return postForm('/resources', form).then((r) => r.data);
  }
  downloadResource(resourceId) {
    return post(`/resources/${resourceId}/download`).then((r) => r.data);
  }
  deleteResource(resourceId) {
    return del(`/resources/${resourceId}`).then((r) => r.data);
  }

  // ---- Messages ----
  getConversations() {
    return get('/messages/conversations').then((r) => r.data);
  }
  startConversation(studentId) {
    return post('/messages/conversations', { studentId }).then((r) => r.data);
  }
  getMessages(conversationId) {
    return get(`/messages/conversations/${conversationId}`).then((r) => r.data);
  }
  sendMessage(conversationId, text) {
    return post(`/messages/conversations/${conversationId}/messages`, { text }).then((r) => r.data);
  }
  markConversationRead(conversationId) {
    return patch(`/messages/conversations/${conversationId}/read`).then((r) => r.data);
  }

  // ---- Announcements / Events / Convocation ----
  getAnnouncements(params = {}) {
    return get('/announcements', params).then((r) => r);
  }
  getAnnouncementById(announcementId) {
    return get(`/announcements/${announcementId}`).then((r) => r.data);
  }
  createAnnouncement(payload, file) {
    if (file) {
      const form = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        if (value === undefined || value === null) continue;
        if (key === 'classes' && Array.isArray(value)) form.append(key, JSON.stringify(value));
        else form.append(key, value);
      }
      form.append('attachment', file);
      return postForm('/announcements', form).then((r) => r.data);
    }
    return post('/announcements', payload).then((r) => r.data);
  }
  updateAnnouncement(announcementId, updates) {
    return patch(`/announcements/${announcementId}`, updates).then((r) => r.data);
  }
  publishAnnouncement(announcementId) {
    return post(`/announcements/${announcementId}/publish`).then((r) => r.data);
  }
  archiveAnnouncement(announcementId) {
    return post(`/announcements/${announcementId}/archive`).then((r) => r.data);
  }
  deleteAnnouncement(announcementId) {
    return del(`/announcements/${announcementId}`).then((r) => r.data);
  }
  getAdminAnnouncements(params = {}) {
    // AdminAnnouncement has no `id` virtual (unlike every other model in
    // this app) — normalized here so consumers can treat it like any other
    // list response instead of each needing to know to fall back to `_id`.
    return get('/announcements/admin', params).then((r) => ({ ...r, data: (r.data || []).map((a) => ({ ...a, id: a.id || a._id })) }));
  }

  // ---- Reports ----
  // A plain <a href> can't reliably carry the auth cookie cross-origin, so
  // this fetches the CSV as an authenticated blob and triggers a
  // client-side download — the same pattern already proven on the Admin
  // Portal's Reports page.
  async downloadReport(type, filters = {}) {
    const query = new URLSearchParams({ type, ...filters }).toString();
    const res = await fetch(`${API_BASE_URL}/reports/export?${query}`, { credentials: 'include' });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new ApiClientError(json.message || 'Failed to generate report', { status: res.status });
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nalanda-${type}-report.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }

  // ---- Search ----
  /** One of this teacher's own students, by enrollment number. 404 for anyone else - by design. */
  findStudentByEnrollmentNumber(enrollmentNumber) {
    return get(`/students/enrollment-number/${encodeURIComponent(enrollmentNumber)}`).then((r) => r.data);
  }
  search(q) {
    return get('/search', { q }).then((r) => r.data);
  }

  /** Resolves a backend-relative file URL (e.g. from Resource.fileUrl) to an absolute one. */
  resolveFileUrl(relativeUrl) {
    if (!relativeUrl) return relativeUrl;
    if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
    const origin = API_BASE_URL.replace(/\/api\/teacher\/?$/, '');
    return `${origin}${relativeUrl}`;
  }
}

export const teacherApiService = new TeacherApiService();
export default teacherApiService;
