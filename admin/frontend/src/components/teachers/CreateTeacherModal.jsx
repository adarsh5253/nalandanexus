import React, { useState } from 'react';
import { X, UserPlus, CheckCircle2, ShieldAlert, Mail, Info } from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import CourseChecklist from './CourseChecklist';
import { EmailStatusBadge } from './OnboardingStatus';

const DEPARTMENTS = [
  'Computer Science & Engineering',
  'Department of Physics',
  'Department of Mathematics',
  'Department of Chemistry',
  'Electrical & Electronics',
  'Mechanical Engineering',
  'Civil Engineering',
  'Artificial Intelligence & ML',
  'Humanities & Social Sciences',
];

const EMPTY_FORM = {
  name: '',
  email: '',
  phone: '',
  designation: '',
  // Neither is preselected: "Subject / Department" is required, so choosing
  // one has to be a decision, not a default left in place.
  department: '',
  subject: '',
  courseSlugs: [],
  // Shown on the public About page only when this is on (see the fields below).
  showOnWebsite: false,
  websiteRole: '',
  websiteCategory: '',
  expertise: '',
  experienceNote: '',
};

const WARNING_COPY = {
  PORTAL_PROVISIONING_FAILED:
    "The Teacher Portal login could not be created, so no email was sent (its link would lead nowhere). Use 'Resend setup email' from the teacher's profile once the Teacher Portal is reachable.",
  EMAIL_DELIVERY_FAILED: "The setup email could not be delivered — see the reason below. Fix the cause, then use 'Resend setup email' from the teacher's profile.",
  COURSE_SYNC_FAILED: "The Teacher Portal did not accept the course assignment, so the teacher would not see their students yet. Open the teacher's profile and save their courses again to retry.",
  TEACHER_ID_MISMATCH: 'The Teacher Portal could not use the Teacher ID shown here; check the ID in the email the teacher received.',
  WEBSITE_PROFILE_NOT_PUBLISHED: 'The public website profile could not be published yet.',
};

export default function CreateTeacherModal({ isOpen, onClose, onTeacherCreated }) {
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [photo, setPhoto] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successResult, setSuccessResult] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [photoNote, setPhotoNote] = useState('');

  if (!isOpen) return null;

  const set = (patch) => setFormData((f) => ({ ...f, ...patch }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.email.trim()) {
      setErrorMsg('Full name and email address are required.');
      return;
    }
    if (!formData.subject.trim() && !formData.department) {
      setErrorMsg('Choose a department or enter a subject.');
      return;
    }
    if (!formData.courseSlugs.length) {
      setErrorMsg('Assign at least one course.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg('');

    try {
      const payload = {
        name: formData.name.trim(),
        email: formData.email.trim(),
        courseSlugs: formData.courseSlugs,
        phone: formData.phone.trim() || undefined,
        designation: formData.designation.trim() || undefined,
        department: formData.department || undefined,
        subject: formData.subject.trim() || undefined,
        showOnWebsite: formData.showOnWebsite,
        websiteRole: formData.websiteRole || undefined,
        websiteCategory: formData.websiteCategory || undefined,
        // One line per point, the way an admin types a list.
        expertise: formData.expertise
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        experienceNote: formData.experienceNote || undefined,
      };
      const response = await adminApi.createTeacher(payload);
      if (!response.success) {
        setErrorMsg(response.message || 'Failed to create teacher account.');
        return;
      }

      let created = response.data;
      // The photo is a separate, optional step: a teacher is never held back by
      // an image that would not upload.
      if (photo) {
        try {
          const uploaded = await adminApi.uploadTeacherPhoto(created._id || created.id, photo);
          created = uploaded.data || created;
          setPhotoNote('');
        } catch (err) {
          setPhotoNote(`The teacher was created, but the photo could not be uploaded: ${err.message}`);
        }
      }

      setSuccessResult(created);
      setWarnings(response.meta?.warnings || []);
      onTeacherCreated?.(created, response.meta?.warnings || []);
    } catch (err) {
      setErrorMsg(err.message || 'Network error occurred while creating the teacher.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetAndClose = () => {
    setSuccessResult(null);
    setWarnings([]);
    setErrorMsg('');
    setPhotoNote('');
    setPhoto(null);
    setFormData(EMPTY_FORM);
    onClose();
  };

  const inputCls =
    'w-full bg-[#F7F5EE] border border-[#DFDACB] rounded-xl px-3.5 py-2 text-xs text-[#2B2B28] placeholder-[#9B9690] focus:outline-none focus:border-[#22355E]';

  return (
    <div className="fixed inset-0 z-50 bg-[#22355E]/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white border border-[#DFDACB] rounded-2xl max-w-xl w-full p-6 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200 overflow-y-auto max-h-[90vh]"
      >
        <button
          type="button"
          onClick={handleResetAndClose}
          aria-label="Close"
          className="absolute right-4 top-4 p-1.5 rounded-lg text-[#9B9690] hover:text-[#2B2B28] hover:bg-[#EDEAE0] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {successResult ? (
          <div className="space-y-4 py-2">
            <div
              className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-2 shadow-sm border ${
                warnings.length ? 'bg-[#C99A2E]/15 border-[#C99A2E]/30 text-[#C99A2E]' : 'bg-[#5C7A5E]/15 border-[#5C7A5E]/30 text-[#5C7A5E]'
              }`}
            >
              {warnings.length ? <ShieldAlert className="w-6 h-6" /> : <CheckCircle2 className="w-6 h-6" />}
            </div>

            <div>
              <h3 className="text-lg font-bold text-[#22355E]">{warnings.length ? 'Teacher Created — Needs Attention' : 'Teacher Created'}</h3>
              <p className="text-xs text-[#2B2B28] mt-1 leading-relaxed">
                {successResult.emailDeliveryStatus === 'sent' ? (
                  <>
                    A password-setup email was sent to <strong className="font-semibold text-[#22355E]">{successResult.email}</strong>. No password was
                    generated for anyone to see — the teacher chooses their own through the link.
                  </>
                ) : (
                  <>
                    The account for <strong className="font-semibold text-[#22355E]">{successResult.email}</strong> was created, but the setup email has not been
                    delivered yet.
                  </>
                )}
              </p>
            </div>

            {warnings.length > 0 && (
              <div className="p-3 rounded-xl bg-[#C99A2E]/10 border border-[#C99A2E]/30 space-y-1.5">
                {warnings.map((code) => (
                  <p key={code} className="text-xs text-[#8a6512] leading-relaxed">
                    ⚠ {WARNING_COPY[code] || code}
                  </p>
                ))}
                {successResult.emailDeliveryError && successResult.emailDeliveryStatus !== 'sent' && (
                  <p className="text-xs text-[#8a6512] leading-relaxed break-words">Reason: {successResult.emailDeliveryError}</p>
                )}
              </div>
            )}
            {photoNote && <p className="text-xs text-[#8a6512]">⚠ {photoNote}</p>}

            <div className="p-4 bg-[#F7F5EE] border border-[#DFDACB] rounded-xl space-y-2 text-xs">
              <div className="flex items-center justify-between text-[#2B2B28]">
                <span>Teacher ID (username):</span>
                <span className="font-mono font-bold text-[#22355E]">{successResult.teacherId}</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-[#2B2B28]">
                <span className="flex-shrink-0">Assigned courses:</span>
                <span className="font-semibold text-[#22355E] text-right">
                  {(successResult.assignedCourses || []).map((c) => c.title || c.slug.toUpperCase()).join(', ') || '—'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[#2B2B28]">
                <span>Teacher Portal login:</span>
                <span
                  className={`px-2 py-0.5 rounded font-bold border ${
                    successResult.portalProvisioned ? 'bg-[#5C7A5E]/15 text-[#5C7A5E] border-[#5C7A5E]/30' : 'bg-[#C1352B]/15 text-[#C1352B] border-[#C1352B]/30'
                  }`}
                >
                  {successResult.portalProvisioned ? 'CREATED' : 'NOT CREATED'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[#2B2B28]">
                <span>Courses sent to Teacher Portal:</span>
                <span className="font-mono text-[#9B9690]">{successResult.courseSyncStatus || '—'}</span>
              </div>
              <div className="flex items-center justify-between text-[#2B2B28]">
                <span>Setup email:</span>
                <EmailStatusBadge teacher={successResult} />
              </div>
              {successResult.setupLinkExpiresAt && (
                <div className="flex items-center justify-between text-[#2B2B28]">
                  <span>Setup link expires:</span>
                  <span className="font-mono text-[#9B9690]">{new Date(successResult.setupLinkExpiresAt).toLocaleString()}</span>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-[#EDEAE0] flex justify-end">
              <button type="button" onClick={handleResetAndClose} className="px-4 py-2 rounded-xl bg-[#22355E] hover:bg-[#1A2A4A] text-white text-xs font-semibold">
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-[#AB5236]/10 border border-[#AB5236]/30 flex items-center justify-center text-[#AB5236]">
                <UserPlus className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-[#22355E]">Create Teacher Profile</h3>
                <p className="text-xs text-[#9B9690]">Creates the Teacher Portal login and emails a secure link for the teacher to set their password</p>
              </div>
            </div>

            {errorMsg && (
              <div role="alert" className="p-3 rounded-xl bg-[#C1352B]/10 border border-[#C1352B]/30 text-[#C1352B] text-xs flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label htmlFor="teacher-name" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                  Full Name <span className="text-[#C1352B]">*</span>
                </label>
                <input id="teacher-name" type="text" required placeholder="e.g. Dr. Vikram Sarabhai" value={formData.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} />
              </div>

              <div>
                <label htmlFor="teacher-email" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                  Email Address <span className="text-[#C1352B]">*</span>
                </label>
                <input id="teacher-email" type="email" required placeholder="teacher@nalanda.edu" value={formData.email} onChange={(e) => set({ email: e.target.value })} className={inputCls} />
              </div>

              <div>
                <label htmlFor="teacher-phone" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                  Mobile Number <span className="font-normal text-[#9B9690]">(optional)</span>
                </label>
                <input id="teacher-phone" type="tel" placeholder="+91 98450 12345" value={formData.phone} onChange={(e) => set({ phone: e.target.value })} className={inputCls} />
              </div>

              <div>
                <label htmlFor="teacher-department" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                  Department <span className="text-[#C1352B]">*</span>
                </label>
                <select id="teacher-department" value={formData.department} onChange={(e) => set({ department: e.target.value })} className={inputCls}>
                  <option value="">Select department…</option>
                  {DEPARTMENTS.map((dept) => (
                    <option key={dept} value={dept}>
                      {dept}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="teacher-subject" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                  Subject <span className="font-normal text-[#9B9690]">(or choose a department)</span>
                </label>
                <input id="teacher-subject" type="text" placeholder="e.g. Data Structures & Algorithms" value={formData.subject} onChange={(e) => set({ subject: e.target.value })} className={inputCls} />
              </div>

              <div>
                <label htmlFor="teacher-designation" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                  Designation <span className="font-normal text-[#9B9690]">(optional)</span>
                </label>
                <input id="teacher-designation" type="text" placeholder="e.g. Senior Faculty" value={formData.designation} onChange={(e) => set({ designation: e.target.value })} className={inputCls} />
              </div>

              <div>
                <label htmlFor="teacher-photo" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                  Profile Photo <span className="font-normal text-[#9B9690]">(optional, up to 2 MB)</span>
                </label>
                <input
                  id="teacher-photo"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={(e) => setPhoto(e.target.files?.[0] || null)}
                  className="w-full text-[11px] text-[#2B2B28] file:mr-2 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-[#EDEAE0] file:text-[#22355E] file:text-xs file:font-semibold"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-[#EDEAE0] space-y-2">
              <div>
                <span className="block text-xs font-semibold text-[#2B2B28]">
                  Assigned Course(s) <span className="text-[#C1352B]">*</span>
                </span>
                <span className="block text-[11px] text-[#9B9690] mt-0.5">The teacher sees every student enrolled in these courses — and only these. You can change this later.</span>
              </div>
              <CourseChecklist value={formData.courseSlugs} onChange={(courseSlugs) => set({ courseSlugs })} idPrefix="create-course" />
            </div>

            <div className="p-3 rounded-xl bg-[#22355E]/5 border border-[#22355E]/15 flex items-start gap-2 text-[11px] text-[#2B2B28] leading-relaxed">
              <Info className="w-4 h-4 text-[#22355E] flex-shrink-0 mt-0.5" />
              <span>
                A Teacher ID is generated automatically and works as the username. No password is created for you to share: the teacher receives an email with a
                single-use, time-limited link to choose their own.
              </span>
            </div>

            {/* What the student site shows. Published to the student portal on
                save, and withdrawn again if this is switched off or the teacher
                is suspended - see services/studentFacultyBridge.service.js. */}
            <div className="pt-4 border-t border-[#EDEAE0] space-y-3">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  id="teacher-show-on-website"
                  checked={formData.showOnWebsite}
                  onChange={(e) => set({ showOnWebsite: e.target.checked })}
                  className="mt-0.5 w-4 h-4 rounded border-[#DFDACB] text-[#22355E] focus:ring-[#22355E]"
                />
                <span>
                  <span className="block text-xs font-semibold text-[#2B2B28]">Show on the student website</span>
                  <span className="block text-[11px] text-[#9B9690]">Adds them to the Nalanda Nexus Network section on the public About page. Email and phone are never published.</span>
                </span>
              </label>

              {formData.showOnWebsite && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="teacher-website-role" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                      Public Role
                    </label>
                    <input id="teacher-website-role" type="text" placeholder="e.g. Communication Specialist" value={formData.websiteRole} onChange={(e) => set({ websiteRole: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor="teacher-website-category" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                      Website Tab
                    </label>
                    <input id="teacher-website-category" type="text" placeholder="e.g. Communication" value={formData.websiteCategory} onChange={(e) => set({ websiteCategory: e.target.value })} className={inputCls} />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor="teacher-expertise" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                      Expertise <span className="font-normal text-[#9B9690]">(one per line)</span>
                    </label>
                    <textarea id="teacher-expertise" rows={3} placeholder={'Content Writer\nScript Writer'} value={formData.expertise} onChange={(e) => set({ expertise: e.target.value })} className={inputCls} />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor="teacher-experience" className="block text-xs font-semibold text-[#2B2B28] mb-1">
                      Experience
                    </label>
                    <input id="teacher-experience" type="text" placeholder="e.g. 5 years of national and international experience." value={formData.experienceNote} onChange={(e) => set({ experienceNote: e.target.value })} className={inputCls} />
                  </div>
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-[#EDEAE0] flex items-center justify-end gap-2.5">
              <button type="button" onClick={handleResetAndClose} disabled={isSubmitting} className="px-4 py-2 rounded-xl bg-[#EDEAE0] hover:bg-[#DFDACB] text-[#2B2B28] text-xs font-semibold transition-colors">
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-5 py-2.5 rounded-xl bg-[#AB5236] hover:bg-[#8F3E26] text-white text-xs font-semibold transition-all shadow-cta flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Creating…</span>
                  </>
                ) : (
                  <>
                    <Mail className="w-3.5 h-3.5" />
                    <span>Create & Send Setup Email</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
