import { useEffect, useState } from 'react';

/**
 * Whether the browser currently has a network connection.
 *
 * Used to tell "the request failed" apart from "there is no network", so the
 * UI can say the honest thing instead of blaming the server, and so a screen
 * that failed while offline can recover by itself when the connection returns
 * rather than waiting for someone to find a retry button.
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  );

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return isOnline;
}

export default useOnlineStatus;
