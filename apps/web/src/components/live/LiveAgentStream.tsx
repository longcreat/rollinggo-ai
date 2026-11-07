// 生成直播的 AI 面板：像对话一样逐条播报规划过程，并提供停止/错误状态。
//
// 数据来自 useLiveTrip（阶段/工具/候选），行程与地图由同一页面的编辑工作区渲染。
import { AlertCircle, Check, LoaderCircle, Sparkles } from 'lucide-react';
import type { LiveStream } from '../../lib/liveAgentStream';
import { Button } from '../ui/Button';

function StatusIcon({ running, error, done }: { running?: boolean; error?: boolean; done?: boolean }) {
  if (error) return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" aria-hidden="true" />;
  if (running) return <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-500 motion-reduce:animate-none" aria-hidden="true" />;
  if (done) return <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />;
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" aria-hidden="true" />;
}

export function LiveAgentStream({ stream, destination, days, cancelling, error, lost, onCancel, onHome, onRetry }: {
  stream: LiveStream;
  destination: string;
  days?: number;
  cancelling: boolean;
  error: string | null;
  lost: boolean;
  onCancel: () => void;
  onHome: () => void;
  /** 失败后原地重试；缺省时只显示回首页。 */
  onRetry?: () => void;
}) {
  const done = stream.terminal?.type === 'job_done';
  const cancelled = stream.terminal?.type === 'job_cancelled';
  const failed = stream.terminal?.type === 'job_error';
  const finished = done || cancelled || failed;
  // 顶部只放一句「当前在哪个阶段」；具体动作由下面的阶段列表展示，避免两处重复。
  const currentPhase = [...stream.phases].reverse().find((phase) => !phase.done) ?? stream.phases.at(-1);
  const status = done
    ? '行程已生成，正在打开…'
    : cancelled
      ? '已停止生成'
      : failed
        ? '生成未完成'
        : stream.phases.length === 0
          ? '正在准备生成…'
          : stream.active && currentPhase
            ? `正在${currentPhase.label}…`
            : null;

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
      <div className="chat-bubble mb-3 break-words rounded-2xl bg-slate-50/90 px-3.5 py-2.5 text-sm leading-relaxed text-slate-800">
        <p className="m-0">正在为你规划{destination ? `「${destination}」` : ''}{days ? ` ${days} 天` : ''}行程，规划好的每天会直接出现在右边的行程和地图里。</p>
        {status && (
          <p className="mb-0 mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
            <StatusIcon running={!finished} done={done} error={failed} />{status}
          </p>
        )}
      </div>

      {stream.phases.map((phase) => (
        <section key={phase.key} className="mb-3 last:mb-0" aria-label={phase.label}>
          <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-slate-600">
            <StatusIcon done={phase.done} running={!phase.done} />
            {phase.label}
          </h3>
          <ul className="m-0 list-none space-y-1 p-0">
            {phase.lines.map((line) => (
              <li key={line.id} className="flex items-start gap-1.5 text-xs leading-5 text-slate-500">
                {line.kind === 'thought'
                  ? <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-slate-300" aria-hidden="true" />
                  : <StatusIcon running={line.running} error={line.error} done={!line.running && !line.error} />}
                <span className={`min-w-0 break-words ${line.running ? 'font-medium text-slate-700' : ''}`}>{line.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {stream.candidates.length > 0 && (
        <p className="mb-0 mt-3 text-xs leading-5 text-slate-400">
          已收集 {stream.candidates.length} 个地点：{stream.candidates.map((poi) => poi.name).join('、')}
        </p>
      )}
    </div>

    <div className="shrink-0 border-t border-slate-100 px-4 py-3">
      {error && <p className="mb-2 mt-0 text-xs text-[var(--color-danger)]" role="alert">{error}</p>}
      {failed && (
        <p className="mb-2 mt-0 text-xs text-slate-500">
          这次没有排成功，行程还没有保存。可以直接重试，或回首页调整条件后再说一次。
        </p>
      )}
      {/* 终态（完成/停止/失败）不再给停止按钮：对已结束的任务点停止只会报「无法取消」。
          失败时留在本页给「重试」——回首页等于让用户重填一遍，是这次最伤体验的一步。 */}
      {failed && onRetry ? (
        <div className="flex flex-col gap-2">
          <Button className="w-full justify-center" onClick={onRetry}>重新生成一次</Button>
          <Button variant="ghost" className="w-full justify-center" onClick={onHome}>回首页调整条件</Button>
        </div>
      ) : lost || failed ? (
        <Button variant="secondary" className="w-full justify-center" onClick={onHome}>回首页</Button>
      ) : finished ? null : (
        <Button variant="secondary" className="w-full justify-center" disabled={cancelling} onClick={onCancel}>
          {cancelling ? '正在停止…' : '停止生成'}
        </Button>
      )}
    </div>
  </div>;
}
