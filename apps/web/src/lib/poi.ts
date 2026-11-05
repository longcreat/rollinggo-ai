// 调研候选与数据源的展示文案 —— 前端唯一来源（概览卡片 / 时间线 / 打印视图共用）
import type { DataSourceKind, PoiCategory, ReservationStatus } from '@tripweaver/shared';

export const POI_CATEGORY_LABEL: Record<PoiCategory, string> = { attraction: '景点', food: '美食', hotel: '住宿' };
export const POI_CATEGORY_ICON: Record<PoiCategory, string> = { attraction: '🏞️', food: '🍜', hotel: '🏨' };

// 预约三态：required 醒目 / none 常规 / unknown 中性「建议核实」（以官方为准）
export const RESERVATION_LABEL: Record<ReservationStatus, string> = { required: '需预约', none: '无需预约', unknown: '建议核实' };

export const DATA_SOURCE_LABEL: Record<DataSourceKind, string> = { amap: '高德地点数据', websearch: '全网搜索' };
