/**
 * YouTube URL parsing for lesson videos.
 *
 * THIS FILE IS SHARED. The same module is copied, byte for byte, into
 *   student/frontend/src/utils/youtube.js
 *   admin/frontend/src/utils/youtube.js
 *   teacher/frontend/src/utils/youtube.js
 * so the thumbnail an editor sees while typing comes from exactly the rule the
 * student service later enforces on save. It has no imports and touches no
 * Node or browser API, which is what lets one file run in all four places.
 * tests/youtube.util.test.js fails if a copy drifts.
 *
 * The student service is the authority: nothing is stored that did not pass
 * parseYoutubeUrl here, and nothing is ever rendered into an iframe except
 * youtubeEmbedUrl(<an id that passed isValidYoutubeVideoId>). A pasted embed
 * code, an arbitrary iframe URL or a bare id never reaches a page.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Hosts a lesson video may be pasted from. Anything else - including
// look-alikes such as youtube.com.evil.example - is another provider.
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const NOCOOKIE_HOSTS = new Set(['youtube-nocookie.com', 'www.youtube-nocookie.com']);

// Path forms whose second segment is the video id.
const ID_PATH_PREFIXES = new Set(['embed', 'shorts', 'live', 'v', 'e']);

export const YOUTUBE_URL_MAX_LENGTH = 2048;

export const YOUTUBE_ERROR_MESSAGES = {
  EMPTY_URL: 'Paste a YouTube link.',
  INVALID_URL: 'That is not a valid web address.',
  UNSUPPORTED_PROVIDER: 'Only YouTube links are supported.',
  UNSUPPORTED_YOUTUBE_URL: 'That YouTube link does not point to a single video.',
  INVALID_VIDEO_ID: 'That YouTube link has a malformed video id.',
};

function fail(code) {
  return { ok: false, code, message: YOUTUBE_ERROR_MESSAGES[code] };
}

export function isValidYoutubeVideoId(id) {
  return typeof id === 'string' && VIDEO_ID.test(id);
}

/**
 * Normalises any supported YouTube link to its 11-character video id.
 *
 * Supported: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID,
 * youtube.com/shorts/ID, youtube.com/live/ID (and the m./music./nocookie
 * variants of the same paths). A missing scheme is tolerated because people
 * paste "youtube.com/watch?v=..." from an address bar.
 *
 * Returns { ok: true, videoId, canonicalUrl } or { ok: false, code, message }.
 */
export function parseYoutubeUrl(input) {
  if (typeof input !== 'string') return fail('EMPTY_URL');
  const raw = input.trim();
  if (!raw) return fail('EMPTY_URL');
  if (raw.length > YOUTUBE_URL_MAX_LENGTH || /\s/.test(raw)) return fail('INVALID_URL');

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return fail('INVALID_URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('INVALID_URL');
  // Credentials or an explicit port have no place in a video link and are a
  // common way of disguising the real host.
  if (url.username || url.password || url.port) return fail('INVALID_URL');

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  let videoId = null;

  if (SHORT_HOSTS.has(host)) {
    if (segments.length !== 1) return fail('UNSUPPORTED_YOUTUBE_URL');
    videoId = segments[0];
  } else if (WATCH_HOSTS.has(host) || NOCOOKIE_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === 'watch' && !NOCOOKIE_HOSTS.has(host)) {
      videoId = url.searchParams.get('v');
    } else if (segments.length === 2 && ID_PATH_PREFIXES.has(segments[0])) {
      videoId = segments[1];
    } else {
      return fail('UNSUPPORTED_YOUTUBE_URL');
    }
    if (videoId === null) return fail('UNSUPPORTED_YOUTUBE_URL');
  } else {
    return fail('UNSUPPORTED_PROVIDER');
  }

  if (!isValidYoutubeVideoId(videoId)) return fail('INVALID_VIDEO_ID');
  return { ok: true, videoId, canonicalUrl: youtubeWatchUrl(videoId) };
}

function assertId(videoId) {
  if (!isValidYoutubeVideoId(videoId)) throw new Error('Invalid YouTube video id');
  return videoId;
}

/** The public watch page - what "Open on YouTube" links to. */
export function youtubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${assertId(videoId)}`;
}

/** The origin every embed is served from - and the only origin whose player messages are trusted. */
export const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

const PAGE_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/**
 * The only iframe source this platform ever renders. Privacy-enhanced domain,
 * related videos limited to the same channel, inline playback on iOS.
 *
 * `apiOrigin` (the embedding page's own origin) turns on YouTube's player
 * messages, so the page can tell when a video fails to play - embedding
 * disabled, made private, removed - and offer YouTube instead of a dead frame.
 */
export function youtubeEmbedUrl(videoId, { autoplay = false, apiOrigin } = {}) {
  let params = `rel=0&modestbranding=1&playsinline=1${autoplay ? '&autoplay=1' : ''}`;
  if (apiOrigin !== undefined) {
    if (typeof apiOrigin !== 'string' || !PAGE_ORIGIN.test(apiOrigin)) throw new Error('Invalid embedding origin');
    params += `&enablejsapi=1&origin=${encodeURIComponent(apiOrigin)}`;
  }
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${assertId(videoId)}?${params}`;
}

/**
 * What the player's onError codes mean for a student. 101 and 150 mean the
 * video cannot be embedded - checked live, YouTube sends 150 both when the
 * owner disabled embedding and when the video is private - so the message
 * names both; 100 is removed; the rest are playback faults where YouTube
 * itself is still the way to watch.
 */
export function describeYoutubePlayerError(code) {
  if (code === 101 || code === 150) {
    return { reason: 'embedding-disabled', message: 'This video can’t be played here - its owner has turned off playback on other websites, or made it private.' };
  }
  if (code === 100) return { reason: 'unavailable', message: 'This video is no longer available on YouTube.' };
  return { reason: 'playback-error', message: 'This video could not be played here.' };
}

/**
 * Thumbnail candidates, best first. maxresdefault exists only for HD uploads;
 * hqdefault exists for every public video, so it is the fallback the player
 * drops to. YouTube answers a missing size with a 120x90 grey placeholder
 * rather than an error, so callers check naturalWidth as well as onerror.
 */
export function youtubeThumbnailUrls(videoId) {
  const id = assertId(videoId);
  return {
    maxres: `https://img.youtube.com/vi/${id}/maxresdefault.jpg`,
    hq: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
  };
}

/** Width of the grey placeholder YouTube serves for a thumbnail that does not exist. */
export const YOUTUBE_PLACEHOLDER_MAX_WIDTH = 120;
