import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

type Guard = () => Promise<void>;
interface NavigationContext {
  register: (guard: Guard) => () => void;
  perform: (action: () => void | Promise<void>) => Promise<boolean>;
  go: (to: string) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
}
const Context = createContext<NavigationContext | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const guard = useRef<Guard | null>(null);
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const register = useCallback((next: Guard) => {
    guard.current = next;
    return () => { if (guard.current === next) guard.current = null; };
  }, []);
  const perform = useCallback(async (action: () => void | Promise<void>) => {
    if (locked.current) return false;
    locked.current = true; setPending(true); setError(null);
    try { await guard.current?.(); await action(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : '暂时无法离开，请重试'); return false; }
    finally { locked.current = false; setPending(false); }
  }, []);
  const go = useCallback((to: string) => perform(() => navigate(to)), [navigate, perform]);
  return <Context.Provider value={{ register, perform, go, pending, error, clearError: () => setError(null) }}>{children}</Context.Provider>;
}

export function useAppNavigation() {
  const value = useContext(Context);
  if (!value) throw new Error('NavigationProvider is required');
  return value;
}
