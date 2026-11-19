export function timeAgo(date) {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGE_CONFIG = {
  '7d': { count: 7, unit: 'day', labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] },
  '30d': { count: 4, unit: 'week', labelPrefix: 'Week' },
  '3m': { count: 3, unit: 'month', labelPrefix: 'Month' },
  '1y': { count: 4, unit: 'quarter', labelPrefix: 'Q' },
};

const DEFAULT_CONFIG = RANGE_CONFIG['7d'];

/**
 * The bucket boundaries and labels for a range, with no counting.
 *
 * Split out of `bucketByRange` so the same windows can be handed to MongoDB
 * as an aggregation's `$bucket` boundaries instead of being applied to
 * documents loaded into this process - see
 * services/dashboard.service.js#computeLearningActivity. One definition, used
 * by both paths, so the chart cannot drift between them.
 *
 * The windows are contiguous and non-overlapping (each bucket's `start` is the
 * previous bucket's `end`), which is what makes them valid `$bucket`
 * boundaries.
 */
export function rangeBuckets(range, now = new Date()) {
  const config = RANGE_CONFIG[range] || DEFAULT_CONFIG;
  const stepMs =
    config.unit === 'day' ? DAY_MS : config.unit === 'week' ? 7 * DAY_MS : config.unit === 'month' ? 30 * DAY_MS : 91 * DAY_MS;

  const buckets = [];
  for (let i = config.count - 1; i >= 0; i -= 1) {
    const end = new Date(now.getTime() - i * stepMs);
    const start = new Date(end.getTime() - stepMs);
    const label =
      config.unit === 'day'
        ? config.labels[end.getDay()]
        : config.unit === 'quarter'
        ? `${config.labelPrefix}${config.count - i}`
        : `${config.labelPrefix} ${config.count - i}`;
    buckets.push({ start, end, name: label });
  }
  return buckets;
}

/** Every range this module knows how to bucket. */
export const BUCKET_RANGES = Object.keys(RANGE_CONFIG);

/**
 * Builds N contiguous day/week/month/quarter buckets ending "now" and counts
 * how many `docs` (each needing a `.createdAt`/`.timestamp` Date field) fall
 * into each bucket. Buckets with zero matching documents are still returned
 * with a count of 0 — never omitted — so charts render a real flat line
 * instead of a gap, satisfying the "no undefined/NaN in charts" requirement.
 */
export function bucketByRange(docs, range, now = new Date()) {
  const buckets = rangeBuckets(range, now).map((b) => ({ ...b, activeSessions: 0, submissions: 0 }));

  for (const doc of docs) {
    const ts = new Date(doc.createdAt).getTime();
    const bucket = buckets.find((b) => ts >= b.start.getTime() && ts < b.end.getTime());
    if (!bucket) continue;
    if (doc.entityType === 'Enrollment') bucket.submissions += 1;
    bucket.activeSessions += 1;
  }

  return buckets.map(({ start, end, ...rest }) => rest);
}

export default { timeAgo, bucketByRange, rangeBuckets, BUCKET_RANGES };
