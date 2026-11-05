// 编排 Agent 的地理编码工具：走 v0.5 高德优先解析链（GeoSession 统一记账与降级），返回 GCJ-02
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { defineTool } from './defineTool';
import type { GeoSession } from '../geoPipeline';

export function buildGeoTools(geo: GeoSession): AgentTool[] {
  const geocodeTool = defineTool({
    name: 'geocode_place',
    label: '查询地点坐标',
    description:
      '查询一个地点的经纬度坐标（GCJ-02）。仅对无把握或易混淆的重点地点使用做消歧；其余地点坐标留空即可，系统会在编排后、审校前统一解析。',
    parameters: Type.Object({
      name: Type.String({ description: '地点名称，如「浅草寺」' }),
    }),
    execute: async (_id, params) => {
      const point = await geo.resolvePlace(params.name);
      if (!point) {
        return {
          content: [{ type: 'text' as const, text: `未查到「${params.name}」的坐标，请将该活动坐标留空（不要编造），系统稍后统一解析。` }],
          details: { found: false },
        };
      }
      return {
        content: [{ type: 'text' as const, text: `「${params.name}」坐标：lat=${point.lat}, lng=${point.lng}` }],
        details: { found: true, lat: point.lat, lng: point.lng },
      };
    },
  });
  return [geocodeTool];
}
