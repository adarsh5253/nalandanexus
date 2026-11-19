import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { teacherApiService, ApiClientError, isAbortError } from '../services/teacherApiService';
import { socketService } from '../services/socketService';

const EMPTY_OVERVIEW = {
  classes: [],
  coreStats: null,
  avgScoreBreakdown: null,
  atRiskStudents: { all: [], actNow: [], watch: [], totalCount: 0 },
  recommendedActions: [],
  pendingTasks: [],
  workloadSummary: null,
  classHealth: [],
  todaysSchedule: [],
  liveClassState: { isActive: false },
  conceptPerformance: [],
};

/**
 * Real data, one round trip: `GET /api/teacher/dashboard` already returns
 * every field this hook exposes, pre-aggregated from live MongoDB queries
 * (see backend/src/services/dashboard.service.js's own doc-comment — the
 * two were built to match exactly). No mock data, no fabricated fallback
 * numbers; an empty institution genuinely shows zeros/empty states.
 */
export function useTeacherDashboard() {
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const [selectedStudent, setSelectedStudent] = useState(null);
  const [isStudentDrawerOpen, setIsStudentDrawerOpen] = useState(false);
  const [isAvgScoreModalOpen, setIsAvgScoreModalOpen] = useState(false);
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState(0);

  const [timeFilter, setTimeFilter] = useState('thisWeek');
  const [connectionStatus, setConnectionStatus] = useState('connecting');

  // The load in flight, so a second trigger joins it rather than starting a
  // duplicate request, plus the abort handle for the component unmounting.
  const inFlight = useRef(null);
  const abortRef = useRef(null);
  const isMounted = useRef(true);

  const fetchOverview = useCallback(async () => {
    if (inFlight.current) return inFlight.current;

    const controller = new AbortController();
    abortRef.current = controller;

    const run = (async () => {
      try {
        setError(null);
        const data = await teacherApiService.getDashboardOverview(controller.signal);
        if (!isMounted.current) return;
        // Merged over the previous overview, not over EMPTY_OVERVIEW alone, so
        // a refresh never momentarily empties a panel the response does not
        // happen to carry.
        setOverview((prev) => ({ ...EMPTY_OVERVIEW, ...prev, ...data }));
      } catch (err) {
        // An abort means this component moved on, not that anything failed.
        if (isAbortError(err) || !isMounted.current) return;
        setError(err instanceof ApiClientError ? err : new Error('Failed to load dashboard.'));
      } finally {
        if (isMounted.current) setIsLoading(false);
        inFlight.current = null;
      }
    })();

    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      // Cancels the request so its response cannot land on an unmounted tree,
      // and frees the connection instead of leaving it to complete unread.
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  useEffect(() => {
    let cancelled = false;
    teacherApiService
      .getUnreadNotificationCount()
      .then((c) => {
        if (!cancelled) setUnreadNotificationsCount(c ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const openStudentDrillDown = useCallback((student) => {
    if (!student) return;
    const found = typeof student === 'string'
      ? overview.atRiskStudents.all.find((s) => s.id === student) || { id: student }
      : student;
    setSelectedStudent(found);
    setIsStudentDrawerOpen(true);
  }, [overview.atRiskStudents]);

  const closeStudentDrillDown = useCallback(() => {
    setIsStudentDrawerOpen(false);
    setSelectedStudent(null);
  }, []);

  // Real-time: score updates, class lifecycle changes, and new notifications
  // all refresh the aggregate overview live rather than needing a manual
  // page reload. Refetching the whole payload (instead of patching pieces
  // client-side) keeps every derived number honest and in sync.
  /**
   * Socket-triggered refreshes are coalesced.
   *
   * Every one of these events used to call `fetchOverview` directly, and the
   * backend emits them in bursts - a grading run or a class transition fires
   * several within a few hundred milliseconds, each starting its own full
   * `/dashboard/overview` request (the most expensive query in the portal) and
   * each overwriting the last one's result. One trailing refresh per burst
   * gives the same final state for a fraction of the work.
   */
  const refreshTimer = useRef(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      fetchOverview();
    }, 400);
  }, [fetchOverview]);

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  useEffect(() => {
    socketService.connect();

    const unbindScore = socketService.on('score:update', scheduleRefresh);
    const unbindClassEvents = ['class.rescheduled', 'class.started', 'class.completed', 'class.cancelled', 'class.updated'].map((ev) =>
      socketService.on(ev, scheduleRefresh)
    );
    const unbindNotification = socketService.on('notification.created', () => {
      setUnreadNotificationsCount((c) => c + 1);
    });
    const unbindStatus = socketService.on('connection:status', ({ status }) => {
      setConnectionStatus(status);
    });

    return () => {
      unbindScore();
      unbindClassEvents.forEach((unbind) => unbind());
      unbindNotification();
      unbindStatus();
    };
  }, [scheduleRefresh]);

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();

    const studentResults = overview.atRiskStudents.all
      .filter((s) => s.name?.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q))
      .slice(0, 5)
      .map((s) => ({ id: s.id, type: 'student', title: s.name, subtitle: `${s.className || ''} • ${s.score ?? 0}% Score`, data: s }));

    const classResults = overview.classes
      .filter((c) => c.name?.toLowerCase().includes(q) || c.subject?.toLowerCase().includes(q))
      .slice(0, 3)
      .map((c) => ({ id: c.id, type: 'class', title: c.name, subtitle: `${c.subject || ''} (${c.studentCount} students)`, data: c }));

    return [...studentResults, ...classResults];
  }, [searchQuery, overview]);

  return {
    isLoading,
    error,
    refetch: fetchOverview,
    ...overview,

    selectedStudent,
    isStudentDrawerOpen,
    openStudentDrillDown,
    closeStudentDrillDown,

    isAvgScoreModalOpen,
    setIsAvgScoreModalOpen,
    isSearchModalOpen,
    setIsSearchModalOpen,
    searchQuery,
    setSearchQuery,
    searchResults,
    unreadNotificationsCount,
    setUnreadNotificationsCount,

    timeFilter,
    setTimeFilter,

    isLive: connectionStatus === 'connected',
    connectionStatus,
  };
}

export default useTeacherDashboard;
