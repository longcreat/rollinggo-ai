import { createContext, useContext, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LoginPage } from '../pages/LoginPage';
import { RegisterPage } from '../pages/RegisterPage';
import { ResetPasswordPage } from '../pages/ResetPasswordPage';
import { Modal } from './Modal';

const Context = createContext<((from?: string) => void) | null>(null);

export function LoginDialogProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [target, setTarget] = useState<string | null>(null);
  const [mode, setMode] = useState<'login' | 'register' | 'reset' | null>(null);
  const state: unknown = location.state;
  const routeLogin = typeof state === 'object' && state !== null && 'login' in state && state.login === true;
  const from = routeLogin && 'from' in state && typeof state.from === 'string' ? state.from : '/';
  const activeMode = mode ?? (routeLogin && 'register' in state && state.register === true ? 'register' : 'login');
  const close = () => {
    setTarget(null);
    setMode(null);
    if (routeLogin) void navigate('/', { replace: true, state: null });
  };
  return <Context.Provider value={(destination = '/') => { setMode('login'); setTarget(destination); }}>
    {children}
    {(target !== null || routeLogin) && <Modal title={activeMode === 'register' ? '注册 RollingGo' : activeMode === 'reset' ? '找回密码' : '登录 RollingGo'} size="auth" closeOnBackdrop={false} onClose={close}>
      {activeMode === 'register'
        ? <RegisterPage embedded from={target ?? from} onSuccess={close} onLogin={() => setMode('login')} />
        : activeMode === 'reset'
          ? <ResetPasswordPage embedded onBack={() => setMode('login')} />
          : <LoginPage embedded from={target ?? from} onSuccess={close} onRegister={() => setMode('register')} onForgotPassword={() => setMode('reset')} />}
    </Modal>}
  </Context.Provider>;
}

export function useLoginDialog() {
  const open = useContext(Context);
  if (!open) throw new Error('LoginDialogProvider is required');
  return open;
}
