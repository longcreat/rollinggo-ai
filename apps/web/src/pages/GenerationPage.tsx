import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import type { GenerationEvent, GenerationJobView } from '@tripweaver/shared';
import { fetchJobSnapshot } from '../api/hooks';
import { useActiveGeneration } from '../components/GenerationProvider';
import { GenerationRunPanel } from '../components/GenerationRunPanel';
import { Button } from '../components/ui/Button';

export function GenerationPage() {
  const { jobId = '' } = useParams();
  const run = useActiveGeneration();
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<GenerationJobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const adopt = run.adopt;
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    let alive = true;
    setSnapshot(null); setError(null);
    fetchJobSnapshot(jobId).then((next) => {
      if (!alive) return;
      setSnapshot(next);
      if (next.status === 'running') adopt(next.jobId);
    }).catch(() => { if (alive) setError('暂时无法恢复这个任务，请重试；若任务已过期，可从通知或我的行程查看结果。'); });
    return () => { alive = false; };
  }, [jobId, adopt, attempt]);
  const completed = run.completed?.jobId === jobId ? run.completed.tripId : snapshot?.status === 'done' ? snapshot.tripId : null;
  if (completed && visible) return <Navigate to={`/trips/${encodeURIComponent(completed)}`} replace />;
  if (error) return <div className="mx-auto max-w-xl px-5 py-20 text-center"><p role="alert" className="leading-7 text-ink-muted">{error}</p><div className="flex justify-center gap-3"><Button onClick={() => setAttempt((n) => n + 1)}>重试</Button><Button variant="ghost" onClick={() => navigate('/trips')}>我的行程</Button></div></div>;
  if (!snapshot) return <p role="status" className="py-20 text-center text-ink-muted">正在恢复生成进度…</p>;
  const fallback: GenerationEvent[] = snapshot.status === 'error' ? [{ type: 'job_error', message: snapshot.message ?? '生成未完成，请回首页重试' }] : snapshot.status === 'cancelled' ? [{ type: 'job_cancelled' }] : [];
  return <GenerationRunPanel events={run.jobId === jobId ? run.events : fallback} city={snapshot.destination ?? run.destination} days={snapshot.days ?? run.days}
    cancelling={run.cancelPending} cancellationError={run.cancellationError} onCancel={run.cancel}
    onReset={() => { if (run.jobId === jobId) run.reset(); navigate('/'); }}
    onOpenTrip={(tripId) => navigate(`/trips/${encodeURIComponent(tripId)}`)} />;
}
