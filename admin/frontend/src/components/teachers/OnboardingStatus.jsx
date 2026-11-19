import React from 'react';
import { Mail, MailCheck, MailX, MailWarning, RotateCcw } from 'lucide-react';

/**
 * How the teacher's onboarding email went, stated honestly.
 *
 * "Sent" means the email provider accepted the message - not that it reached an
 * inbox, which is not tracked. A failure carries the provider's own reason, so an
 * administrator can tell a bad sender address from a typo in the recipient.
 */
const STATUS = {
  sent: { label: 'Email sent', Icon: MailCheck, cls: 'bg-[#5C7A5E]/15 text-[#5C7A5E] border-[#5C7A5E]/30' },
  failed: { label: 'Email failed', Icon: MailX, cls: 'bg-[#C1352B]/10 text-[#C1352B] border-[#C1352B]/30' },
  stubbed: { label: 'Email not configured', Icon: MailWarning, cls: 'bg-[#C99A2E]/15 text-[#8a6512] border-[#C99A2E]/30' },
  not_sent: { label: 'Email not sent', Icon: MailWarning, cls: 'bg-[#C99A2E]/15 text-[#8a6512] border-[#C99A2E]/30' },
};

export function emailStatusOf(teacher) {
  return STATUS[teacher?.emailDeliveryStatus] || null;
}

export function EmailStatusBadge({ teacher }) {
  const s = emailStatusOf(teacher);
  if (!s) return null;
  const { Icon } = s;
  const when = teacher.emailLastAttemptAt ? new Date(teacher.emailLastAttemptAt).toLocaleString() : null;
  const title =
    teacher.emailDeliveryStatus === 'sent'
      ? `Accepted by the email provider${when ? ` on ${when}` : ''}. Whether it reached the inbox is not tracked.`
      : teacher.emailDeliveryError || s.label;
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold ${s.cls}`}>
      <Icon className="w-3 h-3" />
      {s.label}
    </span>
  );
}

function expiryLabel(teacher) {
  if (!teacher.setupLinkExpiresAt) return null;
  const at = new Date(teacher.setupLinkExpiresAt);
  return at.getTime() < Date.now() ? `Expired ${at.toLocaleString()}` : `Expires ${at.toLocaleString()}`;
}

/** Full onboarding detail, with the one action that fixes it: send a new link. */
export function OnboardingPanel({ teacher, onResend, busy = false, canResend = true }) {
  const s = emailStatusOf(teacher);
  const expiry = expiryLabel(teacher);
  const portalOk = teacher.portalProvisioned;

  return (
    <div className="p-3.5 bg-[#F7F5EE] border border-[#DFDACB] rounded-xl space-y-2.5">
      <div className="flex items-center gap-2">
        <Mail className="w-3.5 h-3.5 text-[#22355E]" />
        <span className="font-bold text-[#22355E]">Onboarding email</span>
        {s ? <EmailStatusBadge teacher={teacher} /> : <span className="text-[#9B9690]">No email recorded</span>}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <dt className="text-[#9B9690]">Teacher Portal login</dt>
        <dd className={`font-semibold ${portalOk ? 'text-[#5C7A5E]' : 'text-[#C1352B]'}`}>{portalOk ? 'Created' : 'Not created yet'}</dd>
        <dt className="text-[#9B9690]">Last attempt</dt>
        <dd className="text-[#2B2B28] font-mono">{teacher.emailLastAttemptAt ? new Date(teacher.emailLastAttemptAt).toLocaleString() : '—'}</dd>
        <dt className="text-[#9B9690]">Attempts</dt>
        <dd className="text-[#2B2B28] font-mono">{teacher.emailAttempts || 0}</dd>
        <dt className="text-[#9B9690]">Setup link</dt>
        <dd className="text-[#2B2B28] font-mono">{expiry || '—'}</dd>
      </dl>

      {teacher.emailDeliveryError && teacher.emailDeliveryStatus !== 'sent' && (
        <p className="text-[11px] text-[#C1352B] leading-relaxed break-words">Reason: {teacher.emailDeliveryError}</p>
      )}

      <p className="text-[10px] text-[#9B9690] leading-relaxed">
        The email contains a single-use link for the teacher to choose their own password. No password is ever sent or shown. “Sent” means the email
        provider accepted it; inbox delivery is not tracked.
      </p>

      {onResend && (
        <button
          type="button"
          disabled={busy || !canResend}
          onClick={onResend}
          className="w-full py-2 px-3 rounded-xl bg-[#22355E] hover:bg-[#1A2A4A] disabled:opacity-60 text-white text-xs font-semibold transition-colors flex items-center justify-center gap-2"
          title="Sends a new link. Any earlier link stops working; the teacher's current password is unchanged until they use the new one."
        >
          <RotateCcw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          <span>{busy ? 'Sending…' : 'Resend setup email'}</span>
        </button>
      )}
    </div>
  );
}

export default OnboardingPanel;
