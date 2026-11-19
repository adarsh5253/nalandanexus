import React from 'react';
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';

/**
 * The one way this portal reports a failed request.
 *
 * Before this, a failed fetch surfaced three different ways depending on the
 * screen: a raw error string, an "empty" state that lied about why it was
 * empty, or nothing at all. This shows what went wrong in the user's own
 * terms and - when retrying the same request could actually work (a timeout,
 * a dropped connection, a 5xx) - gives them a button that does it.
 *
 * `error` accepts an ApiError or a plain message string.
 */
export default function ErrorState({
  error,
  onRetry,
  title,
  className = '',
  compact = false,
}) {
  const code = typeof error === 'object' ? error?.code : null;
  const status = typeof error === 'object' ? error?.status : null;
  const message = typeof error === 'string' ? error : error?.message;

  const isOffline = code === 'OFFLINE' || code === 'NETWORK_ERROR';
  const isTimeout = code === 'TIMEOUT';
  // A 4xx other than 408/429 will fail identically on retry, so no button.
  const canRetry =
    Boolean(onRetry) &&
    (isOffline || isTimeout || status === 0 || status === 408 || status === 429 || !status || status >= 500);

  const heading =
    title ||
    (isOffline
      ? "You're offline"
      : isTimeout
      ? 'The server took too long'
      : status === 403
      ? "You don't have access to this"
      : status === 404
      ? 'Not found'
      : 'Could not load this');

  const Icon = isOffline ? WifiOff : AlertTriangle;

  if (compact) {
    return (
      <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-[#C1352B]/5 border border-[#C1352B]/20 ${className}`}>
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className="w-4 h-4 text-[#C1352B] shrink-0" />
          <p className="text-xs text-[#2B2B28] truncate">{message || heading}</p>
        </div>
        {canRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#22355E] text-white text-[11px] font-bold hover:bg-[#1a2a4a] transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`w-full flex items-center justify-center p-6 ${className}`}>
      <div className="max-w-sm w-full text-center space-y-3">
        <div className="w-12 h-12 mx-auto rounded-2xl bg-[#C1352B]/10 text-[#C1352B] flex items-center justify-center">
          <Icon className="w-6 h-6" />
        </div>
        <h3 className="font-heading font-bold text-sm text-[#22355E]">{heading}</h3>
        {message && <p className="text-xs text-[#2B2B28]/70 leading-relaxed">{message}</p>}
        {canRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#AB5236] hover:bg-[#92422a] text-white font-heading font-bold text-xs shadow-xs transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
