import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { onUnauthorized, shouldRetryQuery } from './api/client';
import { keys } from './api/hooks';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: shouldRetryQuery },
    mutations: { retry: false },
  },
});

const unsubscribe = onUnauthorized(() => {
  const { pathname, search, hash } = router.state.location;
  if (pathname === '/login' || pathname === '/register') return;
  void queryClient.cancelQueries();
  queryClient.setQueryData(keys.me, null);
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
  sessionStorage.removeItem('tw.activeJobId');
  void router.navigate('/', { replace: true, state: { login: true, from: pathname + search + hash } });
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
