// 通勤启发式估算（v0.5）：高德失败/超额/无 Key 时的确定性降级，生成流程永不因此失败
// 速度模型下沉到 @tripweaver/shared 的 estimateTransit（引擎与本模块共用，避免漂移），本层只补 source 标注
import { estimateTransit, type LegMode } from '@tripweaver/shared';

export interface LegEstimate {
  durationMin: number;
  distanceM: number;
  source: 'heuristic';
}

export function estimateLeg(
  origin: { lat: number; lng: number },
  dest: { lat: number; lng: number },
  mode: LegMode,
): LegEstimate {
  return { ...estimateTransit(origin, dest, mode), source: 'heuristic' };
}
