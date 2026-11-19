import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { KeyRound, ShieldCheck, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { teacherApiService, ApiClientError } from '../services/teacherApiService';

const RULES = [
  { id: 'length', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'upper', label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
  { id: 'digit', label: 'A number', test: (p) => /\d/.test(p) },
];

/**
 * Where the link in a new teacher's onboarding email lands.
 *
 * The link is the only credential, so this page treats it carefully: it is read
 * from the address once and then removed from the address bar and browser
 * history, it is checked with the server before anything is asked of the
 * person, and every failure - used, expired, mistyped - reads the same, so the
 * page cannot be used to find out which links ever existed.
 *
 * Public by necessity (the person has no account credentials yet), which is
 * why the server rate-limits it like a login.
 */
export default function SetupPasswordPage() {
  const [searchParams] = useSearchParams();
  // Captured once. Reading it again after the address is cleaned would find nothing.
  const [token] = useState(() => searchParams.get('token') || '');

  const [phase, setPhase] = useState('checking'); // checking | invalid | ready | done
  const [details, setDetails] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    // The token must not linger in history, a screenshot of the address bar, or a
    // Referer header from anything the page might later link to.
    if (token) window.history.replaceState(null, '', window.location.pathname);

    if (!token) {
      setPhase('invalid');
      return undefined;
    }
    let cancelled = false;
    teacherApiService
      .inspectPasswordSetup(token)
      .then((data) => {
        if (cancelled) return;
        setDetails(data);
        setPhase('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        // A network failure is not "this link is bad" - say so, so a retry is the obvious move.
        if (err instanceof ApiClientError && err.status === 0) {
          setError(err.message);
          setPhase('unreachable');
        } else {
          setPhase('invalid');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const ruleResults = useMemo(() => RULES.map((r) => ({ ...r, ok: r.test(password) })), [password]);
  const allRulesMet = ruleResults.every((r) => r.ok);
  const matches = password.length > 0 && password === confirm;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!allRulesMet) {
      setError('Your password does not meet all the requirements yet.');
      return;
    }
    if (!matches) {
      setError('The two passwords do not match.');
      return;
    }
    setIsSubmitting(true);
    try {
      const data = await teacherApiService.completePasswordSetup(token, password);
      setResult(data);
      setPassword('');
      setConfirm('');
      setPhase('done');
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'SETUP_LINK_INVALID') {
        setPhase('invalid');
      } else {
        setError(err instanceof ApiClientError ? err.message : 'Could not set your password. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const shell = (children) => (
    <div className="min-h-screen bg-[#0B101B] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-[#131B2E] border border-[#243354] rounded-2xl p-6 shadow-2xl">{children}</div>
    </div>
  );

  if (phase === 'checking') {
    return shell(
      <div className="flex items-center gap-3 text-sm text-[#9B9690]" role="status">
        <Loader2 className="w-4 h-4 animate-spin" /> Checking your link…
      </div>
    );
  }

  if (phase === 'unreachable') {
    return shell(
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-[#D95248] text-sm font-bold">
          <AlertCircle className="w-5 h-5" /> Could not reach the server
        </div>
        <p className="text-xs text-[#9B9690] leading-relaxed">{error}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="w-full py-2.5 bg-[#22355E] hover:bg-[#314B82] text-white text-xs font-bold rounded-xl"
        >
          Try again
        </button>
        <p className="text-[11px] text-[#9B9690]">If the page does not reload with your link, open the link from your email again.</p>
      </div>
    );
  }

  if (phase === 'invalid') {
    return shell(
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-[#C1352B]/15 border border-[#C1352B]/40 flex items-center justify-center text-[#D95248]">
            <AlertCircle className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-bold text-[#EDEAE0]">This link can't be used</h1>
            <p className="text-xs text-[#9B9690] mt-0.5">It may have expired, already been used, or been replaced by a newer one.</p>
          </div>
        </div>
        <p className="text-xs text-[#9B9690] leading-relaxed">
          Ask your administrator to send a new setup email. If you have already chosen a password, you can sign in now.
        </p>
        <Link to="/login" className="block w-full text-center py-2.5 bg-[#22355E] hover:bg-[#314B82] text-white text-xs font-bold rounded-xl">
          Go to sign in
        </Link>
      </div>
    );
  }

  if (phase === 'done') {
    return shell(
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-[#5C7A5E]/20 border border-[#5C7A5E]/40 flex items-center justify-center text-[#5C7A5E]">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-bold text-[#EDEAE0]">Your password is set</h1>
            <p className="text-xs text-[#9B9690] mt-0.5">You can now sign in to the Teacher Portal.</p>
          </div>
        </div>
        <div className="p-3 rounded-xl bg-[#0B101B] border border-[#243354] text-xs space-y-1.5">
          <div className="flex justify-between gap-3">
            <span className="text-[#9B9690]">Sign in with your email</span>
            <span className="font-mono text-[#EDEAE0] break-all text-right">{result?.email}</span>
          </div>
          {result?.teacherId && (
            <div className="flex justify-between gap-3">
              <span className="text-[#9B9690]">or your Teacher ID</span>
              <span className="font-mono text-[#C99A2E] font-bold">{result.teacherId}</span>
            </div>
          )}
        </div>
        <Link to="/login" className="block w-full text-center py-2.5 bg-[#AB5236] hover:bg-[#94452C] text-white text-xs font-bold rounded-xl">
          Go to sign in
        </Link>
      </div>
    );
  }

  return shell(
    <>
      <div className="flex items-center gap-3 mb-5">
        <div className="w-11 h-11 rounded-xl bg-[#C99A2E]/15 border border-[#C99A2E]/40 flex items-center justify-center text-[#C99A2E]">
          <KeyRound className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-base font-bold text-[#EDEAE0]">Choose your password</h1>
          <p className="text-xs text-[#9B9690] mt-0.5">Welcome{details?.name ? `, ${details.name}` : ''}. This link works once.</p>
        </div>
      </div>

      <div className="mb-4 p-3 rounded-xl bg-[#0B101B] border border-[#243354] text-xs space-y-1.5">
        <div className="flex justify-between gap-3">
          <span className="text-[#9B9690]">Email</span>
          <span className="font-mono text-[#EDEAE0] break-all text-right">{details?.email}</span>
        </div>
        {details?.teacherId && (
          <div className="flex justify-between gap-3">
            <span className="text-[#9B9690]">Teacher ID</span>
            <span className="font-mono text-[#C99A2E] font-bold">{details.teacherId}</span>
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-4 p-2.5 rounded-lg bg-[#C1352B]/15 border border-[#C1352B]/40 text-xs text-[#D95248] flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
        <div>
          <label htmlFor="setup-password" className="block text-xs font-semibold text-[#9B9690] mb-1">
            New password
          </label>
          <input
            id="setup-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className="w-full bg-[#0B101B] border border-[#243354] rounded-lg px-3 py-2 text-xs text-[#EDEAE0] focus:outline-none focus:border-[#C99A2E]"
          />
        </div>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1" aria-label="Password requirements">
          {ruleResults.map((r) => (
            <li key={r.id} className={`text-[11px] flex items-center gap-1.5 ${r.ok ? 'text-[#7DB88C]' : 'text-[#9B9690]'}`}>
              <span aria-hidden="true">{r.ok ? '✓' : '○'}</span>
              {r.label}
            </li>
          ))}
        </ul>
        <div>
          <label htmlFor="setup-confirm" className="block text-xs font-semibold text-[#9B9690] mb-1">
            Confirm password
          </label>
          <input
            id="setup-confirm"
            type="password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className="w-full bg-[#0B101B] border border-[#243354] rounded-lg px-3 py-2 text-xs text-[#EDEAE0] focus:outline-none focus:border-[#C99A2E]"
          />
          {confirm.length > 0 && !matches && <p className="text-[11px] text-[#D95248] mt-1">The passwords do not match yet.</p>}
        </div>

        <button
          type="submit"
          disabled={isSubmitting || !allRulesMet || !matches}
          className="w-full py-2.5 bg-[#AB5236] hover:bg-[#94452C] disabled:opacity-50 text-white text-xs font-bold rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          <ShieldCheck className="w-4 h-4" />
          <span>{isSubmitting ? 'Setting password…' : 'Set password'}</span>
        </button>
      </form>
    </>
  );
}
