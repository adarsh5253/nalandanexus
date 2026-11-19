import React from 'react';

/**
 * Shared skeleton primitives for the admin console.
 *
 * Every skeleton reserves the same box the real content will occupy, so
 * swapping skeleton for data does not move anything on the page - the layout
 * shift a bare centred spinner causes when it is replaced by a full data table
 * is what these exist to avoid. `prefers-reduced-motion` turns the shimmer off
 * via the `.skeleton-pulse` rule in index.css while keeping the reserved space.
 */

export function Shimmer({ className = '' }) {
  return <div className={`skeleton-pulse rounded bg-[#E4E0D2] ${className}`} />;
}

export function StatCardSkeleton() {
  return (
    <div className="p-5 rounded-2xl bg-white border border-[#DFDACB] space-y-3">
      <div className="flex items-center justify-between">
        <Shimmer className="h-3 w-24" />
        <Shimmer className="w-8 h-8 rounded-xl" />
      </div>
      <Shimmer className="h-7 w-20" />
      <Shimmer className="h-3 w-28" />
    </div>
  );
}

export function StatsGridSkeleton({ count = 4 }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <StatCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** A data table — the console's most common shape. */
export function TableSkeleton({ rows = 8, columns = 5, title = true }) {
  return (
    <div className="rounded-2xl bg-white border border-[#DFDACB] overflow-hidden">
      {title && (
        <div className="px-5 py-4 border-b border-[#DFDACB] flex items-center justify-between">
          <Shimmer className="h-4 w-44" />
          <Shimmer className="h-8 w-28 rounded-lg" />
        </div>
      )}
      <div className="px-5 py-3 border-b border-[#DFDACB] bg-[#F7F5EE] flex items-center gap-4">
        {Array.from({ length: columns }).map((_, i) => (
          <Shimmer key={i} className="h-3 flex-1" />
        ))}
      </div>
      <div className="divide-y divide-[#DFDACB]/70">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="px-5 py-3.5 flex items-center gap-4">
            {Array.from({ length: columns }).map((_, c) => (
              <Shimmer key={c} className={`h-3.5 flex-1 ${c === 0 ? 'max-w-[30%]' : ''}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChartSkeleton({ height = 'h-72' }) {
  return (
    <div className="p-5 sm:p-6 rounded-2xl bg-white border border-[#DFDACB] space-y-4">
      <div className="flex items-center justify-between">
        <Shimmer className="h-4 w-48" />
        <Shimmer className="h-7 w-28 rounded-lg" />
      </div>
      <Shimmer className={`${height} w-full rounded-xl`} />
    </div>
  );
}

export function ContentSkeleton({ lines = 4 }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: lines }).map((_, i) => (
        <Shimmer key={i} className={`h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

/** The console overview, in its real grid, while the first load runs. */
export function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Shimmer className="h-6 w-64" />
        <Shimmer className="h-3 w-44" />
      </div>
      <StatsGridSkeleton />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <ChartSkeleton />
          <TableSkeleton rows={5} columns={4} />
        </div>
        <div className="space-y-6">
          <TableSkeleton rows={4} columns={2} />
          <TableSkeleton rows={3} columns={2} />
        </div>
      </div>
    </div>
  );
}

export default Shimmer;
