import { useState, useRef, useEffect } from 'react';
import type { KeyboardEvent } from 'react';
import { useParsePrompt, type ParsedPromptResult } from '../../api/hooks';
import type { HomeTripDraft } from './HomeCapsule';
import { type TripPace } from '@tripweaver/shared';
import {
  PinIcon,
  SparkleIcon,
  SendIcon,
  ArrowRightIcon,
} from './HomeIcons';

interface HomeAgentChatProps {
  onStart: (draft?: HomeTripDraft, targetCity?: string, text?: string) => void;
  currentCity: string | null;
  onCityChanged: (city: string) => void;
}

const INSPIRATIONS = [
  '下周末带女友去成都玩4天，看大熊猫吃正宗火锅，节奏放慢不早起',
  '一个人去大理古城和洱海周边躺平放空一周，喜欢自然风光',
  '带父母去西安玩3天历史文化游，少走路，看兵马俑和大雁塔',
  '广州2天亲子周末游，打卡长隆和地道早茶点心',
  '去三亚度假5天，住海边酒店，不赶景点多休息',
  '去杭州西湖与灵隐寺3日悠闲漫步，住特色民宿品龙井茶',
];

export function HomeAgentChat({
  onStart,
  currentCity,
  onCityChanged,
}: HomeAgentChatProps) {
  const [prompt, setPrompt] = useState('');
  const parsePrompt = useParsePrompt();
  const inputRef = useRef<HTMLInputElement>(null);

  // 当用户在地图上点击城市时，联动聚焦并填充引导语
  useEffect(() => {
    if (currentCity) {
      setPrompt(`去${currentCity} `);
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  }, [currentCity]);

  // 极速提交并一步直达主 Agent 工作台
  const handleDirectSubmit = (textToSubmit?: string) => {
    const text = (textToSubmit ?? prompt).trim();
    if (!text) return;
    onStart(undefined, currentCity ?? undefined, text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleDirectSubmit();
    }
  };

  return (
    <div className="w-full flex flex-col gap-2.5">
      {/* 灵感路线标签：单行平滑横向滑动，严格隐藏滚动条 */}
      <div
        className="no-scrollbar flex items-center gap-2 overflow-x-auto py-0.5 px-0.5 scroll-smooth"
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <span className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-full bg-brand/10 border border-brand/20 px-3 py-1 text-xs font-semibold text-brand">
          <SparkleIcon className="h-3.5 w-3.5 text-brand" />
          <span>灵感路线</span>
        </span>
        {INSPIRATIONS.map((item, idx) => (
          <button
            key={idx}
            type="button"
            disabled={parsePrompt.isPending}
            onClick={() => {
              setPrompt(item);
              handleDirectSubmit(item);
            }}
            className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-full border border-white/70 bg-white/75 px-3.5 py-1 text-xs text-ink-muted transition-all backdrop-blur-md hover:border-brand/40 hover:bg-white hover:text-brand hover:shadow-xs active:scale-95 cursor-pointer disabled:opacity-50"
            title="点击直接开启专属规划"
          >
            <PinIcon className="h-3 w-3 text-brand/70 shrink-0" />
            <span>{item}</span>
          </button>
        ))}
      </div>

      {/* 极简自然语言输入条：单行优雅聚焦，一步直达规划 */}
      <div className="relative flex items-center gap-2 rounded-2xl border border-white/90 bg-white/85 p-2 sm:p-2.5 shadow-[0_12px_36px_rgba(31,64,124,0.08)] backdrop-blur-2xl transition-all focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/20 focus-within:bg-white/95">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <SparkleIcon className="h-5 w-5" />
        </div>

        <input
          ref={inputRef}
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="告诉 Agent 你的旅行想法（如：下周末带女友去成都玩4天，看大熊猫吃正宗火锅）"
          className="w-full border-0 bg-transparent px-2 py-1.5 text-sm sm:text-base text-ink placeholder:text-ink-faint focus:outline-none"
        />

        <button
          type="button"
          disabled={!prompt.trim() || parsePrompt.isPending}
          onClick={() => handleDirectSubmit()}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-700 hover:from-blue-500 hover:to-indigo-500 px-4 sm:px-5 py-2.5 text-xs sm:text-sm font-semibold text-white shadow-md shadow-blue-500/20 hover:shadow-lg hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
        >
          {parsePrompt.isPending ? (
            <>
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              <span>规划中...</span>
            </>
          ) : (
            <>
              <span>开始规划</span>
              <ArrowRightIcon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
