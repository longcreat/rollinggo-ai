// 行程内问答的资料收集基元：联网意愿判定、引用去重消毒与素材容器类型。
//
// 三个输入来源（素材由 agent 工具链收集，这里只保留纯函数与契约）：
// 1. 库内地点知识（向量 + 关键词混合）
// 2. 联网搜索（只在问题涉及时效/实时信息，或库内结果太少时）
// 3. 行程自身的上下文（当前天、被点名的地点、近期问题、偏好）
//
// 这里的输出只是「素材」，不得直接当成结论 —— 回答阶段由模型基于这些素材组织。
import type { SourceNote } from '@rollinggo-trip/shared';
import type { RetrievedPlace } from '../generation/placeRetrieval';
import type { WebSearchHit } from '@rollinggo-trip/integrations/websearch/searchSource';

/** 用户明确表态不想联网（“不用联网/只用知识库”）→ 全程禁网 */
export const allowsWebSearch = (question: string) => !/不要联网|不用联网|无需联网|禁止联网|只[用查看].{0,6}(知识库|本地)|仅.{0,4}(知识库|本地)/.test(question);

/** 引用去重与消毒：只留 http(s)、不带凭据、不过长、同一 URL 只出现一次，最多 8 条 */
export function collectReferences(items: readonly SourceNote[]): SourceNote[] {
  const urls = new Set<string>();
  return items.filter((item) => {
    try {
      const parsed = new URL(item.url);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || item.url.length > 300 || urls.has(item.url)) return false;
      urls.add(item.url); return true;
    } catch { return false; }
  }).slice(0, 8).map((item) => ({ title: item.title.slice(0, 100), url: item.url }));
}

export interface DetailKnowledge {
  places: RetrievedPlace[];
  web: WebSearchHit[];
  references: SourceNote[];
  notes: string[];
}
