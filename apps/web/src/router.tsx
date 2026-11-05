import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Outlet, createBrowserRouter, useLocation } from 'react-router-dom';
import { ApiError } from './api/client';
import { useMe } from './api/hooks';
import { AppLayout } from './components/AppLayout';

// 首页是默认入口，静态引入，避免首屏多一次往返。
import { HomePage } from './pages/HomePage';

// 其余页面按路由分包：编辑器会把 Leaflet 与地图组件、生成页会把时间线一起拖走。
// 不改前实测首屏单 chunk 949.69 kB / gzip 301.08 kB，Leaflet 在首屏内。
const TripListPage = lazy(() => import('./pages/TripListPage').then((m) => ({ default: m.TripListPage })));
const NewTripPage = lazy(() => import('./pages/NewTripPage').then((m) => ({ default: m.NewTripPage })));
const GenerationPage = lazy(() => import('./pages/GenerationPage').then((m) => ({ default: m.GenerationPage })));
const TripEditorPage = lazy(() => import('./pages/TripEditorPage').then((m) => ({ default: m.TripEditorPage })));

const PAGE_LOADING = <div className={"page-loading [padding:20vh_16px] text-center [color:var(--color-muted)]"}>加载中…</div>;

/** 每个懒加载页面各自一个 Suspense 边界：等 chunk 时只替换内容区，不动顶栏。 */
const withSuspense = (node: ReactNode) => <Suspense fallback={PAGE_LOADING}>{node}</Suspense>;

function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) {
    return PAGE_LOADING;
  }
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />;
    }
    return <div className={"page-loading [padding:20vh_16px] text-center [color:var(--color-muted)]"}>服务暂不可用，请稍后刷新重试</div>;
  }
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />;
  return <Outlet />;
}

function LoginRedirect({ register = false }: { register?: boolean }) {
  const location = useLocation();
  const state: unknown = location.state;
  const from = typeof state === 'object' && state !== null && 'from' in state && typeof state.from === 'string' ? state.from : '/';
  return <Navigate to={`/${location.search}`} replace state={{ login: true, register, from }} />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginRedirect /> },
  { path: '/register', element: <LoginRedirect register /> },
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <HomePage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: '/trips', element: withSuspense(<TripListPage />) },
          { path: '/trips/new', element: withSuspense(<NewTripPage />) },
          { path: '/generations/:jobId', element: withSuspense(<GenerationPage />) },
          { path: '/trips/:id', element: withSuspense(<TripEditorPage />) },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
