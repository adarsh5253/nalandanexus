import React, { useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  Activity,
  LayoutDashboard,
  Layers,
  BookOpen,
  FileCheck2,
  Users,
  CalendarCheck,
  Award,
  GraduationCap,
  MessageSquare,
  FolderOpen,
  Calendar,
  BarChart3,
  Settings,
  LogOut,
  Bell,
  Search,
  Menu,
  X,
  Sparkles,
  ChevronDown,
  ShieldOff,
  Youtube,
} from 'lucide-react';
import { useTeacherAuth } from '../context/TeacherAuthContext';
import ProBadge from './common/ProBadge';
import GlobalSearchModal from './common/GlobalSearchModal';
import { useTeacherDashboard } from '../hooks/useTeacherDashboard';
import StudentDrillDownDrawer from './students/StudentDrillDownDrawer';
import { teacherApiService } from '../services/teacherApiService';
import { socketService } from '../services/socketService';

const NAV_ITEMS = [
  { name: 'Dashboard', path: '/', icon: LayoutDashboard, end: true },
  { name: 'My Classes', path: '/classes', icon: Layers },
  { name: 'Courses', path: '/courses', icon: BookOpen },
  { name: 'Lesson Videos', path: '/lesson-videos', icon: Youtube },
  { name: 'Assignments', path: '/grading', icon: FileCheck2 },
  { name: 'Students', path: '/students', icon: Users },
  { name: 'Progress', path: '/student-progress', icon: Activity },
  { name: 'Attendance', path: '/attendance', icon: CalendarCheck },
  { name: 'Exams & Quizzes', path: '/exams', icon: Award },
  { name: 'Grades', path: '/grades', icon: GraduationCap },
  { name: 'Messages', path: '/messages', icon: MessageSquare },
  { name: 'Resources', path: '/resources', icon: FolderOpen },
  { name: 'Calendar', path: '/calendar', icon: Calendar },
  { name: 'Reports', path: '/reports', icon: BarChart3 },
  { name: 'Settings', path: '/settings', icon: Settings },
];

export default function TeacherLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const { user, logout, logoutAllDevices } = useTeacherAuth();
  const navigate = useNavigate();

  const {
    isSearchModalOpen,
    setIsSearchModalOpen,
    searchQuery,
    setSearchQuery,
    searchResults,
    selectedStudent,
    isStudentDrawerOpen,
    openStudentDrillDown,
    closeStudentDrillDown,
    unreadNotificationsCount,
    setUnreadNotificationsCount,
    isLive,
    classes,
    atRiskStudents,
  } = useTeacherDashboard();

  const [notifications, setNotifications] = useState([]);

  const fetchNotifications = React.useCallback(() => {
    teacherApiService
      .getNotifications({ limit: 5 })
      .then((res) => setNotifications(res?.notifications || res || []))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  React.useEffect(() => {
    socketService.connect();
    const unbind = socketService.on('notification.created', fetchNotifications);
    return unbind;
  }, [fetchNotifications]);

  const handleMarkAllRead = () => {
    teacherApiService.markAllNotificationsRead().catch(() => {});
    setUnreadNotificationsCount(0);
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
  };

  const totalStudents = classes?.reduce((sum, c) => sum + (c.studentCount || 0), 0) || 0;
  const criticalCount = atRiskStudents?.actNow?.length || 0;

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  /**
   * Revokes every session for this account, not just this browser's cookie.
   * Offered separately because it affects a teacher's other devices too, so
   * it should be a deliberate choice rather than what the ordinary Logout
   * button silently does.
   */
  const handleLogoutAllDevices = async () => {
    if (!window.confirm('Sign out of every device? Any other browser or phone signed in to this account will be signed out too.')) return;
    await logoutAllDevices();
    navigate('/login');
  };

  const isPro = user?.tier === 'pro' || user?.isPro !== false;

  return (
    <div className="min-h-screen bg-[#EDEAE0] text-[#2B2B28] flex flex-col md:flex-row selection:bg-[#22355E] selection:text-[#EDEAE0]">
      {/* Mobile Topbar */}
      <div className="md:hidden flex items-center justify-between p-4 bg-[#22355E] text-[#EDEAE0] border-b border-[#314B82] z-30 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-[#16233F] border border-[#314B82] p-1 flex items-center justify-center font-bold text-white shadow-xs">
            <img src="/favicon.svg" alt="Nalanda Logo" className="w-full h-full object-contain" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight text-[#EDEAE0]">Nalanda Nexus</span>
            {isPro && <ProBadge size="sm" className="ml-1.5" />}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsSearchModalOpen(true)}
            aria-label="Search"
            className="p-2 rounded-xl bg-[#16233F] text-[#EDEAE0]/80 hover:text-white border border-[#314B82]"
          >
            <Search className="w-4 h-4" />
          </button>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Menu"
            className="p-2 rounded-xl bg-[#16233F] text-[#EDEAE0] border border-[#314B82]"
          >
            {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Left Sidebar (Ink Indigo: #22355E) */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-40 w-64 bg-[#22355E] text-[#EDEAE0] p-4 flex flex-col justify-between transition-transform duration-200 shadow-xl md:shadow-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div className="space-y-6">
          {/* Brand Header */}
          <div className="hidden md:flex items-center justify-between px-2 pt-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#16233F] border border-[#314B82] p-1.5 flex items-center justify-center font-bold text-white shadow-sm">
                <img src="/favicon.svg" alt="Nalanda Logo" className="w-full h-full object-contain" />
              </div>
              <div>
                <div className="font-bold text-sm text-[#EDEAE0] tracking-wide font-display">NALANDA NEXUS</div>
                <div className="text-[10px] font-semibold text-[#EDEAE0]/60 uppercase tracking-widest">Faculty Command</div>
              </div>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1 overflow-y-auto max-h-[calc(100vh-280px)] pr-1" aria-label="Main Navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.end}
                  onClick={() => setSidebarOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                      isActive
                        ? 'bg-[#314B82] text-white font-bold shadow-xs'
                        : 'text-[#EDEAE0]/80 hover:bg-[#16233F] hover:text-[#EDEAE0]'
                    }`
                  }
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span>{item.name}</span>
                </NavLink>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer: Pro Status & Teacher Profile */}
        <div className="space-y-3 pt-3 border-t border-[#314B82]">
          {/* Pro Status Box */}
          <div className="p-3 rounded-xl bg-[#16233F] border border-[#C99A2E]/40 shadow-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-extrabold text-[#DFC168] uppercase tracking-wider flex items-center gap-1.5 font-display">
                <Sparkles className="w-3 h-3 text-[#C99A2E]" />
                {isPro ? 'PRO FACULTY SUITE' : 'STANDARD TIER'}
              </span>
              <span
                className={`w-2 h-2 rounded-full ${isPro ? 'bg-[#5C7A5E]' : 'bg-[#9B9690]'}`}
                title={isPro ? 'Pro Active' : 'Standard'}
              />
            </div>
            <p className="text-[10px] text-[#EDEAE0]/70 leading-tight">
              {isPro
                ? `${classes?.length || 0} Class${classes?.length === 1 ? '' : 'es'} · Longitudinal Diagnostics Active`
                : 'Basic gradebook tier'}
            </p>
          </div>

          {/* User Profile Strip */}
          <div className="flex items-center justify-between p-2 rounded-xl bg-[#16233F]/70 border border-[#314B82]/60">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-[#314B82] flex items-center justify-center font-bold text-xs text-white uppercase flex-shrink-0">
                {user?.name ? user.name[0] : 'T'}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-bold text-[#EDEAE0] truncate">{user?.name || 'Faculty'}</div>
                <div className="text-[10px] text-[#EDEAE0]/60 truncate">{user?.title || 'Faculty'}</div>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={handleLogout}
                className="p-1.5 rounded-lg text-[#EDEAE0]/60 hover:text-[#C1352B] hover:bg-[#16233F] transition-colors"
                title="Sign out of this device"
                aria-label="Sign out of this device"
              >
                <LogOut className="w-4 h-4" />
              </button>
              {/* Revokes every token issued to this account, which plain sign-out
                  does not - see TeacherAuthContext.logoutAllDevices. */}
              <button
                onClick={handleLogoutAllDevices}
                className="p-1.5 rounded-lg text-[#EDEAE0]/60 hover:text-[#C1352B] hover:bg-[#16233F] transition-colors"
                title="Sign out of all devices"
                aria-label="Sign out of all devices"
              >
                <ShieldOff className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Workspace Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#EDEAE0]">
        {/* Top Header Bar */}
        <header className="hidden md:flex items-center justify-between px-8 py-4 bg-[#FFFFFF] border-b border-[#DFDACB] sticky top-0 z-20 shadow-xs">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-base font-bold text-[#22355E] font-display">
                {user?.name ? `Welcome back, ${user.name}` : 'Faculty Command Center'}
              </h2>
              <p className="text-xs text-[#6E6A64]">
                {classes?.length || 0} Class{classes?.length === 1 ? '' : 'es'} • {totalStudents} Total Student{totalStudents === 1 ? '' : 's'} • {criticalCount} Critical Intervention{criticalCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Global Search Bar Trigger (Key binding: Ctrl+K) */}
            <button
              onClick={() => setIsSearchModalOpen(true)}
              className="flex items-center gap-3 px-3.5 py-1.5 rounded-xl bg-[#F7F5EE] hover:bg-[#F2EFE6] border border-[#DFDACB] text-xs text-[#6E6A64] transition-all w-64 justify-between group shadow-2xs"
            >
              <div className="flex items-center gap-2">
                <Search className="w-3.5 h-3.5 text-[#22355E]" />
                <span className="text-xs">Search students, classes...</span>
              </div>
              <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#FFFFFF] text-[#22355E] border border-[#DFDACB]">
                ⌘K
              </kbd>
            </button>

            {/* Notification Bell */}
            <div className="relative">
              <button
                onClick={() => setNotificationsOpen(!notificationsOpen)}
                aria-label="Notifications"
                className="p-2 rounded-xl bg-[#F7F5EE] hover:bg-[#F2EFE6] text-[#22355E] border border-[#DFDACB] relative transition-colors"
              >
                <Bell className="w-4 h-4" />
                {unreadNotificationsCount > 0 && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#C1352B]" />
                )}
              </button>

              {notificationsOpen && (
                <div className="absolute right-0 mt-2 w-72 bg-[#FFFFFF] border border-[#DFDACB] rounded-2xl shadow-dropdown p-3 z-50 space-y-2 animate-in fade-in duration-150">
                  <div className="flex items-center justify-between pb-2 border-b border-[#DFDACB]">
                    <span className="text-xs font-bold text-[#22355E]">Notifications</span>
                    <button
                      onClick={handleMarkAllRead}
                      className="text-[10px] text-[#AB5236] font-bold hover:underline"
                    >
                      Mark all read
                    </button>
                  </div>
                  <div className="space-y-2 text-xs max-h-64 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <p className="text-[11px] text-[#9B9690] text-center py-4">No notifications yet.</p>
                    ) : (
                      notifications.map((n) => (
                        <div key={n.id} className={`p-2 rounded-lg border border-[#DFDACB] ${n.isRead ? 'bg-[#F7F5EE]' : 'bg-[#AB5236]/5'}`}>
                          <p className="font-semibold text-[#2B2B28]">{n.title}</p>
                          <span className="text-[10px] text-[#6E6A64]">{new Date(n.createdAt).toLocaleString()}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Live Socket Status Indicator */}
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F7F5EE] border border-[#DFDACB] text-[11px] font-semibold">
              <span
                className={`w-2 h-2 rounded-full ${
                  isLive ? 'bg-[#5C7A5E] animate-pulse' : 'bg-[#C99A2E]'
                }`}
              />
              <span className={isLive ? 'text-[#5C7A5E]' : 'text-[#C99A2E]'}>
                {isLive ? 'Live' : 'Reconnecting...'}
              </span>
            </div>
          </div>
        </header>

        {/* Dynamic Route View Canvas */}
        <main className="p-4 sm:p-6 lg:p-8 flex-1 overflow-auto bg-[#EDEAE0]">
          <Outlet context={{ openStudentDrillDown, selectedStudent, isStudentDrawerOpen, closeStudentDrillDown }} />
        </main>
      </div>

      {/* Global Search Modal */}
      <GlobalSearchModal
        isOpen={isSearchModalOpen}
        onOpen={() => setIsSearchModalOpen(true)}
        onClose={() => setIsSearchModalOpen(false)}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchResults={searchResults}
        onSelectStudent={openStudentDrillDown}
      />

      {/* Student Drill-Down Drawer */}
      <StudentDrillDownDrawer
        isOpen={isStudentDrawerOpen}
        onClose={closeStudentDrillDown}
        student={selectedStudent}
      />
    </div>
  );
}
