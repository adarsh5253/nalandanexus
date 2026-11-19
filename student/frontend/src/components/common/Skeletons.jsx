import React from 'react';

/**
 * Shared skeleton primitives for the student portal.
 *
 * Every skeleton here reserves the same box the real content will occupy, so
 * swapping skeleton for data does not move anything on the page (the layout
 * shift a bare spinner causes when it is replaced by a full dashboard is what
 * these exist to avoid). `prefers-reduced-motion` turns the shimmer off via
 * the `.skeleton-pulse` rule in index.css while keeping the reserved space.
 */

export function Shimmer({ className = '' }) {
  return <div className={`skeleton-pulse rounded bg-[#E4E0D2] ${className}`} />;
}

/** One stat/metric tile. */
export function StatCardSkeleton() {
  return (
    <div className="p-5 rounded-2xl bg-[#FAF9F4] border border-[#DFDACB] space-y-3">
      <div className="flex items-center justify-between">
        <Shimmer className="h-3 w-24" />
        <Shimmer className="w-8 h-8 rounded-xl" />
      </div>
      <Shimmer className="h-7 w-20" />
      <Shimmer className="h-3 w-28" />
    </div>
  );
}

/** A course / content card in a grid. */
export function CourseCardSkeleton() {
  return (
    <div className="rounded-2xl bg-[#FAF9F4] border border-[#DFDACB] overflow-hidden">
      <Shimmer className="h-40 w-full rounded-none" />
      <div className="p-5 space-y-3">
        <Shimmer className="h-3 w-20" />
        <Shimmer className="h-5 w-3/4" />
        <Shimmer className="h-3 w-full" />
        <Shimmer className="h-3 w-5/6" />
        <div className="flex items-center justify-between pt-2">
          <Shimmer className="h-3 w-16" />
          <Shimmer className="h-8 w-24 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

export function CourseGridSkeleton({ count = 6 }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {Array.from({ length: count }).map((_, i) => (
        <CourseCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** The learner profile / identity panel. */
export function ProfileSkeleton() {
  return (
    <div className="p-5 sm:p-6 rounded-2xl bg-[#FAF9F4] border border-[#DFDACB] space-y-4">
      <div className="flex items-center gap-4">
        <Shimmer className="w-14 h-14 rounded-full" />
        <div className="space-y-2 flex-1">
          <Shimmer className="h-4 w-40" />
          <Shimmer className="h-3 w-28" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Shimmer className="h-14 rounded-xl" />
        <Shimmer className="h-14 rounded-xl" />
        <Shimmer className="h-14 rounded-xl" />
      </div>
    </div>
  );
}

/** A list/table of rows (tasks, quizzes, leaderboard, notes). */
export function TableSkeleton({ rows = 6, title = true }) {
  return (
    <div className="rounded-2xl bg-[#FAF9F4] border border-[#DFDACB] overflow-hidden">
      {title && (
        <div className="px-5 py-4 border-b border-[#DFDACB]">
          <Shimmer className="h-4 w-44" />
        </div>
      )}
      <div className="divide-y divide-[#DFDACB]/70">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="px-5 py-3.5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0 flex-1">
              <Shimmer className="w-6 h-4" />
              <div className="space-y-2 flex-1 min-w-0">
                <Shimmer className="h-3.5 w-1/3" />
                <Shimmer className="h-2.5 w-20" />
              </div>
            </div>
            <Shimmer className="h-4 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A chart panel — reserves the chart's exact height so nothing jumps. */
export function ChartSkeleton({ height = 'h-64' }) {
  return (
    <div className="p-5 sm:p-6 rounded-2xl bg-[#FAF9F4] border border-[#DFDACB] space-y-4">
      <div className="flex items-center justify-between">
        <Shimmer className="h-4 w-48" />
        <Shimmer className="h-7 w-28 rounded-lg" />
      </div>
      <Shimmer className={`${height} w-full rounded-xl`} />
    </div>
  );
}

/** Generic text block. */
export function ContentSkeleton({ lines = 4 }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: lines }).map((_, i) => (
        <Shimmer key={i} className={`h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

/** The whole student dashboard, in its real grid, while the first load runs. */
export function DashboardSkeleton() {
  return (
    <div className="w-full min-h-screen bg-[#EDEAE0]">
      <div className="px-4 sm:px-6 lg:px-8 py-4 border-b border-[#DFDACB] bg-[#FAF9F4]">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="space-y-2">
            <Shimmer className="h-5 w-56" />
            <Shimmer className="h-3 w-40" />
          </div>
          <Shimmer className="w-10 h-10 rounded-full" />
        </div>
      </div>
      <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCardSkeleton />
          <StatCardSkeleton />
          <StatCardSkeleton />
          <StatCardSkeleton />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <ChartSkeleton />
            <TableSkeleton rows={4} />
          </div>
          <div className="space-y-6">
            <ProfileSkeleton />
            <TableSkeleton rows={3} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default Shimmer;
