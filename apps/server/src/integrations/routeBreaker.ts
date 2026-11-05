// 路径规划的任务级连续失败熔断器（provider 中立，09-25 从 amap/route.ts 抽出）。
// 背景：负缓存拆除后，provider 大面积超时（单次硬等 10s + 串行队列间隔）时，
// 首轮 geoPipeline、层3 修复器定向重算、修订轮会把失败段反复真实重试，最坏
// ROUTE_MAX_PER_TASK×10.35s≈5.2min，叠加 LLM 推理直接吃穿整任务 10min 超时（终态 cancelled）。
// 语义：同一生成任务内连续失败（超时/网络错/无方案，适配层统一吞错回 null）达阈值
// → 熔断开启：后续 estimate 直接回 null（调用方走启发式降级），不再发请求、不消耗 route 额度；
// 任一次成功（含缓存命中）清零计数。状态为任务级会话内存，不跨任务不持久化 —— 下个任务重新给服务商机会。
import type { LegMode } from '@tripweaver/shared';
import type { GeoPoint, RouteBreaker, RouteEstimate, RouteOpts } from './geoContracts';

/** 连续失败阈值：5 次足以区分「服务真的不可用」与偶发抖动，同时把最坏等待封在 ~52s */
export const ROUTE_BREAKER_THRESHOLD = 5;

export interface RouteBreakerConfig {
  /** 真实调用入口（provider 适配器自行绑定 apiKey 等凭据） */
  estimate(origin: GeoPoint, dest: GeoPoint, mode: LegMode, opts: RouteOpts): Promise<RouteEstimate | null>;
  /** 未发真实请求的前置拦截（如缺必填参数）：命中即回 null，不计失败也不扣额度 */
  skip?(origin: GeoPoint, dest: GeoPoint, mode: LegMode, opts: RouteOpts): boolean;
  /** warn 前缀（如 '[amap-route]'）：运维据此定位「整任务全启发式」根因，无敏感信息 */
  label: string;
}

/** 每个生成任务（geoSession）各建一个实例：熔断状态与该任务同生命周期 */
export function createRouteBreaker(config: RouteBreakerConfig): RouteBreaker {
  let failStreak = 0;
  let open = false;
  return {
    isOpen: () => open,
    failStreak: () => failStreak,
    async estimate(origin, dest, mode, opts, tryAcquire) {
      if (open) return null;   // 熔断开启：不发请求、不扣额度，调用方直接启发式
      // 前置拦截（如高德 transit 缺 adcode）：不会发真实请求，不计失败也不扣额度
      if (config.skip?.(origin, dest, mode, opts)) return null;
      if (!tryAcquire()) return null;   // 任务级上限拒绝：未发请求，不计失败
      const route = await config.estimate(origin, dest, mode, opts);
      if (route) {
        failStreak = 0;   // 任一次成功（含缓存命中）清零连续失败
        return route;
      }
      // 走到这里 = 一次真实调用尝试失败（超时/网络错/无方案）
      failStreak += 1;
      if (failStreak >= ROUTE_BREAKER_THRESHOLD) {
        open = true;
        // 生成会话层无 Fastify logger 可达：单行 warn 供运维定位「整任务全启发式」根因，无敏感信息
        console.warn(
          `${config.label} 路径规划连续失败 ${failStreak} 次（超时/网络错/无方案），本任务熔断：后续通勤不再请求该服务商，直接启发式降级`,
        );
      }
      return null;
    },
  };
}
