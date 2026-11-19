import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Youtube, RefreshCw, Lock, EyeOff, Film, ChevronDown, ChevronRight, Clapperboard } from 'lucide-react';
import LessonVideoEditor from './LessonVideoEditor';
import YouTubeThumbnail from './YouTubeThumbnail';

/**
 * Course → module → lesson, with every video and its state at a glance, and
 * the editor opened inline under whatever is being worked on. Each module can
 * carry an introduction video of its own as well as one per lesson.
 *
 * `api` is { listCourses(), getCourse(slug), inspect(url, opts),
 * save(slug, target, payload), remove(slug, target, payload) }, where target is
 * { lessonId } or { moduleId }. Which courses appear, and whether a save is
 * allowed, is decided by the backend behind it - the Admin portal sees every
 * course, a teacher only their assigned ones - never by this component.
 * Shared verbatim by the Admin and Teacher portals.
 */

function statusOf(node) {
  const v = node.video;
  if (!v) return node.legacyVideoUrl ? { label: 'Hosted file', cls: 'bg-[#22355E]/10 text-[#22355E]' } : null;
  if (v.availability === 'unavailable') return { label: 'Unavailable', cls: 'bg-[#C1352B]/15 text-[#9A2820]' };
  if (!v.isPublished) return { label: 'Draft', cls: 'bg-[#C99A2E]/15 text-[#7A5B12]' };
  if (v.availability === 'restricted') return { label: 'Published · embed off', cls: 'bg-[#C99A2E]/15 text-[#7A5B12]' };
  return { label: 'Published', cls: 'bg-[#5C7A5E]/15 text-[#3F5A41]' };
}

const keyOf = (target) => (target.moduleId ? `m:${target.moduleId}` : `l:${target.lessonId}`);

function StatusPill({ status, testId }) {
  if (!status) return null;
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${status.cls}`} data-testid={testId}>
      {status.label}
    </span>
  );
}

function Thumb({ video }) {
  return (
    <div className="w-24 sm:w-28 aspect-video rounded-lg overflow-hidden shrink-0 bg-[#EDEAE0] flex items-center justify-center">
      {video ? <YouTubeThumbnail videoId={video.videoId} alt="" className="w-full h-full" /> : <Film className="w-5 h-5 text-[#9B9690]" aria-hidden="true" />}
    </div>
  );
}

export default function LessonVideoManager({ api, heading, description, emptyMessage }) {
  const [courses, setCourses] = useState([]);
  const [slug, setSlug] = useState('');
  const [content, setContent] = useState(null);
  const [loadingCourses, setLoadingCourses] = useState(true);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const [collapsed, setCollapsed] = useState({});

  const loadCourses = useCallback(async () => {
    setLoadingCourses(true);
    setError('');
    try {
      const list = await api.listCourses();
      setCourses(list || []);
      setSlug((current) => (current && list.some((c) => c.slug === current) ? current : list[0]?.slug || ''));
    } catch (err) {
      setError(err?.message || 'Could not load courses.');
    } finally {
      setLoadingCourses(false);
    }
  }, [api]);

  const loadContent = useCallback(
    async (courseSlug) => {
      if (!courseSlug) {
        setContent(null);
        return;
      }
      setLoadingContent(true);
      setError('');
      try {
        setContent(await api.getCourse(courseSlug));
      } catch (err) {
        setContent(null);
        setError(err?.message || 'Could not load this course.');
      } finally {
        setLoadingContent(false);
      }
    },
    [api]
  );

  useEffect(() => {
    loadCourses();
  }, [loadCourses]);

  useEffect(() => {
    setOpenKey(null);
    setNotice('');
    loadContent(slug);
  }, [slug, loadContent]);

  // Replaces one video in place, so saving never reloads (and collapses) the
  // page an editor is working through.
  const patchVideo = (target, video) => {
    setContent(
      (c) =>
        c && {
          ...c,
          modules: c.modules.map((m) =>
            target.moduleId
              ? m.moduleId === target.moduleId
                ? { ...m, video }
                : m
              : {
                  ...m,
                  lessons: m.lessons.map((l) =>
                    l.lessonId === target.lessonId ? { ...l, video, legacyVideoUrl: video ? l.legacyVideoUrl : '' } : l
                  ),
                }
          ),
        }
    );
  };

  const totals = useMemo(() => {
    const lessons = content?.modules.flatMap((m) => m.lessons) || [];
    return {
      lessons: lessons.length,
      withVideo: lessons.filter((l) => l.video).length,
      published: lessons.filter((l) => l.video?.isPublished).length,
      moduleIntros: content?.modules.filter((m) => m.video).length || 0,
    };
  }, [content]);

  const currentCourse = courses.find((c) => c.slug === slug);

  const renderEditor = (node, target, label) => (
    <div className="mt-3">
      <LessonVideoEditor
        key={`${keyOf(target)}:${node.video?.updatedAt || 'new'}`}
        lesson={node}
        api={{
          inspect: (url, opts) => api.inspect(url, opts),
          save: (payload) => api.save(slug, target, payload),
          remove: (payload) => api.remove(slug, target, payload),
        }}
        onSaved={(video, mode) => {
          patchVideo(target, video);
          setOpenKey(null);
          setNotice(
            mode === 'publish'
              ? `“${label}”: video published. Enrolled students see it now.`
              : mode === 'unpublish'
              ? `“${label}”: video unpublished. Students no longer see it.`
              : `“${label}”: draft saved. Students will not see it until it is published.`
          );
        }}
        onRemoved={() => {
          patchVideo(target, null);
          setOpenKey(null);
          setNotice(`“${label}”: video removed.`);
        }}
        onConflict={(current) => {
          // Show what is there now; the editor reopens on that version.
          patchVideo(target, current || null);
          setNotice(`“${label}” was changed by someone else. The editor now shows the current version.`);
        }}
        onClose={() => setOpenKey(null)}
      />
    </div>
  );

  const toggleButton = (key, hasVideo, label) => {
    const isOpen = openKey === key;
    return (
      <button
        type="button"
        onClick={() => {
          setNotice('');
          setOpenKey(isOpen ? null : key);
        }}
        aria-expanded={isOpen}
        aria-label={isOpen ? `Close editor for ${label}` : undefined}
        className={`shrink-0 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
          isOpen ? 'bg-[#22355E] text-white' : hasVideo ? 'bg-[#EDEAE0] text-[#22355E] hover:bg-[#DFDACB]' : 'bg-[#AB5236] text-white hover:bg-[#94452C]'
        }`}
      >
        {isOpen ? 'Close' : hasVideo ? 'Edit video' : 'Add video'}
      </button>
    );
  };

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-[#22355E] flex items-center gap-2">
            <Youtube className="w-6 h-6 text-[#AB5236]" /> {heading}
          </h1>
          <p className="text-xs sm:text-sm text-[#6E6A64] mt-1">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            loadCourses();
            loadContent(slug);
          }}
          disabled={loadingCourses || loadingContent}
          className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-[#D8D3C5] text-xs font-semibold text-[#22355E] hover:bg-[#EDEAE0] disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingCourses || loadingContent ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="p-3.5 rounded-xl bg-[#C1352B]/10 border border-[#C1352B]/30 text-[#9A2820] text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="p-3.5 rounded-xl bg-[#5C7A5E]/10 border border-[#5C7A5E]/30 text-[#3F5A41] text-sm">
          {notice}
        </div>
      )}

      {loadingCourses ? (
        <div className="p-4 rounded-xl bg-white border border-[#D8D3C5] space-y-2" aria-busy="true">
          <div className="h-3 w-24 bg-[#EDEAE0] rounded animate-pulse" />
          <div className="h-9 w-full sm:w-96 bg-[#EDEAE0] rounded-lg animate-pulse" />
        </div>
      ) : courses.length === 0 ? (
        <div className="p-8 rounded-xl bg-white border border-[#D8D3C5] text-center text-sm text-[#6E6A64]">{emptyMessage}</div>
      ) : (
        <div className="p-4 rounded-xl bg-white border border-[#D8D3C5] flex flex-col sm:flex-row sm:items-end gap-3 sm:gap-6">
          <div className="min-w-0 flex-1">
            <label htmlFor="lesson-video-course" className="block text-xs font-semibold text-[#6E6A64] mb-1">
              Course
            </label>
            <select
              id="lesson-video-course"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="w-full sm:w-96 bg-[#FAF9F4] border border-[#D8D3C5] rounded-lg px-3 py-2 text-sm text-[#2B2B28]"
            >
              {courses.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.title}
                  {c.isPublished === false ? ' (unpublished)' : ''}
                </option>
              ))}
            </select>
          </div>
          {content && (
            <dl className="flex flex-wrap gap-5 text-xs shrink-0">
              <div>
                <dt className="text-[#9B9690]">Lessons</dt>
                <dd className="font-bold text-[#22355E] text-base">{totals.lessons}</dd>
              </div>
              <div>
                <dt className="text-[#9B9690]">With video</dt>
                <dd className="font-bold text-[#22355E] text-base">{totals.withVideo}</dd>
              </div>
              <div>
                <dt className="text-[#9B9690]">Published</dt>
                <dd className="font-bold text-[#5C7A5E] text-base">{totals.published}</dd>
              </div>
              <div>
                <dt className="text-[#9B9690]">Module intros</dt>
                <dd className="font-bold text-[#22355E] text-base">{totals.moduleIntros}</dd>
              </div>
            </dl>
          )}
        </div>
      )}

      {loadingContent && (
        <div className="space-y-3" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl bg-white border border-[#D8D3C5] p-4 space-y-3">
              <div className="h-4 w-48 bg-[#EDEAE0] rounded animate-pulse" />
              <div className="h-10 w-full bg-[#F5F3EC] rounded animate-pulse" />
              <div className="h-10 w-full bg-[#F5F3EC] rounded animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {!loadingContent && content && content.modules.length === 0 && (
        <div className="p-8 rounded-xl bg-white border border-[#D8D3C5] text-center text-sm text-[#6E6A64]">
          {currentCourse?.title || 'This course'} has no modules or lessons yet.
        </div>
      )}

      {!loadingContent &&
        content?.modules.map((mod) => {
          const isCollapsed = collapsed[mod.moduleId];
          const withVideo = mod.lessons.filter((l) => l.video).length;
          const moduleTarget = { moduleId: mod.moduleId };
          const moduleKey = keyOf(moduleTarget);
          const moduleNode = { kind: 'module', lessonId: mod.moduleId, title: mod.title, video: mod.video || null, legacyVideoUrl: '' };
          return (
            <section key={mod.moduleId} className="rounded-xl bg-white border border-[#D8D3C5] overflow-hidden">
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [mod.moduleId]: !c[mod.moduleId] }))}
                className="w-full px-4 py-3 bg-[#F5F3EC] border-b border-[#D8D3C5] flex items-center justify-between gap-2 text-left"
                aria-expanded={!isCollapsed}
              >
                <span className="min-w-0 flex items-center gap-2">
                  {isCollapsed ? <ChevronRight className="w-4 h-4 text-[#6E6A64]" /> : <ChevronDown className="w-4 h-4 text-[#6E6A64]" />}
                  <span className="text-sm font-bold text-[#22355E] truncate">{mod.title}</span>
                </span>
                <span className="text-[11px] text-[#9B9690] shrink-0">
                  {withVideo}/{mod.lessons.length} with video{mod.video ? ' · intro' : ''}
                </span>
              </button>

              {!isCollapsed && (
                <ul className="divide-y divide-[#EDEAE0]">
                  <li className="px-3 sm:px-4 py-3 bg-[#FAF9F4]" data-testid={`module-intro-${mod.moduleId}`}>
                    <div className="flex items-center gap-3">
                      <Thumb video={mod.video} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-[#22355E] truncate flex items-center gap-1.5">
                          <Clapperboard className="w-3.5 h-3.5 text-[#AB5236] shrink-0" aria-hidden="true" /> Module introduction
                        </p>
                        <p className="text-[11px] text-[#9B9690] truncate">
                          {mod.video?.title || 'Optional - shown to students before the first lesson'}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          <StatusPill status={statusOf(moduleNode)} testId={`status-module-${mod.moduleId}`} />
                        </div>
                      </div>
                      {toggleButton(moduleKey, Boolean(mod.video), `${mod.title} introduction`)}
                    </div>
                    {openKey === moduleKey && renderEditor(moduleNode, moduleTarget, `${mod.title} introduction`)}
                  </li>

                  {mod.lessons.map((lesson) => {
                    const target = { lessonId: lesson.lessonId };
                    const key = keyOf(target);
                    return (
                      <li key={lesson.lessonId} className="px-3 sm:px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Thumb video={lesson.video} />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-[#2B2B28] truncate">{lesson.title}</p>
                            <p className="text-[11px] text-[#9B9690] truncate">
                              {lesson.video?.title ? lesson.video.title : <span className="font-mono">{lesson.lessonId}</span>}
                              {lesson.duration ? ` · ${lesson.duration}` : ''}
                            </p>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              <StatusPill status={statusOf(lesson)} testId={`status-${lesson.lessonId}`} />
                              {!lesson.isPublished && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#9B9690]/15 text-[#6E6A64] inline-flex items-center gap-1">
                                  <EyeOff className="w-2.5 h-2.5" /> Lesson hidden
                                </span>
                              )}
                              {lesson.isLocked && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#9B9690]/15 text-[#6E6A64] inline-flex items-center gap-1">
                                  <Lock className="w-2.5 h-2.5" /> Locked
                                </span>
                              )}
                            </div>
                          </div>
                          {toggleButton(key, Boolean(lesson.video), lesson.title)}
                        </div>
                        {openKey === key && renderEditor(lesson, target, lesson.title)}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
    </div>
  );
}
