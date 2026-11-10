// 工具名 → 用户可读标签：详情对话与行前回合共用，避免两套进度文案漂移。
export const TOOL_LABEL: Record<string, string> = {
  get_trip: '读行程',
  get_day: '看当天的安排',
  search_places: '查地点',
  web_search: '检索全网资讯',
  fetch_web_page: '查看详情正文',
  get_weather: '查天气',
  search_food: '找餐厅',
  ask_user: '确认信息',
  update_brief: '更新出行条件',
  delegate_task: '委派后台任务',
  task_status: '查看任务进度',
  add_activity: '往行程里加地点',
  update_activity: '调整这个安排',
  delete_activity: '删掉这个安排',
  move_activity: '挪动安排',
  reorder_day: '调整当天顺序',
  add_day: '增加一天',
  update_day: '改当天主题',
  delete_day: '删除一天',
  update_trip: '更新行程信息',
  spawn_subagents: '并行调研',
};

/**
 * 提取工具调用入参中的关键动态语义（如搜索关键词、地点名、城市等），
 * 用于在前端步骤列表中以透明副标签呈现，消除黑盒感。
 */
export function toolDetail(name: string, rawArgs?: unknown): string | undefined {
  if (!rawArgs || typeof rawArgs !== 'object') return undefined;
  const args = rawArgs as Record<string, unknown>;
  switch (name) {
    case 'web_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q ? q.slice(0, 40) : undefined;
    }
    case 'fetch_web_page': {
      const u = typeof args.url === 'string' ? args.url.trim() : '';
      if (!u) return undefined;
      try {
        const host = new URL(u).hostname.replace(/^www\./, '');
        return host.slice(0, 30);
      } catch {
        return u.slice(0, 30);
      }
    }
    case 'search_places': {
      const q = (typeof args.keyword === 'string' ? args.keyword : typeof args.query === 'string' ? args.query : typeof args.name === 'string' ? args.name : '').trim();
      return q ? q.slice(0, 30) : undefined;
    }
    case 'search_area_places': {
      const a = (typeof args.area === 'string' ? args.area : typeof args.keyword === 'string' ? args.keyword : '').trim();
      return a ? a.slice(0, 30) : undefined;
    }
    case 'get_weather': {
      const city = typeof args.city === 'string' ? args.city.trim() : '';
      return city ? city.slice(0, 20) : undefined;
    }
    case 'search_food': {
      const cat = typeof args.category === 'string' ? args.category.trim() : '';
      const kw = typeof args.keyword === 'string' ? args.keyword.trim() : '';
      return (kw || cat || undefined)?.slice(0, 30);
    }
    case 'get_day': {
      const d = typeof args.dayIndex === 'number' ? args.dayIndex : typeof args.dayId === 'string' ? args.dayId : undefined;
      return d !== undefined ? `第 ${d} 天` : undefined;
    }
    case 'add_activity':
    case 'update_activity':
    case 'delete_activity': {
      const n = typeof args.name === 'string' ? args.name.trim() : '';
      return n ? n.slice(0, 30) : undefined;
    }
    default:
      return undefined;
  }
}
