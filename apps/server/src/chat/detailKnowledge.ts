/**
 * 行程内问答的「资料收集」阶段：一次提问要拿哪些证据。
 *
 * 三个输入来源：
 * 1. 库内地点知识（向量 + 关键词混合，`vector: 'force'` 失败时降级为关键词）
 * 2. 联网搜索（只在问题涉及时效/实时信息，或库内结果太少时）
 * 3. 行程自身的上下文（当前天、被点名的地点、近期问题、偏好）
 *
 * 这里的输出只是「素材」，不得直接当成结论 —— 回答阶段由模型基于这些素材组织。
 */
import type { SourceNote, Trip } from '@tripweaver/shared';
import type { RetrievedPlace, RetrieveOptions, RetrievalDiagnostics } from '../generation/placeRetrieval';
import type { WebSearchHit } from '../integrations/websearch/searchSource';
import type { DetailSources } from './detailSources';
import { purifiedIntroSources } from '../generation/researchQuality';

export type DetailRetrieve = (names: string[], options?: RetrieveOptions) => Promise<RetrievedPlace[]>;
/** 用户明确表态不想联网（“不用联网/只用知识库”）→ 全程禁网，不再看 needsCurrentSources */
export const allowsWebSearch = (question: string) => !/不要联网|不用联网|无需联网|禁止联网|只[用查看].{0,6}(知识库|本地)|仅.{0,4}(知识库|本地)/.test(question);
/** 问题本身涉及时效信息（营业/门票/天气/末班）→ 必须联网核对，不能只靠库内资料 */
export const needsCurrentSources = (question: string) => /联网|网上|搜索网页|上网|最新|现在|今天|明天|营业|开放|开门|闭馆|预约|门票|票价|天气|停运|末班|时刻表|政策/.test(question);

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

export async function retrieveDetailKnowledge(input: {
  trip: Trip; dayId?: string; question: string; recentQuestions: string[];
  preferences: string[]; food: boolean; signal: AbortSignal;
  retrieve: DetailRetrieve; sources: DetailSources; progress: (text: string) => void;
}): Promise<DetailKnowledge> {
  const { trip, question, signal, sources, progress } = input;
  const activities = trip.days.flatMap((day) => day.activities);
  const mentioned = activities.filter((a) => question.includes(a.name)).map((a) => a.name);
  const scope = trip.days.filter((day) => !input.dayId || day.id === input.dayId).flatMap((day) => day.activities.map((a) => a.name));
  const themes = question.match(/亲子|自然|文化|美食|摄影|博物馆|公园|清淡|素食|清真|徒步|夜景/g) ?? [];
  const terms = [...new Set([...mentioned, ...themes, question.slice(0, 100), ...scope.slice(0, 4)])].slice(0, 8);
  const semanticQuery = `${trip.destination}：${question}。相关地点：${(mentioned.length ? mentioned : scope.slice(0, 4)).join('、')}。${/它|那里|这些|这个|那天|再推荐|还有/.test(question) ? `此前问题：${input.recentQuestions.slice(-2).join('；')}。` : ''}偏好：${input.preferences.join('、')}`.slice(0, 1200);
  progress('正在结合问题检索地点知识库，并尝试语义匹配。');
  let diagnostics: RetrievalDiagnostics | undefined;
  const places = await input.retrieve(terms, {
    city: trip.destination, preferences: input.preferences, category: input.food ? 'food' : undefined,
    browse: input.food, vector: 'force', semanticQuery, limit: input.food ? 48 : 10, signal,
    onDiagnostics: (value) => { diagnostics = value; },
  });
  signal.throwIfAborted();
  const notes: string[] = [];
  if (diagnostics?.vector === 'used') progress(`已融合关键词与语义检索，取得 ${places.length} 条地点资料。`);
  else {
    notes.push('语义检索暂不可用，本轮使用关键词和已有行程资料。');
    progress(`已取得 ${places.length} 条地点资料；语义检索暂不可用，保留关键词结果。`);
  }
  let web: WebSearchHit[] = [];
  if (allowsWebSearch(question) && (needsCurrentSources(question) || places.length < 3)) {
    progress('正在联网补充参考资料，核对与问题相关的信息。');
    web = await sources.search.search(`${trip.destination} ${question} ${mentioned[0] ?? scope[0] ?? ''}`.slice(0, 100));
    signal.throwIfAborted();
    progress(web.length ? `已取得 ${web.length} 条网页参考；时效性信息会标明需要核实之处。` : '联网未取得可用参考，将说明已有资料的局限。');
  }
  return {
    places, web, notes,
    references: collectReferences([
      ...web.map(({ title, url }) => ({ title, url })),
      ...places.flatMap((p) => purifiedIntroSources(p.payload).map((source) => ({ ...source, title: `${p.name} · ${source.title}` }))),
      ...places.flatMap((p) => p.evidence.flatMap((e) => e.sourceUrl ? [{ title: `${p.name} · 地点资料`, url: e.sourceUrl }] : [])),
    ]),
  };
}
