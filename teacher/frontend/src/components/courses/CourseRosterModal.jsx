import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Users, Search, RefreshCw, AlertTriangle } from 'lucide-react';
import Modal from '../common/Modal';
import { teacherApiService, ApiClientError } from '../../services/teacherApiService';
import { socketService } from '../../services/socketService';

const PAGE_SIZE = 25;

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Everyone enrolled in one course the teacher has been assigned.
 *
 * Read-only by design: this is who is in the course, not a gradebook. A student
 * who buys the course, redeems a coupon or edits their profile shows up here by
 * itself - the page listens for the roster event and re-reads - and the server
 * answers 404 for any course the teacher was not assigned, so there is nothing
 * to switch to.
 *
 * If the roster could not be loaded from the student portal the page says so
 * and offers a refresh, rather than showing an empty list that reads as
 * "nobody has enrolled".
 */
export default function CourseRosterModal({ course, isOpen, onClose, onChanged }) {
  const slug = course?.studentCourseSlug;
  const [students, setStudents] = useState([]);
  const [meta, setMeta] = useState(null);
  const [info, setInfo] = useState(null);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  // A response that arrives after a newer request was made must not overwrite it.
  const requestId = useRef(0);

  // Debounced, so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    if (!slug) return;
    const id = ++requestId.current;
    setIsLoading(true);
    setError('');
    try {
      const res = await teacherApiService.getAssignedCourseStudents(slug, { page, limit: PAGE_SIZE, search });
      if (id !== requestId.current) return;
      setStudents(res.data.students);
      setInfo(res.data.course);
      setMeta(res.meta);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof ApiClientError ? err.message : 'Could not load the students for this course.');
    } finally {
      if (id === requestId.current) setIsLoading(false);
    }
  }, [slug, page, search]);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  // A student enrolled, or left, or was corrected: re-read without anybody pressing anything.
  useEffect(() => {
    if (!isOpen || !slug) return undefined;
    socketService.connect();
    return socketService.on('course.roster_updated', (payload) => {
      if (!payload?.slugs || payload.slugs.includes(slug)) {
        load();
        onChanged?.();
      }
    });
  }, [isOpen, slug, load, onChanged]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setError('');
    try {
      await teacherApiService.refreshAssignedCourseStudents(slug);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not refresh from the student portal.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const syncFailed = info?.rosterSyncStatus === 'failed';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${course?.title || 'Course'} — enrolled students`} icon={Users} maxWidth="max-w-3xl">
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-[#9B9690] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name, email or enrollment number…"
              aria-label="Search students"
              className="w-full bg-[#0B101B] border border-[#243354] rounded-xl pl-8 pr-3 py-2 text-xs text-[#EDEAE0] focus:outline-none focus:border-[#C99A2E]"
            />
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="The list keeps itself up to date. Use this only if something looks missing."
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[#0B101B] hover:bg-[#182238] border border-[#243354] text-xs font-semibold text-[#EDEAE0] disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <p className="text-xs text-[#9B9690]">
          {info ? (
            <>
              <strong className="text-[#EDEAE0]">{info.studentCount}</strong> enrolled
              {info.rosterSyncedAt ? ` · last checked with the student portal ${new Date(info.rosterSyncedAt).toLocaleString()}` : ''}
            </>
          ) : (
            'Loading…'
          )}
        </p>

        {syncFailed && (
          <div role="alert" className="p-3 rounded-xl bg-[#C99A2E]/10 border border-[#C99A2E]/30 text-[11px] text-[#C99A2E] flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              The student portal could not be reached the last time this list was loaded, so it may be incomplete. New enrolments still appear as they happen.
              Press Refresh to try again.
            </span>
          </div>
        )}

        {error && (
          <div role="alert" className="p-3 rounded-xl bg-[#C1352B]/15 border border-[#C1352B]/40 text-xs text-[#D95248]">
            {error}
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-[#243354]">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#0F1626] text-[#9B9690]">
              <tr>
                <th className="py-2.5 px-3 font-semibold">Student</th>
                <th className="py-2.5 px-3 font-semibold">Enrollment No.</th>
                <th className="py-2.5 px-3 font-semibold">Batch</th>
                <th className="py-2.5 px-3 font-semibold">Enrolled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#243354]">
              {isLoading && students.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 px-3 text-center text-[#9B9690]">
                    Loading students…
                  </td>
                </tr>
              ) : students.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 px-3 text-center text-[#9B9690]">
                    {search ? 'No student matches that search.' : 'Nobody is enrolled in this course yet. Students appear here the moment they enrol.'}
                  </td>
                </tr>
              ) : (
                students.map((s) => (
                  <tr key={s.id} className="hover:bg-[#182238]/60">
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <img src={s.avatar} alt="" className="w-7 h-7 rounded-full bg-[#22355E] flex-shrink-0" loading="lazy" />
                        <div className="min-w-0">
                          <p className="font-semibold text-[#EDEAE0] truncate">{s.name}</p>
                          <p className="text-[10px] text-[#9B9690] truncate">{s.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[#C99A2E]">{s.enrollmentNumber || '—'}</td>
                    <td className="py-2.5 px-3 text-[#EDEAE0]">{s.batchCode || <span className="text-[#9B9690]">Not placed</span>}</td>
                    <td className="py-2.5 px-3 text-[#9B9690]">{formatDate(s.enrolledAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {meta && meta.totalPages > 1 && (
          <div className="flex items-center justify-between text-xs text-[#9B9690]">
            <span>
              Page {meta.page} of {meta.totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!meta.hasPrevPage || isLoading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 rounded-lg bg-[#0B101B] border border-[#243354] text-[#EDEAE0] disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!meta.hasNextPage || isLoading}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 rounded-lg bg-[#0B101B] border border-[#243354] text-[#EDEAE0] disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}

        <p className="text-[10px] text-[#9B9690] leading-relaxed">
          This is the course-wide list of who is enrolled. Grades, attendance and progress are managed per batch from Classes and Students.
        </p>
      </div>
    </Modal>
  );
}
