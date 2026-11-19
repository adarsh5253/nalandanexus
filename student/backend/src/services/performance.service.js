import mongoose from 'mongoose';
import { QuizAttempt } from '../models/QuizAttempt.js';
import { TaskSubmission } from '../models/TaskSubmission.js';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Real (non-fabricated) 7-day performance series backing the dashboard
 * chart: per-day average quiz score for this student, a per-day task
 * "completion quality" signal, and the cohort-wide average quiz score for
 * the same day (legitimate aggregate analytics - never another student's
 * individual data, per master doc section 27/28).
 *
 * Note: task submissions in this LMS are ungraded reflections/activities
 * (no rubric UI exists), so a completed task is scored as a flat 85% by
 * convention - the same convention already used for the profile's
 * lifetime `averageTaskScore` stat. Days with no activity show 0, which is
 * an honest "nothing happened that day" rather than an invented number.
 *
 * ---------------------------------------------------------------------------
 * Why this is three aggregations and not three `find()` calls
 * ---------------------------------------------------------------------------
 * The cohort series used to be computed by loading EVERY quiz attempt from
 * EVERY student in the last seven days into this process - `QuizAttempt.find({
 * createdAt: { $gte: rangeStart } })` with no user filter and no limit - and
 * then averaging them in JavaScript. On every single dashboard request.
 *
 * That has no upper bound: the documents transferred, and the memory to hold
 * them, grow with the size of the whole student body, so the dashboard got
 * slower for everyone as the platform grew, and one popular quiz week could
 * make it slow for everyone at once. There was no index serving the bare
 * `createdAt` predicate either, so it was also a full collection scan.
 *
 * Grouping by day inside MongoDB returns at most 7 documents per series
 * regardless of how many attempts exist, and the `{ createdAt: -1 }` index
 * added to the QuizAttempt schema covers the range scan. The numbers produced
 * are identical - the same UTC day bucketing (`%Y-%m-%d`), the same mean, and
 * the same `Math.round` applied in JS afterwards.
 */
export async function getWeeklyPerformanceTrend(userId) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d);
  }
  const rangeStart = days[0];
  const userObjectId = new mongoose.Types.ObjectId(String(userId));

  // `$dateToString` with an explicit UTC timezone reproduces exactly what
  // `createdAt.toISOString().slice(0, 10)` produced in JS.
  const dayBucket = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } };

  const [myByDay, cohortByDay, taskDays] = await Promise.all([
    QuizAttempt.aggregate([
      { $match: { userId: userObjectId, createdAt: { $gte: rangeStart } } },
      { $group: { _id: dayBucket, avgScore: { $avg: '$scorePercentage' } } },
    ]),
    QuizAttempt.aggregate([
      { $match: { createdAt: { $gte: rangeStart } } },
      { $group: { _id: dayBucket, avgScore: { $avg: '$scorePercentage' } } },
    ]),
    TaskSubmission.aggregate([
      { $match: { userId: userObjectId, isCompleted: true, completedAt: { $gte: rangeStart } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: 'UTC' } },
        },
      },
    ]),
  ]);

  const myMap = new Map(myByDay.map((r) => [r._id, r.avgScore]));
  const cohortMap = new Map(cohortByDay.map((r) => [r._id, r.avgScore]));
  const taskSet = new Set(taskDays.map((r) => r._id));

  return days.map((d) => {
    const key = dateKey(d);
    // No attempts that day -> 0, the same honest "nothing happened" the
    // JavaScript `average([])` returned.
    const quiz = myMap.has(key) ? Math.round(myMap.get(key)) : 0;
    const task = taskSet.has(key) ? 85 : 0;
    const classAverage = cohortMap.has(key) ? Math.round(cohortMap.get(key)) : 0;
    return {
      day: DAY_LABELS[d.getUTCDay()],
      date: key,
      quiz,
      task,
      average: quiz || task ? Math.round((quiz + task) / (quiz && task ? 2 : 1)) : classAverage,
    };
  });
}
