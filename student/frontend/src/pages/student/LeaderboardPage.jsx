import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Trophy, Flame } from 'lucide-react';
import { useStudent } from '../../context/StudentContext';
import ErrorState from '../../components/common/ErrorState';
import { TableSkeleton } from '../../components/common/Skeletons';

export default function LeaderboardPage() {
  const { student, course, courses, getLeaderboard, leaderboardVersion, isLoadingDashboard } = useStudent();
  const [period, setPeriod] = useState('thisWeek'); // 'thisWeek' | 'thisMonth' | 'allTime'
  const [courseSlug, setCourseSlug] = useState(course?.id || '');
  const [leaderboard, setLeaderboard] = useState([]);
  // Starts false, not true. It used to start true while the effect below
  // returned early whenever there was no course slug yet - so a student with
  // no course sat on "Loading leaderboard…" permanently, with nothing in
  // flight to ever clear it. The flag is now only ever true while a request
  // really is running.
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!courseSlug && course?.id) setCourseSlug(course.id);
  }, [course, courseSlug]);

  const userPoints = student?.points ?? 0;
  const myEntry = leaderboard.find((e) => e.isCurrentUser);

  useEffect(() => {
    if (!courseSlug) return undefined;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getLeaderboard(period, courseSlug)
      .then((entries) => {
        if (!cancelled) setLeaderboard(entries);
      })
      // Without this, a failed request rejected into nothing: an unhandled
      // promise rejection in the console, and - because `.finally` still
      // cleared the flag - a screen that reported "No leaderboard activity
      // yet" when the truth was that the request had failed.
      .catch((err) => {
        if (cancelled || err?.code === 'CANCELLED') return;
        setError(err);
        setLeaderboard([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, courseSlug, getLeaderboard, leaderboardVersion, reloadKey]);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <div className="w-full min-h-screen bg-[#EDEAE0] p-4 sm:p-6 lg:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <Link
            to="/student/dashboard"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#22355E] hover:text-[#AB5236] transition-colors mb-1"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Dashboard</span>
          </Link>
          <h1 className="font-display font-bold text-xl sm:text-2xl text-[#22355E]">
            Nalanda Nexus Peer Leaderboard
          </h1>
          <p className="text-xs text-[#2B2B28]/70 mt-0.5">
            Consistency, task completion, and quiz accuracy earn points toward semester recognition.
          </p>
        </div>

        {courses.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="leaderboard-course" className="text-xs font-semibold text-[#2B2B28]/70">
              Course:
            </label>
            <select
              id="leaderboard-course"
              value={courseSlug}
              onChange={(e) => setCourseSlug(e.target.value)}
              className="text-xs font-semibold bg-[#FAF9F4] border border-[#DFDACB] rounded-lg px-2.5 py-1.5 text-[#22355E] focus:outline-none focus:ring-2 focus:ring-[#22355E]"
            >
              {courses.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Motivational Summary Banner */}
        <div className="p-5 rounded-2xl bg-[#FAF9F4] border border-[#DFDACB] shadow-xs flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-[#C99A2E]/15 text-[#C99A2E] flex items-center justify-center font-bold">
              <Trophy className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-heading font-bold text-sm text-[#22355E]">
                Your Current Score: <span className="font-data text-[#AB5236]">{userPoints} pts</span>
              </h3>
              <p className="text-xs text-[#2B2B28]/70">
                {myEntry ? `Ranked #${myEntry.rank} in this period.` : 'Complete a lesson, task, or quiz to appear on the leaderboard.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-[#EDEAE0] p-1 rounded-xl border border-[#DFDACB]">
            {['thisWeek', 'thisMonth', 'allTime'].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg capitalize transition-colors student-focus ${
                  period === p
                    ? 'bg-[#22355E] text-white font-bold'
                    : 'text-[#2B2B28]/70 hover:text-[#22355E]'
                }`}
              >
                {p === 'thisWeek' ? 'This Week' : p === 'thisMonth' ? 'This Month' : 'All Time'}
              </button>
            ))}
          </div>
        </div>

        {/* Full Ranking Table. Four distinct states, never conflated:
            loading, failed, no course to rank in, and genuinely empty. */}
        {error ? (
          <div className="bg-[#FAF9F4] border border-[#DFDACB] rounded-2xl py-6">
            <ErrorState title="Couldn't load the leaderboard" error={error} onRetry={retry} />
          </div>
        ) : isLoading ? (
          <TableSkeleton rows={8} title={false} />
        ) : !courseSlug ? (
          <div className="p-8 text-center text-xs text-[#2B2B28]/60 bg-[#FAF9F4] border border-[#DFDACB] rounded-2xl">
            {isLoadingDashboard
              ? 'Finding your course…'
              : 'Leaderboards are per course — enroll in a course to see where you stand.'}
          </div>
        ) : leaderboard.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#2B2B28]/60 bg-[#FAF9F4] border border-[#DFDACB] rounded-2xl">
            No leaderboard activity yet for this period.
          </div>
        ) : (
          <div className="rounded-2xl bg-[#FAF9F4] border border-[#DFDACB] shadow-xs overflow-hidden divide-y divide-[#DFDACB]/70">
            {leaderboard.map((entry) => (
              <div
                key={entry.rank}
                className={`flex items-center justify-between px-5 py-3.5 transition-colors ${
                  entry.isCurrentUser
                    ? 'bg-[#FAF5EA] border-l-4 border-l-[#AB5236] font-bold text-[#22355E]'
                    : 'hover:bg-white text-[#2B2B28]'
                }`}
              >
                <div className="flex items-center gap-4 min-w-0">
                  <span
                    className={`w-6 font-data text-center text-sm ${
                      entry.rank === 1
                        ? 'text-[#C99A2E] font-extrabold text-base'
                        : entry.rank === 2
                        ? 'text-slate-500 font-bold'
                        : entry.rank === 3
                        ? 'text-amber-700 font-bold'
                        : 'text-[#2B2B28]/60 font-semibold'
                    }`}
                  >
                    #{entry.rank}
                  </span>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-heading font-semibold text-xs sm:text-sm truncate">
                        {entry.name}
                      </span>
                      {entry.isCurrentUser && (
                        <span className="px-2 py-0.5 text-[9px] font-bold font-data rounded bg-[#AB5236] text-white uppercase tracking-wider">
                          YOU
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-[#2B2B28]/60 font-data flex items-center gap-1 mt-0.5">
                      <Flame className="w-3 h-3 text-[#AB5236]" />
                      <span>{entry.streak} days streak</span>
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 font-data font-bold text-sm sm:text-base text-[#22355E] shrink-0">
                  <span>{entry.points}</span>
                  <span className="text-xs text-[#2B2B28]/60 font-normal">pts</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
