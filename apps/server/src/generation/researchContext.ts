import type { GenerateForm } from '@tripweaver/shared';
import type { RetrievedPlace, RetrieveOptions } from './placeRetrieval';
import { isFoodFocused } from './mealPlanning';
import { placeCategory } from './retrievalRanking';
import { purifiedIntro } from './researchQuality';

const KIND: Record<string, string> = { xhs_warning: '避坑', xhs_reservation: '预约', xhs_price: '价格', xhs_reason: '口碑' };
const STRENGTH: Record<string, string> = { direct: '实证', risk_only: '仅风险', weak: '网友感受' };

export function renderRetrievedPlaces(places: readonly RetrievedPlace[]): string {
  return places.map((place) => {
    // 来源保留在任务 catalog 并在入池时自动附上，模型无需读写重复 URL。
    const evidence = place.evidence.map((e) => `${KIND[e.kind] ?? e.kind}(${STRENGTH[e.strength] ?? '网友感受'})：${e.content.slice(0, 80)}`).join('；');
    const intro = purifiedIntro(place.payload);
    const reasons = Array.isArray(place.payload?.topReasons) ? place.payload.topReasons.filter((s): s is string => typeof s === 'string').slice(0, 3) : [];
    const components = Array.isArray(place.payload?.components) ? place.payload.components.flatMap((c) =>
      c && typeof c === 'object' && typeof c.name === 'string' ? [`${c.name}：${typeof c.reservationNote === 'string' ? c.reservationNote : '信息待核实'}`] : []).slice(0, 4) : [];
    return `id=${place.id}｜${place.name}｜${placeCategory(place.category)}（${place.category}）${intro ? `｜提纯介绍(原文复用)：${intro}` : reasons.length ? `｜看点素材：${reasons.join('；')}` : ''}${components.length ? `｜分项政策(不能泛化到整个景区)：${components.join('；')}` : ''}${evidence ? `｜${evidence}` : ''}`;
  }).join('\n');
}

type Retrieve = (names: string[], options?: RetrieveOptions) => Promise<RetrievedPlace[]>;

/** 首轮前直接提供结构化候选；无主题标签的城市仍按类目/质量取候选，复杂偏好由模型按需补查。 */
export async function prepareResearchContext(form: GenerateForm, retrieve: Retrieve, signal?: AbortSignal): Promise<RetrievedPlace[]> {
  const perDay = form.pace === 'relaxed' ? 3 : form.pace === 'tight' ? 6 : 4;
  const options: RetrieveOptions = { city: form.destination, preferences: form.preferences, browse: true, vector: 'off', signal };
  const [attractions, food] = await Promise.all([
    retrieve([], { ...options, category: 'attraction', limit: Math.min(36, Math.max(8, Math.ceil(form.days * perDay * 1.4))) }),
    isFoodFocused(form.preferences) ? retrieve([], { ...options, category: 'food', limit: Math.min(12, form.days * 2) }) : Promise.resolve([]),
  ]);
  return [...attractions, ...food];
}
