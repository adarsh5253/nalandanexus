import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Layers,
  Tags,
  SlidersHorizontal,
  ShieldCheck,
  ListChecks,
  Ticket,
  LayoutDashboard,
  Users,
  GraduationCap,
  BookOpen,
  FileCheck,
  FileSpreadsheet,
  CalendarCheck,
  FolderArchive,
  Image,
  Activity,
  Bell,
  CreditCard,
  FileText,
  Settings,
  Shield,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Youtube,
} from 'lucide-react';
import { useAdminAuth } from '../../context/AdminAuthContext';

const NAV_SECTIONS = [
  {
    category: 'OVERVIEW',
    items: [{ name: 'Dashboard', path: '/', icon: LayoutDashboard }],
  },
  {
    category: 'MANAGEMENT',
    items: [
      { name: 'Students', path: '/students', icon: Users },
      { name: 'Teachers', path: '/teachers', icon: GraduationCap },
      { name: 'Courses', path: '/courses', icon: BookOpen },
      { name: 'Batches', path: '/batches', icon: Layers },
      { name: 'Coupons', path: '/coupons', icon: Ticket },
      { name: 'Course Subjects', path: '/course-subjects', icon: Tags },
      { name: 'Lesson Videos', path: '/lesson-videos', icon: Youtube },
      { name: 'Progression', path: '/progression', icon: SlidersHorizontal },
      { name: 'Stage Eligibility', path: '/stage-eligibility', icon: ShieldCheck },
      { name: 'Student Eligibility', path: '/student-eligibility', icon: ListChecks },
      { name: 'Resources', path: '/resources', icon: Image },
    ],
  },
  {
    category: 'ACADEMICS',
    items: [
      { name: 'Assignments', path: '/academics?tab=assignments', icon: FileCheck },
      { name: 'Examinations', path: '/academics?tab=exams', icon: FileSpreadsheet },
      { name: 'Attendance', path: '/academics?tab=attendance', icon: CalendarCheck },
      { name: 'Learning Content', path: '/academics?tab=content', icon: FolderArchive },
    ],
  },
  {
    category: 'SYSTEM',
    items: [
      { name: 'Analytics', path: '/analytics', icon: Activity },
      { name: 'Announcements', path: '/announcements', icon: Bell },
      { name: 'Payments', path: '/payments', icon: CreditCard },
      { name: 'Reports', path: '/reports', icon: FileText },
    ],
  },
  {
    category: 'SETTINGS',
    items: [
      { name: 'Settings', path: '/settings', icon: Settings },
      { name: 'Audit Logs', path: '/logs', icon: Shield },
    ],
  },
];

export default function AdminSidebar({ isCollapsed, onToggleCollapse, isMobileOpen, onCloseMobile }) {
  const { user, logout } = useAdminAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const getInitials = (name) => {
    if (!name) return 'AD';
    const parts = name.split(' ');
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    return name.substring(0, 2).toUpperCase();
  };

  return (
    <>
      {/* Mobile Backdrop Overlay */}
      {isMobileOpen && (
        <div
          onClick={onCloseMobile}
          className="fixed inset-0 z-40 bg-[#22355E]/50 backdrop-blur-sm md:hidden"
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed md:sticky top-0 inset-y-0 left-0 z-50 flex flex-col justify-between bg-[#22355E] text-white border-r border-[#22355E]/80 transition-all duration-300 ease-in-out select-none ${
          isCollapsed ? 'w-20' : 'w-64'
        } ${isMobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} h-screen overflow-y-auto`}
      >
        {/* Top Brand Section */}
        <div>
          <div className="p-4 flex items-center justify-between border-b border-white/10">
            <div className="flex items-center gap-3 overflow-hidden">
              <div className="w-10 h-10 rounded-xl bg-white p-1.5 flex items-center justify-center shadow-md flex-shrink-0">
                <img src="/favicon.svg" alt="Nalanda Seal" className="w-full h-full object-contain" />
              </div>
              {!isCollapsed && (
                <div className="min-w-0">
                  <div className="font-extrabold text-sm tracking-wider text-[#EDEAE0] truncate">
                    NALANDA NEXUS
                  </div>
                  <div className="text-[10px] font-semibold tracking-widest text-[#C99A2E] uppercase">
                    Institutional Admin
                  </div>
                </div>
              )}
            </div>

            {/* Desktop Collapse Button */}
            <button
              type="button"
              onClick={onToggleCollapse}
              title={isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
              className="hidden md:flex p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            >
              {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
          </div>

          {/* Navigation Menu */}
          <nav className="p-3 space-y-5">
            {NAV_SECTIONS.map((section) => (
              <div key={section.category} className="space-y-1">
                {!isCollapsed && (
                  <div className="px-3 text-[10px] font-bold tracking-wider text-white/50 uppercase">
                    {section.category}
                  </div>
                )}
                <div className="space-y-0.5">
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <NavLink
                        key={item.path}
                        to={item.path}
                        end={item.path === '/'}
                        onClick={() => onCloseMobile?.()}
                        title={isCollapsed ? item.name : undefined}
                        className={({ isActive }) =>
                          `flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                            isActive
                              ? 'bg-[#EDEAE0] text-[#22355E] font-bold shadow-sm'
                              : 'text-white/80 hover:text-white hover:bg-white/10'
                          } ${isCollapsed ? 'justify-center px-0' : ''}`
                        }
                      >
                        <Icon className="w-4 h-4 flex-shrink-0" />
                        {!isCollapsed && <span className="truncate">{item.name}</span>}
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </div>

        {/* Bottom User Card */}
        <div className="p-3 border-t border-white/10 bg-black/10">
          <div className="flex items-center gap-3 p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
            <div className="w-9 h-9 rounded-lg bg-[#AB5236] text-white flex items-center justify-center font-bold text-xs flex-shrink-0 shadow-sm">
              {getInitials(user?.name)}
            </div>
            {!isCollapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-white truncate">{user?.name || 'Adarsh Admin'}</p>
                <p className="text-[10px] text-white/60 truncate">{user?.email || 'admin@nalanda.edu'}</p>
              </div>
            )}
            <button
              onClick={handleLogout}
              title="Sign Out"
              className="p-1.5 rounded-lg text-white/70 hover:text-rose-300 hover:bg-white/10 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
