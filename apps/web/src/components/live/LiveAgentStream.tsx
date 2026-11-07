// 生成直播的 AI 面板：子 Agent 以卡片呈现，默认只看状态与结果摘要；点击卡片才打开完整工作流。
//
// 对齐 openmuse 的 TaskCard：卡片给用户看「做到哪一步、得到什么」，详细步骤留在任务详情里。
// 数据来自 useLiveTrip（阶段/工具/候选），行程与地图由同一页面的编辑工作区渲染。
import { useState } from 'react';
import { AlertCircle, Check, ChevronRight, LoaderCircle, ListChecks, Sparkles } from 'lucide-react';
import type { LivePhase, LiveStream } from '../../lib/liveAgentStream';
import type { ResearchPoi } from '@tripweaver/shared';
import { Button } from '../ui/Button';
import { Modal } from '../Modal';

function StatusIcon({ running, error, done, className = 'h-3.5 w-3.5' }: { running?: boolean; error?: boolean; done?: boolean; className?: string }) {
  if (error) return <AlertCircle className={`${className} shrink-0 text-rose-500`} aria-hidden="true" />;
  if (running) return <LoaderCircle className={`${className} shrink-0 animate-spin text-slate-500 motion-reduce:animate-none`} aria-hidden="true" />;
  if (done) return <Check className={`${className} shrink-0 text-emerald-600`} aria-hidden="true" />;
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" aria-hidden="true" />;
}

const STATUS_LABEL: Record<LivePhase['status'], string> = {
  pending: '等待中',
  running: '进行中',
  done: '已完成',
  error: '未完成',
};

function durationText(ms?: number): string | null {
  if (ms === undefined || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function phaseSummary(phase: LivePhase): string {
  if (phase.running) return phase.current ?? '正在处理…';
  if (phase.error) return phase.summary ?? '这一步没有完成';
  if (phase.done) return phase.summary ?? `${phase.completed} 步已完成`;
  return '等待开始';
}

function PhaseCard({ phase, onOpen }: { phase: LivePhase; onOpen: () => void }) {
  const percent = phase.total > 0 ? Math.round((phase.completed / phase.total) * 100) : 0;
  const duration = durationText(phase.durationMs);
  return (
    <button
      type="button"
      data-subagent-card={phase.key}
      aria-label={`查看「${phase.label}」的详细流程，${STATUS_LABEL[phase.status]}${phase.total > 0 ? `，${phase.completed}/${phase.total} 步` : ''}`}
      onClick={onOpen}
      className="mb-2 w-full min-w-0 rounded-2xl border border-slate-200/90 bg-white/95 p-3 text-left shadow-2xs transition-colors last:mb-0 hover:bg-slate-50/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
    >
      <span className="flex items-center gap-2.5">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ${
          phase.error ? 'bg-rose-50 text-rose-500' : phase.done ? 'bg-emerald-50 text-emerald-600' : 'bg-sky-50 text-sky-600'
        }`}>
          <StatusIcon running={phase.running} error={phase.error} done={phase.done} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-slate-800">{phase.label}</span>
            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-500">子 Agent</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
            <span>{STATUS_LABEL[phase.status]}</span>
            {phase.total > 0 && <span>· {phase.completed}/{phase.total} 步</span>}
            {duration && <span>· {duration}</span>}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />
      </span>
      {phase.total > 0 && (
        <span className="mt-2 block h-1 overflow-hidden rounded-full bg-slate-100">
          <span
            className={`block h-full rounded-full transition-[width] duration-300 ${phase.error ? 'bg-rose-400' : 'bg-sky-400'}`}
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
      <span className={`mt-2 block text-[11px] leading-4 ${phase.running ? 'text-slate-600' : 'text-slate-500'}`}>
        {phaseSummary(phase)}
      </span>
    </button>
  );
}

function PhaseDetail({ phase, candidates, onClose }: { phase: LivePhase; candidates: readonly ResearchPoi[]; onClose: () => void }) {
  const duration = durationText(phase.durationMs);
  return (
    <Modal title={`${phase.label} · 详细流程`} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm text-slate-700">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <StatusIcon running={phase.running} error={phase.error} done={phase.done} />
            {STATUS_LABEL[phase.status]}
          </span>
          {phase.total > 0 && <span>· {phase.completed}/{phase.total} 步</span>}
          {duration && <span>· 用时 {duration}</span>}
        </div>
        <p className="m-0 rounded-xl bg-slate-50 px-3 py-2 text-[13px] leading-relaxed text-slate-600">
          {phaseSummary(phase)}
        </p>

        {candidates.length > 0 && (
          <section>
            <h3 className="m-0 mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <Sparkles className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              收集到的 {candidates.length} 个地点
            </h3>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {candidates.map((poi) => (
                <li key={poi.id} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{poi.name}</li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="m-0 mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
            <ListChecks className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            工作流程
          </h3>
          {phase.lines.length === 0 ? (
            <p className="m-0 text-xs text-slate-400">还没有可展示的步骤。</p>
          ) : (
            <ol className="m-0 list-none space-y-1.5 p-0">
              {phase.lines.map((line) => (
                <li key={line.id} className="flex items-start gap-2 text-xs leading-5">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                    <StatusIcon running={line.running} error={line.error} done={!line.running && !line.error} />
                  </span>
                  <span className={`min-w-0 flex-1 break-words ${line.running ? 'font-medium text-slate-700' : 'text-slate-500'}`}>
                    {line.text}
                    {durationText(line.durationMs) && <span className="ml-1 text-slate-400">· {durationText(line.durationMs)}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Modal>
  );
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
  const [detail, setDetail] = useState<LivePhase | null>(null);
  const done = stream.terminal?.type === 'job_done';
  const cancelled = stream.terminal?.type === 'job_cancelled';
  const failed = stream.terminal?.type === 'job_error';
  const finished = done || cancelled || failed;
  // 顶部只放一句「当前在哪个阶段」；每个子 Agent 的细节由下面的卡片承载。
  const currentPhase = [...stream.phases].reverse().find((phase) => phase.running) ?? stream.phases.at(-1);
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
        <PhaseCard key={phase.key} phase={phase} onOpen={() => setDetail(phase)} />
      ))}
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

    {detail && (
      <PhaseDetail
        phase={stream.phases.find((phase) => phase.key === detail.key) ?? detail}
        candidates={detail.key === 'research' ? stream.candidates : []}
        onClose={() => setDetail(null)}
      />
    )}
  </div>;
}
