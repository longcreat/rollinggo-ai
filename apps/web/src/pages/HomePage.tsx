// 首页：SVG 中国地图 + AI Agent 自然语言出行规划交互
import { useLoginDialog } from '../components/LoginDialogProvider';
import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCoveredCities, useUsage, useMe } from '../api/hooks';
import { useActiveGeneration } from '../components/GenerationProvider';
import { ChinaMap, type MapCityDot } from '../components/home/ChinaMap';
import type { HomeTripDraft } from '../components/home/HomeCapsule';
import { CITY_GEO, projectToSvg } from '../lib/chinaMap';
import { HomeAgentChat } from '../components/home/HomeAgentChat';
import { useTravelPreferencesDraft } from '../components/TravelPreferencesProvider';
import { SparkleIcon, RocketIcon } from '../components/home/HomeIcons';

/** 首页主标题：逐字入场动画按字符拆分渲染，所以放在常量里 */
const HEADLINE = '想去哪座城市？';

export function HomePage() {
  const covered = useCoveredCities();
  const navigate = useNavigate();
  const generation = useActiveGeneration();
  const me = useMe();
  const openLogin = useLoginDialog();
  const usage = useUsage(Boolean(me.data));
  const [selected, setSelected] = useState<string | null>(null);
  const savedPreferences = useTravelPreferencesDraft();

  const cities = useMemo(() => covered.data?.cities ?? [], [covered.data]);

  const mapCities = useMemo(
    () =>
      cities.flatMap((name) => {
        const geo = CITY_GEO[name];
        return geo ? [{ name, ...projectToSvg(geo.lng, geo.lat) }] : [];
      }),
    [cities],
  );

  // 未覆盖城市只作背景点缀（有坐标才算），保证地图上「哪里能点」一眼可辨
  const contextCities = useMemo<MapCityDot[]>(
    () =>
      Object.entries(CITY_GEO)
        .filter(([name]) => !cities.includes(name))
        .map(([name, geo]) => ({ name, ...projectToSvg(geo.lng, geo.lat) })),
    [cities],
  );

  const start = (draft: HomeTripDraft, targetCity?: string) => {
    if (!me.isSuccess) return;
    const dest = targetCity?.trim() || selected?.trim() || '成都';
    const params = new URLSearchParams({ city: dest, start: draft.startDate, end: draft.endDate });
    if (draft.pace) params.set('pace', draft.pace);
    if (draft.partySize !== 2) params.set('partySize', String(draft.partySize));
    if (draft.preferences.length > 0) params.set('preferences', draft.preferences.join(','));
    if (draft.transportMode) params.set('transport', draft.transportMode);
    if (draft.extraNotes) params.set('extraNotes', draft.extraNotes);
    // 首页收集完参数：带着 autostart 过去，新建页直接开始流式规划
    params.set('autostart', '1');
    const destination = `/trips/new?${params.toString()}`;
    if (!me.data) {
      openLogin(destination);
      return;
    }
    navigate(destination);
  };

  const notice = me.isError
    ? '登录状态暂不可用，请刷新重试。'
    : covered.isPending
    ? '城市列表加载中…'
    : covered.isError
      ? '城市列表加载失败，请刷新重试。'
      : covered.data && cities.length === 0
        ? '暂时没有可规划的城市，请稍后再来。'
        : null;

  return (
    <div className={"home-page-root [--ui:max(0.75px,_min(0.0599vw,_0.106vh))] relative flex flex-1 flex-col overflow-hidden"}>
      {/* 文案区：字号跟 --ui 标尺，位置用百分比对齐；不拦截地图手势 */}
      <div className="pointer-events-none relative z-10 px-5 pt-4 max-lg:mx-auto max-lg:box-border max-lg:w-full max-lg:max-w-xl max-lg:[&_h1]:text-[clamp(28px,7.6vw,36px)] max-lg:[&_h1]:font-bold lg:absolute lg:top-[9%] lg:left-[6.3%] lg:px-0 lg:pt-0">
        <h1 className="m-0 leading-tight font-medium text-ink">
          {Array.from(HEADLINE).map((char, index) => (
            <span
              key={`${char}-${index}`}
              className={"home-hero-char inline-block [animation:home-hero-char-in_0.85s_cubic-bezier(0.22,_1,_0.36,_1)_both] [animation-delay:calc(var(--char-i,_0)_*_55ms)] [@media_(prefers-reduced-motion:_reduce)]:[animation-name:home-hero-char-fade] [@media_(prefers-reduced-motion:_reduce)]:[animation-duration:0.4s]"}
              style={{ '--char-i': index } as CSSProperties}
            >
              {char}
            </span>
          ))}
        </h1>
        <p className={"home-hero-sub [animation:home-hero-rise_0.7s_ease-out_0.5s_both] [@media_(prefers-reduced-motion:_reduce)]:[animation:none] mt-[calc(14*var(--ui))] mb-0 text-[length:calc(19*var(--ui))] text-ink-muted max-lg:text-base"}>
          让每一次出发，都有专属的旅行方案
        </p>
      </div>

      {/* 桌面与大屏地图背景点选 */}
      <div className="hidden lg:contents">
        <ChinaMap
          cities={mapCities}
          contextCities={contextCities}
          selected={selected}
          onSelect={setSelected}
        />
      </div>

      {/* 底部交互区：AI Agent 自然语言对话入口（完全移除原手动四段选择器胶囊） */}
      <div className="relative z-20 mt-4 px-5 pb-6 max-lg:mx-auto max-lg:box-border max-lg:w-full max-lg:max-w-2xl lg:absolute lg:right-[15%] lg:bottom-[calc(24*var(--ui))] lg:left-[15%] lg:mt-0 lg:px-0 lg:pb-0 flex flex-col gap-3">
        {/* 如果后台正有规划任务在运行，提供快捷恢复卡片 */}
        {generation.running && generation.jobId && (
          <button
            type="button"
            onClick={() => navigate(`/agent/${encodeURIComponent(generation.jobId!)}`)}
            className="flex items-center justify-between rounded-xl border border-brand/30 bg-white/90 px-4 py-2 text-xs font-medium text-brand shadow-sm backdrop-blur-md hover:bg-white transition-all cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-brand" />
              </span>
              <span>您有一份专属行程正在后台规划中，点击可查看实时进度</span>
            </span>
            <RocketIcon className="h-3.5 w-3.5 text-brand" />
          </button>
        )}

        <HomeAgentChat
          currentCity={selected}
          onCityChanged={(city) => setSelected(city)}
          onStart={start}
        />

        {notice && (
          <p className="rounded-xl border border-white/70 bg-white/75 px-5 py-2.5 text-center text-xs text-ink-soft backdrop-blur-2xl">
            {notice}
          </p>
        )}

        {usage.data && (
          <p className="mb-0 mt-0.5 text-center text-xs text-ink-muted" title="每日生成次数将在次日零点重置">
            今日可生成 {usage.data.remaining}/{usage.data.dailyLimit} 次
          </p>
        )}
      </div>
    </div>
  );
}
