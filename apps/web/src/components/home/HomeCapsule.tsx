import { Button } from '../ui/Button';
// 首页渐进式玻璃胶囊指挥台（09-26）：4 段摘要（目的地/日期/节奏与同行/偏好与出行）+ 圆形提交。
// 桌面在各段上方弹出玻璃面板；手机共用原生底部弹层，表单草稿不因布局变化重置。
// 只做收集与展示，跳转 /trips/new 预填由 HomePage 负责。
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  MAX_TRIP_DAYS,
  PACE_LABELS,
  PACE_OPTIONS,
  PREFERENCE_OPTIONS,
  type TransportMode,
  type TravelPreferences,
  type TripPace,
} from '@rollinggo-trip/shared';
import { RangeCalendar } from '../RangeCalendar';
import { Modal } from '../Modal';
import { NavigationIcon } from '../NavigationIcon';
import { TravelPreferencesFields } from '../TravelPreferencesFields';
import { useTravelPreferencesDraft } from '../TravelPreferencesProvider';
import { TRANSPORT_LABELS } from '../../lib/chatDerive';
import { daysBetween, isoDateAfter, shortDate } from '../../lib/dates';
import {
  CalendarIcon,
  ChevronDownIcon,
  CloseIcon,
  CompassIcon,
  GaugeIcon,
  PinIcon,
  ScissorsIcon,
  PeopleIcon,
} from './HomeIcons';

type Preference = (typeof PREFERENCE_OPTIONS)[number];
type PanelKey = 'city' | 'date' | 'pace' | 'more';

export interface HomeTripDraft {
  startDate: string;
  endDate: string;
  days: number;
  pace: TripPace | null;
  partySize: number;
  preferences: Preference[];
  transportMode: TransportMode | null;
  extraNotes: string;
}

interface HomeCapsuleProps {
  city: string | null;
  cities: string[];
  externalDates?: { startDate: string; endDate: string } | null;
  onSelectCity: (name: string) => void;
  onStart: (draft: HomeTripDraft) => void;
  onOpenGeneration?: () => void;
  onOpenCity: () => void;
  cityPickerOpen: boolean;
}

const PACE_DESCS: Record<TripPace, string> = {
  relaxed: '少走路、慢节奏探索',
  moderate: '经典地标全景体验',
  tight: '高密度、极致高效',
};

/** 面板外壳：玻璃卡片 + 指向所在段的尾巴（宽度与内边距由各面板自己给，避免原子类互相覆盖） */
const panelShellCls =
  'absolute bottom-[calc(100%_+_31*var(--ui))] left-0 z-30 box-border flex max-h-[calc(100dvh-100px)] max-w-[calc(100vw_-_3rem)] flex-col rounded-[calc(20*var(--ui))] border border-white/70 bg-white/95 shadow-[0_18px_50px_rgba(31,64,124,0.14)] backdrop-blur-2xl backdrop-saturate-150';
const spacedPanelCls = 'gap-[calc(14*var(--ui))] p-[calc(18*var(--ui))]';
const cityPanelCls = `${panelShellCls} ${spacedPanelCls} w-[max(300px,21vw)]`;
const pacePanelCls = `${panelShellCls} ${spacedPanelCls} w-[max(320px,22vw)]`;
const datePanelCls = `${panelShellCls} w-[560px]`;

/** 同一份表单：桌面锚定浮层，手机复用原生底部弹层的焦点与关闭行为。 */
function HomePanel({ mobile, title, className, onClose, children }: {
  mobile: boolean;
  title: string;
  className: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!mobile) return <div className={className}>{children}</div>;
  return <Modal title={title} size="sheet" onClose={onClose}>
    <div className="flex min-w-0 flex-col gap-4 [&_textarea]:text-base [&_.range-calendar]:[--rc-day-height:44px] [&_.range-calendar]:[--rc-head-height:44px] [&_.range-calendar]:[--rc-head-pad-left:48px] [&_.range-calendar]:[--rc-arrow-width:44px]">
      {children}
    </div>
  </Modal>;
}

const panelLabelCls = 'm-0 text-[length:calc(12*max(1px,var(--ui,1px)))] text-ink-muted';
const cityCardCls = (active: boolean) =>
  `rounded-[calc(12*var(--ui))] border px-[calc(10*var(--ui))] py-[calc(13*var(--ui))] text-center text-[length:calc(15*var(--ui))] font-semibold transition-colors ${
    active
      ? 'border-brand bg-brand/10 text-brand'
      : 'border-hairline-strong bg-white/60 text-ink-strong hover:border-brand hover:text-brand'
  }`;

const divider = (
  <span aria-hidden="true" className="my-[calc(13*var(--ui))] w-px shrink-0 bg-hairline-divider max-lg:mx-2 max-lg:my-0 max-lg:h-px max-lg:w-auto" />
);

interface SegmentProps {
  icon: ReactNode;
  iconCls: string;
  label: string;
  value: string;
  pending?: boolean;
  open: boolean;
  onClick: () => void;
}

function Segment({ icon, iconCls, label, value, pending = false, open, onClick }: SegmentProps) {
  return (
    <Button variant="plain"
      type="button"
      aria-expanded={open}
      onClick={onClick}
      className={`flex h-full w-full min-w-0 items-center gap-[calc(8*var(--ui))] rounded-[calc(20*var(--ui))] px-[calc(8*var(--ui))] py-[calc(9*var(--ui))] text-left transition-colors max-lg:min-h-16 max-lg:gap-3 max-lg:rounded-2xl max-lg:px-3 max-lg:py-3 ${open ? "bg-white/80" : "hover:bg-white/55"}`}
    >
      <span className={`grid h-[calc(26*var(--ui))] w-[calc(26*var(--ui))] shrink-0 place-items-center ${iconCls}`}>
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-[calc(4*var(--ui))] max-lg:flex-1">
        <span className="text-[length:calc(13*var(--ui))] leading-none text-ink-faint">{label}</span>
        <span className="flex min-w-0 items-center gap-[calc(5*var(--ui))]">
          <span
            className={`text-[length:calc(16*var(--ui))] leading-tight font-semibold max-lg:truncate ${pending ? "text-ink-pending max-lg:text-ink-soft" : "text-ink-strong"}`}
          >
            {value}
          </span>
          <ChevronDownIcon className="h-[calc(15*var(--ui))] w-[calc(15*var(--ui))] shrink-0 text-ink-faint max-lg:ml-auto max-lg:-rotate-90" />
        </span>
      </span>
    </Button>
  );
}

function PanelHead({ icon, title, onClose }: { icon: ReactNode; title: string; onClose?: () => void }) {
  return (
    <div className="hidden items-center gap-[calc(10*var(--ui))] lg:flex">
      <span className="grid h-[calc(20*var(--ui))] w-[calc(20*var(--ui))] shrink-0 place-items-center">{icon}</span>
      <h2 className="m-0 font-semibold text-ink-strong">{title}</h2>
      {onClose && (
        <Button variant="plain"
          type="button"
          aria-label={`关闭${title}`}
          onClick={onClose}
          className="ml-auto grid h-[calc(28*var(--ui))] w-[calc(28*var(--ui))] place-items-center rounded-full text-ink-soft transition-colors hover:bg-canvas"
        >
          <CloseIcon className="h-[calc(14*var(--ui))] w-[calc(14*var(--ui))]" />
        </Button>
      )}
    </div>
  );
}

/** 指向所在胶囊段的尾巴：只有右下两条边需要描边 */
function PanelTail({ align = 'left' }: { align?: 'left' | 'preferences' }) {
  return (
    <span
      aria-hidden="true"
      className={`absolute -bottom-[calc(8*var(--ui))] left-[calc(30*var(--ui))] hidden h-[calc(16*var(--ui))] w-[calc(16*var(--ui))] rotate-45 border-r border-b border-white/70 bg-white/88 lg:block ${align === 'preferences' ? 'lg:left-auto lg:right-[calc(110*var(--ui))]' : ''}`}
    />
  );
}

export function HomeCapsule({ city, cities, externalDates, onSelectCity, onStart, onOpenGeneration, onOpenCity, cityPickerOpen }: HomeCapsuleProps) {
  const [startDate, setStartDate] = useState(() => externalDates?.startDate ?? isoDateAfter(1));
  const [endDate, setEndDate] = useState(() => externalDates?.endDate ?? isoDateAfter(3));

  useEffect(() => {
    if (externalDates) {
      if (externalDates.startDate) setStartDate(externalDates.startDate);
      if (externalDates.endDate) setEndDate(externalDates.endDate);
    }
  }, [externalDates]);
  const savedPreferences = useTravelPreferencesDraft();
  // 节奏与同行人数跟偏好共用同一份账号记忆：初值直接读账号快照，选择只写本地草稿，
  // 生成成功后才由 NewTripPage 一起提交（见 TravelPreferencesProvider）。
  const saved = savedPreferences.value;
  const pace = saved?.pace ?? null;
  const partySize = saved?.partySize ?? 2;
  const { preferences = [], transportMode = 'transit', extraNotes = '' } = saved ?? {};
  const [activePanel, setActivePanel] = useState<PanelKey | null>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia('(width < 1024px)').matches);
  const deckRef = useRef<HTMLDivElement>(null);

  const days = daysBetween(startDate, endDate);
  const ready = Boolean(city) && pace !== null && Boolean(savedPreferences.value);

  useEffect(() => {
    const query = window.matchMedia('(width < 1024px)');
    const update = () => { setMobile(query.matches); setActivePanel(null); };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // 点胶囊条外部收起面板
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (deckRef.current && !deckRef.current.contains(e.target as Node)) setActivePanel(null);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setActivePanel(null); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const togglePanel = (key: PanelKey) => setActivePanel((cur) => (cur === key ? null : key));

  /** 只改账号草稿，不写库；偏好还没加载完时不允许改（按钮同时置灰，避免点了没反应）。 */
  const changeDraft = (patch: Partial<Pick<TravelPreferences, 'pace' | 'partySize'>>) => {
    if (!saved) return;
    savedPreferences.change({ ...saved, ...patch });
  };

  const paceSummary = `${partySize} 人 · ${pace ? PACE_LABELS[pace] : '选择节奏'}`;
  const moreSummary = [
    preferences.length > 0 ? preferences.join(' · ') : '偏好不限',
    transportMode ? TRANSPORT_LABELS[transportMode] : '',
    extraNotes.trim() ? '已填备注' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const dateSummary = `${shortDate(startDate)} ~ ${shortDate(endDate)} · ${days}天`;

  return (
    <div ref={deckRef} className="relative">
      <div className="flex w-full flex-col gap-[calc(2*var(--ui))] rounded-[calc(28*var(--ui))] border border-white/70 bg-white/72 p-[calc(11*var(--ui))] shadow-[0_18px_46px_rgba(31,64,124,0.12)] backdrop-blur-2xl backdrop-saturate-150 max-lg:box-border max-lg:rounded-3xl max-lg:bg-white/80 max-lg:shadow-[0_8px_32px_rgba(31,64,124,0.04)] lg:flex-row lg:items-stretch">
        <div className="relative min-w-0 flex-1">
          <Segment
            icon={<PinIcon className="h-[calc(26*var(--ui))] w-[calc(26*var(--ui))]" />}
            iconCls="text-brand"
            label="目的地"
            value={city ?? (mobile ? '点击选择想去的城市' : '点击地图选城市')}
            pending={!city}
            open={activePanel === 'city' || cityPickerOpen}
            onClick={() => mobile ? onOpenCity() : togglePanel('city')}
          />
          {activePanel === 'city' && (
            <HomePanel mobile={mobile} title="目的地" className={cityPanelCls} onClose={() => setActivePanel(null)}>
              <PanelHead
                icon={<PinIcon className="h-[calc(20*var(--ui))] w-[calc(20*var(--ui))] text-brand" />}
                title="目的地"
              />
              <p className={panelLabelCls}>可规划城市（也可直接点地图圆点）</p>
              <div className="grid grid-cols-3 gap-[calc(10*var(--ui))]">
                {cities.map((c) => (
                  <Button variant="plain"
                    key={c}
                    type="button"
                    aria-pressed={c === city}
                    className={cityCardCls(c === city)}
                    onClick={() => {
                      onSelectCity(c);
                      if (mobile) setActivePanel(null);
                    }}
                  >
                    {c}
                  </Button>
                ))}
              </div>
              <PanelTail />
            </HomePanel>
          )}
        </div>

        {divider}

        <div className="relative min-w-0 flex-1">
          <Segment
            icon={<CalendarIcon className="h-[calc(26*var(--ui))] w-[calc(26*var(--ui))]" />}
            iconCls="text-accent-indigo"
            label="出行日期"
            value={dateSummary}
            open={activePanel === 'date'}
            onClick={() => togglePanel('date')}
          />
          {activePanel === 'date' && (
            <HomePanel mobile={mobile} title="选择出行日期" className={datePanelCls} onClose={() => setActivePanel(null)}>
              <div className="hidden items-center gap-[calc(12*var(--ui))] px-[calc(20*var(--ui))] pt-[calc(16*var(--ui))] lg:flex">
                <span className="grid h-[calc(20*var(--ui))] w-[calc(20*var(--ui))] shrink-0 place-items-center">
                  <CalendarIcon className="h-[calc(20*var(--ui))] w-[calc(20*var(--ui))] text-accent-indigo" />
                </span>
                <h2 className="m-0 font-semibold text-ink-strong">选择出行日期</h2>
                <Button variant="plain"
                  type="button"
                  aria-label="关闭选择出行日期"
                  onClick={() => setActivePanel(null)}
                  className="ml-auto grid h-[calc(28*var(--ui))] w-[calc(28*var(--ui))] place-items-center rounded-full text-ink-soft transition-colors hover:bg-canvas"
                >
                  <CloseIcon className="h-[calc(14*var(--ui))] w-[calc(14*var(--ui))]" />
                </Button>
              </div>
              <div className="lg:px-[calc(16*var(--ui))] lg:pb-[calc(16*var(--ui))]">
                <RangeCalendar
                  startDate={startDate}
                  endDate={endDate}
                  maxDays={MAX_TRIP_DAYS}
                  months={mobile ? 1 : 2}
                  onRangeChange={(s, e) => {
                    setStartDate(s);
                    setEndDate(e);
                  }}
                  footSlot={null}
                />
              </div>
              <PanelTail />
            </HomePanel>
          )}
        </div>

        {divider}

        <div className="relative min-w-0 flex-1">
          <Segment
            icon={mobile ? <PeopleIcon className="h-[calc(26*var(--ui))] w-[calc(26*var(--ui))]" /> : <GaugeIcon className="h-[calc(26*var(--ui))] w-[calc(26*var(--ui))]" />}
            iconCls="text-accent-teal max-lg:text-brand"
            label="节奏与同行"
            value={paceSummary}
            pending={!pace}
            open={activePanel === 'pace'}
            onClick={() => togglePanel('pace')}
          />
          {activePanel === 'pace' && (
            <HomePanel mobile={mobile} title="节奏与同行" className={pacePanelCls} onClose={() => setActivePanel(null)}>
              <PanelHead
                icon={<GaugeIcon className="h-[calc(20*var(--ui))] w-[calc(20*var(--ui))] text-accent-teal" />}
                title="节奏与同行"
                onClose={() => setActivePanel(null)}
              />
              <p className={panelLabelCls}>旅行节奏</p>
              <div className="grid grid-cols-1 gap-[calc(10*var(--ui))] min-[400px]:grid-cols-3">
                {PACE_OPTIONS.map((option) => (
                  <Button variant="plain"
                    key={option}
                    type="button"
                    disabled={!saved}
                    aria-pressed={pace === option}
                    onClick={() => changeDraft({ pace: option })}
                    className={`flex flex-col gap-[calc(4*var(--ui))] rounded-[calc(12*var(--ui))] border px-[calc(12*var(--ui))] py-[calc(12*var(--ui))] text-left transition-colors ${pace === option ? "border-brand bg-brand/10 ring-1 ring-brand" : "border-hairline-strong bg-white/60 hover:border-brand"}`}
                  >
                    <span className="text-[length:calc(15*var(--ui))] font-semibold text-ink-strong">
                      {PACE_LABELS[option]}
                    </span>
                    <span className="text-[length:calc(12*var(--ui))] text-ink-muted">{PACE_DESCS[option]}</span>
                  </Button>
                ))}
              </div>
              <p className={panelLabelCls}>同行人数</p>
              <div className="inline-flex items-center gap-[calc(12*var(--ui))]">
                <Button variant="plain"
                  type="button"
                  aria-label="减少人数"
                  disabled={!saved || partySize <= 1}
                  onClick={() => changeDraft({ partySize: Math.max(1, partySize - 1) })}
                  className="grid h-[calc(32*var(--ui))] w-[calc(32*var(--ui))] place-items-center rounded-[calc(10*var(--ui))] border border-hairline-strong bg-white/70 text-ink-strong disabled:opacity-30 max-lg:min-h-11 max-lg:min-w-11"
                >
                  −
                </Button>
                <span className="min-w-[6em] text-center text-[length:calc(15*var(--ui))] font-semibold text-ink-strong">
                  {partySize} 人同行
                </span>
                <Button variant="plain"
                  type="button"
                  aria-label="增加人数"
                  disabled={!saved || partySize >= 20}
                  onClick={() => changeDraft({ partySize: Math.min(20, partySize + 1) })}
                  className="grid h-[calc(32*var(--ui))] w-[calc(32*var(--ui))] place-items-center rounded-[calc(10*var(--ui))] border border-hairline-strong bg-white/70 text-ink-strong disabled:opacity-30 max-lg:min-h-11 max-lg:min-w-11"
                >
                  ＋
                </Button>
              </div>
              <PanelTail />
            </HomePanel>
          )}
        </div>

        {divider}

        <div className="relative min-w-0 flex-1">
          <Segment
            icon={<ScissorsIcon className="h-[calc(26*var(--ui))] w-[calc(26*var(--ui))]" />}
            iconCls="text-accent-pink"
            label="偏好与出行"
            value={savedPreferences.value ? moreSummary : savedPreferences.error ? '加载失败，请重试' : '正在加载偏好…'}
            open={activePanel === 'more'}
            onClick={() => togglePanel('more')}
          />
          {activePanel === 'more' && (
            <HomePanel mobile={mobile} title="偏好与出行" className={`${pacePanelCls} lg:left-auto lg:right-0`} onClose={() => setActivePanel(null)}>
              <PanelHead
                icon={<ScissorsIcon className="h-[calc(20*var(--ui))] w-[calc(20*var(--ui))] text-accent-pink" />}
                title="偏好与出行"
                onClose={() => setActivePanel(null)}
              />
              <div className="min-h-0 overflow-y-auto overscroll-contain">
                <TravelPreferencesFields />
              </div>
              <PanelTail align="preferences" />
            </HomePanel>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-center rounded-full bg-white/55 px-[calc(12*var(--ui))] py-[calc(6*var(--ui))] max-lg:mt-2 max-lg:rounded-2xl max-lg:bg-transparent max-lg:p-0">
          <Button variant="plain"
            type="button"
            aria-label={onOpenGeneration ? '查看正在生成的行程' : mobile ? '生成我的行程' : '开始规划'}
            title={onOpenGeneration ? '查看正在生成的行程' : ready ? '开始规划' : !savedPreferences.value ? '请先加载偏好设置' : '先选目的地与节奏'}
            disabled={!onOpenGeneration && !ready}
            onClick={() => onOpenGeneration ? onOpenGeneration() : onStart({ startDate, endDate, days, pace, partySize, preferences, transportMode, extraNotes })}
            className="relative flex h-[calc(76*var(--ui))] w-[calc(76*var(--ui))] items-center justify-center gap-2 rounded-full bg-gradient-to-br from-brand-light to-brand text-white shadow-[0_12px_26px_rgba(47,107,243,0.35)] transition-transform enabled:hover:scale-[1.04] enabled:active:scale-95 disabled:cursor-not-allowed disabled:from-brand-disabled disabled:to-brand-disabled-deep disabled:shadow-none max-lg:h-14 max-lg:w-full max-lg:bg-gradient-to-r max-lg:from-brand-sky max-lg:px-12 max-lg:text-base max-lg:font-semibold max-lg:shadow-none max-lg:enabled:hover:scale-100"
          >
            <CompassIcon className="hidden h-[calc(30*var(--ui))] w-[calc(30*var(--ui))] lg:block" />
            <span className="lg:hidden">{onOpenGeneration ? '查看正在生成的行程' : '生成我的行程'}</span>
            <span className="absolute right-2 grid h-10 w-10 place-items-center rounded-full bg-white text-brand lg:hidden"><NavigationIcon name="arrow" /></span>
          </Button>
        </div>
      </div>
      {!ready && !onOpenGeneration && <p className="mb-0 mt-2 text-center text-xs leading-5 text-ink-muted lg:hidden">{!savedPreferences.value ? '正在加载旅行偏好' : !city && !pace ? '选好目的地和旅行节奏，就可以出发了' : !city ? '请选择一个目的地' : '请选择旅行节奏'}</p>}
    </div>
  );
}






