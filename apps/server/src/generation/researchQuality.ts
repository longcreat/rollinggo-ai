import type { ResearchPoi } from '@tripweaver/shared';

const UNKNOWN = '预约要求尚未核实，请以官方最新信息为准。';
const CONFLICT = '预约资料存在冲突，请通过官方渠道确认后安排。';
const UNCERTAIN = /可能|或许|疑似|不确定|待确认|尚未核实|建议.*预约|sometimes|may\b/i;
const NO_BOOKING = /无需(?:提前)?预约|无须(?:提前)?预约|不(?:需要|用)(?:提前)?预约|免预约|现场(?:购票|入园)|直接入园|随到随入|no reservation/i;
const BOOKING = /(?:需|须|要|请|必须|提前|实名|官方渠道|公众号|小程序|官网).{0,16}预约|预约(?:购票|入园|参观|登记)|reservation required/i;
/** 「提前 N 天」区间：`3-7天` 算一个区间，不会把正常的区间写法当成两个数字。 */
const LEAD_DAYS = /提前\s*(\d{1,3})\s*(?:[-~～至到—–]\s*(\d{1,3}))?\s*天/g;

/** 同一段说明里出现互不重叠的提前天数，说明资料来自不同来源却没被归一（如「提前7天；提前1天00:00预约」）。 */
function hasConflictingLeadDays(note: string): boolean {
  const ranges: [number, number][] = [];
  for (const match of note.matchAll(LEAD_DAYS)) {
    const first = Number(match[1]);
    const second = match[2] ? Number(match[2]) : first;
    if (!Number.isFinite(first) || !Number.isFinite(second)) continue;
    ranges.push([Math.min(first, second), Math.max(first, second)]);
  }
  return ranges.some((a, i) => ranges.some((b, j) => i < j && (a[1] < b[0] || b[1] < a[0])));
}

/** 校验结构化字段也校验模型字段。矛盾只降为未知，绝不凭一句「无需预约」反写数据库。 */
export function normalizeReservation(status: unknown, rawNote: unknown): Pick<ResearchPoi, 'reservation' | 'reservationNote'> {
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  if (hasConflictingLeadDays(note)) return { reservation: 'unknown', reservationNote: CONFLICT };
  const negative = NO_BOOKING.test(note);
  const positive = BOOKING.test(note.replace(new RegExp(NO_BOOKING.source, 'gi'), ''));
  if ((negative && positive) || (status === 'required' && negative) || (status === 'none' && positive)) {
    return { reservation: 'unknown', reservationNote: CONFLICT };
  }
  if (UNCERTAIN.test(note) || !note) return { reservation: 'unknown', reservationNote: UNKNOWN };
  if ((status === 'required' && positive) || (status === 'none' && negative)) {
    return { reservation: status, reservationNote: note.length <= 120 ? note : '具体预约要求请通过官方渠道确认。' };
  }
  return { reservation: 'unknown', reservationNote: UNKNOWN };
}

/** 内容提纯属于上游；这里只收尾空白和契约限长，不按关键词删除事实/看点。 */
export function cleanResearchIntro(raw: string): string {
  const value = raw.trim();
  if (value.length <= 200) return value;
  const sentences = value.match(/[^。！？!?]+[。！？!?]|[^。！？!?]+$/g) ?? [];
  let result = '';
  for (const sentence of sentences) {
    if (result.length + sentence.length > 200) break;
    result += sentence;
  }
  // 工具schema会限制新输入；旧资料若连一句都放不下，不截成可能改变原意的半句。
  return result;
}

export function purifiedIntro(payload: { content?: unknown } | null | undefined): string | undefined {
  const content = payload?.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return;
  const value = content as Record<string, unknown>;
  if (value.version !== 1 || typeof value.intro !== 'string' || !value.intro.trim() || value.intro.length > 200) return;
  return value.intro.trim();
}

/** 介绍来源随正文进入候选快照，不能只留下无关的社区口碑链接。 */
export function purifiedIntroSources(payload: { content?: unknown } | null | undefined): ResearchPoi['sourceLinks'] {
  if (!purifiedIntro(payload)) return [];
  const highlights = (payload?.content as Record<string, unknown>).highlights;
  if (!Array.isArray(highlights)) return [];
  const urls = highlights.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Record<string, unknown>;
    const citations: unknown[] = Array.isArray(entry.citations) ? entry.citations : [];
    return [entry, ...citations].flatMap((citation) => {
      if (!citation || typeof citation !== 'object') return [];
      const url = (citation as Record<string, unknown>).sourceUrl;
      if (typeof url !== 'string' || url.length > 300) return [];
      try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return []; } catch { return []; }
      return [url];
    });
  });
  return [...new Set(urls)].map((url) => ({ title: '景点介绍来源', url }));
}
