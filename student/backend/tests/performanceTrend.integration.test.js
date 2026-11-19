import test from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp, registerAndLogin, bearer } from './helpers/testApp.js';

/**
 * Covers services/performance.service.js#getWeeklyPerformanceTrend.
 *
 * The trend used to be computed by loading every quiz attempt from every
 * student in the last seven days into the Node process and averaging them in
 * JavaScript - an unbounded read on the dashboard's critical path. It is now
 * three `$group` aggregations that return at most seven rows each.
 *
 * These tests pin the behaviour that rewrite had to preserve, because the
 * numbers it produces are visible on the dashboard chart:
 *   - the `quiz` series is THIS student's own mean, never the cohort's;
 *   - the `average` series falls back to the cohort mean only on a day where
 *     this student did nothing, which is the one place another student's work
 *     may legitimately influence what this student sees;
 *   - a day with no activity is 0, not null and not invented;
 *   - the window is exactly seven UTC days, oldest first, and an attempt
 *     older than that window is excluded.
 */

/** Writes attempts directly, which is the only way to place them on a chosen date. */
async function seedAttempt({ userId, quizId, scorePercentage, createdAt }) {
  const { QuizAttempt } = await import('../src/models/QuizAttempt.js');
  // `timestamps: true` would overwrite createdAt on a normal save, so the
  // date is set explicitly and timestamp handling turned off for this write.
  await QuizAttempt.create(
    [
      {
        userId,
        quizId,
        scorePercentage,
        correctCount: 1,
        totalCount: 1,
        pointsAwarded: 0,
        isFirstAttempt: true,
        attemptNumber: 1,
        startedAt: createdAt,
        expiresAt: new Date(createdAt.getTime() + 60_000),
        status: 'submitted',
        submittedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    { timestamps: false }
  );
}

function utcMidnightDaysAgo(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  // Midday, so the row sits unambiguously inside its own UTC day.
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

test('weekly performance trend: own scores, cohort fallback, and a bounded 7-day window', async (t) => {
  const { request, teardown } = await bootTestApp();
  t.after(teardown);

  const mine = await registerAndLogin(request, { name: 'Trend Owner', email: 'trend.owner@example.com' });
  const peer = await registerAndLogin(request, { name: 'Trend Peer', email: 'trend.peer@example.com' });

  const mongoose = (await import('mongoose')).default;
  const myId = mine.user._id || mine.user.id;
  const peerId = peer.user._id || peer.user.id;
  const quizId = new mongoose.Types.ObjectId();

  const twoDaysAgo = utcMidnightDaysAgo(2);
  const fourDaysAgo = utcMidnightDaysAgo(4);
  const wayOutsideWindow = utcMidnightDaysAgo(30);

  // Two of my own attempts on the same day -> the mean of the two, 70.
  await seedAttempt({ userId: myId, quizId, scorePercentage: 60, createdAt: twoDaysAgo });
  await seedAttempt({ userId: myId, quizId, scorePercentage: 80, createdAt: twoDaysAgo });
  // A peer on the SAME day. Must not move my own `quiz` number.
  await seedAttempt({ userId: peerId, quizId, scorePercentage: 10, createdAt: twoDaysAgo });

  // A day where only the peer was active: two attempts averaging 40.
  await seedAttempt({ userId: peerId, quizId, scorePercentage: 30, createdAt: fourDaysAgo });
  await seedAttempt({ userId: peerId, quizId, scorePercentage: 50, createdAt: fourDaysAgo });

  // Well outside the seven-day window: must be excluded entirely.
  await seedAttempt({ userId: myId, quizId, scorePercentage: 100, createdAt: wayOutsideWindow });

  const { getWeeklyPerformanceTrend } = await import('../src/services/performance.service.js');
  const trend = await getWeeklyPerformanceTrend(myId);

  assert.equal(trend.length, 7, 'exactly seven days');

  // Oldest first, contiguous, and ending today - the order the chart plots.
  const dates = trend.map((d) => d.date);
  assert.deepEqual([...dates].sort(), dates, 'days are returned oldest first');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  assert.equal(dates[6], today.toISOString().slice(0, 10), 'the last bucket is today (UTC)');

  const byDate = new Map(trend.map((d) => [d.date, d]));
  const myDay = byDate.get(twoDaysAgo.toISOString().slice(0, 10));
  const peerOnlyDay = byDate.get(fourDaysAgo.toISOString().slice(0, 10));

  // My own mean, not polluted by the peer's 10 on the same day: (60+80)/2.
  assert.equal(myDay.quiz, 70, "the quiz series is this student's own mean");
  assert.equal(myDay.task, 0, 'no task completed that day');
  assert.equal(myDay.average, 70, 'with own activity, average comes from own scores');

  // A day I did nothing: quiz 0, and `average` falls back to the cohort mean
  // of that day, (30+50)/2 = 40.
  assert.equal(peerOnlyDay.quiz, 0, 'no attempts of my own that day');
  assert.equal(peerOnlyDay.average, 40, 'average falls back to the cohort mean on an inactive day');

  // Every bucket is a real number, never null/undefined/NaN.
  for (const day of trend) {
    for (const key of ['quiz', 'task', 'average']) {
      assert.equal(typeof day[key], 'number', `${day.date}.${key} is a number`);
      assert.ok(Number.isFinite(day[key]), `${day.date}.${key} is finite`);
    }
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(day.day, /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
  }

  // The 100% from 30 days ago must not appear anywhere in the window.
  assert.ok(
    trend.every((d) => d.quiz !== 100),
    'an attempt older than the window is excluded'
  );
});

test('weekly performance trend: a student with no activity gets seven honest zeroes', async (t) => {
  const { request, teardown } = await bootTestApp();
  t.after(teardown);

  const fresh = await registerAndLogin(request, { name: 'Trend Fresh', email: 'trend.fresh@example.com' });
  const { getWeeklyPerformanceTrend } = await import('../src/services/performance.service.js');
  const trend = await getWeeklyPerformanceTrend(fresh.user._id || fresh.user.id);

  assert.equal(trend.length, 7);
  for (const day of trend) {
    assert.equal(day.quiz, 0);
    assert.equal(day.task, 0);
    assert.equal(day.average, 0, 'no cohort activity either, so nothing is invented');
  }
});

test('dashboard endpoint still returns the trend in the shape the chart reads', async (t) => {
  const { request, teardown } = await bootTestApp();
  t.after(teardown);

  const session = await registerAndLogin(request, { name: 'Dash Reader', email: 'dash.reader@example.com' });

  const res = await request.get('/api/student/dashboard').set(bearer(session.accessToken));
  assert.equal(res.status, 200);

  const trend = res.body.data.performanceTrend;
  assert.ok(Array.isArray(trend), 'performanceTrend is an array');
  assert.equal(trend.length, 7);
  // The exact keys Recharts is configured against in PerformanceChart.jsx.
  for (const day of trend) {
    assert.deepEqual(Object.keys(day).sort(), ['average', 'date', 'day', 'quiz', 'task']);
  }
});
