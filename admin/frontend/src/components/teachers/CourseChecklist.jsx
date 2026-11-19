import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { adminApi } from '../../services/adminApi';

/**
 * The courses an administrator can assign to a teacher, read live from the
 * student catalogue (the only place PRARAMBH, GARUD and YODDHA exist) and picked
 * by tick. A course is identified by its slug.
 *
 * If the catalogue cannot be reached this says so and offers a retry - it never
 * shows an empty list that reads as "there are no courses".
 */
export default function CourseChecklist({ value, onChange, disabled = false, idPrefix = 'course' }) {
  const [courses, setCourses] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const items = await adminApi.getCourses({ limit: 100 });
      const seen = new Set();
      setCourses(
        items
          .filter((c) => c.slug && !seen.has(c.slug) && seen.add(c.slug))
          .map((c) => ({ slug: c.slug, title: c.title, code: c.code }))
      );
    } catch (err) {
      setError(err.message || 'The course list could not be loaded.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (slug) => {
    onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug]);
  };

  if (isLoading) {
    return <p className="text-[11px] text-[#9B9690]">Loading courses…</p>;
  }

  if (error) {
    return (
      <div className="p-3 rounded-xl bg-[#C1352B]/10 border border-[#C1352B]/30 text-[#C1352B] text-xs flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </span>
        <button type="button" onClick={load} className="flex items-center gap-1 font-semibold hover:underline">
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </div>
    );
  }

  if (!courses.length) {
    return <p className="text-[11px] text-[#C1352B]">No courses are available to assign yet.</p>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="group" aria-label="Assigned courses">
      {courses.map((c) => {
        const checked = value.includes(c.slug);
        return (
          <label
            key={c.slug}
            htmlFor={`${idPrefix}-${c.slug}`}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs cursor-pointer transition-colors ${
              checked ? 'bg-[#22355E]/10 border-[#22355E] text-[#22355E] font-semibold' : 'bg-[#F7F5EE] border-[#DFDACB] text-[#2B2B28] hover:border-[#22355E]/50'
            } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            <input
              id={`${idPrefix}-${c.slug}`}
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => toggle(c.slug)}
              className="w-4 h-4 rounded border-[#DFDACB] text-[#22355E] focus:ring-[#22355E]"
            />
            <span className="truncate" title={c.title}>
              {c.title}
            </span>
          </label>
        );
      })}
    </div>
  );
}
