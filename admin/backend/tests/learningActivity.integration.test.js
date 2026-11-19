import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Covers services/dashboard.service.js#computeLearningActivity.
 *
 * That function used to load every audit-log row from the last 370 days into
 * the process and bucket them in JavaScript, four times over, on every admin
 * overview load - an unbounded read that grew with platform usage. The
 * counting now happens inside MongoDB via `$facet` + `$bucket`.
 *
 * The point of this test is equivalence: the aggregation's output is compared
 * directly against the original JavaScript bucketing (`bucketByRange`, still
 * exported and still the single source of the window definitions) over the
 * same rows and the same `now`. If the two ever disagree, the chart on the
 * admin overview is wrong and this fails.
 */

let mongod;
let AuditLog;
let getDashboardOverview;
let bucketByRange;
let rangeBuckets;
let BUCKET_RANGES;

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'activity_test_secret';
  process.env.CLIENT_URL = 'http://localhost:5175';

  const { connectDatabase } = await import('../src/config/db.js');
  await connectDatabase();
  ({ AuditLog } = await import('../src/models/AuditLog.js'));
  ({ getOverview: getDashboardOverview } = await import("../src/services/dashboard.service.js"));
  ({ bucketByRange, rangeBuckets, BUCKET_RANGES } = await import('../src/utils/time.js'));
});

after(async () => {
  const mongoose = (await import('mongoose')).default;
  await mongoose.connection.close();
  await mongod.stop();
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Writes a log row at an exact instant (`timestamps: false` keeps createdAt). */
async function seedLog(createdAt, entityType) {
  await AuditLog.create(
    [
      {
        actorName: 'Seeder',
        action: 'test.seeded',
        entityType,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    { timestamps: false }
  );
}

test('the aggregated learning activity matches the original JavaScript bucketing exactly', async () => {
  await AuditLog.deleteMany({});

  const now = new Date();
  // Spread rows across every window the four series cover, with a deliberate
  // mix of Enrollment (counted as a submission) and other entity types, plus
  // rows far enough back to land outside every bucket.
  const offsetsDays = [
    0.1, 0.9, 1.5, 2.2, 3.7, 5.1, 6.4, 6.9, // inside 7d
    8, 12, 19, 25, 27, // inside 30d only
    45, 70, 88, // inside 3m only
    120, 200, 300, 360, // inside 1y only
    400, 500, // outside every window
  ];
  for (const [i, d] of offsetsDays.entries()) {
    await seedLog(new Date(now.getTime() - d * DAY_MS), i % 3 === 0 ? 'Enrollment' : 'Course');
  }
  // Two rows at the same instant, to confirm counts accumulate rather than dedupe.
  await seedLog(new Date(now.getTime() - 2.2 * DAY_MS), 'Enrollment');
  await seedLog(new Date(now.getTime() - 2.2 * DAY_MS), 'Teacher');

  // The reference: the untouched JavaScript implementation over all the rows,
  // anchored at the same `now` the service will use.
  const allDocs = await AuditLog.find({}).select('createdAt entityType').lean();

  const overview = await getDashboardOverview();
  const actual = overview.learningActivityData;

  assert.ok(actual, 'the overview carries learningActivityData');

  for (const range of BUCKET_RANGES) {
    const expected = bucketByRange(allDocs, range, now);
    const got = actual[range];

    assert.ok(Array.isArray(got), `${range} is an array`);
    assert.equal(got.length, expected.length, `${range} has ${expected.length} buckets`);

    for (let i = 0; i < expected.length; i += 1) {
      assert.equal(got[i].name, expected[i].name, `${range}[${i}].name`);
      // The service and the reference each take their own `new Date()`,
      // milliseconds apart, so a row sitting exactly on a boundary could land
      // in a neighbouring bucket. Allowed to differ by at most one row.
      assert.ok(
        Math.abs(got[i].activeSessions - expected[i].activeSessions) <= 1,
        `${range}[${i}].activeSessions: got ${got[i].activeSessions}, expected ${expected[i].activeSessions}`
      );
      assert.ok(
        Math.abs(got[i].submissions - expected[i].submissions) <= 1,
        `${range}[${i}].submissions: got ${got[i].submissions}, expected ${expected[i].submissions}`
      );
    }

    // Totals must agree - a bucket-boundary wobble may move a row between
    // adjacent buckets but can never create or lose one.
    const sum = (rows, key) => rows.reduce((t, r) => t + r[key], 0);
    assert.equal(sum(got, 'activeSessions'), sum(expected, 'activeSessions'), `${range} total activeSessions`);
    assert.equal(sum(got, 'submissions'), sum(expected, 'submissions'), `${range} total submissions`);

    // Never a gap, never a NaN - the chart draws a real flat line at zero.
    for (const row of got) {
      assert.equal(typeof row.activeSessions, 'number');
      assert.equal(typeof row.submissions, 'number');
      assert.ok(Number.isFinite(row.activeSessions) && Number.isFinite(row.submissions));
      assert.ok(row.submissions <= row.activeSessions, 'submissions are a subset of all activity');
    }
  }
});

test('an empty audit log yields every bucket at zero rather than a gap', async () => {
  await AuditLog.deleteMany({});

  const overview = await getDashboardOverview();
  const activity = overview.learningActivityData;

  for (const range of BUCKET_RANGES) {
    const expectedLength = rangeBuckets(range).length;
    assert.equal(activity[range].length, expectedLength, `${range} still has all ${expectedLength} buckets`);
    for (const row of activity[range]) {
      assert.equal(row.activeSessions, 0);
      assert.equal(row.submissions, 0);
      assert.equal(typeof row.name, 'string');
      assert.ok(row.name.length > 0);
    }
  }
});

test('rows outside every window are excluded, not folded into the oldest bucket', async () => {
  await AuditLog.deleteMany({});

  const now = Date.now();
  // Well outside the 1y series (4 x 91 days = 364 days of coverage).
  await seedLog(new Date(now - 800 * DAY_MS), 'Enrollment');
  await seedLog(new Date(now - 900 * DAY_MS), 'Course');
  // One row that definitely is inside the 7d window.
  await seedLog(new Date(now - 0.5 * DAY_MS), 'Enrollment');

  const activity = (await getDashboardOverview()).learningActivityData;

  const total = (range) => activity[range].reduce((t, r) => t + r.activeSessions, 0);
  assert.equal(total('7d'), 1, 'only the recent row is counted in 7d');
  assert.equal(total('1y'), 1, 'the two ancient rows are not folded into the oldest quarter');
});
