import { useEffect } from 'react';
import { LEG_MODES, type RouteOptionsRequest } from '@tripweaver/shared';
import { useRouteOptions } from '../../api/routeOptions';
import { hasValidCoord } from '../../lib/colors';
import { recommendedRoute } from '../../lib/recommendedRoute';
import { useEditorStore, type RouteReplan } from '../../store/editorStore';

/** Mounted above day filtering so both sides of cross-day moves are planned. */
export function AutoRoutePlanner() {
  const trip = useEditorStore((s) => s.trip);
  const jobs = useEditorStore((s) => s.routeReplans);
  if (!trip) return null;
  return <>{Object.values(jobs).filter((job) => job.status === 'pending').map((job) => {
    const day = trip.days.find((d) => d.id === job.dayId)!;
    const index = day.activities.findIndex((a) => a.id === job.fromId);
    return <PlanPair key={job.id} job={job} tripId={trip.id} input={{ from: day.activities[index]!, to: day.activities[index + 1]!, destination: trip.destination }} />;
  })}</>;
}

function PlanPair({ job, tripId, input }: { job: RouteReplan; tripId: string; input: RouteOptionsRequest }) {
  // Observe the same cache as the menu, but start the batch explicitly for retry.
  const { get } = useRouteOptions(job.key, tripId, input, false);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (!hasValidCoord(input.from) || !hasValidCoord(input.to)) {
        useEditorStore.getState().finishRouteReplan(job.id, undefined, '地点缺少坐标，暂时无法规划路线');
        return;
      }
      void Promise.allSettled(LEG_MODES.map((mode) => get(mode, job.refresh))).then((results) => {
        if (!active) return;
        const options = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
        const leg = recommendedRoute(options);
        useEditorStore.getState().finishRouteReplan(job.id, leg, '暂时无法推荐交通方式，请重试或手动选择');
      });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
    // Each job has immutable endpoint inputs and remounts with a new request ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
