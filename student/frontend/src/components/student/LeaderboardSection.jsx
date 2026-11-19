import React, { useState, useEffect, useCallback } from 'react';
import { Award, Trophy, ArrowUpRight, Flame, Sparkles } from 'lucide-react';
import { useStudent } from '../../context/StudentContext';
import ErrorState from '../common/ErrorState';
import { TableSkeleton } from '../common/Skeletons';

export default function LeaderboardSection() {
  const { student, course, courses, getLeaderboard, leaderboardVersion } = useStudent();

  const [activeTab, setActiveTab] = useState('personal'); // 'personal' | 'leaderboard'
  const [leaderboardPeriod, setLeaderboardPeriod] = useState('thisWeek'); // 'thisWeek' | 'thisMonth' | 'allTime'
  const [courseSlug, setCourseSlug] = useState(course?.id || '');
  const [currentLeaderboard, setCurrentLeaderboard] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const points = student?.points ?? 0;

  useEffect(() => {
    if (!courseSlug && course?.id) setCourseSlug(course.id);
  }, [course, courseSlug]);

  useEffect(() => {
    if (activeTab !== 'leaderboard' || !courseSlug) return undefined;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getLeaderboard(leaderboardPeriod, courseSlug)
      .then((entries) => {
        if (!cancelled) setCurrentLeaderboard(entries);
      })
      // Without this, a failed request rejected into nothing: an unhandled
      // promise rejection in the console, and a panel that claimed there was
      // "no activity this period" when the request had actually failed.
      .catch((err) => {
        if (cancelled || err?.code === 'CANCELLED') return;
        setError(err);
        setCurrentLeaderboard([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, leaderboardPeriod, courseSlug, getLeaderboard, leaderboardVersion, reloadKey]);

  const retryLeaderboard = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <section aria-labelledby="leaderboard-heading">
      <div className="bg-[#FAF9F4] border border-[#DFDACB] rounded-2xl p-5 sm:p-6 shadow-xs">
        {/* Header with Navigation Tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-[#C99A2E]" />
            <h2
              id="leaderboard-heading"
              className="font-display font-bold text-sm sm:text-base text-[#22355E] tracking-tight"
            >
              Your progress & standings
            </h2>
          </div>

          {/* Main Segmented Toggle */}
          <div className="flex items-center p-1 rounded-xl bg-[#EDEAE0] border border-[#DFDACB] w-fit">
            <button
              type="button"
              onClick={() => setActiveTab('personal')}
              className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all student-focus ${
                activeTab === 'personal'
                  ? 'bg-white text-[#22355E] font-bold shadow-xs'
                  : 'text-[#2B2B28]/70 hover:text-[#22355E]'
              }`}
            >
              You vs. last week
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('leaderboard')}
              className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all student-focus ${
                activeTab === 'leaderboard'
                  ? 'bg-white text-[#22355E] font-bold shadow-xs'
                  : 'text-[#2B2B28]/70 hover:text-[#22355E]'
              }`}
            >
              Leaderboard
            </button>
          </div>
        </div>

        {/* Tab 1: Default 'You vs. last week' View */}
        {activeTab === 'personal' && (
          <div className="p-5 sm:p-6 rounded-xl bg-white border border-[#DFDACB] shadow-2xs space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
              {/* Metric Card 1: Points Total */}
              <div className="p-4 rounded-xl bg-[#FAF9F4] border border-[#DFDACB]">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[#5C7A5E]">
                  <ArrowUpRight className="w-4 h-4" />
                  <span>Keep learning to climb</span>
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="font-data font-bold text-2xl sm:text-3xl text-[#22355E] tracking-tight">
                    {points}
                  </span>
                  <span className="font-heading font-semibold text-xs text-[#2B2B28]/70 uppercase tracking-wider">
                    pts total
                  </span>
                </div>
              </div>

              {/* Metric Card 2: Streak Consistency */}
              <div className="p-4 rounded-xl bg-[#FAF9F4] border border-[#DFDACB]">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[#C99A2E]">
                  <Flame className="w-4 h-4 text-[#AB5236]" />
                  <span>Current Streak</span>
                </div>
                <p className="mt-2 font-data font-bold text-lg sm:text-xl text-[#22355E]">
                  {student?.streak?.current ?? 0} day{(student?.streak?.current ?? 0) === 1 ? '' : 's'}
                </p>
              </div>
            </div>

            {/* Motivational statement */}
            <div className="p-3.5 rounded-xl bg-[#FAF5EA] border border-[#DFDACB]/80 text-xs sm:text-sm text-[#2B2B28]/85 leading-relaxed flex items-start gap-2.5">
              <Sparkles className="w-4 h-4 text-[#C99A2E] shrink-0 mt-0.5" />
              <p>
                Keep completing your quizzes and tasks. Your consistency is moving you forward.
              </p>
            </div>
          </div>
        )}

        {/* Tab 2: Secondary 'Leaderboard' View */}
        {activeTab === 'leaderboard' && (
          <div className="space-y-3">
            {courses.length > 1 && (
              <select
                value={courseSlug}
                onChange={(e) => setCourseSlug(e.target.value)}
                className="text-[11px] font-semibold bg-white border border-[#DFDACB] rounded-md px-2 py-1 text-[#22355E] focus:outline-none focus:ring-2 focus:ring-[#22355E]"
              >
                {courses.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.title}
                  </option>
                ))}
              </select>
            )}
            {/* Period sub-filters */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setLeaderboardPeriod('thisWeek')}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors student-focus ${
                  leaderboardPeriod === 'thisWeek'
                    ? 'bg-[#22355E] text-white font-bold'
                    : 'bg-white text-[#2B2B28]/70 border border-[#DFDACB] hover:bg-[#EDEAE0]'
                }`}
              >
                This Week
              </button>
              <button
                type="button"
                onClick={() => setLeaderboardPeriod('thisMonth')}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors student-focus ${
                  leaderboardPeriod === 'thisMonth'
                    ? 'bg-[#22355E] text-white font-bold'
                    : 'bg-white text-[#2B2B28]/70 border border-[#DFDACB] hover:bg-[#EDEAE0]'
                }`}
              >
                This Month
              </button>
              <button
                type="button"
                onClick={() => setLeaderboardPeriod('allTime')}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors student-focus ${
                  leaderboardPeriod === 'allTime'
                    ? 'bg-[#22355E] text-white font-bold'
                    : 'bg-white text-[#2B2B28]/70 border border-[#DFDACB] hover:bg-[#EDEAE0]'
                }`}
              >
                All Time
              </button>
            </div>

            {/* Ranking List. Loading, failed and empty are three different
                answers and are shown as three different things. */}
            {error ? (
              <ErrorState compact error={error} onRetry={retryLeaderboard} />
            ) : isLoading ? (
              <TableSkeleton rows={5} title={false} />
            ) : !courseSlug ? (
              <div className="p-6 text-center text-xs text-[#2B2B28]/60">
                Leaderboards are per course — enroll in a course to see where you stand.
              </div>
            ) : currentLeaderboard.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#2B2B28]/60">No leaderboard activity yet this period.</div>
            ) : (
              <div className="rounded-xl bg-white border border-[#DFDACB] divide-y divide-[#DFDACB]/60 overflow-hidden">
                {currentLeaderboard.map((entry) => (
                  <div
                    key={entry.rank}
                    className={`flex items-center justify-between px-4 py-2.5 text-xs transition-colors ${
                      entry.isCurrentUser
                        ? 'bg-[#FAF5EA] font-bold text-[#22355E] border-l-4 border-l-[#AB5236]'
                        : 'text-[#2B2B28] hover:bg-[#FAF9F4]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`w-5 font-data text-center ${
                          entry.rank <= 3
                            ? 'text-[#C99A2E] font-extrabold'
                            : 'text-[#2B2B28]/60 font-semibold'
                        }`}
                      >
                        {entry.rank}
                      </span>
                      <span className="font-medium truncate">{entry.name}</span>
                      {entry.isCurrentUser && (
                        <span className="px-1.5 py-0.5 text-[9px] font-bold font-data rounded bg-[#AB5236] text-white uppercase tracking-wider">
                          YOU
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 font-data font-semibold shrink-0">
                      <span className="text-[#22355E]">{entry.points}</span>
                      <span className="text-[10px] text-[#2B2B28]/60 font-normal">pts</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
