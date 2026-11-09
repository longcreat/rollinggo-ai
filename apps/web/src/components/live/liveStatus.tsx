// 直播/子 Agent 页面共用的状态图标与耗时格式（统一纯黑白灰与 Soft Radar 极简风格）。
import { AlertCircle, Check } from 'lucide-react';
import type { LivePhase } from '../../lib/liveAgentStream';
import { SoftRadar } from '../ui/SoftRadar';

export function StatusIcon({ running, error, done, className = 'h-3.5 w-3.5' }: { running?: boolean; error?: boolean; done?: boolean; className?: string }) {
  if (error) return <AlertCircle className={`${className} shrink-0 text-slate-500`} aria-hidden="true" />;
  if (running) return <SoftRadar size={14} className="text-slate-700" />;
  if (done) return <Check className={`${className} shrink-0 text-slate-600`} aria-hidden="true" />;
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" aria-hidden="true" />;
}

export const STATUS_LABEL: Record<LivePhase['status'], string> = {
  pending: '等待中',
  running: '进行中',
  done: '已完成',
  error: '未完成',
};

export function durationText(ms?: number): string | null {
  if (ms === undefined || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}
