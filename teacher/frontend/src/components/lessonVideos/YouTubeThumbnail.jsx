import React, { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { isValidYoutubeVideoId, youtubeThumbnailUrls, YOUTUBE_PLACEHOLDER_MAX_WIDTH } from '../../utils/youtube';

/**
 * A YouTube thumbnail that never shows as a broken image.
 *
 * Tries maxresdefault, falls back to hqdefault, then to a quiet placeholder.
 * YouTube answers a size it does not have with a 120x90 grey image rather than
 * an error, so a load that small is treated as a miss too. If even hqdefault
 * is missing, YouTube has no public video with this id - `onStatus('missing')`
 * lets an editor say so.
 *
 * Shared verbatim by the Admin, Teacher and Student portals.
 */
export default function YouTubeThumbnail({ videoId, alt = '', className = '', imgClassName = '', onStatus }) {
  const [stage, setStage] = useState('maxres');

  useEffect(() => {
    setStage('maxres');
  }, [videoId]);

  const valid = isValidYoutubeVideoId(videoId);

  useEffect(() => {
    if (!valid) onStatus?.('missing');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid]);

  if (!valid || stage === 'failed') {
    return (
      <div
        className={`flex items-center justify-center bg-gradient-to-br from-[#22355E] to-[#16233F] text-white/40 ${className}`}
        data-testid="yt-thumb-fallback"
        role="img"
        aria-label={alt || 'Video thumbnail unavailable'}
      >
        <ImageOff className="w-6 h-6" aria-hidden="true" />
      </div>
    );
  }

  const urls = youtubeThumbnailUrls(videoId);
  const src = stage === 'maxres' ? urls.maxres : urls.hq;

  const miss = () => {
    if (stage === 'maxres') {
      setStage('hq');
    } else {
      setStage('failed');
      onStatus?.('missing');
    }
  };

  return (
    <div className={`overflow-hidden bg-[#16233F] ${className}`}>
      <img
        key={src}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={miss}
        onLoad={(e) => {
          if (e.currentTarget.naturalWidth && e.currentTarget.naturalWidth <= YOUTUBE_PLACEHOLDER_MAX_WIDTH) miss();
          else onStatus?.('ok');
        }}
        className={`w-full h-full object-cover ${imgClassName}`}
      />
    </div>
  );
}
