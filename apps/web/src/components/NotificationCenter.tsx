import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import { TripSchema, TripShareImageResponseSchema, type GenerationNotification, type Trip, type TripShareImageResponse } from '@tripweaver/shared';
import { api, ApiError } from '../api/client';
import { keys, useNotifications, useReadNotifications } from '../api/hooks';
import { useNotificationStream } from '../hooks/useNotificationStream';
import { useDismissibleDisclosure } from './ui/Dropdown';
import { Button, IconButton } from './ui/Button';
import { Modal } from './Modal';
import { NavigationIcon } from './NavigationIcon';
import { useAppNavigation } from './NavigationProvider';
import { subscribeShareImageCompletion } from '../lib/shareImageJobs';
import { downloadShareImage, isWeChat } from '../lib/export';

const actionLabel = (item: GenerationNotification) => item.shareImageStyle ? '下载图片' : item.kind === 'success' ? '查看行程' : '返回重试';

function notificationTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (now.getTime() - timestamp < 60_000) return '刚刚';
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)} ${time}`;
}

export function NotificationCenter({ userId }: { userId: string }) {
  const query = useNotifications(userId);
  useNotificationStream(userId);        // 实时提示；列表本身仍由 query 负责
  const read = useReadNotifications(userId);
  const navigation = useAppNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const ref = useRef<HTMLDetailsElement>(null);
  const disclosure = useDismissibleDisclosure(ref);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState<GenerationNotification | null>(null);
  const [paused, setPaused] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TripShareImageResponse | null>(null);
  const [toastHost, setToastHost] = useState<Element>(document.body);
  const shownToasts = useRef(new Set<string>());
  const mounted = useRef(true);
  const lastSequence = useRef<number | undefined>(undefined);
  const readAttempts = useRef(new Set<string>());
  const first = query.data?.pages[0];
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const hasUnread = first?.hasUnread ?? false;
  const routeTripId = /^\/trips\/([^/]+)$/.exec(location.pathname)?.[1] ?? '';
  const displayedTrip = useQuery<Trip>({ queryKey: keys.trip(routeTripId), queryFn: skipToken, enabled: false });
  const markRead = read.mutate;
  const hasToast = toast !== null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => subscribeShareImageCompletion(event => {
    if (event.userId !== userId) return;
    if (event.notification.id) shownToasts.current.add(event.notification.id);
    setPaused(false); setOpenError(null);
    setToast({ ...event.notification, message: event.downloadStarted
      ? '图片已生成，已为你发起自动下载。也可以点击下方再次下载。'
      : isWeChat() ? '图片已生成，点击下方查看图片，长按即可保存。' : '图片已生成，请点击下方下载图片。' });
    void qc.invalidateQueries({ queryKey: keys.notifications(userId) });
  }), [userId, qc]);

  // 原生 dialog 在浏览器顶层；提醒挂进当前弹窗，避免被遮罩遮住或无法点击。
  useEffect(() => {
    if (!hasToast) return;
    const updateHost = () => setToastHost(Array.from(document.querySelectorAll('dialog[open]')).at(-1) ?? document.body);
    updateHost();
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, [hasToast]);

  useEffect(() => {
    if (!displayedTrip.data || displayedTrip.data.id !== routeTripId) return;
    for (const item of rows) {
      if (item.shareImageStyle || item.tripId !== routeTripId || item.readAt !== null || readAttempts.current.has(item.id)) continue;
      readAttempts.current.add(item.id);
      markRead({ id: item.id }, { onError: () => readAttempts.current.delete(item.id) });
    }
  }, [displayedTrip.data, routeTripId, rows, markRead]);

  useEffect(() => {
    if (!first) return;
    if (lastSequence.current === undefined) { lastSequence.current = first.readThrough; return; }
    // 隐藏／未聚焦标签不争抢提醒；重新可见时只显示最近一条。
    const showLatest = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const item = rows.find((row) => row.sequence > (lastSequence.current ?? 0) && row.readAt === null && !shownToasts.current.has(row.id));
      lastSequence.current = Math.max(lastSequence.current ?? 0, first.readThrough);
      // 只在「正在看这一轮的生成进度页」时抑制：生成完成会自动跳到 /trips/:id，
      // 那是系统跳转而非用户主动查看结果，完成提醒应该照弹（否则红点先亮、弹窗晚到）。
      if (item && (item.shareImageStyle || location.pathname !== `/generations/${item.jobId}`)) {
        shownToasts.current.add(item.id); setPaused(false); setOpenError(null); setToast(item);
      }
    };
    showLatest();
    window.addEventListener('focus', showLatest);
    document.addEventListener('visibilitychange', showLatest);
    return () => { window.removeEventListener('focus', showLatest); document.removeEventListener('visibilitychange', showLatest); };
  }, [first, rows, location.pathname]);

  useEffect(() => {
    if (!toast || paused) return;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'visible' && document.hasFocus()) timer = window.setTimeout(() => setToast(null), 8_000);
    };
    schedule();
    window.addEventListener('focus', schedule);
    window.addEventListener('blur', schedule);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', schedule);
      window.removeEventListener('blur', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [toast, paused]);

  const open = async (item: GenerationNotification) => {
    if (opening || navigation.pending) return;
    setOpening(item.id); setOpenError(null);
    const success = await navigation.perform(async () => {
      if (item.shareImageStyle && item.tripId) {
        let image: unknown;
        try { image = await api.get<unknown>(`/api/trips/${encodeURIComponent(item.tripId)}/share-image?style=${item.shareImageStyle}`); }
        catch (error) {
          if (error instanceof ApiError && error.status === 404) throw new Error('图片暂不可用，请打开行程重新生成。');
          throw error;
        }
        if (!mounted.current) return;
        if (!Value.Check(TripShareImageResponseSchema, image)) throw new Error('图片暂时无法下载，请重试');
        if (isWeChat()) setPreview(image);
        else if (!await downloadShareImage(image, item.title.replace(/ · 图片已生成$/, ''))) throw new Error('图片暂时无法下载，请重试');
      } else if (item.kind === 'success' && item.tripId) {
        let result: unknown;
        try { result = await api.get<unknown>(`/api/trips/${encodeURIComponent(item.tripId)}`); }
        catch (error) {
          if (error instanceof ApiError && error.status === 404) throw new Error('该行程已不可用，请前往我的行程查看其他行程。');
          throw error;
        }
        if (!Value.Check(TripSchema, result)) throw new Error('行程暂时无法打开，请重试');
        qc.setQueryData(keys.trip(item.tripId), result);
        await navigate(`/trips/${encodeURIComponent(item.tripId)}`);
      } else { await navigate('/'); }
      if (mounted.current && item.id) markRead({ id: item.id });
    });
    if (!mounted.current) return;
    if (success) { if (ref.current) ref.current.open = false; setMobileOpen(false); setToast(null); }
    else setOpenError('未能打开，请查看提示后重试。');
    setOpening(null);
  };

  const readAll = <Button variant="plain" className="min-h-10 shrink-0 px-2 text-[13px] font-medium text-brand disabled:opacity-40" disabled={!hasUnread || read.isPending} onClick={() => first && markRead({ through: first.readThrough })}>{read.isPending ? '正在更新…' : '全部已读'}</Button>;
  const contents = <>
    {query.isPending && <p role="status" className="m-0 px-4 py-8 text-center text-sm text-ink-muted">正在读取通知…</p>}
    {query.isError && <div role="alert" className="px-4 py-5 text-center text-sm text-ink-muted"><p>通知暂时无法加载</p><Button variant="ghost" onClick={() => void query.refetch()}>重新加载</Button></div>}
    {!query.isPending && !query.isError && rows.length === 0 && <div className="px-4 py-9 text-center"><p className="m-0 font-medium text-ink">暂无通知</p><p className="mb-0 mt-2 text-[13px] leading-relaxed text-ink-muted">行程或图片生成完成后会出现在这里。</p></div>}
    <div className="notification-list flex max-h-[min(440px,60dvh)] flex-col gap-1 overflow-y-auto overscroll-contain" onScroll={(event) => {
      // 滚到底部附近就取下页；距底 120px 开始预取，避免看到空白
      const el = event.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 120) return;
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    }}>
      {rows.map((item) => <div key={item.id} className={`notification-item flex w-full items-center gap-4 rounded-xl px-3 py-[11px] text-left transition-colors ${item.readAt === null ? 'bg-brand/[0.06]' : 'bg-transparent'}`}>
        <span aria-hidden="true" className={`mt-0.5 h-2.5 w-2.5 shrink-0 self-start translate-y-1 ${item.readAt === null ? 'bg-brand' : 'bg-ink-muted/45'} rounded-full`} />
        <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold leading-6 text-ink">{item.title}</span><time dateTime={new Date(item.createdAt).toISOString()} className="mt-0.5 block text-xs text-ink-muted">{notificationTime(item.createdAt)}</time></span>
        <Button variant="plain" className="flex min-h-11 shrink-0 items-center rounded-lg px-2 text-xs font-medium text-brand transition-colors hover:bg-hairline disabled:opacity-60" disabled={opening !== null || navigation.pending} onClick={() => void open(item)} aria-label={`${actionLabel(item)}：${item.title}${item.readAt === null ? '（未读）' : ''}`}>{opening === item.id ? '正在打开…' : actionLabel(item)}</Button>
      </div>)}
    </div>
    {query.isFetchingNextPage && <p role="status" className="m-0 px-4 py-3 text-center text-xs text-ink-muted">正在加载…</p>}
    {(read.isError || openError) && <p role="alert" className="mx-3 mb-2 text-xs leading-relaxed text-[var(--color-danger)]">{read.isError ? '已读状态保存失败，请重试。' : openError}</p>}
  </>;

  return <>
    <details ref={ref} className="notification-disclosure relative" {...disclosure}>
      <summary className="relative grid h-11 w-11 cursor-pointer list-none place-items-center rounded-full text-ink transition-colors hover:bg-white/70 focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden" aria-label={hasUnread ? '通知，有未读消息' : '通知，无未读消息'} title="通知" onClick={(event) => {
        if (window.matchMedia('(max-width: 600px)').matches) { event.preventDefault(); setMobileOpen(true); }
      }}>
        <NavigationIcon name="bell" />
        {hasUnread && <span data-testid="notification-dot" aria-hidden="true" className="absolute right-[9px] top-[6px] h-2 w-2 rounded-full bg-[var(--color-danger)] ring-2 ring-[var(--color-canvas)]" />}
      </summary>
      <section aria-label="通知面板" className="notification-panel absolute -right-[84px] top-full z-50 mt-1.5 w-[400px] max-w-[calc(100vw-24px)] rounded-xl border border-solid border-white bg-white/95 p-2.5 shadow-[0_16px_40px_rgba(31,64,124,0.12)] backdrop-blur-xl">
        <div className="flex min-h-10 items-center justify-between px-3"><h2 className="m-0 text-base font-semibold text-ink">通知</h2>{readAll}</div>
        {contents}
      </section>
    </details>
    {mobileOpen && createPortal(<Modal title="通知" size="sheet" onClose={() => setMobileOpen(false)}><div className="-mt-3 mb-1 flex justify-end">{readAll}</div>{contents}</Modal>, document.body)}
    {preview && createPortal(<Modal title="保存图片" size="photo" onClose={() => setPreview(null)}><img src={preview.url} alt="已生成的旅行海报" className="block max-h-[70dvh] w-full object-contain" /><p className="text-center text-sm text-ink-muted">长按图片保存到相册</p></Modal>, document.body)}
    {toast && createPortal(<aside role="status" aria-live="polite" className="notification-toast fixed right-[2.5%] top-24 z-50 flex w-[380px] max-w-[calc(100vw-24px)] items-start gap-3 rounded-2xl border border-solid border-white bg-white/95 p-4 text-ink shadow-[0_12px_36px_rgba(31,64,124,0.16)] backdrop-blur-xl max-[600px]:right-3 max-[600px]:top-auto max-[600px]:bottom-5" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
      <div className="min-w-0 flex-1 text-left"><span className="block text-sm font-semibold">{toast.title}</span><span className="mt-1.5 block text-[13px] leading-6 text-ink-muted">{toast.message}</span><Button variant="plain" className="mt-2 flex min-h-8 items-center rounded-lg px-2 text-sm text-brand transition-colors hover:bg-hairline disabled:opacity-60" onClick={() => void open(toast)} disabled={opening !== null || navigation.pending} aria-label={`${actionLabel(toast)}：${toast.title}`}>{actionLabel(toast)}</Button>{openError && <span role="alert" className="mt-1 block text-xs leading-5 text-[var(--color-danger)]">{navigation.error ?? openError}</span>}</div>
      <IconButton variant="plain" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-hairline" aria-label="关闭完成提醒" onClick={() => setToast(null)}><NavigationIcon name="close" className="h-4 w-4" /></IconButton>
    </aside>, toastHost)}
  </>;
}
