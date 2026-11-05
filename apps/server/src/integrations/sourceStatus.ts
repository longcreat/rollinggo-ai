// 数据源自检状态：设置页 GET /api/settings/sources-status 与冒烟脚本共用形状
export interface SourceStatus {
  configured: boolean;
  checked: boolean;
  ok: boolean | null;   // null = 未配置（无从探测）
  message: string;
}
