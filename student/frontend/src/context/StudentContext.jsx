import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from './AuthContext';
import { studentApiService } from '../services/studentApiService';
import { connectSocket, disconnectSocket } from '../services/socket';
import { timeAgo } from '../utils/timeAgo';
// The "journey stages" visual (Orientation -> Mindset -> Skills -> Projects
// -> Future Ready) is a cosmetic progress ribbon with no backing collection
// on the backend yet - kept as static illustrative data for now (documented
// as a deferred item; a real implementation would derive it from course
// module completion).
import { parambhJourneyStages } from '../data/studentMockData';

const StudentContext = createContext(null);

/**
 * Maps the backend's StudentProfile + dashboard payload into the same
 * view-model shape the original UI components already expect (see
 * src/types/student.js). This keeps ~20 existing dashboard components
 * unchanged while swapping the actual data source from localStorage mocks
 * to the real API (master doc section 42/60: adapt the mapper layer, don't
 * rewrite working components).
 */
function mapToStudentViewModel(user, profile, course) {
  if (!user || !profile) return null;
  const avgQuiz = profile.stats?.averageQuizScore || 0;
  const avgTask = profile.stats?.averageTaskScore || 0;

  return {
    id: user._id || user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar || null,
    course: course
      ? {
          id: course.id,
          name: course.name,
          subtitle: course.subtitle,
          pillar: course.pillar,
          progress: course.progress,
          currentModuleId: course.currentModuleId,
          currentModuleTitle: course.currentModuleTitle,
          currentLessonId: course.currentLessonId,
          currentLessonTitle: course.currentLessonTitle,
        }
      : null,
    performance: {
      averageQuiz: avgQuiz,
      averageTask: avgTask,
      overallScore: Math.round((avgQuiz + avgTask) / 2),
    },
    streak: {
      current: profile.streak?.current || 0,
      longest: profile.streak?.longest || 0,
      lastActiveDate: profile.streak?.lastActiveDate || null,
    },
    points: profile.xp || 0,
    level: profile.level || 1,
    topicsCompleted: profile.stats?.lessonsCompleted || 0,
    totalTopics: course?.totalLessons || 0,
    quizzesCompleted: profile.stats?.quizzesCompleted || 0,
    tasksCompleted: profile.stats?.tasksCompleted || 0,
    hasCompletedOnboarding: Boolean(profile.hasCompletedOnboarding),
    enrollmentNumber: profile.enrollmentNumber || null,
  };
}

function mapNotification(n) {
  return {
    id: n._id,
    title: n.title,
    description: n.description,
    time: timeAgo(n.createdAt),
    isRead: n.isRead,
    type: n.type,
    link: n.link,
  };
}

function mapNote(n) {
  return {
    id: n._id,
    title: n.title,
    category: n.category,
    content: n.content,
    updatedAt: new Date(n.updatedAt || n.createdAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
  };
}

export function StudentProvider({ children }) {
  const { user, isAuthenticated } = useAuth();
  // Which student is signed in, not merely whether someone is: switching accounts
  // without a reload must not leave the previous student's data on screen.
  const userId = user?._id || user?.id || null;

  const [profile, setProfile] = useState(null);
  const [course, setCourse] = useState(null);
  const [courses, setCourses] = useState([]); // every active enrollment, for the leaderboard's course selector
  const [tasks, setTasks] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [notes, setNotes] = useState([]);
  const [performanceHistory, setPerformanceHistory] = useState([]);
  const [isEnrolled, setIsEnrolled] = useState(null); // null = unknown/loading
  // From the dashboard: whether the student owes the profile a course requires.
  const [profileCompletion, setProfileCompletion] = useState(null);
  const profileReloadPending = useRef(false);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(false);
  const [dashboardError, setDashboardError] = useState(null);
  const [activeNotification, setActiveNotification] = useState(null);
  // Bumped whenever the backend pushes a `leaderboard.updated` socket event -
  // components read this in a useEffect dependency array to trigger a fresh
  // REST fetch (push-notifies, pull-fetches-authoritative-data pattern; the
  // socket payload itself is never rendered directly).
  const [leaderboardVersion, setLeaderboardVersion] = useState(0);

  // The in-flight load, so a second trigger (a socket event arriving while the
  // first load runs, a remount, a retry pressed twice) joins the request
  // already travelling instead of starting a duplicate one.
  const inFlightLoad = useRef(null);

  const loadDashboard = useCallback(async () => {
    if (!isAuthenticated) return undefined;
    if (inFlightLoad.current) return inFlightLoad.current;

    setIsLoadingDashboard(true);
    setDashboardError(null);

    const run = (async () => {
      try {
        const data = await studentApiService.getDashboard();
        setProfile(data.profile);
        setCourse(data.course);
        setIsEnrolled(Boolean(data.isEnrolledInAnyCourse));
        setProfileCompletion(data.profileCompletion || null);
        setNotifications((data.notifications || []).map(mapNotification));
        // Already shaped as { day, quiz, task, average } by the backend -
        // matches what PerformanceChart (Recharts) expects directly.
        setPerformanceHistory(data.performanceTrend || []);

        // The dashboard is on screen at this point. Everything below is
        // secondary data for other screens, and none of the three requests
        // depends on another's answer - they used to run one after the next,
        // so the slowest path to a usable dashboard was four serial round
        // trips (dashboard -> tasks -> courses -> notes) rather than two.
        //
        // `allSettled`, not `all`: a failed notes fetch must not discard the
        // tasks that did arrive, nor mark the whole dashboard as failed when
        // the dashboard itself loaded fine.
        const enrolled = Boolean(data.isEnrolledInAnyCourse);
        // Tasks are course content, which waits for a complete profile - asking
        // for them first would only be refused.
        const wantsTasks = enrolled && !data.profileCompletion?.requiresCompletion;

        const [tasksResult, coursesResult, notesResult] = await Promise.allSettled([
          wantsTasks ? studentApiService.getTasks() : Promise.resolve([]),
          enrolled ? studentApiService.getCourses() : Promise.resolve([]),
          studentApiService.getNotes(),
        ]);

        if (tasksResult.status === 'fulfilled') {
          setTasks(
            (tasksResult.value || []).map((t) => ({
              ...t,
              dueDateLabel: t.urgency === 'high' ? 'Due soon' : t.urgency === 'medium' ? 'This week' : 'Flexible',
              dueIsoDate: t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : null,
            }))
          );
        }
        if (coursesResult.status === 'fulfilled') {
          setCourses((coursesResult.value || []).map((c) => ({ slug: c.slug, title: c.title })));
        }
        if (notesResult.status === 'fulfilled') {
          setNotes((notesResult.value || []).map(mapNote));
        }

        // A secondary request that failed is reported, not hidden - but only
        // when the dashboard itself has nothing wrong with it, so the primary
        // error message is never overwritten by a lesser one.
        const firstSecondaryFailure = [tasksResult, coursesResult, notesResult].find(
          (r) => r.status === 'rejected' && r.reason?.code !== 'CANCELLED'
        );
        if (firstSecondaryFailure) {
          console.warn('[StudentContext] Secondary dashboard data failed to load:', firstSecondaryFailure.reason);
        }
      } catch (err) {
        if (err?.code === 'CANCELLED') return;
        // The ApiError itself, not just its text: the gate and the pages read
        // `.code`/`.status` off it to decide whether a retry is worth offering.
        setDashboardError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoadingDashboard(false);
        inFlightLoad.current = null;
      }
    })();

    inFlightLoad.current = run;
    return run;
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      // A different student may have just signed in over the previous one.
      setProfile(null);
      setCourse(null);
      setIsEnrolled(null);
      setProfileCompletion(null);
      loadDashboard();
    } else {
      setProfile(null);
      setCourse(null);
      setTasks([]);
      setNotifications([]);
      setIsEnrolled(null);
      setProfileCompletion(null);
    }
  }, [isAuthenticated, userId, loadDashboard]);

  // Returns the load, so a caller that needs fresh state before navigating can wait for it.
  const refreshData = useCallback(() => loadDashboard(), [loadDashboard]);

  // The API refused course content because the profile is incomplete - from
  // whichever page asked. The dashboard carries the authoritative answer, so it
  // is reloaded (once, however many requests were refused together) and the
  // route gate then sends the student to the profile form.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const handleProfileIncomplete = () => {
      if (profileReloadPending.current) return;
      profileReloadPending.current = true;
      loadDashboard().finally(() => {
        profileReloadPending.current = false;
      });
    };
    window.addEventListener('nalanda-profile-incomplete', handleProfileIncomplete);
    return () => window.removeEventListener('nalanda-profile-incomplete', handleProfileIncomplete);
  }, [isAuthenticated, loadDashboard]);

  // Real-time layer: one authenticated socket connection per session,
  // subscribed to the student's own private room server-side (master doc
  // section 12/16). Never a fake setInterval poll.
  useEffect(() => {
    if (!isAuthenticated) {
      disconnectSocket();
      return;
    }

    // A socket is authenticated as whoever held the session when it connected.
    // When the signed-in student changes, the old connection must not go on
    // delivering the previous student's notifications.
    disconnectSocket();
    const socket = connectSocket();
    if (!socket) return undefined;

    const handleNotificationCreated = (notification) => {
      setNotifications((prev) => [mapNotification(notification), ...prev]);
      setActiveNotification({
        title: notification.title,
        message: notification.description,
        type: 'success',
      });
      setTimeout(() => setActiveNotification(null), 4000);
    };

    const handleLeaderboardUpdated = () => {
      setLeaderboardVersion((v) => v + 1);
    };

    socket.on('notification.created', handleNotificationCreated);
    socket.on('leaderboard.updated', handleLeaderboardUpdated);

    return () => {
      socket.off('notification.created', handleNotificationCreated);
      socket.off('leaderboard.updated', handleLeaderboardUpdated);
    };
  }, [isAuthenticated, userId]);

  useEffect(() => disconnectSocket, []);

  // Rebuilt only when its inputs change. It used to be recomputed on every
  // render of the provider, which produced a new object identity each time -
  // so every component reading `student` re-rendered on any unrelated state
  // change here (a notification arriving, a note being saved), and any child
  // memoised on `student` was never actually spared any work.
  const student = useMemo(() => mapToStudentViewModel(user, profile, course), [user, profile, course]);

  const completeOnboarding = useCallback(async () => {
    const { profile: updated } = await studentApiService.completeOnboarding();
    setProfile(updated);
  }, []);

  const hasCompletedOnboarding = useCallback(() => Boolean(profile?.hasCompletedOnboarding), [profile]);

  const completeTask = useCallback(async (taskId, submissionText) => {
    const result = await studentApiService.submitTask(taskId, submissionText);
    if (result.profile) setProfile(result.profile);
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, isCompleted: true } : t)));

    setActiveNotification({
      title: `Task Completed! +${result.pointsAwarded} pts`,
      message: 'Your progress and streak have been recorded.',
      type: 'success',
    });
    setTimeout(() => setActiveNotification(null), 4000);

    return result;
  }, []);

  const submitQuiz = useCallback(async (quizId, answers) => {
    const result = await studentApiService.submitQuiz(quizId, answers);
    if (result.profile) setProfile(result.profile);

    setActiveNotification({
      title: `Quiz Submitted: ${result.scorePercentage}%`,
      message: result.pointsAwarded > 0 ? `You earned +${result.pointsAwarded} points!` : 'Retake recorded (points only count on your first attempt).',
      type: 'success',
    });
    setTimeout(() => setActiveNotification(null), 4500);

    return result;
  }, []);

  const markNotificationsRead = useCallback(async () => {
    await studentApiService.markAllNotificationsRead();
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
  }, []);

  const getLeaderboard = useCallback(
    async (period = 'thisWeek', courseSlug) => {
      const slug = courseSlug || course?.id;
      if (!slug) return [];
      const { entries, currentUserEntry } = await studentApiService.getLeaderboard(slug, period);
      const alreadyIncluded = currentUserEntry && entries.some((e) => e.userId === currentUserEntry.userId);
      return alreadyIncluded || !currentUserEntry ? entries : [...entries, currentUserEntry];
    },
    [course]
  );

  const saveNote = useCallback(async (note) => {
    const saved = await studentApiService.saveNote(note);
    setNotes((prev) => {
      const mapped = mapNote(saved);
      const exists = prev.some((n) => n.id === mapped.id);
      return exists ? prev.map((n) => (n.id === mapped.id ? mapped : n)) : [mapped, ...prev];
    });
  }, []);

  const deleteNote = useCallback(async (noteId) => {
    await studentApiService.deleteNote(noteId);
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
  }, []);

  const unreadNotificationsCount = useMemo(
    () => notifications.filter((n) => !n.isRead).length,
    [notifications]
  );
  const pendingTasks = useMemo(() => tasks.filter((t) => !t.isCompleted), [tasks]);

  /**
   * Memoised so the provider does not hand every consumer a brand-new object
   * on each render.
   *
   * A context value rebuilt inline is a new identity every render, which makes
   * `useContext` fire in every subscriber regardless of what actually changed -
   * about twenty dashboard components re-rendering because an unrelated note
   * was saved. The dependency list is the full set of values and callbacks
   * below; the callbacks are already `useCallback`-stable, so in practice this
   * only changes identity when real data does.
   */
  const value = useMemo(
    () => ({
      student,
      profileLoaded: Boolean(profile),
      tasks,
      pendingTasks,
      performanceHistory,
      notifications,
      unreadNotificationsCount,
      notes,
      journeyStages: parambhJourneyStages,
      leaderboardVersion,
      course,
      courses,
      isEnrolled,
      profileCompletion,
      requiresProfileCompletion: Boolean(profileCompletion?.requiresCompletion),
      isLoadingDashboard,
      dashboardError,
      activeNotification,
      completeTask,
      submitQuiz,
      markNotificationsRead,
      getLeaderboard,
      saveNote,
      deleteNote,
      refreshData,
      hasCompletedOnboarding,
      completeOnboarding,
    }),
    [
      student,
      profile,
      tasks,
      pendingTasks,
      performanceHistory,
      notifications,
      unreadNotificationsCount,
      notes,
      leaderboardVersion,
      course,
      courses,
      isEnrolled,
      profileCompletion,
      isLoadingDashboard,
      dashboardError,
      activeNotification,
      completeTask,
      submitQuiz,
      markNotificationsRead,
      getLeaderboard,
      saveNote,
      deleteNote,
      refreshData,
      hasCompletedOnboarding,
      completeOnboarding,
    ]
  );

  return <StudentContext.Provider value={value}>{children}</StudentContext.Provider>;
}

export function useStudent() {
  const context = useContext(StudentContext);
  if (!context) {
    throw new Error('useStudent must be used within a StudentProvider');
  }
  return context;
}
