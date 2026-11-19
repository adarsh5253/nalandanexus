import { Student } from '../models/Student.js';
import { Teacher } from '../models/Teacher.js';
import { Course } from '../models/Course.js';
import { AuditLog } from '../models/AuditLog.js';
import { Settings } from '../models/Settings.js';
import { computeLeaderboard } from './leaderboard.service.js';
import { rangeBuckets, BUCKET_RANGES, timeAgo } from '../utils/time.js';
import { emitEvent } from '../sockets/index.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function trendFor(currentCount, newInWindow) {
  if (newInWindow === 0) return { trend: 'No change vs last month', isPositive: true };
  const priorCount = Math.max(currentCount - newInWindow, 0);
  const pct = priorCount === 0 ? 100 : Math.round((newInWindow / priorCount) * 1000) / 10;
  return { trend: `↑ ${newInWindow} new this month`, isPositive: true, pct };
}

async function computeKpi() {
  const now = new Date();
  const monthAgo = new Date(now.getTime() - THIRTY_DAYS_MS);

  const [
    totalStudents,
    activeLearners,
    newStudents,
    totalTeachers,
    newTeachers,
    totalCourses,
    newCourses,
  ] = await Promise.all([
    Student.countDocuments({ deletedAt: null }),
    Student.countDocuments({ deletedAt: null, status: 'ACTIVE' }),
    Student.countDocuments({ deletedAt: null, createdAt: { $gte: monthAgo } }),
    Teacher.countDocuments({ deletedAt: null }),
    Teacher.countDocuments({ deletedAt: null, createdAt: { $gte: monthAgo } }),
    Course.countDocuments({ deletedAt: null, status: 'APPROVED' }),
    Course.countDocuments({ deletedAt: null, status: 'APPROVED', createdAt: { $gte: monthAgo } }),
  ]);

  return {
    students: { value: totalStudents, ...trendFor(totalStudents, newStudents) },
    teachers: { value: totalTeachers, ...trendFor(totalTeachers, newTeachers) },
    courses: { value: totalCourses, ...trendFor(totalCourses, newCourses) },
    activeLearners: { value: activeLearners, ...trendFor(activeLearners, newStudents) },
  };
}

async function computeTeacherStatus() {
  const rows = await Teacher.aggregate([
    { $match: { deletedAt: null } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const map = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  return {
    active: map.ACTIVE || 0,
    invited: map.INVITED || 0,
    suspended: map.SUSPENDED || 0,
    inactive: map.INACTIVE || 0,
  };
}

async function computeNeedsAttention() {
  const settings = await Settings.findById('platform_settings').lean();
  const threshold = settings?.academic?.attendanceThresholdPercent ?? 75;

  const [pendingCourses, suspendedTeachers, pendingInvites, lowAttendance] = await Promise.all([
    Course.countDocuments({ deletedAt: null, status: 'PENDING_REVIEW' }),
    Teacher.countDocuments({ deletedAt: null, status: 'SUSPENDED' }),
    Teacher.countDocuments({ deletedAt: null, status: 'INVITED' }),
    Student.countDocuments({ deletedAt: null, status: 'ACTIVE', attendancePercent: { $lt: threshold } }),
  ]);

  const items = [];
  if (pendingCourses > 0) {
    items.push({
      id: 'courses-pending', severity: 'attention', title: 'Courses Awaiting Review', count: pendingCourses,
      description: `${pendingCourses} course${pendingCourses === 1 ? '' : 's'} submitted and waiting for governance approval.`,
      actionText: 'Review Courses', linkTo: '/courses',
    });
  }
  if (suspendedTeachers > 0) {
    items.push({
      id: 'teachers-suspended', severity: 'blocked', title: 'Suspended Faculty Accounts', count: suspendedTeachers,
      description: `${suspendedTeachers} faculty account${suspendedTeachers === 1 ? '' : 's'} currently suspended.`,
      actionText: 'Review Faculty', linkTo: '/teachers',
    });
  }
  if (pendingInvites > 0) {
    items.push({
      id: 'teachers-invited', severity: 'attention', title: 'Pending Faculty Invitations', count: pendingInvites,
      description: `${pendingInvites} invitation${pendingInvites === 1 ? '' : 's'} not yet activated.`,
      actionText: 'View Invitations', linkTo: '/teachers',
    });
  }
  if (lowAttendance > 0) {
    items.push({
      id: 'students-attendance', severity: 'attention', title: 'Low Attendance Students', count: lowAttendance,
      description: `${lowAttendance} student${lowAttendance === 1 ? '' : 's'} below the ${threshold}% attendance threshold.`,
      actionText: 'Review Students', linkTo: '/students',
    });
  }
  return items;
}

/**
 * Real signal used as the activity proxy: this backend's own audit trail
 * (every admin write is recorded there). There is no separate student
 * session-tracking system owned by admin/backend to source "active
 * sessions" from — see implementation report for the cross-service gap.
 *
 * ---------------------------------------------------------------------------
 * Why this is an aggregation and not a `find()`
 * ---------------------------------------------------------------------------
 * This used to load EVERY audit log row from the last 370 days into this
 * process - `AuditLog.find({ createdAt: { $gte: since } })` with no limit -
 * and then walk that array four times in JavaScript to fill the four series.
 * On every single admin overview load.
 *
 * The audit log gains a row on every administrative write, so that read has no
 * upper bound: the overview got progressively slower for the whole team as the
 * platform was used, which is precisely backwards. The counting is now done
 * inside MongoDB, which returns at most 18 rows (7 + 4 + 3 + 4 buckets)
 * however large the collection grows.
 *
 * The bucket boundaries still come from the same `rangeBuckets` definition the
 * JavaScript path uses, so the windows cannot drift apart, and a single `now`
 * is shared across all four series - previously each called `new Date()` for
 * itself, so the four charts were anchored milliseconds apart.
 */
async function computeLearningActivity() {
  const now = new Date();
  const bucketsByRange = Object.fromEntries(BUCKET_RANGES.map((r) => [r, rangeBuckets(r, now)]));

  // The earliest instant any series covers. Anything older cannot land in a
  // bucket, so it is excluded before the grouping rather than fetched and
  // discarded (which is what the old `370 days` window did).
  const since = new Date(
    Math.min(...Object.values(bucketsByRange).map((buckets) => buckets[0].start.getTime()))
  );

  /**
   * One `$facet` with a `$bucket` per range, so all four series are computed
   * in a single pass over the same indexed range scan.
   *
   * `default: 'out-of-range'` is required: without it `$bucket` errors on any
   * document that falls outside the boundaries, and a row sitting between two
   * series' windows legitimately does. That bucket is read and dropped below,
   * matching the JavaScript's `if (!bucket) continue`.
   */
  const facet = {};
  for (const [range, buckets] of Object.entries(bucketsByRange)) {
    facet[range] = [
      {
        $bucket: {
          groupBy: '$createdAt',
          // Contiguous windows: every bucket's start is the previous one's end.
          boundaries: [buckets[0].start, ...buckets.map((b) => b.end)],
          default: 'out-of-range',
          output: {
            activeSessions: { $sum: 1 },
            submissions: { $sum: { $cond: [{ $eq: ['$entityType', 'Enrollment'] }, 1, 0] } },
          },
        },
      },
    ];
  }

  const [facetResult] = await AuditLog.aggregate([{ $match: { createdAt: { $gte: since } } }, { $facet: facet }]);

  // `$bucket` omits empty buckets entirely; the chart needs every bucket
  // present with a real 0 so it draws a flat line instead of a gap.
  const activity = {};
  for (const [range, buckets] of Object.entries(bucketsByRange)) {
    const counts = new Map(
      (facetResult?.[range] || [])
        .filter((row) => row._id !== 'out-of-range')
        .map((row) => [new Date(row._id).getTime(), row])
    );
    activity[range] = buckets.map((b) => {
      const row = counts.get(b.start.getTime());
      return {
        name: b.name,
        activeSessions: row?.activeSessions || 0,
        submissions: row?.submissions || 0,
      };
    });
  }
  return activity;
}

async function computeRecentActivity() {
  const logs = await AuditLog.find({}).sort({ createdAt: -1 }).limit(8).lean();
  return logs.map((log) => ({
    id: String(log._id),
    actor: log.actorName || 'System',
    action: humanizeAction(log.action),
    target: log.entityType,
    timestamp: timeAgo(log.createdAt),
    result: log.result,
  }));
}

function humanizeAction(action) {
  return action.replace(/\./g, ' ').replace(/_/g, ' ');
}

export async function getOverview() {
  const [kpi, teacherStatus, needsAttention, learningActivityData, recentActivity, leaderboard] = await Promise.all([
    computeKpi(),
    computeTeacherStatus(),
    computeNeedsAttention(),
    computeLearningActivity(),
    computeRecentActivity(),
    computeLeaderboard(),
  ]);

  const snapshot = { kpi, teacherStatus, needsAttention, learningActivityData, recentActivity, leaderboard };
  emitEvent.analyticsUpdated(snapshot);
  return snapshot;
}

export default { getOverview };
