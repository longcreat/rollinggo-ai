// 实体归一键（09-23）：trim + 去尾部机构后缀。
//
// 09-27 从 generation/scheduling/placeFacts 下沉到这里：图片适配器也要用它做命中闸门，
// 而适配器不该依赖 placeFacts —— 那个模块导入即连库（db/client 顶层跑迁移），会把纯单测拖成集成测试。
// placeFacts 仍然 re-export 本函数，既有导入路径不变。

/** 机构类尾部后缀（长后缀优先，只剥一次）：「故宫博物院」与「故宫」归一到同键 */
const MERGEABLE_SUFFIXES = [
  '风景名胜区', '自然保护区', '旅游度假区',
  '风景区', '旅游区', '度假区', '博物院', '博物馆', '纪念馆', '陈列馆',
  '公园', '景区', '寺院', '寺庙', '陵寝', '故居', '广场',
] as const;

/**
 * 只剥后缀、不做任意子串合并——「沈阳故宫」与「故宫博物院」归一键不同（「沈阳故宫」无后缀可剥），天然隔离。
 * 剥后至少保留 2 个字，防「公园」整名被剥空。
 */
export function normalizePlaceKey(name: string): string {
  const key = name.trim();
  for (const suffix of MERGEABLE_SUFFIXES) {
    if (key.length - suffix.length >= 2 && key.endsWith(suffix)) {
      return key.slice(0, -suffix.length);
    }
  }
  return key;
}
