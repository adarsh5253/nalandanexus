import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { TeacherAuthProvider } from './context/TeacherAuthContext';
import TeacherThemeProvider from './theme/ThemeProvider';
import TeacherProtectedRoute from './components/TeacherProtectedRoute';
import ErrorBoundary from './components/common/ErrorBoundary';
import OfflineBanner from './components/common/OfflineBanner';
import { Analytics } from "@vercel/analytics/react"

/**
 * Every route is lazy-loaded.
 *
 * All twenty pages used to be statically imported here, which produced a
 * single ~930KB entry chunk: MUI, Recharts, framer-motion and every page in
 * the portal had to be downloaded, parsed and executed before the login form
 * could paint - for a teacher who then visited two of those pages. Splitting
 * per route means the first paint only pays for the shell plus the one page
 * being opened, and the rest arrives on demand.
 *
 * The layout is lazy too: it is only ever reached behind the auth gate, so it
 * does not belong in the chunk the login screen needs.
 */
const TeacherLayout = lazy(() => import('./components/TeacherLayout'));
const TeacherLoginPage = lazy(() => import('./pages/TeacherLoginPage'));
const ForcedPasswordResetPage = lazy(() => import('./pages/ForcedPasswordResetPage'));
const SetupPasswordPage = lazy(() => import('./pages/SetupPasswordPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ClassesPage = lazy(() => import('./pages/ClassesPage'));
const CoursesPage = lazy(() => import('./pages/CoursesPage'));
const LessonVideosPage = lazy(() => import('./pages/LessonVideosPage'));
const GradingPage = lazy(() => import('./pages/GradingPage'));
const StudentsPage = lazy(() => import('./pages/StudentsPage'));
const StudentProgressPage = lazy(() => import('./pages/StudentProgressPage'));
const AttendancePage = lazy(() => import('./pages/AttendancePage'));
const ExamsPage = lazy(() => import('./pages/ExamsPage'));
const GradesPage = lazy(() => import('./pages/GradesPage'));
const MessagesPage = lazy(() => import('./pages/MessagesPage'));
const ResourcesPage = lazy(() => import('./pages/ResourcesPage'));
const CalendarPage = lazy(() => import('./pages/CalendarPage'));
const AnnouncementsPage = lazy(() => import('./pages/AnnouncementsPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const LiveSchedulePage = lazy(() => import('./pages/LiveSchedulePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

/**
 * Shown while a route's chunk downloads.
 *
 * Deliberately not a full-viewport spinner: the previous page stays mounted
 * underneath until the new chunk resolves, so blanking the viewport would
 * flash the screen on every navigation and then shift the layout again when
 * the real page arrived. A fixed 2px bar cannot move anything.
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
 * of the lazy import. Reloading is the one thing that actually fixes it, so
 * that is offered first.
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
            ? 'Part of the portal is missing or out of date, usually because a new version was released while this tab was open. Reloading will pick it up.'
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
      title="The Faculty portal could not start"
      description="Something went wrong before the portal finished loading. Reloading usually clears it."
    >
      <TeacherAuthProvider>
        <TeacherThemeProvider>
          <BrowserRouter>
            <OfflineBanner />
            <RouteBoundary>
              <Routes>
                {/* Public Authentication Route (100% untouched) */}
                <Route path="/login" element={<TeacherLoginPage />} />

                {/* Public: where the link in a new teacher's onboarding email lands. */}
                <Route path="/setup-password" element={<SetupPasswordPage />} />

                {/* Mandatory first-login reset for an admin-provisioned temp password */}
                <Route
                  path="/reset-password"
                  element={
                    <TeacherProtectedRoute skipPasswordCheck>
                      <ForcedPasswordResetPage />
                    </TeacherProtectedRoute>
                  }
                />

                {/* Protected Faculty Suite Routes */}
                <Route
                  path="/"
                  element={
                    <TeacherProtectedRoute>
                      <TeacherLayout />
                    </TeacherProtectedRoute>
                  }
                >
                  <Route index element={<DashboardPage />} />
                  <Route path="classes" element={<ClassesPage />} />
                  <Route path="courses" element={<CoursesPage />} />
                  <Route path="lesson-videos" element={<LessonVideosPage />} />
                  <Route path="grading" element={<GradingPage />} />
                  <Route path="assignments" element={<GradingPage />} />
                  <Route path="students" element={<StudentsPage />} />
                  <Route path="student-progress" element={<StudentProgressPage />} />
                  <Route path="attendance" element={<AttendancePage />} />
                  <Route path="exams" element={<ExamsPage />} />
                  <Route path="grades" element={<GradesPage />} />
                  <Route path="messages" element={<MessagesPage />} />
                  <Route path="resources" element={<ResourcesPage />} />
                  <Route path="calendar" element={<CalendarPage />} />
                  <Route path="announcements" element={<AnnouncementsPage />} />
                  <Route path="reports" element={<ReportsPage />} />
                  <Route path="live" element={<LiveSchedulePage />} />
                  <Route path="settings" element={<SettingsPage />} />
                </Route>

                {/* Catch-all fallback */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </RouteBoundary>
          </BrowserRouter>
        </TeacherThemeProvider>
      </TeacherAuthProvider>
    </ErrorBoundary>
  );
}
