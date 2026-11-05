// DraftTrip：Agent 产出的内存草稿。编排/审校 Agent 经工具读写，审校通过后一次性 toTrip 入库。
// 完整性校验是 R2（小参数模型工具调用弱）的兜底 —— 校验失败信息回给 Agent 自愈。
import {
  ACTIVITY_CATEGORIES,
  LODGING_SENTINEL,
  MAX_OVERVIEW_POIS,
  MAX_SOURCE_NOTES,
  MAX_TRIP_DAYS,
  simulateTrip,
  uid,
  type Activity,
  type ActivityCategory,
  type DataSourceKind,
  type FeasibilityReport,
  type GenerateForm,
  type Lodging,
  type ResearchPoi,
  type SourceNote,
  type TransitLeg,
  type Trip,
} from '@tripweaver/shared';
import { isFoodFocused, mealCoverageProblems } from './mealPlanning';
import { type DraftActivity, type PlaceHint } from './placeLookup';

export interface DraftActivityInput extends PlaceHint {
  name: string;
  canonicalPlaceId?: string;
  startTime?: string;
  endTime?: string;
  description?: string;
  category?: string;
  cost?: number;
  lat?: number;
  lng?: number;
  coordSource?: 'geocoded' | 'estimated' | 'manual';
  coordSystem?: Activity['coordSystem'];
  openTime?: string;
  sourceNotes?: SourceNote[];
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeCategory(raw: string | undefined): ActivityCategory {
  return (ACTIVITY_CATEGORIES as readonly string[]).includes(raw ?? '') ? (raw as ActivityCategory) : '其他';
}

function toActivity(input: DraftActivityInput): DraftActivity {
  const hasCoord = typeof input.lat === 'number' && typeof input.lng === 'number' && (input.lat !== 0 || input.lng !== 0);
  return {
    id: uid(),
    ...(input.canonicalPlaceId?.trim() ? { canonicalPlaceId: input.canonicalPlaceId.trim().slice(0, 128) } : {}),
    name: input.name.slice(0, 100),
    startTime: TIME_RE.test(input.startTime ?? '') ? input.startTime! : '',
    endTime: TIME_RE.test(input.endTime ?? '') ? input.endTime! : '',
    description: (input.description ?? '').slice(0, 500),
    lat: hasCoord ? input.lat! : 0,
    lng: hasCoord ? input.lng! : 0,
    coordSource: hasCoord ? (input.coordSource ?? 'estimated') : 'estimated',
    ...(hasCoord && input.coordSystem ? { coordSystem: input.coordSystem } : {}),
    ...(input.placeName?.trim() ? { placeName: input.placeName.trim().slice(0, 100) } : {}),
    ...(input.poiId?.trim() ? { poiId: input.poiId.trim().slice(0, 100) } : {}),
    // cost 仅供旧数据/内部兼容；新生成工具不再向模型暴露该字段。
    ...(typeof input.cost === 'number' ? { cost: Math.max(0, input.cost) } : {}),
    category: normalizeCategory(input.category),
    ...(input.openTime?.trim() ? { openTime: input.openTime.trim().slice(0, 60) } : {}),
    sourceNotes: (input.sourceNotes ?? []).slice(0, MAX_SOURCE_NOTES),
  };
}

export class DraftTrip {
  title = '';
  /** 住宿锚点（ST3）：用户表单指定或规划 Agent 建议的区域；坐标由 geoPipeline 后处理解析 */
  lodging?: Lodging;
  /** lodging 是否来自用户表单（Agent 不得覆盖） */
  lodgingFromUser = false;
  private days: { title: string; activities: DraftActivity[]; legs?: TransitLeg[] }[] = [];

  constructor(private form: GenerateForm) {
    const userLodging = form.lodging?.trim();
    if (userLodging) {
      this.lodging = { name: userLodging.slice(0, 60) };
      this.lodgingFromUser = true;
    }
  }

  /** 规划 Agent set_lodging 工具入口：仅在用户未指定时生效 */
  setLodging(name: string): string {
    if (this.lodgingFromUser) return `用户已指定住宿位置「${this.lodging!.name}」，无需建议`;
    const trimmed = name.trim();
    if (!trimmed) return '错误：住宿区域不能为空';
    const normalized = trimmed.slice(0, 60);
    if (this.lodging?.name !== normalized) {
      this.lodging = { name: normalized };
      for (const day of this.days) {
        if (day.legs) day.legs = day.legs.filter((leg) => leg.fromActivityId !== LODGING_SENTINEL && leg.toActivityId !== LODGING_SENTINEL);
      }
    }
    return `住宿区域建议已记录：${this.lodging.name}`;
  }

  setSkeleton(title: string, dayTitles: string[]): string {
    this.title = title.slice(0, 60);
    this.days = dayTitles.slice(0, MAX_TRIP_DAYS).map((t) => ({ title: t.slice(0, 30), activities: [] }));
    return `骨架已建立：${this.title}，共 ${this.days.length} 天`;
  }

  /** 确定性后处理专用（orchestrator geoPipeline）：暴露可变天列表以写回坐标与通勤段 */
  mutableDays(): { title: string; activities: DraftActivity[]; legs?: TransitLeg[] }[] {
    return this.days;
  }

  /** dayIndex 从 1 开始；越界返回错误文本供 Agent 自愈 */
  addActivity(dayIndex: number, input: DraftActivityInput): string {
    const day = this.days[dayIndex - 1];
    if (!day) return `错误：第 ${dayIndex} 天不存在（当前共 ${this.days.length} 天，请先 set_trip_skeleton）`;
    if (!input.name?.trim()) return '错误：活动名称不能为空';
    day.activities.push(toActivity(input));
    return `已添加到第 ${dayIndex} 天：${input.name}（该天现有 ${day.activities.length} 个活动）`;
  }

  updateActivity(dayIndex: number, position: number, patch: Partial<DraftActivityInput>): string {
    const day = this.days[dayIndex - 1];
    const existing = day?.activities[position - 1];
    if (!day || !existing) return `错误：第 ${dayIndex} 天第 ${position} 个活动不存在`;
    const renamed = patch.name !== undefined && patch.name !== existing.name;
    const referenceChanged = (patch.placeName !== undefined && patch.placeName.trim() !== existing.placeName)
      || (patch.poiId !== undefined && patch.poiId.trim() !== existing.poiId);
    const placeName = patch.placeName ?? (renamed || referenceChanged ? undefined : existing.placeName);
    const poiId = patch.poiId ?? (renamed || referenceChanged ? undefined : existing.poiId);
    const placeChanged = renamed || placeName !== existing.placeName || poiId !== existing.poiId;
    const coordinatesChanged = (patch.lat !== undefined && patch.lat !== existing.lat)
      || (patch.lng !== undefined && patch.lng !== existing.lng);
    const needsResolution = placeChanged || coordinatesChanged;
    const merged = toActivity({
      name: patch.name ?? existing.name,
      startTime: patch.startTime ?? existing.startTime,
      endTime: patch.endTime ?? existing.endTime,
      description: patch.description ?? existing.description,
      category: patch.category ?? existing.category,
      cost: patch.cost ?? existing.cost,
      placeName,
      poiId,
      canonicalPlaceId: patch.canonicalPlaceId ?? (placeChanged ? undefined : existing.canonicalPlaceId),
      // Never let a replacement inherit the old place's verified coordinates or adcode.
      lat: needsResolution ? 0 : existing.lat,
      lng: needsResolution ? 0 : existing.lng,
      coordSource: needsResolution ? 'estimated' : existing.coordSource,
      coordSystem: needsResolution ? undefined : existing.coordSystem,
      sourceNotes: patch.sourceNotes ?? (placeChanged ? [] : existing.sourceNotes),
    });
    day.activities[position - 1] = { ...merged, id: existing.id };
    if (needsResolution && day.legs) {
      day.legs = day.legs.filter((leg) => leg.fromActivityId !== existing.id && leg.toActivityId !== existing.id);
    }
    return `已更新第 ${dayIndex} 天第 ${position} 个活动：${merged.name}`;
  }

  /** 只改标题（文案阶段用）：`setSkeleton` 会重建 days 并清空已排活动，绝不能交给模型调用。 */
  updateTitles(title: string, dayTitles: string[]): string {
    const nextTitle = title.trim().slice(0, 60);
    if (!nextTitle) return '错误：行程标题不能为空';
    this.title = nextTitle;
    const count = Math.min(dayTitles.length, this.days.length);
    for (let i = 0; i < count; i += 1) {
      const dayTitle = dayTitles[i]!.trim().slice(0, 30);
      if (dayTitle) this.days[i]!.title = dayTitle;
    }
    return `标题已更新：${this.title}｜${this.days.map((day) => day.title).join(' / ')}`;
  }

  removeActivity(dayIndex: number, position: number): string {
    const day = this.days[dayIndex - 1];
    if (!day || !day.activities[position - 1]) return `错误：第 ${dayIndex} 天第 ${position} 个活动不存在`;
    const [removed] = day.activities.splice(position - 1, 1);
    return `已删除第 ${dayIndex} 天的「${removed!.name}」`;
  }

  /** 跨天移动原子方法（确定性修复器和修订工具共用）：把活动移到目标天末尾。
   *  语义对齐前端 editorStore.moveActivityToDay（splice 源天 → push 目标天，只挪不删）；
   *  时间槽由调用方另行写入。本方法不动 legs：两天旧 leg 随即失配（消费方按 ST3 契约静默按缺失降级），
   *  调用方须随后定向重算。dayIndex 从 1 开始；天不存在/同天/活动不存在返回 false 且不做任何修改。 */
  moveActivityToDay(fromDayIndex: number, activityId: string, toDayIndex: number): boolean {
    const from = this.days[fromDayIndex - 1];
    const to = this.days[toDayIndex - 1];
    if (!from || !to || from === to) return false;
    const idx = from.activities.findIndex((a) => a.id === activityId);
    if (idx < 0) return false;
    const [moved] = from.activities.splice(idx, 1);
    to.activities.push(moved!);
    return true;
  }

  /** 紧凑文本视图（控 token）：审校/修订轮的 get_draft 工具输出 */
  render(): string {
    if (!this.days.length) return '（草稿为空，尚未建立骨架）';
    const lines: string[] = [`行程：${this.title || '(未命名)'}｜目的地 ${this.form.destination}｜${this.days.length} 天`];
    if (this.lodging) lines.push(`住宿位置：${this.lodging.name}${this.lodgingFromUser ? '（用户指定）' : '（已建议区域）'}`);
    this.days.forEach((day, i) => {
      lines.push(`第 ${i + 1} 天：${day.title}`);
      day.activities.forEach((a, j) => {
        const coord = a.lat === 0 && a.lng === 0 ? '无坐标' : `${a.lat.toFixed(4)},${a.lng.toFixed(4)}(${a.coordSource})`;
        const time = a.startTime ? `${a.startTime}-${a.endTime || '?'}` : '时间未定';
        lines.push(`  ${j + 1}. ${a.name}｜id=${a.id}｜${time}｜${a.category}｜${coord}${a.placeName ? `｜定位=${a.placeName}` : ''}${a.poiId ? `｜poiId=${a.poiId}` : ''}${a.sourceNotes.length ? '｜有来源笔记' : ''}`);
      });
      if (!day.activities.length) lines.push('  （空）');
    });
    return lines.join('\n');
  }

  /** 可行性模拟（M0-A）：以当前草稿（含 geoPipeline 已解析的坐标/leg）真算时空违规报告。
   *  纯函数引擎在 @tripweaver/shared，本方法只做 DraftTrip → Trip 适配。 */
  feasibility(): FeasibilityReport {
    return simulateTrip(this.toTrip());
  }

  /** 完整性校验：返回问题清单（空数组 = 通过） */
  validate(): string[] {
    const problems: string[] = [];
    if (!this.title.trim()) problems.push('缺少行程标题（set_trip_skeleton）');
    if (this.days.length !== this.form.days) {
      problems.push(`天数不符：要求 ${this.form.days} 天，当前 ${this.days.length} 天`);
    }
    this.days.forEach((day, i) => {
      if (!day.activities.length) problems.push(`第 ${i + 1} 天没有任何活动`);
      if (day.activities.length > 8) problems.push(`第 ${i + 1} 天活动过多（${day.activities.length} 个，应 ≤8）`);
    });
    const visited = new Set<string>();
    for (const activity of this.days.flatMap(day => day.activities)) {
      if (!activity.canonicalPlaceId || activity.category === '美食') continue;
      if (visited.has(activity.canonicalPlaceId)) problems.push(`同一地点重复安排：${activity.name}`);
      visited.add(activity.canonicalPlaceId);
    }
    // 餐次要求改为偏好驱动（09-21 D3/D6）：仅偏好含「美食」时才算完整性问题
    problems.push(...mealCoverageProblems(this.days, { foodFocused: isFoodFocused(this.form.preferences) }));
    // v0.5：坐标覆盖不再作为完整性问题 —— 审校后由确定性 geoPipeline 统一解析全量坐标
    return problems;
  }

  toTrip(reviewNotes: string[] = [], research?: { overview: ResearchPoi[]; dataSources: DataSourceKind[] }): Trip {
    const now = Date.now();
    return {
      id: uid(),
      title: this.title || `${this.form.destination}之旅`,
      destination: this.form.destination,
      startDate: this.form.startDate ?? '',
      budgetLevel: this.form.budgetLevel,
      totalBudget: this.form.totalBudget ?? 0,
      preferences: this.form.preferences ?? [],
      partySize: this.form.partySize,
      extraNotes: this.form.extraNotes ?? '',
      // 出行方式基调（ST3）：缺省 transit，持久化供未来重排复用
      transportMode: this.form.transportMode ?? 'transit',
      // 住宿锚点（ST3）：坐标解析成功与否均如实持久化名称；坐标由 geoPipeline 写入
      ...(this.lodging ? { lodging: this.lodging } : {}),
      days: this.days.map((day, i) => ({
        id: uid(),
        dayIndex: i + 1,
        title: day.title,
        activities: day.activities.map(({ placeName: _placeName, poiId: _poiId, ...activity }) => activity),
        // 通勤段（geoPipeline 后处理写入）；为空时不写字段，与旧行程 JSON 形状一致
        ...(day.legs?.length ? { legs: day.legs } : {}),
      })),
      // 调研候选池（行程概览页数据源）；为空时不写字段，与旧行程 JSON 形状一致
      ...(research?.overview.length ? { overview: research.overview.slice(0, MAX_OVERVIEW_POIS) } : {}),
      meta: {
        usedXhs: false,   // 小红书集成已移除；字段保留做旧行程只读兼容
        reviewNotes: reviewNotes.map((n) => n.slice(0, 200)),
        ...(research?.dataSources.length ? { dataSources: research.dataSources } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
  }
}
