import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Trip, TripShareImageStyle } from '@tripweaver/shared';
import { downloadShareImage, isWeChat } from '../lib/export';
import { clearShareImageError, getShareImageJob, loadShareImage, shareImageSignature, startShareImageJob, subscribeShareImageJobs } from '../lib/shareImageJobs';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import { EditorIcon } from './editor/EditorIcon';
import { ShareIcon } from './ShareIcon';

const STYLE_OPTIONS: { id: TripShareImageStyle; name: string; hint: string }[] = [
  { id: 'journal', name: '旅行手账插画', hint: '清新手绘风，记录旅途的每一刻美好' },
  { id: 'ink', name: '水墨写意', hint: '东方水墨意境，感受诗意的远方' },
];
const primaryClass = 'flex min-h-11 w-full items-center justify-center rounded-full border-0 bg-brand px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-deep';
const generateClass = 'flex min-h-12 w-full items-center justify-center rounded-full border-0 bg-brand px-4 text-base font-semibold text-white transition-colors hover:bg-brand-deep';
const secondaryClass = 'flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-full border-0 bg-canvas/70 px-2 text-xs font-semibold text-[var(--color-text)] transition-colors hover:bg-hairline';

export function ExportDialog({ trip, open, onClose }: { trip: Trip; open: boolean; onClose: () => void }) {
  // 任务存在模块级 store：离开详情页再回来仍能看到进行中的生成。
  const signature = shareImageSignature(trip);
  const job = useSyncExternalStore(subscribeShareImageJobs, () => getShareImageJob(trip.id));
  const [style, setStyle] = useState<TripShareImageStyle>(() => getShareImageJob(trip.id)?.result?.style ?? getShareImageJob(trip.id)?.style ?? 'journal');
  const [view, setView] = useState<'styles' | 'result'>('styles');
  const [missingThumbnails, setMissingThumbnails] = useState<string[]>([]);
  const [missingAssistant, setMissingAssistant] = useState(false);
  const busy = job?.status === 'running';
  const error = job?.status === 'error' ? job.error ?? '' : '';
  // 签名不匹配说明结果来自旧草稿，不展示；重新生成或失败期间保留上一张成品。
  const delivered = job?.result && job.result.signature === signature ? job.result : null;
  const currentResult = delivered?.image ?? null;
  const resultStyle = delivered?.style ?? style;
  const showResult = !busy && view === 'result' && currentResult !== null;

  useEffect(() => {
    if (job?.status === 'done') setView('result');
  }, [job]);

  // 服务端已落盘过成品时直接回显（刷新页面后同样成立），用户不必再点一次生成
  useEffect(() => {
    if (open) void loadShareImage(trip, style);
  }, [open, trip, style]);

  function generate(regenerate = false) {
    startShareImageJob(trip, style, signature, regenerate);
  }

  function clearError() {
    clearShareImageError(trip.id);
  }

  if (!open) return null;
  return <Modal title="AI 生成海报" size="poster" onClose={onClose}
    footer={busy ? undefined : <>
      {error && <p role="alert" className="mb-3 mt-0 text-xs leading-5 text-[var(--color-danger)]">{error}</p>}
      {showResult ? <div className="grid grid-cols-3 gap-2">
      <Button variant="plain" className={secondaryClass} onClick={() => { setStyle(resultStyle); clearError(); setView('styles'); }}><ShareIcon name="shuffle" />更换风格</Button>
      <Button variant="plain" className={secondaryClass} onClick={() => generate(true)}><ShareIcon name="refresh" />{error ? '重试生成' : '重新生成'}</Button>
      <Button variant="plain" className={primaryClass} onClick={() => void downloadShareImage(currentResult, trip.title)}>下载</Button>
    </div> : <div className="px-1.5">
      <Button variant="plain" className={generateClass} onClick={() => generate()}>{error ? '重试生成' : '开始生成'}</Button>
      {currentResult && <Button variant="plain" className="mx-auto mt-2 block min-h-11 border-0 bg-transparent px-4 text-xs text-ink-muted hover:text-brand" onClick={() => { clearError(); setStyle(resultStyle); setView('result'); }}>返回已生成海报</Button>}
    </div>}</>}>
    {busy ? <div className="flex min-h-full flex-col items-center text-center" aria-busy="true">
      <div className="flex min-h-[300px] w-full flex-1 flex-col items-center justify-center py-4">
        <div className="flex h-[200px] w-[200px] items-center justify-center" aria-hidden="true">
          {missingAssistant ? <div className="grid h-36 w-36 place-items-center rounded-full bg-brand/5 text-brand [&_svg]:h-16 [&_svg]:w-16"><EditorIcon name="sparkle" /></div> : <img src="/share-styles/painting-assistant.png" alt="" className="h-full w-full object-contain" onError={() => setMissingAssistant(true)} />}
        </div>
        <div role="status" aria-live="polite" className="mt-5">
          <p className="m-0 text-sm font-semibold">正在生成你的旅行海报…</p>
          <p className="mb-0 mt-2 text-xs leading-5 text-ink-muted">{isWeChat() ? '你可以关闭弹窗，生成后会收到消息提醒' : '你可以关闭弹窗，生成后会通知你并自动下载图片'}</p>
        </div>
        <div role="progressbar" aria-label="正在生成海报" className="mt-6 flex h-8 w-full items-center justify-center">
          <span className="h-7 w-7 animate-spin rounded-full border-[3px] border-solid border-brand/15 border-t-brand motion-reduce:animate-none" />
        </div>
      </div>
      <div className="mb-1 mt-2 flex w-full box-border shrink-0 items-start gap-2 rounded-xl bg-canvas/65 px-4 py-3.5 text-left">
        <span className="mt-0.5 text-brand [&_svg]:h-4 [&_svg]:w-4"><EditorIcon name="bulb" /></span>
        <div><p className="m-0 text-xs font-medium text-ink-muted">小贴士：</p><p className="mb-0 mt-1 text-[11px] leading-[18px] text-ink-muted">生成完成后，随时更换风格或重新生成。</p></div>
      </div>
    </div> : showResult ? <div className="flex h-full min-h-0 flex-col">
      <img src={currentResult.url} alt={`${trip.title} AI 行程分享图`} className="mx-auto mt-2 block min-h-0 w-auto max-w-[calc(100%-24px)] flex-1 rounded-lg object-contain shadow-[0_3px_16px_var(--color-editor-menu-list-box-shadow-86)]" />
      {isWeChat() && <p className="mb-0 mt-2 shrink-0 text-center text-xs text-ink-muted">长按图片可保存或发送给朋友</p>}
    </div> : <div className="flex min-h-full flex-col justify-center">
      <p id="share-style-label" className="mb-3.5 mt-0 text-sm font-medium">选择你喜欢的风格</p>
      <div role="group" aria-labelledby="share-style-label" className="grid grid-cols-2 gap-4 p-px">
        {STYLE_OPTIONS.map(option => <Button key={option.id} variant="plain" aria-pressed={style === option.id} onClick={() => { setStyle(option.id); clearError(); }}
          className={`relative min-w-0 rounded-[11px] border border-solid p-2 text-left transition-colors ${style === option.id ? 'border-brand bg-brand/[0.025] shadow-[0_2px_10px_var(--color-editor-page-box-shadow-72)]' : 'border-transparent bg-canvas/25 hover:border-brand/30 hover:bg-brand/5'}`}>
          <span className="relative block aspect-[5/7] overflow-hidden rounded-md bg-canvas">
            {missingThumbnails.includes(option.id) ? <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas text-brand"><ShareIcon name="image" /><span className="text-xs">风格示例</span></span> : <img src={`/share-styles/${option.id}.png`} alt="" className="h-full w-full object-cover" onError={() => setMissingThumbnails(list => [...list, option.id])} />}
          </span>
          <span aria-hidden="true" className={`absolute right-2.5 top-2.5 grid h-[18px] w-[18px] place-items-center rounded-full border-2 border-solid ${style === option.id ? 'border-white bg-brand text-white' : 'border-[var(--color-border)] bg-white/90'}`}>{style === option.id && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="m5 12 4 4L19 6" /></svg>}</span>
          <span className="block px-1 pb-1 pt-3"><span className="block text-base font-semibold leading-6 text-[var(--color-text)]">{option.name}</span><span className="mt-1 block text-sm leading-5 text-ink-muted">{option.hint}</span></span>
        </Button>)}
      </div>
    </div>}
  </Modal>;
}
