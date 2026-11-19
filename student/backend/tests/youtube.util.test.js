import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseYoutubeUrl,
  isValidYoutubeVideoId,
  youtubeEmbedUrl,
  youtubeWatchUrl,
  youtubeThumbnailUrls,
  describeYoutubePlayerError,
} from '../src/utils/youtube.js';

const ID = 'dQw4w9WgXcQ';

test('every supported link form normalises to the same video id', () => {
  const forms = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `http://m.youtube.com/watch?feature=share&v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abcdef&t=10`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/embed/${ID}?start=30`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://youtube.com/shorts/${ID}?feature=share`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/live/${ID}?si=xyz`,
    `www.youtube.com/watch?v=${ID}`,
    `  youtu.be/${ID}  `,
  ];
  for (const url of forms) {
    const r = parseYoutubeUrl(url);
    assert.equal(r.ok, true, `expected ${url} to parse`);
    assert.equal(r.videoId, ID, url);
    assert.equal(r.canonicalUrl, `https://www.youtube.com/watch?v=${ID}`);
  }
});

test('empty input is rejected as EMPTY_URL', () => {
  for (const v of ['', '   ', null, undefined, 42]) {
    assert.equal(parseYoutubeUrl(v).code, 'EMPTY_URL');
  }
});

test('other providers and look-alike hosts are UNSUPPORTED_PROVIDER', () => {
  for (const url of [
    `https://vimeo.com/123456`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://evil.example/youtube.com/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://example.com/embed/${ID}`,
  ]) {
    assert.equal(parseYoutubeUrl(url).code, 'UNSUPPORTED_PROVIDER', url);
  }
});

test('non-video YouTube pages are UNSUPPORTED_YOUTUBE_URL', () => {
  for (const url of [
    'https://www.youtube.com/',
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/feed/subscriptions',
    `https://youtu.be/${ID}/extra`,
    `https://www.youtube-nocookie.com/watch?v=${ID}`,
  ]) {
    assert.equal(parseYoutubeUrl(url).code, 'UNSUPPORTED_YOUTUBE_URL', url);
  }
});

test('malformed ids are INVALID_VIDEO_ID', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=waytoolongvideoid123',
    'https://youtu.be/abc$efghijk',
    'https://www.youtube.com/embed/<script>xx',
    'https://www.youtube.com/watch?v=',
  ]) {
    assert.equal(parseYoutubeUrl(url).code, 'INVALID_VIDEO_ID', url);
  }
});

test('non-http schemes, credentials, ports and whitespace are INVALID_URL', () => {
  for (const url of [
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    `data:text/html,<iframe src="https://youtube.com/embed/${ID}">`,
    `ftp://youtube.com/watch?v=${ID}`,
    `https://user:pass@www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:8443/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID} extra`,
    'http://',
    `https://www.youtube.com/watch?v=${ID}&x=${'a'.repeat(2100)}`,
  ]) {
    assert.equal(parseYoutubeUrl(url).code, 'INVALID_URL', url);
  }
});

test('a pasted iframe embed code is not accepted', () => {
  const r = parseYoutubeUrl(`<iframe src="https://www.youtube.com/embed/${ID}"></iframe>`);
  assert.equal(r.ok, false);
});

test('a bare id is not trusted as a link', () => {
  assert.equal(parseYoutubeUrl(ID).ok, false);
});

test('derived URLs are fixed-origin and refuse invalid ids', () => {
  assert.equal(isValidYoutubeVideoId(ID), true);
  assert.equal(isValidYoutubeVideoId('x'), false);
  assert.equal(youtubeWatchUrl(ID), `https://www.youtube.com/watch?v=${ID}`);
  assert.match(youtubeEmbedUrl(ID), /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.match(youtubeEmbedUrl(ID, { autoplay: true }), /autoplay=1/);
  assert.deepEqual(youtubeThumbnailUrls(ID), {
    maxres: `https://img.youtube.com/vi/${ID}/maxresdefault.jpg`,
    hq: `https://img.youtube.com/vi/${ID}/hqdefault.jpg`,
  });
  assert.throws(() => youtubeEmbedUrl('"><script>'));
  // The player API is opt-in, and only for a plain origin.
  assert.doesNotMatch(youtubeEmbedUrl(ID), /enablejsapi/);
  assert.equal(
    youtubeEmbedUrl(ID, { apiOrigin: 'https://www.nalandanexus.com' }),
    `https://www.youtube-nocookie.com/embed/${ID}?rel=0&modestbranding=1&playsinline=1&enablejsapi=1&origin=https%3A%2F%2Fwww.nalandanexus.com`
  );
  assert.match(youtubeEmbedUrl(ID, { apiOrigin: 'http://localhost:3000' }), /origin=http%3A%2F%2Flocalhost%3A3000/);
  for (const bad of ['https://evil.example/path', 'javascript:alert(1)', 'https://a.com"><x', '', null]) {
    assert.throws(() => youtubeEmbedUrl(ID, { apiOrigin: bad }), String(bad));
  }
  assert.equal(describeYoutubePlayerError(150).reason, 'embedding-disabled');
  assert.equal(describeYoutubePlayerError(101).reason, 'embedding-disabled');
  assert.equal(describeYoutubePlayerError(100).reason, 'unavailable');
  assert.equal(describeYoutubePlayerError(5).reason, 'playback-error');
  assert.throws(() => youtubeThumbnailUrls('../../etc'));
});

/**
 * The editors preview with a copy of this module, and a preview that accepted
 * a link the server then refused (or the reverse) would be a lie. Skipped when
 * the portal folders are not alongside this one, e.g. in a single-service deploy.
 */
test('frontend copies of the parser are identical to this one', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = path.resolve(here, '../src/utils/youtube.js');
  const original = await readFile(source, 'utf8');
  const copies = ['student', 'admin', 'teacher'].map((p) => path.resolve(here, `../../../${p}/frontend/src/utils/youtube.js`));
  for (const copy of copies) {
    try {
      await access(copy);
    } catch {
      continue;
    }
    const text = await readFile(copy, 'utf8');
    assert.equal(text.replace(/\r\n/g, '\n'), original.replace(/\r\n/g, '\n'), `${copy} has drifted from ${source}`);
  }
});
