import React, { useState } from 'react';
import {
  Search,
  MoreVertical,
  UserCheck,
  RotateCcw,
  Ban,
  Trash2,
  KeyRound,
  Eye,
  Edit,
  MailX,
  Plus,
  Filter,
} from 'lucide-react';
import StatusBadge from '../common/StatusBadge';
import EmptyState from '../common/EmptyState';
import { EmailStatusBadge } from './OnboardingStatus';

export default function TeacherTable({
  teachers = [],
  isLoading = false,
  onOpenProfile,
  onOpenCreate,
  onResendInvite,
  onResendCredentials,
  onRevokeInvite,
  onSuspend,
  onReactivate,
  onResetPassword,
  onDelete,
  onFilterChange,
  filters = {},
}) {
  const [activeMenuId, setActiveMenuId] = useState(null);

  const getInitials = (name) => {
    if (!name) return 'TC';
    const parts = name.split(' ');
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    return name.substring(0, 2).toUpperCase();
  };

  const departments = Array.from(new Set(teachers.map((t) => t.department).filter(Boolean)));
  const subjects = Array.from(new Set(teachers.map((t) => t.subject).filter(Boolean)));

  return (
    <div className="space-y-4">
      {/* Table Toolbar & Search Filters */}
      <div className="bg-white border border-[#DFDACB] rounded-2xl p-4 shadow-card flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        {/* Search Bar */}
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9B9690]" />
          <input
            type="text"
            placeholder="Search teachers by name, email, or teacher ID..."
            value={filters.search || ''}
            onChange={(e) => onFilterChange({ ...filters, search: e.target.value })}
            className="w-full bg-[#F7F5EE] border border-[#DFDACB] rounded-xl pl-10 pr-4 py-2 text-xs text-[#2B2B28] placeholder-[#9B9690] focus:outline-none focus:border-[#22355E]"
          />
        </div>

        {/* Filter Dropdowns */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Status Filter */}
          <select
            value={filters.status || 'ALL'}
            onChange={(e) => onFilterChange({ ...filters, status: e.target.value })}
            className="bg-[#F7F5EE] border border-[#DFDACB] rounded-xl px-3 py-2 text-xs font-semibold text-[#22355E] focus:outline-none focus:border-[#22355E]"
          >
            <option value="ALL">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INVITED">Invited</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="INACTIVE">Inactive</option>
          </select>

          {/* Department Filter */}
          <select
            value={filters.department || 'ALL'}
            onChange={(e) => onFilterChange({ ...filters, department: e.target.value })}
            className="bg-[#F7F5EE] border border-[#DFDACB] rounded-xl px-3 py-2 text-xs font-semibold text-[#22355E] focus:outline-none focus:border-[#22355E] max-w-[160px] truncate"
          >
            <option value="ALL">All Departments</option>
            {departments.map((dept) => (
              <option key={dept} value={dept}>
                {dept}
              </option>
            ))}
          </select>

          {/* Subject Filter */}
          <select
            value={filters.subject || 'ALL'}
            onChange={(e) => onFilterChange({ ...filters, subject: e.target.value })}
            className="bg-[#F7F5EE] border border-[#DFDACB] rounded-xl px-3 py-2 text-xs font-semibold text-[#22355E] focus:outline-none focus:border-[#22355E] max-w-[140px] truncate"
          >
            <option value="ALL">All Subjects</option>
            {subjects.map((sub) => (
              <option key={sub} value={sub}>
                {sub}
              </option>
            ))}
          </select>

          {/* Reset Filters button if any active */}
          {(filters.search || (filters.status && filters.status !== 'ALL') || (filters.department && filters.department !== 'ALL')) && (
            <button
              type="button"
              onClick={() => onFilterChange({ search: '', status: 'ALL', department: 'ALL', subject: 'ALL' })}
              className="text-xs text-[#AB5236] hover:underline font-semibold px-2 py-1"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Teachers Data Table */}
      <div className="bg-white border border-[#DFDACB] rounded-2xl shadow-card overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-xs text-[#9B9690] space-y-2">
            <div className="w-6 h-6 border-2 border-[#22355E] border-t-transparent rounded-full animate-spin mx-auto" />
            <p>Loading verified teacher records...</p>
          </div>
        ) : teachers.length === 0 ? (
          <div className="p-8">
            <EmptyState
              title="No teachers found"
              description="Try changing your search terms or filter selection."
              actionText="Reset Filters"
              onAction={() => onFilterChange({ search: '', status: 'ALL', department: 'ALL', subject: 'ALL' })}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-[#F7F5EE] border-b border-[#DFDACB] text-[#9B9690] font-semibold">
                <tr>
                  <th className="py-3 px-4">Teacher & ID</th>
                  <th className="py-3 px-4">Official Email</th>
                  <th className="py-3 px-4">Subject & Department</th>
                  <th className="py-3 px-4">Courses</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 font-mono">Last Active</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EDEAE0] text-[#2B2B28]">
                {teachers.map((teacher) => {
                  const isMenuOpen = activeMenuId === teacher.id;

                  return (
                    <tr
                      key={teacher.id}
                      className="hover:bg-[#F7F5EE]/60 transition-colors group cursor-pointer"
                      onClick={() => onOpenProfile(teacher)}
                    >
                      {/* Teacher Column */}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-xl bg-[#22355E] text-white font-bold text-xs flex items-center justify-center flex-shrink-0 shadow-sm">
                            {getInitials(teacher.name)}
                          </div>
                          <div className="min-w-0">
                            <p className="font-bold text-[#22355E] group-hover:text-[#AB5236] transition-colors truncate">
                              {teacher.name}
                            </p>
                            <p className="text-[10px] font-mono text-[#9B9690] truncate">
                              {teacher.teacherId}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* Email Column */}
                      <td className="py-3.5 px-4 font-mono text-[11px] text-[#2B2B28]">
                        {teacher.email}
                      </td>

                      {/* Subject & Department */}
                      <td className="py-3.5 px-4">
                        <p className="font-semibold text-[#22355E] truncate max-w-[180px]">
                          {teacher.subject || 'Allotted Subjects'}
                        </p>
                        <p className="text-[10px] text-[#9B9690] truncate max-w-[180px]">
                          {teacher.department}
                        </p>
                      </td>

                      {/* Assigned courses: what decides which students they see */}
                      <td className="py-3.5 px-4">
                        {(teacher.assignedCourses || []).length ? (
                          <div className="flex flex-wrap gap-1 max-w-[200px]">
                            {teacher.assignedCourses.map((c) => (
                              <span
                                key={c.slug}
                                title={c.title || c.slug}
                                className="px-1.5 py-0.5 rounded-md bg-[#22355E]/10 border border-[#22355E]/20 text-[10px] font-bold text-[#22355E] uppercase"
                              >
                                {c.title || c.slug}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[11px] text-[#9B9690]">None assigned</span>
                        )}
                        {teacher.courseSyncStatus === 'failed' && (
                          <p className="text-[10px] text-[#C1352B] mt-1" title={teacher.courseSyncError || ''}>
                            Not sent to Teacher Portal
                          </p>
                        )}
                      </td>

                      {/* Status Column */}
                      <td className="py-3.5 px-4">
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge status={teacher.status} size="xs" />
                          <EmailStatusBadge teacher={teacher} />
                        </div>
                      </td>

                      {/* Last Active */}
                      <td className="py-3.5 px-4 font-mono text-[11px] text-[#9B9690]">
                        {teacher.lastActive ? new Date(teacher.lastActive).toLocaleDateString() : 'Never'}
                      </td>

                      {/* Action ⋮ Dropdown */}
                      <td
                        className="py-3.5 px-4 text-right relative"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveMenuId(isMenuOpen ? null : teacher.id)}
                          className="p-1.5 rounded-lg text-[#9B9690] hover:text-[#22355E] hover:bg-[#EDEAE0] transition-colors"
                          title="Actions Menu"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>

                        {/* Actions Menu Popup */}
                        {isMenuOpen && (
                          <div
                            className="absolute right-4 top-10 w-48 bg-white border border-[#DFDACB] rounded-2xl shadow-dropdown py-1.5 z-30 text-left animate-in fade-in zoom-in-95 duration-100 divide-y divide-[#EDEAE0]"
                            onMouseLeave={() => setActiveMenuId(null)}
                          >
                            <div className="py-1">
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  onOpenProfile(teacher);
                                }}
                                className="w-full px-3.5 py-1.5 text-xs text-[#2B2B28] hover:bg-[#F7F5EE] flex items-center gap-2"
                              >
                                <Eye className="w-3.5 h-3.5 text-[#22355E]" />
                                <span>View Profile</span>
                              </button>
                            </div>

                            {/* Invitation Actions */}
                            {teacher.status === 'INVITED' && (
                              <div className="py-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveMenuId(null);
                                    onResendInvite(teacher);
                                  }}
                                  className="w-full px-3.5 py-1.5 text-xs text-[#22355E] hover:bg-[#F7F5EE] flex items-center gap-2 font-medium"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                  <span>Resend Invitation</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveMenuId(null);
                                    onRevokeInvite(teacher);
                                  }}
                                  className="w-full px-3.5 py-1.5 text-xs text-[#9B9690] hover:bg-[#F7F5EE] flex items-center gap-2"
                                >
                                  <MailX className="w-3.5 h-3.5" />
                                  <span>Revoke Invitation</span>
                                </button>
                              </div>
                            )}

                            {/* Security / Credentials */}
                            <div className="py-1">
                              {teacher.status === 'ACTIVE' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveMenuId(null);
                                    onResendCredentials(teacher);
                                  }}
                                  className="w-full px-3.5 py-1.5 text-xs text-[#22355E] hover:bg-[#F7F5EE] flex items-center gap-2 font-medium"
                                  title="Emails a new password-setup link. Any earlier link stops working; the teacher's current password is unchanged until they use it."
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                  <span>Resend Setup Email</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  onResetPassword(teacher);
                                }}
                                className="w-full px-3.5 py-1.5 text-xs text-[#2B2B28] hover:bg-[#F7F5EE] flex items-center gap-2"
                              >
                                <KeyRound className="w-3.5 h-3.5 text-[#22355E]" />
                                <span>Reset Password</span>
                              </button>
                            </div>

                            {/* Status State Transitions */}
                            <div className="py-1">
                              {teacher.status === 'ACTIVE' ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveMenuId(null);
                                    onSuspend(teacher);
                                  }}
                                  className="w-full px-3.5 py-1.5 text-xs text-[#C1352B] hover:bg-[#C1352B]/10 flex items-center gap-2 font-medium"
                                >
                                  <Ban className="w-3.5 h-3.5" />
                                  <span>Suspend Account</span>
                                </button>
                              ) : teacher.status === 'SUSPENDED' ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveMenuId(null);
                                    onReactivate(teacher);
                                  }}
                                  className="w-full px-3.5 py-1.5 text-xs text-[#5C7A5E] hover:bg-[#5C7A5E]/10 flex items-center gap-2 font-medium"
                                >
                                  <UserCheck className="w-3.5 h-3.5" />
                                  <span>Reactivate Account</span>
                                </button>
                              ) : null}

                              {/* Delete Action */}
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  onDelete(teacher);
                                }}
                                className="w-full px-3.5 py-1.5 text-xs text-[#C1352B] hover:bg-[#C1352B]/10 flex items-center gap-2"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>Delete Teacher</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Table Footer / Summary */}
        <div className="p-4 bg-[#F7F5EE] border-t border-[#DFDACB] flex items-center justify-between text-xs text-[#9B9690]">
          <div>
            Showing <span className="font-mono font-bold text-[#22355E]">{teachers.length}</span> faculty records
          </div>
          <div className="flex items-center gap-2">
            <span>Faculty Roster</span>
            <span>•</span>
            <span className="font-mono text-[#5C7A5E]">Nalanda Master Database</span>
          </div>
        </div>
      </div>
    </div>
  );
}
