/**
 * Centralized API client for the Nalanda Nexus backend.
 *
 * - Single base URL (VITE_API_URL, or VITE_STUDENT_API_URL to match the
 *   admin/teacher portals' naming convention - both are accepted so a
 *   deploy-time env var name mismatch can't silently fall back to
 *   localhost), single place to attach auth headers, normalize errors,
 *   and transparently refresh an expired access token.
 * - Access token is kept in memory (module-level) + mirrored into
 *   sessionStorage only so it survives a hard page reload without relying
 *   on a JS-readable long-lived secret in localStorage. The *real* session
 *   persistence is the httpOnly refresh-token cookie the backend sets -
 *   this in-memory token is just a short-lived convenience copy.
 */
const API_BASE_URL =
  import.meta.env.VITE_STUDENT_API_URL || import.meta.env.VITE_API_URL || 'http://localhost:5001/api';

/**
 * Origin that serves backend-hosted files (avatars under /uploads/...).
 * The API returns those as ROOT-RELATIVE paths ("/uploads/avatars/x.png").
 * Rendering them directly resolves against the frontend origin, which on a
 * split-domain deployment (frontend on Vercel, backend on Render) 404s every
 * uploaded avatar - confirmed live. Strip the trailing "/api" to get the
 * backend origin and prefix such paths with it.
 */
const ASSET_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');

/** Absolute URL for a backend-served asset path; passes through absolute URLs, data: URIs and empty values. */
export function resolveAssetUrl(pathOrUrl) {
  if (!pathOrUrl) return pathOrUrl;
  if (/^(https?:)?\/\//i.test(pathOrUrl) || pathOrUrl.startsWith('data:')) return pathOrUrl;
  if (pathOrUrl.startsWith('/uploads/')) return `${ASSET_BASE_URL}${pathOrUrl}`;
  return pathOrUrl;
}

/**
 * Every request carries a deadline.
 *
 * `fetch` has no timeout of its own: a request to a host that accepts the
 * connection and then never answers stays pending for as long as the tab is
 * open. That is what left the dashboard, the enrollment gate and the course
 * screens spinning with no error and no way out - the promise simply never
 * settled, so no `catch` and no `finally` ever ran. An AbortController gives
 * every request an upper bound, and an aborted request surfaces as a normal
 * `ApiError` the UI can show and offer a retry for.
 *
 * The session-restore and sign-in calls get a longer deadline because the API
 * is hosted on an instance that sleeps when idle and takes ~25s to wake; a
 * 20s cap there would turn every first visit into a failure.
 */
const DEFAULT_TIMEOUT_MS = 20000;
const COLD_START_TIMEOUT_MS = 45000;
const COLD_START_PATHS = ['/auth/refresh', '/auth/login', '/auth/me', '/auth/google', '/auth/verify-email'];

function timeoutFor(path) {
  return COLD_START_PATHS.some((p) => path.startsWith(p)) ? COLD_START_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/** Runs `fetch` with a deadline, and with any caller-supplied abort signal still honoured. */
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

let accessToken = null;
try {
  accessToken = sessionStorage.getItem('nalanda_access_token') || null;
} catch {
  accessToken = null;
}

let refreshPromise = null;

// Counts sign-ins, verifications and sign-outs. A refresh already in flight when
// one of them finished describes the session from before it, and must not
// replace the token the newer one issued.
let sessionEpoch = 0;

function storeAccessToken(token) {
  accessToken = token;
  try {
    if (token) sessionStorage.setItem('nalanda_access_token', token);
    else sessionStorage.removeItem('nalanda_access_token');
  } catch {
    // sessionStorage unavailable (e.g. private mode) - in-memory token still works for this tab session.
  }
}

/** Sets the token a sign-in, verification or sign-out produced. */
export function setAccessToken(token) {
  sessionEpoch += 1;
  storeAccessToken(token);
}

/**
 * Waits for a session refresh that is already in flight.
 *
 * Every page load starts one to restore the previous session. A sign-in sent
 * while it is still travelling can finish first, and the refresh's response -
 * the previous account's cookie and token - then lands on top of it. Signing in
 * only once any refresh has settled keeps the newer session last.
 */
export async function settleSessionRefresh() {
  if (refreshPromise) await refreshPromise;
}

export function getAccessToken() {
  return accessToken;
}

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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

async function rawRequest(path, { method = 'GET', body, skipAuth = false, isRetry = false, signal } = {}) {
  // A FormData body (file uploads) must NOT be JSON-stringified, and must
  // NOT get an explicit Content-Type - the browser sets one itself
  // (multipart/form-data with the correct boundary) only when it's absent.
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  const headers = isFormData ? {} : { 'Content-Type': 'application/json' };
  if (!skipAuth && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError('You appear to be offline. Check your connection and try again.', {
      status: 0,
      code: 'OFFLINE',
    });
  }

  let res;
  try {
    res = await fetchWithTimeout(
      `${API_BASE_URL}${path}`,
      {
        method,
        headers,
        credentials: 'include', // send/receive httpOnly refresh cookie
        body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
      },
      timeoutFor(path),
      signal
    );
  } catch (err) {
    // A caller-initiated abort is not a failure to report - it means the UI
    // moved on. Distinguished from our own deadline so the two are not
    // conflated: one is noise, the other is a real, retryable problem.
    if (signal?.aborted) throw new ApiAbortError();
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ApiError('The server took too long to respond. Please try again.', {
        status: 0,
        code: 'TIMEOUT',
      });
    }
    throw new ApiError('Could not reach the Nalanda Nexus server. Check your connection and try again.', {
      status: 0,
      code: 'NETWORK_ERROR',
    });
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (res.ok) {
    return payload;
  }

  const code = payload?.error?.code;

  // Access token expired - try exactly one silent refresh, then retry the original request.
  if (res.status === 401 && !skipAuth && !isRetry && (code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN' || code === 'NO_TOKEN')) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return rawRequest(path, { method, body, skipAuth, isRetry: true, signal });
    }
  }

  // Course content refused because the student profile is incomplete. Whatever
  // screen asked, the remedy is the same, so it is announced once here for the
  // student context to act on instead of every page learning the code.
  if (res.status === 403 && code === 'PROFILE_INCOMPLETE' && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nalanda-profile-incomplete'));
  }

  throw new ApiError(payload?.error?.message || 'Something went wrong. Please try again.', {
    status: res.status,
    code: code || 'UNKNOWN_ERROR',
    details: payload?.error?.details,
  });
}

async function refreshAccessToken() {
  if (!refreshPromise) {
    const startedAt = sessionEpoch;
    // A sign-in or sign-out finished while this was in flight: its token stands.
    const superseded = () => startedAt !== sessionEpoch;
    refreshPromise = fetchWithTimeout(
      `${API_BASE_URL}/auth/refresh`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      },
      COLD_START_TIMEOUT_MS
    )
      .then(async (res) => {
        if (superseded()) return Boolean(accessToken);
        if (!res.ok) {
          storeAccessToken(null);
          return false;
        }
        const payload = await res.json();
        if (superseded()) return Boolean(accessToken);
        storeAccessToken(payload?.data?.accessToken || null);
        return Boolean(payload?.data?.accessToken);
      })
      .catch(() => {
        if (superseded()) return Boolean(accessToken);
        storeAccessToken(null);
        return false;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export const apiClient = {
  get: (path, opts) => rawRequest(path, { method: 'GET', ...opts }),
  post: (path, body, opts) => rawRequest(path, { method: 'POST', body, ...opts }),
  patch: (path, body, opts) => rawRequest(path, { method: 'PATCH', body, ...opts }),
  put: (path, body, opts) => rawRequest(path, { method: 'PUT', body, ...opts }),
  delete: (path, opts) => rawRequest(path, { method: 'DELETE', ...opts }),
  tryRefreshSession: refreshAccessToken,
};
