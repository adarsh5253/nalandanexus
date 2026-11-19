import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

/**
 * A fixed strip shown only while the browser reports no connection.
 *
 * Fixed-position so it cannot shift the page's layout when it appears, and
 * `aria-live` so it is announced rather than only seen.
 */
export default function OfflineBanner() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-[#2B2B28] text-white shadow-2xl text-xs font-semibold"
    >
      <WifiOff className="w-4 h-4 text-amber-400" />
      <span>You're offline — changes won't save until the connection returns.</span>
    </div>
  );
}
