import { useEffect, useRef, useState } from 'react';
import type { ResearchPoi } from '@tripweaver/shared';
import { advanceGenerationCards } from '../lib/generationCards';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** A fixed presentation clock consumes the latest target; SSE bursts never reset the delay. */
export function useStagedGenerationCards(target: ResearchPoi[], running: boolean, reduced: boolean): ResearchPoi[] {
  const latest = useRef(target);
  latest.current = target;
  const [shown, setShown] = useState<ResearchPoi[]>([]);
  useEffect(() => {
    if (!running || reduced) return;
    const timer = window.setInterval(() => {
      setShown(previous => advanceGenerationCards(previous, latest.current));
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [running, reduced]);
  return reduced ? target : shown;
}
