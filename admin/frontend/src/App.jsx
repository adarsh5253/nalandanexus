import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AdminAuthProvider } from './context/AdminAuthContext';
import AdminProtectedRoute from './components/AdminProtectedRoute';
import ErrorBoundary from './components/common/ErrorBoundary';
import OfflineBanner from './components/common/OfflineBanner';
import { Analytics } from "@vercel/analytics/react"

/**
 * Every route is lazy-loaded.
 *
 * All nineteen pages used to be statically imported here, producing a single
 * ~930KB entry chunk: Recharts and every console page had to be downloaded,
 * parsed and executed before the login form could paint - for an administrator
 * who then opened two of those pages. Splitting per route means the first
 * paint only pays for the shell plus the page actually being opened.
 *
 * The layout is lazy too: it is only reachable behind the auth gate, so it
 * does not belong in the chunk the login screen needs.
 */
const AdminLayout = lazy(() => import('./components/layout/AdminLayout'));
const AdminLoginPage = lazy(() => import('./pages/AdminLoginPage'));
const TeacherActivationPage = lazy(() => import('./pages/TeacherActivationPage'));
const AdminOverviewPage = lazy(() => import('./pages/AdminOverviewPage'));
const TeachersPage = lazy(() => import('./pages/TeachersPage'));
const StudentsPage = lazy(() => import('./pages/StudentsPage'));
const CourseGovernancePage = lazy(() => import('./pages/CourseGovernancePage'));
const BatchesPage = lazy(() => import('./pages/BatchesPage'));
const CouponsPage = lazy(() => import('./pages/CouponsPage'));
const CourseSubjectsPage = lazy(() => import('./pages/CourseSubjectsPage'));
const LessonVideosPage = lazy(() => import('./pages/LessonVideosPage'));
const ProgressionPage = lazy(() => import('./pages/ProgressionPage'));
const StageEligibilityPage = lazy(() => import('./pages/StageEligibilityPage'));
const StudentEligibilityPage = lazy(() => import('./pages/StudentEligibilityPage'));
const ResourcesPage = lazy(() => import('./pages/ResourcesPage'));
const AcademicsPage = lazy(() => import('./pages/AcademicsPage'));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));
const AnnouncementsPage = lazy(() => import('./pages/AnnouncementsPage'));
const PaymentsPage = lazy(() => import('./pages/PaymentsPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const SystemLogsPage = lazy(() => import('./pages/SystemLogsPage'));
const AdminSettingsPage = lazy(() => import('./pages/AdminSettingsPage'));

/**
 * Shown while a route chunk downloads.
 *
 * Deliberately not a full-viewport spinner: the previous page stays mounted
 * underneath until the new chunk resolves, so blanking the viewport would
 * flash the screen on every navigation and shift the layout again when the
 * real page arrived. A fixed 2px bar cannot move anything.
 */
function RouteLoadingFallback() {
  return (
    <>
      <div className="route-progress" role="progressbar" aria-label="Loading page" aria-busy="true" />
      <div className="min-h-screen bg-[#EDEAE0]" aria-hidden="true" />
    </>
  );
}

/**
 * A chunk that fails to download - a release that rotated the asset hashes
 * while this tab was open, or a dropped connection mid-navigation - throws out
 * of the lazy import. Reloading is the one thing that actually fixes it.
 */
function RouteErrorFallback({ error, reset }) {
  const isChunkError = /dynamically imported module|Importing a module script failed|Loading chunk/i.test(
    String(error?.message || '')
  );

  return (
    <div className="min-h-screen bg-[#EDEAE0] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <h2 className="font-heading font-bold text-lg text-[#22355E]">
          {isChunkError ? 'This page could not be downloaded' : 'This page failed to load'}
        </h2>
        <p className="text-sm text-[#2B2B28]/80 leading-relaxed">
          {isChunkError
            ? 'Part of the console is missing or out of date, usually because a new version was released while this tab was open. Reloading will pick it up.'
            : 'Something went wrong rendering this page. Your session is intact.'}
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 rounded-xl bg-[#22355E] text-white text-xs font-bold hover:bg-[#1a2a4a] transition-colors"
          >
            Reload page
          </button>
          <button
            type="button"
            onClick={reset}
            className="px-5 py-2.5 rounded-xl border border-[#DFDACB] text-[#2B2B28] text-xs font-semibold hover:bg-[#F7F5EE] transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

/** Clears the route boundary error state when the user navigates elsewhere. */
function RouteBoundary({ children }) {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname} fallback={RouteErrorFallback}>
      <Suspense fallback={<RouteLoadingFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <ErrorBoundary
      title="The Admin console could not start"
      description="Something went wrong before the console finished loading. Reloading usually clears it."
    >
      <AdminAuthProvider>
        <BrowserRouter>
          <OfflineBanner />
          <RouteBoundary>
            <Routes>
              {/* Public Authentication & Setup Routes */}
              <Route path="/login" element={<AdminLoginPage />} />
              <Route path="/activate" element={<TeacherActivationPage />} />

              {/* Protected Master Console Routes */}
              <Route
                path="/"
                element={
                  <AdminProtectedRoute>
                    <AdminLayout />
                  </AdminProtectedRoute>
                }
              >
                <Route index element={<AdminOverviewPage />} />
                <Route path="teachers" element={<TeachersPage />} />
                <Route path="students" element={<StudentsPage />} />
                <Route path="courses" element={<CourseGovernancePage />} />
                <Route path="batches" element={<BatchesPage />} />
                <Route path="coupons" element={<CouponsPage />} />
                <Route path="course-subjects" element={<CourseSubjectsPage />} />
                <Route path="lesson-videos" element={<LessonVideosPage />} />
                <Route path="progression" element={<ProgressionPage />} />
                <Route path="stage-eligibility" element={<StageEligibilityPage />} />
                <Route path="student-eligibility" element={<StudentEligibilityPage />} />
                <Route path="resources" element={<ResourcesPage />} />
                <Route path="academics" element={<AcademicsPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="announcements" element={<AnnouncementsPage />} />
                <Route path="payments" element={<PaymentsPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="logs" element={<SystemLogsPage />} />
                <Route path="settings" element={<AdminSettingsPage />} />
              </Route>

              {/* Fallback */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </RouteBoundary>
        </BrowserRouter>
      </AdminAuthProvider>
    </ErrorBoundary>
  );
}
