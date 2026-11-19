import React, { useEffect, useRef, useState } from 'react';
import { Play, ExternalLink, Loader2, ShieldAlert } from 'lucide-react';
import YouTubeThumbnail from './YouTubeThumbnail';
import {
  isValidYoutubeVideoId,
  youtubeEmbedUrl,
  youtubeWatchUrl,
  describeYoutubePlayerError,
  YOUTUBE_EMBED_ORIGIN,
} from '../../utils/youtube';

/**
 * A lesson's (or a module's) YouTube video, thumbnail first.
 *
 * Nothing from YouTube loads until the student presses Play: the page shows the
 * video's own thumbnail on a dark surface of fixed 16:9 size (so nothing shifts
 * when it arrives), and only then mounts the privacy-enhanced embed. A lesson
 * page with a video therefore costs one image, not a player.
 *
 * The iframe source is never taken from data. It is rebuilt here from the
 * video id, after the id passes the same 11-character check the server
 * applied - so whatever a lesson record holds, the only thing this can frame
 * is youtube-nocookie.com/embed/<id>.
 *
 * Two layers keep a student from facing a dead player. Before playing: a video
 * the server knows cannot be embedded, or one set to open on YouTube, shows
 * "Watch on YouTube" instead of Play. While playing: the embed reports its own
 * errors (the owner disabled embedding after it was saved, it was made private
 * or removed), and the frame is replaced by the same explanation and link.
 * Player messages are accepted only from this frame and only from YouTube's
 * embed origin, and only their numeric error code is read.
 */
export default function LessonVideoPlayer({ video, lessonTitle, showDescription = true }) {
  const [playing, setPlaying] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [thumbReady, setThumbReady] = useState(false);
  const [playerError, setPlayerError] = useState(null);
  const frameRef = useRef(null);

  // Listen to the embedded player for as long as it is mounted.
  useEffect(() => {
    if (!playing) return undefined;
    const onMessage = (event) => {
      if (event.origin !== YOUTUBE_EMBED_ORIGIN || event.source !== frameRef.current?.contentWindow) return;
      let data;
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.event === 'onError') {
        const code = Number(data.info);
        if (Number.isFinite(code)) setPlayerError(describeYoutubePlayerError(code));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [playing]);

  if (!video || !isValidYoutubeVideoId(video.videoId)) return null;

  const { videoId } = video;
  const title = video.title || lessonTitle || 'Lesson video';
  const watchUrl = youtubeWatchUrl(videoId);
  const blocked = video.embeddable === false;
  const external = blocked || video.playbackMode === 'external';
  const showFrame = playing && !external && !playerError;
  const notice = playerError?.message || (blocked ? describeYoutubePlayerError(150).message : null);

  let embedSrc = null;
  if (showFrame) {
    try {
      embedSrc = youtubeEmbedUrl(videoId, { autoplay: true, apiOrigin: window.location.origin });
    } catch {
      // An origin the player API will not accept (e.g. a file:// preview):
      // play without error reporting rather than not at all.
      embedSrc = youtubeEmbedUrl(videoId, { autoplay: true });
    }
  }

  const onFrameLoad = () => {
    setFrameLoaded(true);
    // Asks the player to start sending its events (the documented handshake of
    // YouTube's iframe API), addressed only to YouTube's embed origin.
    try {
      frameRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: videoId }), YOUTUBE_EMBED_ORIGIN);
    } catch {
      // Without events the player still works; it just cannot report failures.
    }
  };

  return (
    <div className="space-y-2">
      <div
        className="relative aspect-video w-full rounded-2xl overflow-hidden bg-[#0F1A30] shadow-lg border border-[#DFDACB]"
        data-testid="lesson-video-player"
      >
        {showFrame ? (
          <>
            {!frameLoaded && (
              <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                <Loader2 className="w-8 h-8 text-white/60 animate-spin" />
              </div>
            )}
            <iframe
              ref={frameRef}
              src={embedSrc}
              title={title}
              onLoad={onFrameLoad}
              className="absolute inset-0 w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            />
          </>
        ) : (
          <>
            {!thumbReady && <div className="absolute inset-0 bg-[#16233F] animate-pulse" aria-hidden="true" />}
            <YouTubeThumbnail
              videoId={videoId}
              alt=""
              className="absolute inset-0"
              imgClassName={external || playerError ? 'opacity-60' : ''}
              onStatus={() => setThumbReady(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-black/20 pointer-events-none" />

            {external || playerError ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center" role={playerError ? 'alert' : undefined}>
                {notice && (
                  <p className="max-w-sm text-xs sm:text-sm text-white/90 flex items-start gap-2 bg-black/40 rounded-xl px-3 py-2">
                    <ShieldAlert className="w-4 h-4 shrink-0 mt-px text-[#C99A2E]" aria-hidden="true" />
                    <span>
                      {notice}
                      {playerError?.reason !== 'unavailable' && ' You can still watch it on YouTube.'}
                    </span>
                  </p>
                )}
                {playerError?.reason !== 'unavailable' && (
                  <a
                    href={watchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-5 py-3 rounded-full bg-[#AB5236] hover:bg-[#92422a] text-white font-heading font-bold text-sm shadow-lg transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-white/60"
                  >
                    <Play className="w-4 h-4 fill-white" aria-hidden="true" />
                    Watch on YouTube
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                  </a>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPlaying(true)}
                className="absolute inset-0 flex items-center justify-center group focus:outline-none"
                aria-label={`Play video: ${title}`}
              >
                <span className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-[#AB5236]/95 text-white flex items-center justify-center shadow-2xl ring-4 ring-white/15 transition-transform duration-200 group-hover:scale-105 group-hover:bg-[#92422a] group-focus-visible:ring-white/70">
                  <Play className="w-7 h-7 sm:w-8 sm:h-8 fill-white ml-1" aria-hidden="true" />
                </span>
              </button>
            )}

            <div className="absolute inset-x-0 bottom-0 px-4 pb-3 pt-8 pointer-events-none">
              <p className="font-heading font-bold text-sm sm:text-base text-white drop-shadow line-clamp-2">{title}</p>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 px-1">
        <span className="text-[11px] font-data text-[#2B2B28]/55 truncate">{showDescription && video.description ? video.description : 'YouTube'}</span>
        <a
          href={watchUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-[#22355E] hover:text-[#AB5236] transition-colors"
        >
          Open on YouTube <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
