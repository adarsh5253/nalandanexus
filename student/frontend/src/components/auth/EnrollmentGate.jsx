import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useStudent } from '../../context/StudentContext';
import { DashboardSkeleton } from '../common/Skeletons';
import ErrorState from '../common/ErrorState';

/**
 * Route-level purchase gate: a logged-in student may not access the
 * dashboard, Parambh course, tasks, quizzes, or leaderboard until they
 * have an active (paid) course enrollment. This mirrors the backend's own
 * `requireEnrollment` middleware - the frontend gate is a UX convenience,
 * the backend is the actual security boundary (master doc section 74).
 *
 * The gate has to handle the *failed* load as well as the pending one. It
 * used to render a spinner whenever `isEnrolled` was still unknown and the
 * profile had not arrived - a condition that stays true forever once the
 * dashboard request fails, because nothing ever sets `isEnrolled` or
 * `profile` after an error. Since this gate sits above every learning route,
 * a single failed dashboard call left the student on a spinner with no
 * message and no way out, and the retry button that StudentDashboardPage
 * already had was never reached because the gate never rendered it. Loading
 * and failed are now two separate states, and the failed one offers the
 * retry.
 */
export default function EnrollmentGate() {
  const {
    isEnrolled,
    isLoadingDashboard,
    profileLoaded,
    requiresProfileCompletion,
    dashboardError,
    refreshData,
  } = useStudent();
  const location = useLocation();

  const stillUnknown = isEnrolled === null;

  // The load failed and we never learned the student's enrollment state. Say
  // so, and let them retry - never spin on this.
  if (stillUnknown && dashboardError && !isLoadingDashboard) {
    return (
      <div className="min-h-screen bg-[#EDEAE0] flex items-center justify-center">
        <ErrorState
          title="We couldn't load your learning space"
          error={dashboardError}
          onRetry={refreshData}
        />
      </div>
    );
  }

  // Still genuinely in flight: show the dashboard's own shape, not a spinner,
  // so the swap to real content does not move the page.
  if (stillUnknown && (isLoadingDashboard || !profileLoaded)) {
    return <DashboardSkeleton />;
  }

  if (isEnrolled === false) {
    return <Navigate to="/student/purchase" replace />;
  }

  // Holding a course is not enough: the student profile it requires comes
  // first. The backend refuses the content anyway (PROFILE_INCOMPLETE); this
  // sends the student straight to the form, and the form brings them back here.
  if (requiresProfileCompletion) {
    return <Navigate to="/student/complete-profile" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  return <Outlet />;
}
