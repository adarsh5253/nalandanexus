import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import { adminApi } from '../services/adminApi';
import { disconnectSocket } from '../services/socket';

const AdminAuthContext = createContext(null);

export function AdminAuthProvider({ children }) {
  // No default-authenticated fallback user — session state starts unknown
  // (isLoading=true) and is only ever set from a real backend response.
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // On mount (and after any refresh) ask the backend who we are. The session
  // cookie is httpOnly, so this page cannot inspect it and must not try to
  // guess - /auth/me is the only way to know whether it is still valid, and it
  // also rejects a suspended or deleted account immediately.
  useEffect(() => {
    let cancelled = false;
    async function restoreSession() {
      try {
        const me = await adminApi.getMe();
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // Any 401 response from the API (expired/revoked token) clears the
  // session immediately, wherever in the app it happens.
  useEffect(() => {
    const handleUnauthorized = () => {
      disconnectSocket();
      setUser(null);
    };
    window.addEventListener('nalanda-admin-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('nalanda-admin-unauthorized', handleUnauthorized);
  }, []);

  const login = useCallback(async ({ email, password, rememberMe }) => {
    setIsLoading(true);
    setError(null);

    try {
      // The backend sets the session cookie on this response; `result.token`
      // is a transitional leftover and is deliberately not stored anywhere.
      const result = await adminApi.login({ email, password });
      setUser(result.admin);
      if (rememberMe) {
        localStorage.setItem('nalanda_admin_remembered_email', email);
      } else {
        localStorage.removeItem('nalanda_admin_remembered_email');
      }
      setIsLoading(false);
      return { success: true, user: result.admin };
    } catch (err) {
      setError(err.message || 'Invalid administrator credentials');
      setIsLoading(false);
      return { success: false, error: err.message || 'Invalid credentials' };
    }
  }, []);

  const logout = useCallback(async () => {
    // Awaited: only the backend can clear an httpOnly cookie, so a logout that
    // tore down local state without waiting could leave the browser still
    // holding a valid session.
    await adminApi.logout().catch(() => {});
    disconnectSocket();
    setUser(null);
  }, []);

  const hasRole = useCallback(
    (requiredRole) => {
      if (!user) return false;
      if (user.role === 'SUPER_ADMIN') return true;
      return user.role === requiredRole;
    },
    [user]
  );

  const hasPermission = useCallback(
    (permission) => {
      if (!user) return false;
      if (user.role === 'SUPER_ADMIN') return true;
      return (user.permissions || []).includes(permission);
    },
    [user]
  );

  const getFirstName = useCallback(() => {
    if (!user || !user.name) return 'Admin';
    const parts = user.name.split(' ');
    if (['Dr.', 'Prof.', 'Mr.', 'Ms.', 'Master'].includes(parts[0]) && parts.length > 1) {
      return parts[1];
    }
    return parts[0];
  }, [user]);

  // Memoised so the provider does not hand every consumer a new object on each
  // render: a context value rebuilt inline has a fresh identity every time,
  // which makes `useContext` fire in every subscriber regardless of whether
  // anything it reads actually changed. The callbacks below are all
  // `useCallback`-stable, so this only changes when real session state does.
  const value = useMemo(
    () => ({
      user,
      isAuthenticated: Boolean(user),
      isLoading,
      error,
      login,
      logout,
      hasRole,
      hasPermission,
      getFirstName,
    }),
    [user, isLoading, error, login, logout, hasRole, hasPermission, getFirstName]
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  const context = useContext(AdminAuthContext);
  if (!context) {
    throw new Error('useAdminAuth must be used within an AdminAuthProvider');
  }
  return context;
}
