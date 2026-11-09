// 实时时间上下文：为 Agent 提供当前日期、星期与相对时间锚点。
//
// 关键设计（Prefix Caching 优化）：
// 此上下文必须严格放在系统提示词的最末尾（末尾追加）。
// 这样前面所有的核心角色定义、工具说明、业务纪律等长篇提示词始终保持完全静态，
// 从而最大程度（接近 100%）命中大模型的前缀缓存（Prefix / Prompt Caching），大幅减少延迟与 token 消耗。

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function buildCurrentTimeContext(now: Date = new Date()): string {
  // 统一转为中国标准时间（Asia/Shanghai，UTC+8）
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const beijing = new Date(utc + 8 * 3600_000);

  const dateStr = formatDate(beijing);
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const dayOfWeek = weekdays[beijing.getDay()];
  const hours = String(beijing.getHours()).padStart(2, '0');
  const minutes = String(beijing.getMinutes()).padStart(2, '0');

  const tomorrow = new Date(beijing.getTime() + 24 * 3600_000);
  const dayAfter = new Date(beijing.getTime() + 48 * 3600_000);

  const day = beijing.getDay(); // 0 是周日，1-6 是周一到周六
  let weekendDesc = '';
  if (day === 0) {
    const nextSat = new Date(beijing.getTime() + 6 * 24 * 3600_000);
    const nextSun = new Date(beijing.getTime() + 7 * 24 * 3600_000);
    weekendDesc = `今天就是周日；下个周末为 ${formatDate(nextSat)}（六）~ ${formatDate(nextSun)}（日）`;
  } else if (day === 6) {
    const sun = new Date(beijing.getTime() + 24 * 3600_000);
    weekendDesc = `今天就是周六；明天周日为 ${formatDate(sun)}`;
  } else {
    const sat = new Date(beijing.getTime() + (6 - day) * 24 * 3600_000);
    const sun = new Date(beijing.getTime() + (7 - day) * 24 * 3600_000);
    weekendDesc = `本周末为 ${formatDate(sat)}（六）~ ${formatDate(sun)}（日）`;
  }

  return [
    '<current_time>',
    `当前日期：${dateStr}（${dayOfWeek}）`,
    `当前时间：${hours}:${minutes}（中国标准时间 UTC+8）`,
    `相对日期基准：明天 ${formatDate(tomorrow)}｜后天 ${formatDate(dayAfter)}｜${weekendDesc}`,
    '时间纪律：',
    '1. 行程规划与安排时，用户提到「今天/明天/后天/周末/下周」必须以此处的基准日期为准换算成具体日期填入行程（如 startDate）。',
    '2. 全网搜索（web_search）时，严禁在搜索词中添加未发生的未来年份（如 2026年）或写死精确年月日！搜索新闻与时效资讯时，使用「城市 + 关键词 + 最新/今日」（如「杭州 最新动态」「杭州 今日要闻」），并配合 freshness 参数限定时效范围。',
    '</current_time>',
  ].join('\n');
}

/** 将时间上下文拼接在静态指令的最末尾，最大化命中前缀缓存 */
export function withTimeContext(baseInstructions: string, now: Date = new Date()): string {
  return `${baseInstructions.trim()}\n\n${buildCurrentTimeContext(now)}`;
}
