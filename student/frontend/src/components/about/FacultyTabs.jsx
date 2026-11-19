import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { nexusNetwork } from '../../data/network';
import { facultyService } from '../../services/facultyService';

/**
 * The Nalanda Nexus Network, by category.
 *
 * Leadership (the MD, the Director and the experts associated with the
 * institution) is part of this page's copy and ships with it. The teaching
 * faculty comes from the admin portal, which owns teacher records and publishes
 * the public part of them (see services/facultyService.js) - so a new
 * instructor appears here when an administrator adds them, not when the site is
 * rebuilt. Published profiles win over a bundled entry of the same name.
 *
 * The bundled entries render immediately, so the section is never empty while
 * the request is in flight, and an unreachable API leaves the page intact.
 */

// Used only for a published profile, which carries no colour of its own; the
// bundled entries keep the accent they were written with.
const ACCENTS = ['#A855F7', '#06B6D4', '#3B82F6', '#EC4899', '#10B981', '#F97316'];

const nameKey = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** One shape for both sources: bundled "highlights" and published "expertise" are the same bullet list. */
function shape(member, index, source) {
  return {
    id: member.id || `faculty-${index}`,
    name: member.name,
    role: member.role || null,
    category: member.category || 'Faculty',
    points: (member.highlights || member.expertise || []).filter(Boolean),
    experience: member.experience || null,
    accent: member.accent || ACCENTS[index % ACCENTS.length],
    source,
  };
}

function initialFor(name) {
  const parts = String(name || '').trim().split(/\s+/);
  // "Dr. Rajeev Kumar Yadav" reads better as R than D, so skip a title.
  const meaningful = parts.length > 1 && /^(dr|mr|ms|mrs|prof)\.?$/i.test(parts[0]) ? parts[1] : parts[0];
  return (meaningful?.[0] || '?').toUpperCase();
}

export default function FacultyTabs() {
  const [published, setPublished] = useState([]);
  const [activeTab, setActiveTab] = useState('All');
  const tabRefs = useRef([]);

  useEffect(() => {
    let cancelled = false;
    facultyService
      .listPublicFaculty()
      .then((rows) => {
        if (!cancelled && Array.isArray(rows)) setPublished(rows);
      })
      .catch(() => {
        // The bundled entries are already on screen; a faculty list that could
        // not be fetched must not blank out the section.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const members = useMemo(() => {
    const fromAdmin = [...published]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)))
      .map((m, i) => shape(m, i, 'admin'));
    const publishedNames = new Set(fromAdmin.map((m) => nameKey(m.name)));
    const bundled = nexusNetwork.filter((m) => !publishedNames.has(nameKey(m.name))).map((m, i) => shape(m, i, 'bundled'));
    return [...bundled, ...fromAdmin];
  }, [published]);

  const tabs = useMemo(() => ['All', ...[...new Set(members.map((m) => m.category))]], [members]);

  // A category can disappear when the published list arrives and replaces a
  // bundled entry; fall back rather than render an empty panel.
  const currentTab = tabs.includes(activeTab) ? activeTab : 'All';
  const visible = currentTab === 'All' ? members : members.filter((m) => m.category === currentTab);

  const selectByOffset = (offset) => {
    const index = tabs.indexOf(currentTab);
    const next = (index + offset + tabs.length) % tabs.length;
    setActiveTab(tabs[next]);
    tabRefs.current[next]?.focus();
  };

  const onKeyDown = (event) => {
    const keys = {
      ArrowRight: () => selectByOffset(1),
      ArrowLeft: () => selectByOffset(-1),
      Home: () => {
        setActiveTab(tabs[0]);
        tabRefs.current[0]?.focus();
      },
      End: () => {
        setActiveTab(tabs[tabs.length - 1]);
        tabRefs.current[tabs.length - 1]?.focus();
      },
    };
    const handler = keys[event.key];
    if (!handler) return;
    event.preventDefault();
    handler();
  };

  return (
    <div>
      {/* Horizontally scrollable on a phone, centred and wrapped from tablet up,
          so the tabs never overflow the page or force it sideways. */}
      <div
        role="tablist"
        aria-label="Nalanda Nexus Network categories"
        onKeyDown={onKeyDown}
        className="flex sm:flex-wrap sm:justify-center gap-2 mb-8 overflow-x-auto sm:overflow-visible -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 snap-x"
      >
        {tabs.map((tab, index) => {
          const isActive = tab === currentTab;
          return (
            <button
              key={tab}
              id={`faculty-tab-${index}`}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              role="tab"
              type="button"
              aria-selected={isActive}
              aria-controls="faculty-panel"
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(tab)}
              className={`shrink-0 snap-start px-4 py-2 rounded-full text-xs sm:text-sm font-semibold border transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#070B14] ${
                isActive
                  ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/50 shadow-sm'
                  : 'bg-white/80 dark:bg-[#0D1424]/70 text-slate-600 dark:text-slate-300 border-slate-200/90 dark:border-white/15 hover:border-cyan-500/40 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab}
              <span className="ml-2 text-[10px] font-bold text-slate-400 dark:text-slate-500 tabular-nums">
                {tab === 'All' ? members.length : members.filter((m) => m.category === tab).length}
              </span>
            </button>
          );
        })}
      </div>

      <div
        id="faculty-panel"
        role="tabpanel"
        aria-labelledby={`faculty-tab-${tabs.indexOf(currentTab)}`}
        tabIndex={-1}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6"
      >
        {visible.map((member, idx) => (
          <motion.div
            key={member.id}
            initial={{ opacity: 0, y: 15 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: Math.min(idx, 5) * 0.08 }}
            className="p-6 rounded-3xl bg-white/95 dark:bg-[#0D1424]/85 backdrop-blur-xl border border-slate-200/90 dark:border-white/15 hover:border-cyan-500/50 shadow-xl shadow-slate-200/50 dark:shadow-2xl transition-all flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div
                  className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-purple-600/20 to-cyan-500/20 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-900 dark:text-white font-bold text-lg shrink-0"
                  style={{ boxShadow: `inset 0 0 0 1px ${member.accent}33` }}
                  aria-hidden="true"
                >
                  {initialFor(member.name)}
                </div>
                <div className="min-w-0">
                  <h4 className="font-heading font-extrabold text-base sm:text-lg text-slate-900 dark:text-white leading-tight break-words">
                    {member.name}
                  </h4>
                  {member.role && (
                    <span className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 block mt-0.5 break-words">
                      {member.role}
                    </span>
                  )}
                </div>
              </div>

              {member.points.length > 0 && (
                <div className="space-y-1.5 pt-3 border-t border-slate-100 dark:border-white/10">
                  {member.points.map((point) => (
                    <div key={point} className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 shrink-0 mt-1.5" />
                      <span className="break-words">{point}</span>
                    </div>
                  ))}
                </div>
              )}

              {member.experience && (
                <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-3 pt-3 border-t border-slate-100 dark:border-white/10 leading-relaxed">
                  {member.experience}
                </p>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
