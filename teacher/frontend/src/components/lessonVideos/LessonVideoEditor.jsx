import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, X, Save, Send, EyeOff, Trash2, ExternalLink, CheckCircle2, AlertTriangle, XCircle, Loader2, Info } from 'lucide-react';
import YouTubeThumbnail from './YouTubeThumbnail';
import { parseYoutubeUrl, youtubeEmbedUrl, youtubeWatchUrl } from '../../utils/youtube';

/**
 * Editing one lesson's YouTube video.
 *
 * The link is parsed as it is typed, with the same module the student service
 * enforces on save, so the thumbnail appears immediately and an unusable link
 * is explained before anything is sent. A moment later the server asks YouTube
 * whether the video exists and allows embedding, and offers its title.
 *
 * `api` is { inspect(url, {signal}), save(payload), remove(payload) } - the
 * portal wrapping this decides which backend and which permission check stand
 * behind them. Every save and remove names the version of the video this
 * editor loaded, so if someone else changed it in the meantime the server
 * refuses (409) and the editor offers the current version instead of
 * overwriting it. Shared verbatim by the Admin and Teacher portals.
 *
 * `lesson` may be a lesson or a module ({ kind: 'module' }); the editor is the
 * same for both.
 */

const AVAILABILITY = {
  available: { tone: 'ok', text: 'Valid YouTube video · embedding allowed' },
  restricted: {
    tone: 'warn',
    text: 'YouTube reports that embedding is disabled for this video (or it is private). Students will be offered “Open on YouTube” instead of the in-page player.',
  },
  unavailable: {
    tone: 'error',
    text: 'YouTube cannot find a public video with this id. You can keep it as a draft, but it cannot be published.',
  },
  unknown: { tone: 'info', text: 'Link is valid. YouTube could not be reached to confirm the video, so it was not checked.' },
};

const TONE_STYLE = {
  ok: 'bg-[#5C7A5E]/10 border-[#5C7A5E]/30 text-[#3F5A41]',
  warn: 'bg-[#C99A2E]/10 border-[#C99A2E]/40 text-[#7A5B12]',
  error: 'bg-[#C1352B]/10 border-[#C1352B]/30 text-[#9A2820]',
  info: 'bg-[#22355E]/5 border-[#22355E]/15 text-[#22355E]',
};

const TONE_ICON = { ok: CheckCircle2, warn: AlertTriangle, error: XCircle, info: Info };

const isAbort = (err) => err?.name === 'AbortError' || err?.name === 'ApiAbortError' || err?.code === 'CANCELLED';

function formatWhen(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function LessonVideoEditor({ lesson, api, onSaved, onRemoved, onClose, onConflict }) {
  const saved = lesson.video;
  const isModule = lesson.kind === 'module';
  const fieldKey = `${isModule ? 'm' : 'l'}-${lesson.lessonId}`;
  // The version this editor is based on; null means "there was no video".
  const expectedUpdatedAt = saved?.updatedAt || null;
  const [url, setUrl] = useState(saved?.originalUrl || '');
  const [title, setTitle] = useState(saved?.title || '');
  const [titleTouched, setTitleTouched] = useState(Boolean(saved?.title));
  const [description, setDescription] = useState(saved?.description || '');
  const [playbackMode, setPlaybackMode] = useState(saved?.playbackMode || 'embed');
  const [check, setCheck] = useState({ state: saved ? 'done' : 'idle', data: saved ? { availability: saved.availability } : null });
  const [thumbMissing, setThumbMissing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(null); // 'draft' | 'publish' | 'unpublish' | 'remove'
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(null); // { message, current }
  const urlInputRef = useRef(null);

  const parsed = useMemo(() => parseYoutubeUrl(url), [url]);
  const videoId = parsed.ok ? parsed.videoId : null;

  useEffect(() => {
    urlInputRef.current?.focus();
  }, []);

  // A new video id resets everything that described the previous one.
  useEffect(() => {
    setPreviewing(false);
    setThumbMissing(false);
  }, [videoId]);

  // Ask the server about the link once typing pauses. Re-checking the video
  // that is already saved is skipped - its answer came with the lesson.
  useEffect(() => {
    if (!videoId) {
      setCheck({ state: 'idle', data: null });
      return undefined;
    }
    if (saved && saved.videoId === videoId) {
      setCheck({ state: 'done', data: { availability: saved.availability } });
      return undefined;
    }
    const controller = new AbortController();
    setCheck({ state: 'checking', data: null });
    const timer = setTimeout(async () => {
      try {
        const data = await api.inspect(url, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setCheck({ state: 'done', data });
        if (data?.title) setTitle((current) => (titleTouched || current.trim() ? current : data.title));
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return;
        // The link itself was already validated here; the server refusing it
        // (e.g. a stricter rule) is shown as an error, a transport failure as unknown.
        if (err?.status >= 400 && err?.status < 500) setCheck({ state: 'error', data: null, message: err.message });
        else setCheck({ state: 'done', data: { availability: 'unknown' } });
      }
    }, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const availability = check.state === 'done' ? check.data?.availability || 'unknown' : null;
  // YouTube's own answer wins; a missing thumbnail only counts when YouTube
  // has not confirmed the video (it is the only other sign of a dead id).
  const unavailable = availability === 'unavailable' || (thumbMissing && availability !== 'available');

  const dirty =
    !saved ||
    saved.videoId !== videoId ||
    (saved.originalUrl || '') !== url.trim() ||
    (saved.title || '') !== title.trim() ||
    (saved.description || '') !== description.trim() ||
    (saved.playbackMode || 'embed') !== playbackMode;

  const handleFailure = (err, fallback) => {
    if (err?.status === 409 || err?.code === 'VIDEO_CHANGED') {
      const current = err?.details?.current ?? err?.errors?.current ?? null;
      setConflict({ message: err.message || 'This video was changed by someone else since you opened it.', current });
      return;
    }
    setError(err?.message || fallback);
  };

  const submit = async (mode) => {
    setError('');
    setConflict(null);
    if (!parsed.ok) {
      setError(parsed.message);
      urlInputRef.current?.focus();
      return;
    }
    setBusy(mode);
    try {
      const result = await api.save({
        url: url.trim(),
        title: title.trim(),
        description: description.trim(),
        playbackMode,
        isPublished: mode === 'publish',
        expectedUpdatedAt,
      });
      onSaved?.(result?.video || null, mode);
    } catch (err) {
      handleFailure(err, 'Could not save this video.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setError('');
    setConflict(null);
    setBusy('remove');
    try {
      await api.remove({ expectedUpdatedAt });
      onRemoved?.();
    } catch (err) {
      handleFailure(err, 'Could not remove this video.');
      setBusy(null);
      setConfirmRemove(false);
    }
  };

  let status;
  if (!url.trim()) status = { tone: 'info', text: 'Paste a YouTube link — watch, youtu.be, shorts, live and embed links all work.' };
  else if (!parsed.ok) status = { tone: 'error', text: parsed.message };
  else if (check.state === 'checking') status = { tone: 'info', text: 'Checking with YouTube…', spinning: true };
  else if (check.state === 'error') status = { tone: 'error', text: check.message || 'The link was refused.' };
  else if (thumbMissing && availability !== 'available') status = AVAILABILITY.unavailable;
  else if (availability) status = AVAILABILITY[availability] || AVAILABILITY.unknown;
  else status = { tone: 'info', text: 'Link is valid.' };
  const StatusIcon = status.spinning ? Loader2 : TONE_ICON[status.tone];

  const isPublished = Boolean(saved?.isPublished);
  const anyBusy = Boolean(busy);
  const canPublish = parsed.ok && !unavailable && check.state !== 'checking' && check.state !== 'error';

  return (
    <div className="rounded-2xl border border-[#D8D3C5] bg-[#FAF9F4] p-4 sm:p-5 space-y-4" data-testid="lesson-video-editor">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[#AB5236]">{isModule ? 'Module introduction video' : 'Lesson video'}</p>
          <h3 className="text-sm font-bold text-[#22355E] truncate">{lesson.title}</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-[#6E6A64] hover:bg-[#EDEAE0] hover:text-[#22355E]"
          aria-label="Close video editor"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {lesson.legacyVideoUrl && (
        <p className="text-[11px] text-[#6E6A64] bg-[#EDEAE0] rounded-lg px-3 py-2">
          This lesson currently plays a directly-hosted file (<span className="font-mono">{lesson.legacyVideoUrl}</span>). A
          published YouTube video replaces it for students; removing the video clears both.
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Preview card */}
        <div className="lg:col-span-2">
          <div className="relative aspect-video rounded-xl overflow-hidden bg-[#16233F] shadow-sm" data-testid="video-preview">
            {videoId && previewing ? (
              <iframe
                key={videoId}
                src={youtubeEmbedUrl(videoId, { autoplay: true })}
                title={title || 'YouTube video preview'}
                className="absolute inset-0 w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
              />
            ) : videoId ? (
              <>
                <YouTubeThumbnail
                  videoId={videoId}
                  alt={title ? `Thumbnail: ${title}` : 'Video thumbnail'}
                  className="absolute inset-0"
                  onStatus={(s) => setThumbMissing(s === 'missing')}
                />
                <button
                  type="button"
                  onClick={() => setPreviewing(true)}
                  className="absolute inset-0 flex items-center justify-center group focus:outline-none"
                  aria-label="Preview video"
                >
                  <span className="w-14 h-14 rounded-full bg-[#AB5236] group-hover:bg-[#94452C] group-focus-visible:ring-4 group-focus-visible:ring-white/60 text-white flex items-center justify-center shadow-lg transition-transform group-hover:scale-105">
                    <Play className="w-6 h-6 fill-white ml-0.5" />
                  </span>
                </button>
                {title && (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pt-6 pb-2 pointer-events-none">
                    <p className="text-xs font-semibold text-white truncate">{title}</p>
                  </div>
                )}
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white/50 gap-2 px-4 text-center">
                <Play className="w-8 h-8" />
                <span className="text-[11px]">The thumbnail appears as soon as you paste a valid link</span>
              </div>
            )}
          </div>
          {videoId && (
            <div className="flex items-center justify-between mt-2 text-[11px]">
              {previewing ? (
                <button type="button" onClick={() => setPreviewing(false)} className="font-semibold text-[#22355E] hover:text-[#AB5236]">
                  Close preview
                </button>
              ) : (
                <button type="button" onClick={() => setPreviewing(true)} className="font-semibold text-[#22355E] hover:text-[#AB5236]">
                  Preview
                </button>
              )}
              <a
                href={youtubeWatchUrl(videoId)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-[#6E6A64] hover:text-[#AB5236]"
              >
                Open on YouTube <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}
        </div>

        {/* Fields */}
        <div className="lg:col-span-3 space-y-3">
          <div>
            <label htmlFor={`yt-url-${fieldKey}`} className="block text-xs font-semibold text-[#22355E] mb-1">
              YouTube video URL
            </label>
            <input
              id={`yt-url-${fieldKey}`}
              ref={urlInputRef}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=…"
              maxLength={2048}
              aria-invalid={Boolean(url.trim()) && !parsed.ok}
              aria-describedby={`yt-status-${fieldKey}`}
              className="w-full bg-white border border-[#D8D3C5] rounded-lg px-3 py-2 text-sm text-[#2B2B28] focus:outline-none focus:ring-2 focus:ring-[#22355E]/30 focus:border-[#22355E]"
            />
            <div
              id={`yt-status-${fieldKey}`}
              role="status"
              aria-live="polite"
              className={`mt-2 flex gap-2 items-start text-[11px] leading-snug border rounded-lg px-2.5 py-2 ${TONE_STYLE[status.tone]}`}
              data-testid="video-status"
            >
              <StatusIcon className={`w-3.5 h-3.5 shrink-0 mt-px ${status.spinning ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>
                {status.text}
                {videoId && <span className="ml-1 font-mono opacity-70">({videoId})</span>}
              </span>
            </div>
          </div>

          <div>
            <label htmlFor={`yt-title-${fieldKey}`} className="block text-xs font-semibold text-[#22355E] mb-1">
              Video title
            </label>
            <input
              id={`yt-title-${fieldKey}`}
              type="text"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleTouched(true);
              }}
              maxLength={200}
              placeholder="Filled in from YouTube when left blank"
              className="w-full bg-white border border-[#D8D3C5] rounded-lg px-3 py-2 text-sm text-[#2B2B28] focus:outline-none focus:ring-2 focus:ring-[#22355E]/30 focus:border-[#22355E]"
            />
          </div>

          <div>
            <label htmlFor={`yt-desc-${fieldKey}`} className="block text-xs font-semibold text-[#22355E] mb-1">
              Description <span className="font-normal text-[#9B9690]">(optional)</span>
            </label>
            <textarea
              id={`yt-desc-${fieldKey}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={2}
              className="w-full bg-white border border-[#D8D3C5] rounded-lg px-3 py-2 text-sm text-[#2B2B28] focus:outline-none focus:ring-2 focus:ring-[#22355E]/30 focus:border-[#22355E] resize-y"
            />
          </div>

          <fieldset>
            <legend className="block text-xs font-semibold text-[#22355E] mb-1">Playback</legend>
            <div className="inline-flex rounded-lg border border-[#D8D3C5] bg-white p-0.5 text-xs font-semibold">
              {[
                ['embed', 'Play inside Nalanda'],
                ['external', 'Open on YouTube'],
              ].map(([value, label]) => (
                <label
                  key={value}
                  className={`px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                    playbackMode === value ? 'bg-[#22355E] text-white' : 'text-[#6E6A64] hover:text-[#22355E]'
                  }`}
                >
                  <input
                    type="radio"
                    name={`yt-mode-${fieldKey}`}
                    value={value}
                    checked={playbackMode === value}
                    onChange={() => setPlaybackMode(value)}
                    className="sr-only"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </div>

      {conflict && (
        <div role="alert" className="p-3 rounded-lg bg-[#C99A2E]/10 border border-[#C99A2E]/40 text-[#7A5B12] text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <span>
            {conflict.message} Nothing you typed has been saved.
          </span>
          <button
            type="button"
            onClick={() => onConflict?.(conflict.current)}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-[#22355E] hover:bg-[#16233F] text-white font-semibold"
          >
            Load the current version
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-[#C1352B]/10 border border-[#C1352B]/30 text-[#9A2820] text-xs">
          {error}
        </div>
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-[#D8D3C5]">
        <div className="text-[11px] text-[#9B9690] min-h-[1rem]">
          {saved && (
            <>
              {isPublished ? 'Published' : 'Draft'}
              {saved.updatedAt && ` · updated ${formatWhen(saved.updatedAt)}`}
              {saved.updatedBy?.name && ` by ${saved.updatedBy.name} (${saved.updatedBy.portal})`}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(saved || lesson.legacyVideoUrl) &&
            (confirmRemove ? (
              <span className="inline-flex items-center gap-1.5 text-xs">
                <span className="text-[#9A2820] font-semibold">Remove from this {isModule ? 'module' : 'lesson'}?</span>
                <button
                  type="button"
                  onClick={remove}
                  disabled={anyBusy}
                  className="px-2.5 py-1.5 rounded-lg bg-[#C1352B] hover:bg-[#A42C23] text-white font-semibold disabled:opacity-60"
                >
                  {busy === 'remove' ? 'Removing…' : 'Yes, remove'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemove(false)}
                  disabled={anyBusy}
                  className="px-2.5 py-1.5 rounded-lg bg-[#EDEAE0] hover:bg-[#DFDACB] text-[#22355E] font-semibold"
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                disabled={anyBusy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-[#C1352B] hover:bg-[#C1352B]/10 disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> Remove video
              </button>
            ))}

          {isPublished && (
            <button
              type="button"
              onClick={() => submit('unpublish')}
              disabled={anyBusy || !parsed.ok}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-[#EDEAE0] hover:bg-[#DFDACB] text-[#22355E] disabled:opacity-50"
            >
              <EyeOff className="w-3.5 h-3.5" /> {busy === 'unpublish' ? 'Unpublishing…' : 'Unpublish'}
            </button>
          )}

          {!isPublished && (
            <button
              type="button"
              onClick={() => submit('draft')}
              disabled={anyBusy || !parsed.ok || (!dirty && Boolean(saved))}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-[#EDEAE0] hover:bg-[#DFDACB] text-[#22355E] disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" /> {busy === 'draft' ? 'Saving…' : 'Save draft'}
            </button>
          )}

          <button
            type="button"
            onClick={() => submit('publish')}
            disabled={anyBusy || !canPublish || (isPublished && !dirty)}
            title={unavailable ? 'This video cannot be published' : undefined}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold bg-[#AB5236] hover:bg-[#94452C] text-white shadow-sm disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            {busy === 'publish' ? 'Publishing…' : isPublished ? 'Update published video' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}
