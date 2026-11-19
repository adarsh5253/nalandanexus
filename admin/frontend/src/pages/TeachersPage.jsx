import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, UserPlus, FileDown, CheckCircle2, ShieldAlert, X } from 'lucide-react';
import TeacherTable from '../components/teachers/TeacherTable';
import CreateTeacherModal from '../components/teachers/CreateTeacherModal';
import TeacherProfileDrawer from '../components/teachers/TeacherProfileDrawer';
import DeleteModal from '../components/common/DeleteModal';
import { adminApi } from '../services/adminApi';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';

const RESEND_WARNING_COPY = {
  PORTAL_PROVISIONING_FAILED: 'The Teacher Portal could not be reached, so no new link was issued and no email was sent. Nothing was changed — try again in a moment.',
  EMAIL_DELIVERY_FAILED: 'The link was issued, but the email provider did not accept the message.',
  COURSE_SYNC_FAILED: 'The Teacher Portal did not accept the course assignment yet.',
  TEACHER_ID_MISMATCH: 'The Teacher Portal could not use the Teacher ID shown here; check the ID in the email.',
};

export default function TeachersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilter = searchParams.get('filter');

  const [teachers, setTeachers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters
  const [filters, setFilters] = useState({
    search: '',
    status: initialFilter === 'suspended' ? 'SUSPENDED' : initialFilter === 'expiring' ? 'INVITED' : 'ALL',
    department: 'ALL',
    subject: 'ALL',
  });

  // Modal / Drawer state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedTeacher, setSelectedTeacher] = useState(null);
  const [profileDrawerOpen, setProfileDrawerOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [teacherToDelete, setTeacherToDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Toast / Action notification
  const [toastMsg, setToastMsg] = useState(null);
  // Only populated when a resend did not fully work - shown in a dedicated,
  // non-auto-dismissing modal, because a 4s toast is the wrong place for the
  // reason an email did not go out.
  const [resendProblem, setResendProblem] = useState(null);
  // Which teacher a resend is in flight for, so its button can show it.
  const [resendingId, setResendingId] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToastMsg({ msg, type });
    setTimeout(() => setToastMsg(null), 4000);
  };

  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const handleExportCsv = async () => {
    setIsExportingCsv(true);
    try {
      await adminApi.downloadReport('teachers');
    } catch (err) {
      showToast(err.message || 'Export failed.', 'error');
    } finally {
      setIsExportingCsv(false);
    }
  };

  const fetchTeachers = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const query = { ...filters, limit: 100 };
      if (query.status === 'ALL') delete query.status;
      if (query.department === 'ALL') delete query.department;
      if (query.subject === 'ALL') delete query.subject;
      const data = await adminApi.getTeachers(query);
      setTeachers(data);
    } catch (err) {
      setError(err.message || 'Failed to fetch teachers.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTeachers();
  }, [filters]);

  useRealtimeEvents(
    ['teacher.created', 'teacher.updated', 'teacher.statusChanged', 'teacher.deleted'],
    fetchTeachers
  );

  // Actions
  const handleOpenProfile = (teacher) => {
    setSelectedTeacher(teacher);
    setProfileDrawerOpen(true);
  };

  const handleResendInvite = async (teacher) => {
    try {
      const res = await adminApi.resendInvite(teacher.id);
      showToast(`New 24-hour invitation token dispatched to ${teacher.email}`);
      fetchTeachers();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  /**
   * Sends the teacher a new password-setup link. No password is involved: the
   * link replaces any earlier one, and the teacher chooses their own. If it
   * could not be sent, the recorded reason is shown rather than a vague error.
   */
  const handleResendCredentials = async (teacher) => {
    setResendingId(teacher.id);
    try {
      const res = await adminApi.resendCredentials(teacher.id);
      const warnings = res.meta?.warnings || [];
      if (warnings.length) {
        setResendProblem({ name: teacher.name, email: teacher.email, warnings, reason: res.data?.emailDeliveryError || null });
      } else {
        showToast(`A new password-setup email was sent to ${teacher.email}.`);
      }
      if (selectedTeacher?.id === teacher.id && res.data) setSelectedTeacher({ ...selectedTeacher, ...res.data, id: teacher.id });
      fetchTeachers();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setResendingId(null);
    }
  };

  /** Replaces the teacher's assigned courses; the Teacher Portal's student list follows. */
  const handleSetCourses = async (teacher, courseSlugs) => {
    try {
      const res = await adminApi.setTeacherCourses(teacher.id, courseSlugs);
      const warnings = res.meta?.warnings || [];
      if (warnings.length) {
        showToast('Courses saved, but the Teacher Portal has not accepted them yet — retry from the profile.', 'error');
      } else {
        showToast(`Courses updated for ${teacher.name}. Their enrolled students are now visible to the teacher.`);
      }
      if (res.data) setSelectedTeacher((current) => (current?.id === teacher.id ? { ...current, ...res.data, id: teacher.id } : current));
      fetchTeachers();
      return res;
    } catch (err) {
      showToast(err.message, 'error');
      throw err;
    }
  };

  const handleRevokeInvite = async (teacher) => {
    try {
      await adminApi.revokeInvite(teacher.id);
      showToast(`Invitation for ${teacher.email} has been revoked.`);
      fetchTeachers();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleSuspend = async (teacher) => {
    try {
      await adminApi.suspendTeacher(teacher.id, 'Administrative suspension applied from console');
      showToast(`Account for ${teacher.name} has been suspended.`);
      fetchTeachers();
      if (selectedTeacher?.id === teacher.id) {
        setSelectedTeacher({ ...selectedTeacher, status: 'SUSPENDED' });
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  /**
   * Saves what the public About page shows for this teacher. The backend
   * publishes it to the student portal, or withdraws it when it is switched
   * off - see admin/backend/src/services/studentFacultyBridge.service.js.
   */
  const handleUpdateWebsiteProfile = async (teacher, profile) => {
    try {
      const updated = await adminApi.updateTeacher(teacher.id, profile);
      showToast(
        profile.showOnWebsite
          ? `${teacher.name} now appears on the student website.`
          : `${teacher.name} was removed from the student website.`
      );
      fetchTeachers();
      if (selectedTeacher?.id === teacher.id) setSelectedTeacher({ ...selectedTeacher, ...(updated || profile) });
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleReactivate = async (teacher) => {
    try {
      await adminApi.reactivateTeacher(teacher.id);
      showToast(`Account for ${teacher.name} has been reactivated.`);
      fetchTeachers();
      if (selectedTeacher?.id === teacher.id) {
        setSelectedTeacher({ ...selectedTeacher, status: 'ACTIVE' });
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // A password can only be set through an emailed single-use link, so a reset is
  // the same thing as sending a new one.
  const handleResetPassword = (teacher) => handleResendCredentials(teacher);

  const handleDeletePrompt = (teacher) => {
    setTeacherToDelete(teacher);
    setDeleteModalOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!teacherToDelete) return;
    setIsDeleting(true);
    try {
      await adminApi.deleteTeacher(teacherToDelete.id);
      showToast(`Teacher account ${teacherToDelete.name} permanently deleted.`);
      setDeleteModalOpen(false);
      setTeacherToDelete(null);
      setProfileDrawerOpen(false);
      fetchTeachers();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Toast Notification */}
      {toastMsg && (
        <div
          className={`fixed bottom-6 right-6 z-50 p-4 rounded-2xl border shadow-2xl flex items-center gap-3 animate-in slide-in-from-bottom duration-200 ${
            toastMsg.type === 'error'
              ? 'bg-[#C1352B] text-white border-[#C1352B]'
              : 'bg-[#22355E] text-white border-[#22355E]'
          }`}
        >
          {toastMsg.type === 'error' ? (
            <ShieldAlert className="w-5 h-5 flex-shrink-0 text-white" />
          ) : (
            <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-[#5C7A5E]" />
          )}
          <span className="text-xs font-semibold">{toastMsg.msg}</span>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#DFDACB]/80 pb-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-[#22355E] tracking-tight">
            Faculty & Teacher Governance
          </h1>
          <p className="text-xs text-[#9B9690] mt-1">
            Manage faculty accounts, subject allocations, cryptographic invitations, and security permissions.
          </p>
        </div>

        {/* Header Action Buttons */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            disabled={isExportingCsv}
            onClick={handleExportCsv}
            className="px-3.5 py-2 rounded-xl bg-white border border-[#DFDACB] hover:bg-[#EDEAE0] disabled:opacity-60 text-xs font-semibold text-[#22355E] transition-colors flex items-center gap-1.5 shadow-sm"
          >
            {isExportingCsv ? (
              <span className="w-3.5 h-3.5 border-2 border-[#22355E]/30 border-t-[#22355E] rounded-full animate-spin" />
            ) : (
              <FileDown className="w-3.5 h-3.5" />
            )}
            <span className="hidden sm:inline">Export CSV</span>
          </button>

          {/* Primary CTA: brick-terracotta */}
          <button
            type="button"
            onClick={() => setCreateModalOpen(true)}
            className="px-4 py-2 rounded-xl bg-[#AB5236] hover:bg-[#8F3E26] text-white text-xs font-semibold transition-all shadow-cta flex items-center gap-2"
          >
            <UserPlus className="w-4 h-4" />
            <span>Create Teacher</span>
          </button>
        </div>
      </div>

      {/* Teachers Table & Filter Interface */}
      <TeacherTable
        teachers={teachers}
        isLoading={isLoading}
        filters={filters}
        onFilterChange={setFilters}
        onOpenProfile={handleOpenProfile}
        onOpenCreate={() => setCreateModalOpen(true)}
        onResendInvite={handleResendInvite}
        onResendCredentials={handleResendCredentials}
        onRevokeInvite={handleRevokeInvite}
        onSuspend={handleSuspend}
        onReactivate={handleReactivate}
        onResetPassword={handleResetPassword}
        onDelete={handleDeletePrompt}
      />

      {/* Modals & Drawers */}
      <CreateTeacherModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onTeacherCreated={(teacher, warnings = []) => {
          showToast(
            warnings.length
              ? 'Teacher created — see the dialog for items needing attention.'
              : 'Teacher created. A password-setup email has been sent.'
          );
          fetchTeachers();
        }}
      />

      <TeacherProfileDrawer
        teacher={selectedTeacher}
        isOpen={profileDrawerOpen}
        onClose={() => setProfileDrawerOpen(false)}
        onSuspend={handleSuspend}
        onReactivate={handleReactivate}
        onResetPassword={handleResetPassword}
        onResendInvite={handleResendInvite}
        onResendCredentials={handleResendCredentials}
        onUpdateWebsiteProfile={handleUpdateWebsiteProfile}
        onSetCourses={handleSetCourses}
        isResending={resendingId === selectedTeacher?.id}
      />

      <DeleteModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={handleConfirmDelete}
        title="Permanently Delete Teacher Account?"
        description="This will permanently delete the teacher record, invalidate all tokens, and remove classroom permissions. This action is audited and cannot be undone."
        itemName={teacherToDelete ? `${teacherToDelete.name} (${teacherToDelete.email})` : ''}
        isDeleting={isDeleting}
      />

      {/* Shown when a resend did not fully work. It states why, and never contains a password: there is none to show. */}
      {resendProblem && (
        <div className="fixed inset-0 z-50 bg-[#22355E]/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div role="dialog" aria-modal="true" className="bg-white border border-[#DFDACB] rounded-2xl max-w-md w-full p-6 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200">
            <button
              type="button"
              aria-label="Close"
              onClick={() => setResendProblem(null)}
              className="absolute right-4 top-4 p-1.5 rounded-lg text-[#9B9690] hover:text-[#2B2B28] hover:bg-[#EDEAE0] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3 shadow-sm border bg-[#C99A2E]/15 border-[#C99A2E]/30 text-[#C99A2E]">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-[#22355E]">Setup Email Needs Attention</h3>
            <p className="text-xs text-[#2B2B28] mt-1.5 leading-relaxed">
              The new setup link for <strong className="font-semibold text-[#22355E]">{resendProblem.email}</strong> could not be fully sent.
            </p>
            <ul className="mt-3 space-y-1.5">
              {resendProblem.warnings.map((code) => (
                <li key={code} className="text-xs text-[#8a6512] leading-relaxed">
                  ⚠ {RESEND_WARNING_COPY[code] || code}
                </li>
              ))}
            </ul>
            {resendProblem.reason && <p className="mt-2 text-xs text-[#C1352B] break-words">Reason: {resendProblem.reason}</p>}
            <div className="pt-4 mt-4 border-t border-[#EDEAE0] flex justify-end">
              <button type="button" onClick={() => setResendProblem(null)} className="px-4 py-2 rounded-xl bg-[#22355E] hover:bg-[#1A2A4A] text-white text-xs font-semibold">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
