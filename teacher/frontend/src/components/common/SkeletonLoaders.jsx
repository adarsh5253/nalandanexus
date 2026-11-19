import React from 'react';

export function StatCardSkeleton() {
  return (
    <div className="p-5 rounded-2xl bg-[#FFFFFF] border border-[#DFDACB] animate-pulse space-y-3">
      <div className="flex items-center justify-between">
        <div className="h-4 w-24 bg-[#F7F5EE] rounded" />
        <div className="w-8 h-8 rounded-xl bg-[#F7F5EE]" />
      </div>
      <div className="h-8 w-20 bg-[#F7F5EE] rounded" />
      <div className="h-3 w-32 bg-[#F7F5EE] rounded" />
    </div>
  );
}

export const StatSkeleton = StatCardSkeleton;

export function AlertStripSkeleton() {
  return (
    <div className="p-5 rounded-2xl bg-[#FFFFFF] border border-[#DFDACB] animate-pulse space-y-3">
      <div className="flex items-center justify-between">
        <div className="h-5 w-44 bg-[#F7F5EE] rounded" />
        <div className="h-4 w-28 bg-[#F7F5EE] rounded" />
      </div>
      <div className="space-y-2">
        <div className="h-16 w-full bg-[#F7F5EE] rounded-xl border border-[#DFDACB]" />
        <div className="h-16 w-full bg-[#F7F5EE] rounded-xl border border-[#DFDACB]" />
      </div>
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <div className="p-6 rounded-2xl bg-[#FFFFFF] border border-[#DFDACB] animate-pulse space-y-4">
      <div className="flex items-center justify-between">
        <div className="h-5 w-48 bg-[#F7F5EE] rounded" />
        <div className="h-7 w-32 bg-[#F7F5EE] rounded-lg" />
      </div>
      <div className="h-64 w-full bg-[#F7F5EE] rounded-xl border border-[#DFDACB]" />
    </div>
  );
}

export function TableSkeleton() {
  return (
    <div className="p-6 rounded-2xl bg-[#FFFFFF] border border-[#DFDACB] animate-pulse space-y-4">
      <div className="h-5 w-48 bg-[#F7F5EE] rounded" />
      <div className="space-y-2">
        <div className="h-10 w-full bg-[#F7F5EE] rounded" />
        <div className="h-10 w-full bg-[#F7F5EE] rounded" />
        <div className="h-10 w-full bg-[#F7F5EE] rounded" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   Added so every shape the portal renders has a matching skeleton -
   a page that had no skeleton for its content fell back to a spinner
   (or to nothing), which is what produced the layout jump when the
   real content arrived.
   ------------------------------------------------------------------ */

/** One shimmering block. Uses `.skeleton-pulse` (see index.css) so
    prefers-reduced-motion stops the shimmer but keeps the reserved space. */
export function Shimmer({ className = '' }) {
  return <div className={`skeleton-pulse rounded bg-[#E4E0D2] ${className}`} />;
}

/** A teacher/class/student profile panel. */
export function ProfileSkeleton() {
  return (
    <div className="p-5 sm:p-6 rounded-2xl bg-[#FFFFFF] border border-[#DFDACB] space-y-4">
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

/** A card in a grid (a class, a course, a resource). */
export function CardSkeleton() {
  return (
    <div className="p-5 rounded-2xl bg-[#FFFFFF] border border-[#DFDACB] space-y-3">
      <div className="flex items-center justify-between">
        <Shimmer className="h-4 w-32" />
        <Shimmer className="w-8 h-8 rounded-xl" />
      </div>
      <Shimmer className="h-3 w-full" />
      <Shimmer className="h-3 w-4/5" />
      <div className="flex items-center justify-between pt-2">
        <Shimmer className="h-3 w-20" />
        <Shimmer className="h-8 w-24 rounded-xl" />
      </div>
    </div>
  );
}

export function CardGridSkeleton({ count = 6 }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
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

/** The whole faculty dashboard, in its real grid, while the first load runs. */
export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Shimmer className="h-6 w-64" />
        <Shimmer className="h-3 w-44" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
      <AlertStripSkeleton />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <ChartSkeleton />
          <TableSkeleton />
        </div>
        <div className="space-y-6">
          <ProfileSkeleton />
          <TableSkeleton />
        </div>
      </div>
    </div>
  );
}
