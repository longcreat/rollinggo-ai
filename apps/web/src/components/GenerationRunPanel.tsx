import { handwritingFallback } from '../lib/handwriting';
import { Button } from './ui/Button';
// 生成进度视图（09-27 改版）：旅行手账氛围 —— 左侧旅程里程碑小径 + 右侧拍立得候选卡片扇形散开。
// 只呈现用户向信息：三阶段进度、友好状态文案（按稳定工具名查表，见 lib/generationToolCopy）、候选卡片、耗时；
// token/LLM 请求/system prompt 等开发者信息不再展示（见任务 PRD）。
// 配色只用 tailwind.css @theme 里的语义 token（bg-brand / text-ink-* 等），不硬编码色值。
import { useEffect, useId, useMemo, useState } from 'react';
import {
  GENERATION_TIMEOUT_MINUTES,
  type DataSourceKind,
  type GenerationEvent,
  type GenerationPhase,
} from '@tripweaver/shared';
import { buildTimeline, formatDuration, type TimelineModel } from '../lib/generationTimeline';
import { toolCopy } from '../lib/generationToolCopy';
import { DATA_SOURCE_LABEL } from '../lib/poi';
import { PoiCover } from './PoiCard';
import { generationCardCaption, selectGenerationCards } from '../lib/generationCards';
import { useReducedMotion, useStagedGenerationCards } from '../hooks/useGenerationMotion';

interface Props {
  events: GenerationEvent[];
  /** 标题所需：目的地与天数（由表单页传入） */
  city: string;
  days: number;
  cancelling: boolean;
  cancellationError: string | null;
  onCancel: () => void;
  /** 终态后回到可重新发起的状态 */
  onReset: () => void;
  onOpenTrip: (tripId: string) => void;
}

interface Milestone {
  phase: GenerationPhase;
  title: string;
  pendingHint: string;
  doneHint: string;
  activeFallback: string;
}

const MILESTONES: Milestone[] = [
  { phase: 'research', title: '发现好去处', pendingHint: '寻找适合你的景点与体验', doneHint: '好去处已收集', activeFallback: '正在寻找旅行灵感…' },
  { phase: 'plan', title: '安排每日路线', pendingHint: '串联景点，安排游玩顺序', doneHint: '每日路线已安排', activeFallback: '正在安排游玩顺序…' },
  { phase: 'review', title: '完善旅程细节', pendingHint: '为旅程起名，检查路线安排', doneHint: '旅程细节已完善', activeFallback: '正在完善旅程细节…' },
];

/** 里程碑线性图标（描边随 currentColor，等待/进行/完成三态由外层 badge 类控色） */
function MilestoneIcon({ phase }: { phase: GenerationPhase }) {
  const common = {
    width: 26,
    height: 26,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (phase === 'research') {
    return (
      <svg {...common}>
        <circle cx="11" cy="11" r="6.5" />
        <path d="M15.9 15.9 21 21" />
      </svg>
    );
  }
  if (phase === 'plan') {
    // 设计稿的指南针是彩色圆盘 + 橙指针（不是单色线描），自带颜色不跟状态色
    return (
      <svg {...common} stroke="none" fill="none">
        <circle cx="12" cy="12" r="9.2" fill="#6D9BEE" />
        <circle cx="12" cy="12" r="7.4" fill="#EAF1FF" />
        <path d="m18 6-3.4 8.6L6 18l3.4-8.6Z" fill="#F99364" />
        <path d="m6 18 8.6-3.4-5.2-5.2Z" fill="#536DDA" />
        <circle cx="12" cy="12" r="1.1" fill="#1E3A8A" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

/** 四角星光点（标题两侧装饰） */
function SparkIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2c.6 5.6 4.4 9.4 10 10-5.6.6-9.4 4.4-10 10-.6-5.6-4.4-9.4-10-10 5.6-.6 9.4-4.4 10-10z" />
    </svg>
  );
}

/** 拍立得散落位姿（最多展示最近 5 张候选；按设计稿排布，避免覆盖底部操作区）。 */
const FAN = [
  { left: '1.5%', top: '4.8%', rotate: -7 },
  { left: '36.4%', top: '2.5%', rotate: 8 },
  { left: '68%', top: '5.5%', rotate: 9 },
  { left: '10.8%', top: '44%', rotate: -5 },
  { left: '47.6%', top: '48%', rotate: 6 },
];

type MilestoneState = 'pending' | 'active' | 'done';

function milestoneState(model: TimelineModel, phase: GenerationPhase): MilestoneState {
  const last = model.phases.filter((b) => b.phase === phase).at(-1);
  if (!last) return !model.terminal && model.phases.length === 0 && phase === 'research' ? 'active' : 'pending';
  // A phase_end is not job completion: final route checks and persistence run afterward.
  // Keep the latest step live across these gaps, including replayed snapshots.
  if (!model.terminal && model.phases.every(block => block.done) && model.phases.at(-1)?.phase === phase) return 'active';
  return last.done ? 'done' : 'active';
}

/** 最新 SSE 正文/进度短预览；工具事件用用户可读文案（未知工具名走通用 fallback，不显示内部 label）。 */
function activeStatusLine(model: TimelineModel, phase: GenerationPhase, fallback: string): { key: string; text: string } {
  const block = model.phases.filter((b) => b.phase === phase).at(-1);
  if (!block) return { key: `${phase}:preparing`, text: '正在准备你的旅程…' };
  const item = block?.items.filter(i => i.kind === 'thought' || i.kind === 'tool').at(-1);
  const key = `${block?.key ?? phase}:${item?.key ?? 'pending'}`;
  if (item?.kind === 'thought') {
    const text = item.text.trim();
    return { key, text: text ? Array.from(text).slice(0, 90).join('') + (Array.from(text).length > 90 ? '…' : '') : fallback };
  }
  return { key, text: item?.kind === 'tool' ? `正在${toolCopy(item.tool)}…` : fallback };
}

function TypedStatus({ text }: { text: string }) {
  const characters = Array.from(text);
  const characterDelay = Math.min(45, 2400 / Math.max(characters.length, 1));
  return (
    <span className="gen-typewriter" role="status" aria-label={text}>
      <span aria-hidden="true">
        {characters.map((char, index) => <span key={index} className={"gen-typewriter-char [animation:gen-character-in_90ms_both] [@media_(prefers-reduced-motion:_reduce)]:[animation:none]"} style={{ animationDelay: `${index * characterDelay}ms` }}>{char}</span>)}
        <span className={"gen-typewriter-caret inline-block [height:.85em] [border-right:1.5px_solid_currentColor] [margin-left:3px] [animation:gen-caret-blink_1s_step-end_infinite_backwards] [@media_(prefers-reduced-motion:_reduce)]:[animation:none] [@media_(prefers-reduced-motion:_reduce)]:hidden"} style={{ animationDelay: `${characters.length * characterDelay}ms` }} />
      </span>
    </span>
  );
}

/** 数据源降级提示：双源齐全不提示；部分/全无时注明本次实际所用 */
function sourceBanner(sources: DataSourceKind[] | null): string | null {
  if (sources === null || sources.length >= 2) return null;
  const only = sources[0];
  if (only === undefined) return '未配置外部数据源，本次基于模型知识调研。';
  return only === 'websearch'
    ? '地点数据源不可用，本次基于全网搜索 + 模型知识调研。'
    : `全网搜索不可用，本次基于${DATA_SOURCE_LABEL[only]} + 模型知识调研。`;
}

const submitBtnCls =
  'rounded-full bg-gradient-to-r from-brand-light to-brand px-8 py-2.5 text-[0.9rem] font-bold text-white shadow-md transition-transform hover:scale-[1.03] active:scale-95';

export function GenerationRunPanel({ events, city, days, cancelling, cancellationError, onCancel, onReset, onOpenTrip }: Props) {
  const brushId = useId();
  const [failedCovers, setFailedCovers] = useState<ReadonlySet<string>>(() => new Set());
  const model = useMemo(() => buildTimeline(events), [events]);
  const terminal = model.terminal;
  const running = terminal === null;
  const reducedMotion = useReducedMotion();
  const banner = sourceBanner(model.dataSources);
  // 标题用任务自身参数；恢复/刷新链路 URL 里没有日期，prop 的值只是兜底
  const titleCity = model.destination ?? city;
  const titleDays = model.days ?? days;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = model.durationMs ?? (running && model.startedAt !== undefined ? Math.max(0, now - model.startedAt) : undefined);

  // 保留可用照片：后续无图候选不再把整个画面替换为空白。
  const targetCandidates = selectGenerationCards(model.candidates, failedCovers, FAN.length);
  const visibleCandidates = useStagedGenerationCards(targetCandidates, running, reducedMotion);
  const newestId = targetCandidates.filter(poi => visibleCandidates.some(shown => shown.id === poi.id)).at(-1)?.id;

  return (
    <div
      className={"gen-page-root [--ui:max(0.75px,_min(0.0599vw,_0.106vh))] [--gen-serif:'SimSun',_'Songti_SC',_'Noto_Serif_SC_Variable',_serif] [&_.gen-title]:block [&_.gen-title]:[margin:0_0_0_calc(80_*_var(--ui))] [&_.gen-title]:[font-family:var(--gen-serif)] [&_.gen-title]:[font-size:calc(42_*_var(--ui))] [&_.gen-title]:font-bold [&_.gen-title]:[line-height:1.12] [&_.gen-title]:[color:var(--color-gen-page-root-color-30)] [&_.gen-step-title]:m-0 [&_.gen-step-title]:[font-family:var(--gen-serif)] [&_.gen-step-title]:[font-size:calc(28_*_var(--ui))] [&_.gen-step-title]:font-bold [&_.gen-step-title]:[line-height:1.25] [&_.gen-step-title]:[color:var(--color-gen-page-root-color-30)] [@media_(max-width:_900px)]:[&_.gen-title]:m-0 [@media_(max-width:_900px)]:[&_.gen-title]:[font-size:clamp(25px,_4.5vw,_36px)] [@media_(max-width:_900px)]:[&_.gen-title]:[line-height:1.4] relative flex flex-1 flex-col overflow-hidden"}
    >
      {/* 标题区：星形光点 + 笔刷弧线（仅进行中显示，终态有自己的卡片标题） */}
      {!terminal && (
        <header className={"gen-header relative [z-index:10] flex flex-col items-center [gap:0] [padding:calc(37_*_var(--ui))_calc(40_*_var(--ui))_0] text-center [@media_(max-width:_900px)]:[padding:36px_16px_0]"}>
          <h1 className={"gen-title [&_.gen-star]:inline-block [&_.gen-star]:shrink-0 [&_.gen-star]:[width:calc(20_*_var(--ui))] [&_.gen-star]:[height:calc(20_*_var(--ui))] [&_.gen-star]:[margin:0_calc(12_*_var(--ui))] [&_.gen-star]:[vertical-align:top] [&_.gen-star]:[color:var(--color-gen-title-color-31)] [&_.gen-star]:[animation:gen-star-twinkle_3.2s_ease-in-out_infinite] [&_.gen-star-l]:[align-self:flex-start] [&_.gen-star-l]:[margin-top:calc(4_*_var(--ui))] [&_.gen-star-r]:[align-self:flex-start] [&_.gen-star-r]:[margin-top:calc(-10_*_var(--ui))] [&_.gen-star-r]:[animation-delay:-1.4s] [@media_(max-width:_900px)]:[&_.gen-star]:[width:12px] [@media_(max-width:_900px)]:[&_.gen-star]:[height:12px] [@media_(max-width:_900px)]:[&_.gen-star]:[margin:8px] [@media_(prefers-reduced-motion:_reduce)]:[&_.gen-star]:[animation:none]"}>
            <SparkIcon className="gen-star gen-star-l" />
            <span>正在为你编织 <strong className={"gen-title-city [font-size:1.4em] [font-weight:inherit]"}>{titleCity}</strong> 的 {titleDays} 天旅程…</span>
            <SparkIcon className="gen-star gen-star-r" />
          </h1>
          <svg className={"gen-title-arc block [width:calc(440_*_var(--ui))] [height:calc(32_*_var(--ui))] [max-width:85%] [margin-left:calc(80_*_var(--ui))] [@media_(max-width:_900px)]:[margin-left:0]"} viewBox="0 0 440 32" fill="none" aria-hidden="true">
            <defs><linearGradient id={brushId}><stop stopColor="#eee5ff" stopOpacity="0" /><stop offset=".35" stopColor="#c9b1fc" /><stop offset=".7" stopColor="#99cfff" /><stop offset="1" stopColor="#c9b1fc" stopOpacity="0" /></linearGradient></defs>
            <path d="M4 29C88 7 183 1 245 6c16 2-10 12 5 9s63-11 70-7-8 7 5 6 65-7 109 3" stroke={`url(#${brushId})`} strokeWidth="4" strokeLinecap="round" />
          </svg>
          {banner && <p className="m-0 rounded-full bg-white/60 px-4 py-1 text-[0.8rem] text-ink-muted backdrop-blur-md">{banner}</p>}
        </header>
      )}

      {terminal ? (
        /* ---------- 终态视图（成功 / 失败 / 取消） ---------- */
        <main className="relative z-10 flex flex-1 items-center justify-center px-6">
          <div className="w-[min(460px,100%)] rounded-[20px] border border-white/50 bg-white/75 p-8 text-center shadow-[0_8px_32px_rgba(0,0,0,0.08)] backdrop-blur-xl">
            {terminal.type === 'job_done' && (
              <>
                <p className="m-0 mb-2 text-xl font-bold text-ink">行程已准备好，正在为你打开…</p>
                {terminal.reviewNotes.length > 0 && (
                  <ul className="m-0 mb-4 list-none p-0 text-left text-[0.88rem] text-ink-soft">
                    {terminal.reviewNotes.map((note, i) => (
                      <li key={i} className="py-0.5">📝 {note}</li>
                    ))}
                  </ul>
                )}
                <Button variant="plain" type="button" onClick={() => onOpenTrip(terminal.tripId)} className={submitBtnCls}>
                  立即打开
                </Button>
              </>
            )}
            {terminal.type === 'job_error' && (
              <>
                <p className="m-0 mb-2 text-xl font-bold text-ink">生成失败</p>
                <p className="m-0 mb-4 text-[0.88rem] text-ink-soft">{terminal.message}（失败不计入今日配额）</p>
                <Button variant="plain" type="button" onClick={onReset} className={submitBtnCls}>
                  返回重试
                </Button>
              </>
            )}
            {terminal.type === 'job_cancelled' && (
              <>
                <p className="m-0 mb-2 text-xl font-bold text-ink">已取消</p>
                <p className="m-0 mb-4 text-[0.88rem] text-ink-soft">
                  {terminal.reason === 'timeout'
                    ? `生成超过 ${GENERATION_TIMEOUT_MINUTES} 分钟未完成，系统已自动取消。本次不计入今日配额，可稍后重新生成。`
                    : '你已取消本次生成。本次不计入今日配额。'}
                </p>
                <Button variant="plain" type="button" onClick={onReset} className={submitBtnCls}>
                  返回重新规划
                </Button>
              </>
            )}
          </div>
        </main>
      ) : (
        /* ---------- 进行中：左里程碑小径 + 右拍立得 ---------- */
        <main className={"gen-main relative [z-index:10] flex flex-1 min-h-0 [gap:calc(60_*_var(--ui))] [padding:0_calc(40_*_var(--ui))_0_calc(188_*_var(--ui))] [@media_(max-width:_900px)]:flex-col [@media_(max-width:_900px)]:flex-none [@media_(max-width:_900px)]:[gap:24px] [@media_(max-width:_900px)]:[padding:16px_20px_24px]"}>
          {/* 里程碑小径 */}
          <div className={"gen-path flex flex-col justify-center shrink-0 [width:calc(500_*_var(--ui))] [padding-bottom:calc(42_*_var(--ui))] [@media_(max-width:_900px)]:w-full [@media_(max-width:_900px)]:[padding-bottom:0]"}>
            {MILESTONES.map((m, i) => {
              const state = milestoneState(model, m.phase);
              const liveStatus = activeStatusLine(model, m.phase, m.activeFallback);
              const hint =
                state === 'done'
                  ? m.doneHint
                  : state === 'active'
                    ? liveStatus.text
                    : m.pendingHint;
              return (
                <div key={m.phase} className={`gen-step [--gen-badge:calc(80_*_var(--ui))] [--gen-gap:calc(47_*_var(--ui))] relative flex items-center [gap:calc(24_*_var(--ui))] [padding:var(--gen-gap)_0] [&.is-done_.gen-step-badge]:[background:linear-gradient(145deg,_var(--color-gen-step-background-39),_var(--color-gen-step-background-40))] [&.is-done_.gen-step-badge]:[border-color:var(--color-gen-step-border-color-41)] [&.is-done_.gen-step-badge]:[color:var(--color-gen-step-color-42)] [&.is-done_.gen-step-badge]:[filter:none] [&.is-done_.gen-step-badge]:[opacity:1] [&.is-done_.gen-step-badge]:[box-shadow:0_0_0_calc(5_*_var(--ui))_rgba(52,_199,_123,_0.12)] [&.is-active_.gen-step-badge]:[background:linear-gradient(145deg,_var(--color-gen-step-background-43),_var(--color-gen-step-background-44))] [&.is-active_.gen-step-badge]:[border-color:var(--color-gen-step-border-color-45)] [&.is-active_.gen-step-badge]:[color:var(--color-brand)] [&.is-active_.gen-step-badge]:[filter:none] [&.is-active_.gen-step-badge]:[opacity:1] [&.is-active_.gen-step-badge]:[box-shadow:0_0_0_calc(6_*_var(--ui))_rgba(130,169,255,.26),_0_0_0_calc(13_*_var(--ui))_rgba(174,205,255,.2),_0_0_calc(25_*_var(--ui))_rgba(91,135,247,.4),_inset_0_2px_6px_rgba(255,255,255,.9)] [&.is-active_.gen-step-badge]:[animation:gen-badge-breathe_2.8s_ease-in-out_infinite] [&.is-pending_.gen-step-title]:[color:var(--color-gen-step-color-46)] [@media_(max-width:_900px)]:[--gen-gap:24px] [@media_(prefers-reduced-motion:_reduce)]:[&.is-active_.gen-step-badge]:[animation:none] is-${state}`}>
                  {i > 0 && <svg className={"gen-step-line absolute [left:calc(var(--gen-badge)_/_2_-_58_*_var(--ui))] [top:calc(-1_*_var(--gen-gap))] [height:calc(50%_+_var(--gen-gap)_-_var(--gen-badge)_/_2)] [width:calc(60_*_var(--ui))] [overflow:visible] [&_path]:[fill:none] [&_path]:[stroke:var(--color-gen-step-line-stroke-33)] [&_path]:[stroke-width:1.8] [&_path]:[stroke-dasharray:6_8] [&_path]:[stroke-linecap:round] [&_path]:[vector-effect:non-scaling-stroke]"} viewBox="0 0 60 100" preserveAspectRatio="none" aria-hidden="true"><path d="M58 0C54 20 8 24 16 54S45 82 58 100" /></svg>}
                  <span className={"gen-step-badge relative [z-index:1] shrink-0 flex items-center justify-center [width:var(--gen-badge)] [height:var(--gen-badge)] [border-radius:50%] [background:linear-gradient(145deg,_var(--color-gen-step-badge-background-34),_var(--color-gen-step-badge-background-35))] [border:calc(2_*_var(--ui))_solid_rgba(255,255,255,.8)] [color:var(--color-gen-step-badge-color-36)] [filter:grayscale(0.4)] [opacity:0.85] [box-shadow:0_0_0_calc(5_*_var(--ui))_rgba(205,216,237,.35),_inset_0_2px_5px_rgba(255,255,255,.85)] [&_>_svg]:relative [&_>_svg]:[z-index:2] [&_>_svg]:[width:calc(36_*_var(--ui))] [&_>_svg]:[height:calc(36_*_var(--ui))] [&::before]:[content:''] [&::before]:absolute [&::before]:[inset:calc(10_*_var(--ui))] [&::before]:[z-index:1] [&::before]:[border:calc(2_*_var(--ui))_solid_white] [&::before]:[border-radius:50%] [&::before]:[background:linear-gradient(145deg,_var(--color-btn-primary-color-3),_var(--color-gen-step-badge-background-37))] [&::before]:[box-shadow:0_2px_5px_rgba(60,88,150,.12)] [&::after]:[content:''] [&::after]:absolute [&::after]:[left:50%] [&::after]:[bottom:calc(-10_*_var(--ui))] [&::after]:[width:calc(24_*_var(--ui))] [&::after]:[height:calc(24_*_var(--ui))] [&::after]:[border-radius:calc(3_*_var(--ui))] [&::after]:[background:inherit] [&::after]:[transform:translateX(-50%)_rotate(45deg)]"} aria-hidden="true">
                    <MilestoneIcon phase={m.phase} />
                    {state === 'done' && (
                      <span className={"gen-step-check absolute [z-index:3] [right:calc(-9_*_var(--ui))] [bottom:calc(-5_*_var(--ui))] flex items-center justify-center [width:calc(34_*_var(--ui))] [height:calc(34_*_var(--ui))] [border-radius:50%] [background:var(--color-gen-step-check-background-38)] [color:var(--color-btn-primary-color-3)] [border:calc(3_*_var(--ui))_solid_var(--color-btn-primary-color-3)] [box-shadow:0_calc(3_*_var(--ui))_calc(8_*_var(--ui))_rgba(52,_199,_123,_0.35)] [&_svg]:[width:calc(20_*_var(--ui))] [&_svg]:[height:calc(20_*_var(--ui))]"}>
                        <CheckIcon />
                      </span>
                    )}
                  </span>
                  <div className={"gen-step-body min-w-0"}>
                    <p className="gen-step-title">
                      {m.title}
                    </p>
                    <p style={state === 'active' ? handwritingFallback(hint) : undefined} className={`gen-step-hint [margin:calc(8_*_var(--ui))_0_0] [font-size:calc(18_*_var(--ui))] [color:var(--color-gen-queue-hint-color-32)] [@media_(max-width:_900px)]:[overflow-wrap:anywhere] ${state === 'active' ? "gen-step-hint-live [font-family:'Youran_Handwriting',_var(--gen-serif)] [font-size:calc(34_*_var(--ui))] [letter-spacing:-0.075em] [@media_(max-width:_900px)]:[font-size:28px] [line-height:1.25] [color:var(--color-gen-step-hint-live-color-47)] [min-height:2.5em] [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical] overflow-hidden [@media_(prefers-reduced-motion:_reduce)]:[animation:none]" : ""}`}>
                      {state === 'active' ? <TypedStatus key={liveStatus.key} text={hint} /> : hint}
                    </p>
                  </div>
                </div>
              );
            })}
            {model.phases.length === 0 && <p className={"gen-queue-hint m-0 [font-size:calc(18_*_var(--ui))] [color:var(--color-gen-queue-hint-color-32)]"}>正在准备你的旅程…</p>}
          </div>

          {/* 拍立得候选卡片 */}
          <div className={"gen-fan relative flex-1 min-w-0 [@media_(max-width:_900px)]:grid [@media_(max-width:_900px)]:[grid-template-columns:repeat(2,_minmax(0,_1fr))] [@media_(max-width:_900px)]:[gap:28px_20px] [@media_(max-width:_900px)]:[padding:12px_0] [@media_(max-width:_900px)]:[&_.gen-polaroid]:relative [@media_(max-width:_900px)]:[&_.gen-polaroid]:[left:auto]! [@media_(max-width:_900px)]:[&_.gen-polaroid]:[top:auto]! [@media_(max-width:_900px)]:[&_.gen-polaroid]:[transform:rotate(-3deg)]! [@media_(max-width:_900px)]:[&_.gen-polaroid]:w-full [@media_(max-width:_900px)]:[&_.gen-polaroid]:[padding:10px_10px_14px] [@media_(max-width:_900px)]:[&_.gen-polaroid:nth-child(even)]:[transform:rotate(3deg)]!"}>
            {visibleCandidates.length === 0 ? (
              /* 候选未到时先放 3 张虚线空相框，避免右侧长时间全空 */
              FAN.slice(0, 3).map((pose, i) => (
                <div
                  key={i}
                  className={"gen-polaroid absolute [z-index:1] [width:calc(250_*_var(--ui))] m-0 [border-radius:calc(6_*_var(--ui))] [padding:calc(20_*_var(--ui))_calc(20_*_var(--ui))_calc(16_*_var(--ui))] [box-shadow:0_calc(10_*_var(--ui))_calc(40_*_var(--ui))_rgba(0,_0,_0,_0.12)] [&:nth-child(-n+3)]:[z-index:2] [&:has(.gen-polaroid-new)::after]:[content:''] [&:has(.gen-polaroid-new)::after]:absolute [&:has(.gen-polaroid-new)::after]:[inset:-6px] [&:has(.gen-polaroid-new)::after]:pointer-events-none [&:has(.gen-polaroid-new)::after]:[background:linear-gradient(35deg,_transparent_44%,_var(--color-gen-polaroid-background-52)_45%_55%,_transparent_56%)_left_15%_/_18px_20px_no-repeat,_linear-gradient(-35deg,_transparent_44%,_var(--color-gen-polaroid-background-52)_45%_55%,_transparent_56%)_right_70%_/_18px_20px_no-repeat] [@media_(prefers-reduced-motion:_reduce)]:[animation:none] gen-polaroid-ghost [background:rgba(255,_255,_255,_0.35)] [border:calc(2_*_var(--ui))_dashed_rgba(255,_255,_255,_0.75)] shadow-none [animation:gen-ghost-breathe_2.8s_ease-in-out_infinite] [&_.gen-polaroid-photo]:[background:rgba(255,_255,_255,_0.3)]"}
                  style={{ left: pose.left, top: pose.top, transform: `rotate(${pose.rotate}deg)` }}
                  aria-hidden="true"
                >
                  <div className={"gen-polaroid-photo [aspect-ratio:1_/_1.05] overflow-hidden [border-radius:calc(2_*_var(--ui))] [background:var(--color-gen-polaroid-photo-background-48)] [&_.poi-cover]:w-full [&_.poi-cover]:h-full [&_.poi-cover]:[object-fit:cover] [&_.poi-cover]:block [&_.poi-cover-fallback]:flex [&_.poi-cover-fallback]:items-center [&_.poi-cover-fallback]:justify-center [&_.poi-cover-fallback]:[font-size:calc(46_*_var(--ui))]"} />
                  <div className={"gen-polaroid-caption [margin:calc(18_*_var(--ui))_0_0] [font-family:'Youran_Handwriting',_var(--gen-serif)] [font-size:calc(30_*_var(--ui))] [letter-spacing:-0.055em] [line-height:1.25] [color:var(--color-gen-polaroid-caption-color-49)] text-center whitespace-normal [overflow-wrap:anywhere] [@media_(max-width:_900px)]:[margin-top:12px] [@media_(max-width:_900px)]:[font-size:24px] gen-ghost-bar [height:calc(24_*_var(--ui))] [border-radius:calc(4_*_var(--ui))] [background:rgba(255,_255,_255,_0.45)]"} />
                </div>
              ))
            ) : (
              visibleCandidates.map((poi, i) => {
                const pose = FAN[i % FAN.length]!;
                return (
                  <figure
                    key={`${poi.id}:${poi.coverUrl ?? ''}`}
                    className={"gen-polaroid absolute [z-index:1] [width:calc(250_*_var(--ui))] m-0 [background:var(--color-btn-primary-color-3)] [border-radius:calc(6_*_var(--ui))] [padding:calc(20_*_var(--ui))_calc(20_*_var(--ui))_calc(16_*_var(--ui))] [box-shadow:0_calc(10_*_var(--ui))_calc(40_*_var(--ui))_rgba(0,_0,_0,_0.12)] [animation:gen-polaroid-in_1.1s_cubic-bezier(0.22,_1,_0.36,_1)_both] [&:nth-child(-n+3)]:[z-index:2] [&:has(.gen-polaroid-new)::after]:[content:''] [&:has(.gen-polaroid-new)::after]:absolute [&:has(.gen-polaroid-new)::after]:[inset:-6px] [&:has(.gen-polaroid-new)::after]:pointer-events-none [&:has(.gen-polaroid-new)::after]:[background:linear-gradient(35deg,_transparent_44%,_var(--color-gen-polaroid-background-52)_45%_55%,_transparent_56%)_left_15%_/_18px_20px_no-repeat,_linear-gradient(-35deg,_transparent_44%,_var(--color-gen-polaroid-background-52)_45%_55%,_transparent_56%)_right_70%_/_18px_20px_no-repeat] [@media_(prefers-reduced-motion:_reduce)]:[animation:none]"}
                    style={{ left: pose.left, top: pose.top, transform: `rotate(${pose.rotate}deg)` }}
                  >
                    <div className={"gen-polaroid-photo [aspect-ratio:1_/_1.05] overflow-hidden [border-radius:calc(2_*_var(--ui))] [background:var(--color-gen-polaroid-photo-background-48)] [&_.poi-cover]:w-full [&_.poi-cover]:h-full [&_.poi-cover]:[object-fit:cover] [&_.poi-cover]:block [&_.poi-cover-fallback]:flex [&_.poi-cover-fallback]:items-center [&_.poi-cover-fallback]:justify-center [&_.poi-cover-fallback]:[font-size:calc(46_*_var(--ui))]"}>
                      <PoiCover key={poi.coverUrl} poi={poi} onCoverError={(url) => setFailedCovers(previous => new Set(previous).add(url))} />
                    </div>
                    <figcaption style={handwritingFallback(generationCardCaption(poi))} className={"gen-polaroid-caption [margin:calc(18_*_var(--ui))_0_0] [font-family:'Youran_Handwriting',_var(--gen-serif)] [font-size:calc(30_*_var(--ui))] [letter-spacing:-0.055em] [line-height:1.25] [color:var(--color-gen-polaroid-caption-color-49)] text-center whitespace-normal [overflow-wrap:anywhere] [@media_(max-width:_900px)]:[margin-top:12px] [@media_(max-width:_900px)]:[font-size:24px]"} title={generationCardCaption(poi)}>{generationCardCaption(poi)}</figcaption>
                    {poi.id === newestId && <span className={"gen-polaroid-new absolute [top:calc(14_*_var(--ui))] [right:calc(-18_*_var(--ui))] [padding:calc(9_*_var(--ui))_calc(18_*_var(--ui))] [background:var(--color-gen-polaroid-new-background-50)] [color:var(--color-gen-polaroid-new-color-51)] [font-size:calc(38_*_var(--ui))] [font-family:'Youran_Handwriting',_cursive] [line-height:1] [font-style:italic] [clip-path:polygon(4%_0,_20%_8%,_32%_0,_44%_9%,_59%_0,_70%_10%,_86%_4%,_88%_20%,_100%_30%,_92%_46%,_100%_62%,_90%_72%,_94%_92%,_76%_90%,_65%_100%,_50%_90%,_37%_100%,_25%_88%,_7%_94%,_10%_74%,_0_62%,_8%_46%,_0_29%,_9%_18%)] [animation:gen-new-pop_0.6s_ease-out] [@media_(prefers-reduced-motion:_reduce)]:[animation:none]"}>new</span>}
                  </figure>
                );
              })
            )}
          </div>
        </main>
      )}

      {/* 底部：耗时 + 取消 */}
      <footer className={"gen-footer relative [z-index:10] flex flex-col items-center [gap:calc(14_*_var(--ui))] [padding-bottom:0] [@media_(max-width:_900px)]:[padding:12px_16px_24px]"}>
        {cancellationError && (
          <p className="m-0 rounded-full bg-white/70 px-4 py-1 text-[0.82rem] text-red-600 backdrop-blur-md" role="alert">
            {cancellationError}
          </p>
        )}
        {running && (
          <>
            <Button variant="plain"
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className={"gen-cancel-btn [border:1px_solid_rgba(255,_255,_255,_0.5)] rounded-full [background:rgba(255,_255,_255,_0.72)] [padding:calc(11_*_var(--ui))_calc(22_*_var(--ui))] [font-size:calc(20_*_var(--ui))] [color:var(--color-gen-cancel-btn-color-53)] [backdrop-filter:blur(10px)] [transition:background-color_0.2s] [&:hover]:[background:rgba(255,_255,_255,_0.92)] [&:disabled]:[opacity:0.5]"}
            >
              {cancelling ? '取消中…' : '取消生成'}
            </Button>
            {elapsed !== undefined && (
              <span className={"gen-elapsed [font-size:calc(16_*_var(--ui))] [color:var(--color-gen-elapsed-color-54)]"}>已用 {formatDuration(elapsed)}</span>
            )}
          </>
        )}
      </footer>
    </div>
  );
}
