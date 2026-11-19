import { revalidatePublishedVideos } from '../services/lessonVideo.service.js';
import { logger } from '../utils/logger.js';

// Hourly, a small batch each time: a published video is re-checked about once a
// day, and YouTube is never asked about more than a handful at once.
const SWEEP_INTERVAL_MS = 60 * 60_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;

/**
 * Keeps each published video's availability current after it was saved -
 * owners disable embedding, make videos private or delete them. Only a
 * definite answer from YouTube changes anything, and nothing is ever
 * unpublished automatically; see services/lessonVideo.service.js
 * #revalidatePublishedVideos.
 */
export function startLessonVideoRecheck() {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    revalidatePublishedVideos()
      .then((outcome) => {
        if (outcome.checked) logger.info('[jobs] Lesson video re-check', outcome);
      })
      .catch((err) => logger.error('[jobs] Lesson video re-check failed:', err.message))
      .finally(() => {
        running = false;
      });
  };
  // The first pass waits a few minutes so a deploy's restart does not open
  // with a burst of requests to YouTube.
  const first = setTimeout(run, FIRST_RUN_DELAY_MS);
  first.unref?.();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export default startLessonVideoRecheck;
