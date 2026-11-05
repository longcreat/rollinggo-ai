import { LoginDialogProvider, useLoginDialog } from './LoginDialogProvider';
import { useEffect, type MouseEvent } from 'react';
import { setShareImageUser } from '../lib/shareImageJobs';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLogout, useMe } from '../api/hooks';
import { Button, IconButton, Spinner } from './ui/Button';
import { TravelPreferencesProvider, useTravelPreferencesDraft } from './TravelPreferencesProvider';
import { GenerationProvider, useActiveGeneration } from './GenerationProvider';
import { NavigationProvider, useAppNavigation } from './NavigationProvider';
import { NotificationCenter } from './NotificationCenter';
import { NavigationIcon } from './NavigationIcon';

export function AppLayout() {
  const me = useMe();
  const userId = me.data?.id ?? '';
  return <LoginDialogProvider><TravelPreferencesProvider key={userId} userId={userId}>
    <NavigationProvider><GenerationProvider userId={userId}><AppLayoutContent userId={userId} /></GenerationProvider></NavigationProvider>
  </TravelPreferencesProvider></LoginDialogProvider>;
}

function AppLayoutContent({ userId }: { userId: string }) {
  useEffect(() => {
    setShareImageUser(userId);
    return () => setShareImageUser('');
  }, [userId]);
  const me = useMe();
  const logout = useLogout();
  const openLogin = useLoginDialog();
  const navigate = useNavigate();
  const location = useLocation();
  const isTripEditor = /^\/trips\/[^/]+$/.test(location.pathname) && location.pathname !== '/trips/new';

  const preferences = useTravelPreferencesDraft();
  const navigation = useAppNavigation();
  const generation = useActiveGeneration();
  const follow = (event: MouseEvent<HTMLAnchorElement>, to: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void navigation.go(to);
  };
  const generationLink = generation.running && generation.jobId ? `/generations/${encodeURIComponent(generation.jobId)}` : null;
  const progress = (mobile: boolean) => generationLink && <NavLink to={generationLink} onClick={(event) => follow(event, generationLink)} className={`generation-nav items-center justify-center gap-2 rounded-full border border-solid border-brand/10 bg-brand/[0.07] px-4 text-[13px] font-medium text-brand transition-colors hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-brand ${mobile ? 'mt-2 flex min-h-10 w-full min-[601px]:hidden' : 'mr-3 flex min-h-10 max-w-[240px] max-[600px]:hidden'}`}><Spinner /><span className="truncate">{generation.destination ? `${generation.destination} · ` : ''}生成中</span><NavigationIcon name="arrow" className="h-4 w-4 shrink-0" /></NavLink>;

  return <div className={`app-layout flex flex-col [background:var(--color-canvas)_url('/home-bg.webp')_center_/_cover_no-repeat] ${isTripEditor ? 'h-dvh max-h-dvh overflow-hidden min-h-0' : 'min-h-dvh'} [&:has(.home-page-root)_.app-main]:p-0 [@media_screen]:[&:has(.editor-page)]:h-dvh [@media_screen]:[&:has(.editor-page)]:min-h-0 [@media_screen]:[&:has(.editor-page)]:overflow-hidden [@media_screen]:[&:has(.editor-page)_.app-main]:overflow-hidden [@media_screen]:[&_.editor-page]:flex-1 [@media_screen]:[&_.editor-page]:h-auto [@media_screen]:[&_.editor-page]:max-h-none`}>
    {!isTripEditor && (
      <header className="topbar sticky top-0 z-40 shrink-0 px-[2.5%] pt-4 max-[768px]:px-3 max-[768px]:pt-[max(12px,env(safe-area-inset-top))]">
        <div className="topbar-capsule flex h-14 items-center justify-between rounded-full border border-solid border-white/75 bg-white/[0.62] pl-6 pr-5 shadow-[0_12px_32px_rgba(31,64,124,0.1)] backdrop-blur-[18px] backdrop-saturate-150 max-[600px]:pl-2 max-[600px]:pr-2">
          <div className="flex min-w-0 items-center">
            <Link to="/" onClick={(event) => follow(event, '/')} aria-label="返回首页" title="返回首页" className="brand grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink focus-visible:outline-2 focus-visible:outline-brand">
              <img className="brand-mark h-9 w-9 object-contain" src="/brand/logo-bird.png" width={256} height={256} alt="" aria-hidden="true" />
            </Link>
            <nav aria-label="主导航" className="ml-8 flex items-center gap-3 max-[600px]:ml-1 max-[600px]:gap-1">
              {([{ to: '/', label: '首页' }, { to: '/trips', label: '我的行程' }] as const).map(({ to, label }) => <NavLink key={to} to={to} end={to === '/'} onClick={event => {
                if (to === '/trips' && !userId && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                  event.preventDefault();
                  openLogin('/trips');
                } else follow(event, to);
              }} className={({ isActive }) => `flex min-h-11 items-center whitespace-nowrap rounded-2xl px-6 text-base font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-brand max-[600px]:px-3 max-[600px]:text-sm ${isActive ? 'bg-brand/10 text-brand' : 'text-ink hover:bg-white/60'}`}>{label}</NavLink>)}
            </nav>
          </div>
          <div className="topbar-actions flex shrink-0 items-center gap-6 max-[600px]:gap-1">
            {progress(false)}
            {userId && <NotificationCenter key={userId} userId={userId} />}
            {userId ? <IconButton variant="plain" aria-label="退出登录" title="退出登录" className="grid h-11 w-11 place-items-center rounded-full text-ink transition-colors hover:bg-white/70 disabled:opacity-40" disabled={preferences.saving || logout.isPending || navigation.pending} onClick={() => void navigation.perform(async () => {
              await navigate('/', { replace: true, state: null });
              await logout.mutateAsync();
              sessionStorage.removeItem('tw.activeJobId');
            })}><NavigationIcon name="logout" /></IconButton> : <Button variant="primary" disabled={!me.isSuccess} onClick={() => openLogin()}>{me.isPending ? '加载中…' : me.isError ? '暂不可用' : '登录'}</Button>}
          </div>
        </div>
        {progress(true)}
      </header>
    )}
    {navigation.error && <div role="alert" className="mx-auto mt-3 flex max-w-[calc(100%-24px)] items-center gap-3 rounded-xl bg-white/95 px-4 py-2 text-sm text-[var(--color-danger)] shadow-sm"><span>{navigation.error}</span><Button variant="plain" className="min-h-11 shrink-0 px-2 text-ink-muted" onClick={navigation.clearError}>关闭</Button></div>}
    <main className={`app-main flex min-h-0 flex-1 flex-col ${isTripEditor ? 'p-0 overflow-hidden' : 'px-[2.5%] max-[768px]:px-3'}`}><Outlet /></main>
  </div>;
}
