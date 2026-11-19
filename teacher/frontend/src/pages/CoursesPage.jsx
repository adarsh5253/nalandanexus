import React, { useState, useEffect, useCallback } from 'react';
import { BookOpen, Users, Star, Plus, ShieldCheck, IndianRupee, X } from 'lucide-react';
import { teacherApiService, ApiClientError } from '../services/teacherApiService';
import { socketService } from '../services/socketService';
import CourseRosterModal from '../components/courses/CourseRosterModal';

const STATUS_LABEL = {
  ASSIGNED: 'Assigned',
  DRAFT: 'Draft',
  PENDING_REVIEW: 'Pending Review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  ARCHIVED: 'Archived',
};

const STATUS_STYLE = {
  ASSIGNED: 'bg-[#22355E]/10 text-[#22355E] border-[#22355E]/30',
  DRAFT: 'bg-[#9B9690]/15 text-[#6E6A64] border-[#9B9690]/30',
  PENDING_REVIEW: 'bg-[#C99A2E]/15 text-[#C99A2E] border-[#C99A2E]/30',
  APPROVED: 'bg-[#5C7A5E]/15 text-[#5C7A5E] border-[#5C7A5E]/30',
  REJECTED: 'bg-[#C1352B]/15 text-[#C1352B] border-[#C1352B]/30',
  ARCHIVED: 'bg-[#9B9690]/15 text-[#6E6A64] border-[#9B9690]/30',
};

function formatPrice(priceInPaise) {
  if (!priceInPaise) return 'Free';
  return `₹${(priceInPaise / 100).toLocaleString('en-IN')}`;
}

export default function CoursesPage() {
  const [myCourses, setMyCourses] = useState([]);
  const [assignedCourses, setAssignedCourses] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // The assigned course whose enrolled students are open, or null.
  const [rosterCourse, setRosterCourse] = useState(null);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ title: '', category: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');

  const fetchAll = useCallback(async () => {
    try {
      setError(null);
      const [mine, assigned] = await Promise.all([
        teacherApiService.getCourses(),
        teacherApiService.getAssignedCourses(),
      ]);
      setMyCourses(mine || []);
      setAssignedCourses(assigned || []);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load courses.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Real-time: an admin assigning/updating/unassigning a course reaches
  // this page live — no refresh, no redeploy.
  useEffect(() => {
    socketService.connect();
    const unbindAssigned = socketService.on('course.assigned', fetchAll);
    const unbindUnassigned = socketService.on('course.unassigned', fetchAll);
    // A catalogue course added or taken away, or students enrolling in one: the
    // counts on these cards follow.
    const unbindAccess = socketService.on('course.access_changed', fetchAll);
    const unbindRoster = socketService.on('course.roster_updated', fetchAll);
    return () => {
      unbindAssigned();
      unbindUnassigned();
      unbindAccess();
      unbindRoster();
    };
  }, [fetchAll]);

  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    if (!createForm.title.trim()) {
      setCreateError('Course title is required.');
      return;
    }
    setIsSubmitting(true);
    setCreateError('');
    try {
      await teacherApiService.createCourse({ title: createForm.title.trim(), category: createForm.category.trim() || undefined });
      setCreateModalOpen(false);
      setCreateForm({ title: '', category: '' });
      fetchAll();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : 'Failed to create course module.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-[#22355E] font-display">Curriculum & Course Management</h1>
          <p className="text-xs text-[#6E6A64] mt-1">Design course modules, assign problem sets, and inspect class progress.</p>
        </div>
        <button
          type="button"
          onClick={() => setCreateModalOpen(true)}
          className="flex items-center gap-2 bg-[#AB5236] hover:bg-[#94452C] text-white font-bold px-4 py-2 rounded-xl text-xs transition-all shadow-xs"
        >
          <Plus className="w-4 h-4" /> Create Course Module
        </button>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl bg-[#C1352B]/10 border border-[#C1352B]/30 text-[#C1352B] text-xs font-medium">
          {error}
        </div>
      )}

      {/* Assigned by Admin — read-only, no edit/purchase controls. Teachers
          access these because they're assigned, they never buy them. */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#22355E]" />
          <h2 className="text-sm font-bold text-[#22355E]">Assigned by Admin</h2>
          <span className="text-[10px] font-mono font-bold text-[#22355E] bg-[#EDEAE0] px-2 py-0.5 rounded">
            {assignedCourses.length}
          </span>
        </div>

        {isLoading ? (
          <div className="p-6 rounded-2xl bg-white border border-[#D8D3C5] text-xs text-[#9B9690]">Loading…</div>
        ) : assignedCourses.length === 0 ? (
          <div className="p-6 rounded-2xl bg-white border border-[#D8D3C5] text-xs text-[#9B9690]">
            No courses have been assigned to you by an administrator yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {assignedCourses.map((course) => (
              <div
                key={course.id}
                className="rounded-2xl bg-white border border-[#D8D3C5] overflow-hidden shadow-xs flex flex-col"
              >
                {course.image && (
                  <img src={course.image} alt={course.title} className="w-full h-32 object-cover" />
                )}
                <div className="p-5 flex flex-col justify-between flex-1">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      {course.courseCode && (
                        <span className="text-[11px] font-mono font-bold text-[#22355E] bg-[#EDEAE0] border border-[#D8D3C5] px-2.5 py-0.5 rounded-full">
                          {course.courseCode}
                        </span>
                      )}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${STATUS_STYLE[course.status] || STATUS_STYLE.DRAFT}`}>
                        {STATUS_LABEL[course.status] || course.status}
                      </span>
                    </div>
                    <h3 className="text-base font-bold text-[#22355E] mt-3">{course.title}</h3>
                    {course.description && (
                      <p className="text-xs text-[#6E6A64] mt-1.5 line-clamp-2">{course.description}</p>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-[#E8E4DA]">
                    {course.kind === 'catalogue' ? (
                      <span className="flex items-center gap-1 text-xs font-bold text-[#22355E]">
                        <Users className="w-3.5 h-3.5" />
                        {course.studentCount ?? 0} enrolled
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs font-bold text-[#22355E]">
                        <IndianRupee className="w-3.5 h-3.5" />
                        {formatPrice(course.priceInPaise).replace('₹', '')}
                      </span>
                    )}
                    {course.studentCourseSlug ? (
                      <button
                        type="button"
                        onClick={() => setRosterCourse(course)}
                        className="text-[11px] font-bold text-[#AB5236] hover:underline flex items-center gap-1"
                      >
                        <Users className="w-3.5 h-3.5" />
                        View students{course.kind !== 'catalogue' && course.studentCount != null ? ` (${course.studentCount})` : ''}
                      </button>
                    ) : (
                      <span className="text-[10px] text-[#9B9690]">Access via assignment — no purchase required</span>
                    )}
                  </div>
                  {course.rosterSyncStatus === 'failed' && (
                    <p className="mt-2 text-[10px] text-[#C1352B]">The student list could not be loaded from the student portal yet — open it and press Refresh.</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* My Courses — teacher-authored curriculum modules, full CRUD */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-[#22355E]" />
          <h2 className="text-sm font-bold text-[#22355E]">My Course Modules</h2>
          <span className="text-[10px] font-mono font-bold text-[#22355E] bg-[#EDEAE0] px-2 py-0.5 rounded">
            {myCourses.length}
          </span>
        </div>

        {isLoading ? (
          <div className="p-6 rounded-2xl bg-white border border-[#D8D3C5] text-xs text-[#9B9690]">Loading…</div>
        ) : myCourses.length === 0 ? (
          <div className="p-6 rounded-2xl bg-white border border-[#D8D3C5] text-xs text-[#9B9690]">
            You haven't created any course modules yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {myCourses.map((course) => (
              <div key={course.id} className="p-6 rounded-2xl bg-[#FFFFFF] border border-[#D8D3C5] hover:border-[#22355E] transition-all flex flex-col justify-between group shadow-xs">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-[#22355E] bg-[#EDEAE0] border border-[#D8D3C5] px-2.5 py-0.5 rounded-full">
                      {course.category || 'Uncategorized'}
                    </span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-[#5C7A5E]/15 text-[#5C7A5E] border border-[#5C7A5E]/30 capitalize">
                      {course.status}
                    </span>
                  </div>
                  <h3 className="text-base font-bold text-[#22355E] group-hover:text-[#AB5236] transition-colors mt-3">
                    {course.title}
                  </h3>
                  <div className="flex items-center gap-4 text-xs text-[#6E6A64] mt-3">
                    <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> {course.students} students</span>
                    <span className="flex items-center gap-1.5"><BookOpen className="w-3.5 h-3.5" /> {course.modules} modules</span>
                    {course.rating != null && (
                      <span className="flex items-center gap-1.5"><Star className="w-3.5 h-3.5 text-[#C99A2E] fill-[#C99A2E]" /> {course.rating}</span>
                    )}
                  </div>
                  {course.completionRate != null && (
                    <div className="mt-4 pt-3 border-t border-[#E8E4DA]">
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="text-[#6E6A64]">Class Completion</span>
                        <span className="font-bold text-[#22355E] font-mono">{course.completionRate}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-[#EDEAE0] rounded-full overflow-hidden">
                        <div className="h-full bg-[#5C7A5E] rounded-full" style={{ width: `${course.completionRate}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {createModalOpen && (
        <div className="fixed inset-0 z-50 bg-[#22355E]/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-[#D8D3C5] rounded-2xl max-w-md w-full p-6 shadow-2xl relative">
            <button
              type="button"
              onClick={() => setCreateModalOpen(false)}
              className="absolute right-4 top-4 p-1.5 rounded-lg text-[#9B9690] hover:text-[#2B2B28] hover:bg-[#EDEAE0]"
            >
              <X className="w-4 h-4" />
            </button>
            <h3 className="text-base font-bold text-[#22355E] mb-4">Create Course Module</h3>
            <form onSubmit={handleCreateSubmit} className="space-y-3">
              {createError && (
                <div className="p-2.5 rounded-xl bg-[#C1352B]/10 border border-[#C1352B]/30 text-[#C1352B] text-xs">
                  {createError}
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-[#2B2B28] mb-1">Title *</label>
                <input
                  type="text"
                  required
                  value={createForm.title}
                  onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })}
                  placeholder="e.g. Advanced Electrodynamics"
                  className="w-full bg-[#F7F5EE] border border-[#D8D3C5] rounded-xl px-3.5 py-2 text-xs text-[#2B2B28] placeholder-[#9B9690] focus:outline-none focus:border-[#22355E]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#2B2B28] mb-1">Category</label>
                <input
                  type="text"
                  value={createForm.category}
                  onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}
                  placeholder="e.g. Foundation Skills"
                  className="w-full bg-[#F7F5EE] border border-[#D8D3C5] rounded-xl px-3.5 py-2 text-xs text-[#2B2B28] placeholder-[#9B9690] focus:outline-none focus:border-[#22355E]"
                />
              </div>
              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-[#EDEAE0] hover:bg-[#D8D3C5] text-[#2B2B28] text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-xl bg-[#AB5236] hover:bg-[#94452C] text-white text-xs font-bold disabled:opacity-60"
                >
                  {isSubmitting ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <CourseRosterModal course={rosterCourse} isOpen={Boolean(rosterCourse)} onClose={() => setRosterCourse(null)} onChanged={fetchAll} />
    </div>
  );
}
