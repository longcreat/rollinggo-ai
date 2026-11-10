// 行程体检决策卡（行前精细化）：每个 Finding 一张卡，四动作 + 按需实时核验。
// 交互参考出发鸭 PreparingDecisionsSheet：
// 按建议改 / 我自己处理 / 跳过 / 留言；全部处置完提交 → Pass 2 重排 → 新版本。
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { HEALTH_ACTIONS, type HealthCheckView, type HealthFinding } from '@rollinggo-trip/shared';
import { keys, useResolveHealthCheck, useStartHealthCheck, useVerifyFinding } from '../../api/hooks';
import { Button } from '../ui/Button';
import { Modal } from '../Modal';

const SEVERITY_LABEL: Record<HealthFinding['severity'], string> = { hard: '硬冲突', soft: '可优化' };
const ACTION_LABEL: Record<string, string> = {
  accept: '按建议改', self_handle: '我自己处理', skip: '跳过', accept_all: '按建议改',
};

function severityBadge(severity: HealthFinding['severity']) {
  return severity === 'hard'
    ? 'bg-rose-50 text-rose-700 border-rose-200'
    : 'bg-amber-50 text-amber-700 border-amber-200';
}

export function HealthCheckSheet(props: {
  open: boolean;
  onClose: () => void;
  tripId: string;
  tripUpdatedAt: number;
  check: HealthCheckView | undefined;
}) {
  const { open, onClose, tripId, tripUpdatedAt, check } = props;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const start = useStartHealthCheck(tripId);
  const verify = useVerifyFinding(tripId, check?.id ?? '');
  const resolve = useResolveHealthCheck(tripId, check?.id ?? '');
  const [actions, setActions] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const findings = check?.findings ?? [];
  const hard = useMemo(() => findings.filter((f) => f.severity === 'hard'), [findings]);
  const soft = useMemo(() => findings.filter((f) => f.severity === 'soft'), [findings]);

  const pending = findings.filter((f) => !actions[f.id]).length;
  const allDecided = findings.length > 0 && pending === 0;

  const setAction = (id: string, action: string) => setActions((prev) => ({ ...prev, [id]: action }));

  const submit = async () => {
    setError('');
    try {
      const view = await resolve.mutateAsync({
        updatedAt: tripUpdatedAt,
        decisions: findings.map((f) => ({
          findingId: f.id,
          action: (actions[f.id] === 'accept_all' ? 'accept' : actions[f.id]) as (typeof HEALTH_ACTIONS)[number],
          ...(comments[f.id]?.trim() ? { comment: comments[f.id]!.trim().slice(0, 200) } : {}),
        })),
      });
      onClose();
      // 重排产生了新版本 → 前端切换到新版本
      if (view.result && view.result.tripId !== tripId) {
        void qc.invalidateQueries({ queryKey: keys.tripVersions(tripId) }).then(() => {
          navigate(`/trips/${view.result!.tripId}`, { replace: true });
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请重试');
    }
  };

  const findingCard = (finding: HealthFinding) => {
    const decided = actions[finding.id];
    return (
      <article key={finding.id} className={`rounded-xl border p-3 ${decided ? 'opacity-60' : ''} ${finding.severity === 'hard' ? 'border-rose-200 bg-rose-50/40' : 'border-amber-200 bg-amber-50/30'}`}>
        <div className="flex items-start gap-2">
          <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium ${severityBadge(finding.severity)}`}>
            第 {finding.dayIndex} 天 · {SEVERITY_LABEL[finding.severity]}
          </span>
          <p className="text-sm text-slate-800 leading-snug m-0 flex-1">{finding.message}</p>
        </div>
        {finding.detail && <p className="mt-1 text-xs text-slate-500 m-0">{finding.detail}</p>}
        {finding.suggestion.kind !== 'none' && (
          <p className="mt-2 text-xs text-slate-600 m-0">建议：{finding.suggestion.summary}</p>
        )}
        {finding.verification && (
          <div className="mt-2 rounded-lg bg-slate-50 border border-slate-200 p-2 text-xs text-slate-600 whitespace-pre-wrap">
            {finding.verification.text}
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {(['accept', 'self_handle', 'skip'] as const).map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => setAction(finding.id, action)}
              className={`px-2.5 py-1 rounded-full border text-xs transition-colors cursor-pointer ${
                decided === action
                  ? action === 'accept' ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-slate-700 border-slate-700 text-white'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {ACTION_LABEL[action]}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void verify.mutate(finding.id)}
            disabled={verify.isPending}
            className="px-2.5 py-1 rounded-full border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-50"
          >
            {verify.isPending ? '核验中…' : finding.verification ? '重新核验' : '实时核验'}
          </button>
        </div>
        {decided === 'self_handle' && (
          <input
            value={comments[finding.id] ?? ''}
            onChange={(e) => setComments((prev) => ({ ...prev, [finding.id]: e.target.value.slice(0, 200) }))}
            placeholder="补充说明（可选，比如「已自己预约了」）"
            className="mt-2 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-slate-400"
          />
        )}
      </article>
    );
  };

  if (!open) return null;
  return (
    <Modal onClose={onClose} title="行程体检" size="sheet">
      <div className="health-check-sheet flex flex-col gap-3 min-w-[min(92vw,560px)] max-h-[80vh]">
        {!check && (start.isPending ? (
          <p className="text-sm text-slate-500 text-center py-8">正在体检…</p>
        ) : (
          <div className="text-center py-8">
            <p className="text-sm text-slate-600">检查行程的时空可行性：超载、闭馆日、排不下、远郊混排。</p>
            <Button variant="primary" className="mt-3" onClick={() => { void start.mutate(); }}>开始体检</Button>
          </div>
        ))}

        {check && (
          <>
            <div className="text-xs text-slate-500">
              {hard.length > 0 ? (
                <>发现 <b className="text-rose-600">{hard.length}</b> 处硬冲突、{soft.length} 处可优化。逐项选择处理方式，全部决定后提交。</>
              ) : soft.length > 0 ? (
                <>未发现硬冲突，{soft.length} 处可优化（不阻断出行）。</>
              ) : (
                <>体检通过：未发现结构性时空冲突。</>
              )}
            </div>
            {findings.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-2xl">✓</p>
                <p className="mt-1 text-sm text-slate-600">这份行程没有可修复的结构性问题。</p>
                <Button variant="secondary" className="mt-3" onClick={onClose}>关闭</Button>
              </div>
            )}
            <div className="flex flex-col gap-2 overflow-y-auto pr-1">
              {hard.map(findingCard)}
              {soft.map(findingCard)}
            </div>
            {findings.length > 0 && (
              <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActions(Object.fromEntries(findings.map((f) => [f.id, findings.some((x) => x.severity === 'hard') && f.severity === 'soft' ? 'skip' : 'accept'])))}
                    className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer underline underline-offset-2"
                  >
                    硬冲突全按建议改
                  </button>
                  {pending > 0 && <span className="text-xs text-slate-400">还有 {pending} 项未决定</span>}
                </div>
                <Button
                  variant="primary"
                  disabled={!allDecided || resolve.isPending}
                  onClick={() => void submit()}
                >
                  {resolve.isPending ? '正在重排…' : '提交处理'}
                </Button>
              </div>
            )}
            {error && <p className="text-xs text-rose-600 m-0" role="alert">{error}</p>}
          </>
        )}
      </div>
    </Modal>
  );
}
