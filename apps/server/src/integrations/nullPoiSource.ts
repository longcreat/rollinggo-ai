// POI 源的 Null 降级实现（provider 中立）：未配置高德 Key 时使用。
// 放在中立位置，避免「数据源依赖具体适配器」的反向依赖。
import type { PoiSource, SourcedPoi } from './geoContracts';
import type { SourceStatus } from './sourceStatus';

export class NullPoiSource implements PoiSource {
  readonly kind = 'null' as const;
  constructor(private reason = '站点未配置地理数据源 Key') {}

  async searchPois(): Promise<SourcedPoi[]> {
    return [];
  }
  async selfCheck(): Promise<SourceStatus> {
    return { configured: false, checked: true, ok: null, message: `${this.reason}（生成时自动降级为模型知识调研）` };
  }
}

const nullSource = new NullPoiSource();

/** 全站日额度用尽、或所选服务商未配置 Key 等场景下按需取用 */
export function getNullPoiSource(): PoiSource {
  return nullSource;
}
