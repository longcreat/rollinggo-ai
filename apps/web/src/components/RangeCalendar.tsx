import { Button } from './ui/Button';
// 范围日历（09-26，交互参考 Yuntu InputPage.CustomCalendarRange）：
// 点第一次定出发日，悬停预览区间，点第二次定返回日；跨度超过 maxDays 时自动收短到上限。
// 纯受控组件：值由父组件持有，这里只负责网格渲染与两次点击的区间语义。
// months 控制并列月数（首页日期浮层用 2 个月并排，其它调用方默认 1）；
// footSlot 用于替换底栏内容；传 null 表示不要底栏（首页日期面板只用标题栏 + 日历）。
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(iso: string): Date {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Six complete weeks cover every month without dropping its last dates. */
function generateMonthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - offset);
  return Array.from(
    { length: 42 },
    (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i),
  );
}

interface Props {
  startDate: string;   // "2026-11-05"
  endDate: string;
  maxDays: number;
  onRangeChange: (start: string, end: string) => void;
  months?: number;
  footSlot?: ReactNode;   // 不传用默认底栏，传 null 则不渲染底栏
}

export function RangeCalendar({ startDate, endDate, maxDays, onRangeChange, months = 1, footSlot }: Props) {
  const [viewDate, setViewDate] = useState(() => parseDate(startDate));
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hoverIso, setHoverIso] = useState<string | null>(null);

  const today = useMemo(() => startOfDay(new Date()), []);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const viewMonths = useMemo(
    () => Array.from({ length: months }, (_, i) => new Date(year, month + i, 1)),
    [year, month, months],
  );

  const handleDayClick = (iso: string) => {
    if (!pendingStart) {
      setPendingStart(iso);
      return;
    }
    if (iso <= pendingStart) {
      // 点回起点之前：重定起点，继续选
      setPendingStart(iso);
      setHoverIso(null);
      return;
    }
    const days = Math.round((parseDate(iso).getTime() - parseDate(pendingStart).getTime()) / 86_400_000) + 1;
    const clampedEnd = new Date(parseDate(pendingStart));
    clampedEnd.setDate(clampedEnd.getDate() + Math.min(days, maxDays) - 1);
    onRangeChange(pendingStart, toISO(clampedEnd));
    setPendingStart(null);
    setHoverIso(null);
  };

  const effectiveStart = pendingStart ?? startDate;
  const effectiveEnd = pendingStart
    ? hoverIso && hoverIso >= pendingStart
      ? hoverIso
      : pendingStart
    : endDate;

  const shiftMonth = (delta: number) => setViewDate(new Date(year, month + delta, 1));

  return (
    <div className={"range-calendar [--rc-gap:6px] [--rc-month-gap:12px] [--rc-head-height:30px] [--rc-head-pad-left:26px] [--rc-title-size:1rem] [--rc-arrow-width:24px] [--rc-arrow-size:1.15rem] [--rc-weekday-size:0.82rem] [--rc-day-height:34px] [--rc-day-size:0.95rem] flex flex-col [gap:var(--rc-gap)]"}>
      <div className={"range-calendar-months flex [gap:var(--rc-month-gap)]"}>
        {viewMonths.map((monthDate, index) => {
          const mYear = monthDate.getFullYear();
          const mMonth = monthDate.getMonth();
          const grid = generateMonthGrid(mYear, mMonth);
          return (
            <div className={"range-calendar-month flex-1 min-w-0 flex flex-col [gap:var(--rc-gap)]"} key={`${mYear}-${mMonth}`}>
              <div className={"range-calendar-head relative flex items-center [height:var(--rc-head-height)] [padding-left:var(--rc-head-pad-left)]"}>
                {index === 0 && (
                  <Button variant="plain"
                    type="button"
                    className={"range-calendar-arrow absolute [top:0] flex items-center justify-center [width:var(--rc-arrow-width)] [height:var(--rc-head-height)] p-0 border-0 [background:none] [font:inherit] [font-size:var(--rc-arrow-size)] [line-height:1] [color:var(--color-muted)] cursor-pointer [&.is-prev]:[left:0] [&.is-next]:[right:0] [&:hover]:[color:var(--color-primary)] is-prev"}
                    aria-label="上一月"
                    onClick={() => shiftMonth(-1)}
                  >
                    ‹
                  </Button>
                )}
                <span className={"range-calendar-title font-bold [font-size:var(--rc-title-size)] [color:var(--color-ink-strong)]"}>
                  {mYear}年{mMonth + 1}月
                </span>
                {index === months - 1 && (
                  <Button variant="plain"
                    type="button"
                    className={"range-calendar-arrow absolute [top:0] flex items-center justify-center [width:var(--rc-arrow-width)] [height:var(--rc-head-height)] p-0 border-0 [background:none] [font:inherit] [font-size:var(--rc-arrow-size)] [line-height:1] [color:var(--color-muted)] cursor-pointer [&.is-prev]:[left:0] [&.is-next]:[right:0] [&:hover]:[color:var(--color-primary)] is-next"}
                    aria-label="下一月"
                    onClick={() => shiftMonth(1)}
                  >
                    ›
                  </Button>
                )}
              </div>

              <div className={"range-calendar-weekdays grid [grid-template-columns:repeat(7,_1fr)] text-center [font-size:var(--rc-weekday-size)] font-semibold [color:var(--color-muted)]"}>
                {WEEKDAYS.map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </div>

              <div className={"range-calendar-grid grid [grid-template-columns:repeat(7,_1fr)] [gap:2px]"}>
                {grid.map((d) => {
                  const iso = toISO(d);
                  const isCurrentMonth = d.getMonth() === mMonth;
                  const isPast = d < today;
                  const isStart = iso === effectiveStart;
                  const isEnd = iso === effectiveEnd;
                  const inRange = iso >= effectiveStart && iso <= effectiveEnd;
                  const className = [
                    "range-calendar-day flex items-center justify-center [height:var(--rc-day-height)] border-0 bg-transparent [color:var(--color-ink-strong)] [font:inherit] [font-size:var(--rc-day-size)] cursor-pointer rounded-full [&:hover:not(:disabled):not(.is-start):not(.is-end)]:[background:var(--color-bg)] [&.is-outside]:[color:var(--color-muted)] [&.is-outside]:[opacity:0.45] [&.is-past]:[color:var(--color-muted)] [&.is-past]:[opacity:0.4] [&.is-past]:[cursor:not-allowed] [&.is-in-range]:[background:var(--color-range-calendar-day-background-4)] [&.is-start]:[background:var(--color-primary)] [&.is-start]:[color:var(--color-btn-primary-color-3)] [&.is-start]:font-bold [&.is-end]:[background:var(--color-primary)] [&.is-end]:[color:var(--color-btn-primary-color-3)] [&.is-end]:font-bold",
                    isCurrentMonth ? '' : 'invisible',
                    isPast ? 'is-past' : '',
                    inRange ? 'is-in-range' : '',
                    isStart ? 'is-start' : '',
                    isEnd ? 'is-end' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <Button variant="plain"
                      key={iso}
                      type="button"
                      aria-label={iso}
                      disabled={isPast || !isCurrentMonth}
                      aria-hidden={!isCurrentMonth}
                      aria-pressed={isCurrentMonth && (isStart || isEnd)}
                      className={className}
                      onClick={() => handleDayClick(iso)}
                      onMouseEnter={() => {
                        if (pendingStart && iso >= pendingStart) setHoverIso(iso);
                      }}
                    >
                      {d.getDate()}
                    </Button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {footSlot === undefined ? (
        <div className={"range-calendar-foot [border-top:1px_solid_var(--color-border)] [padding-top:8px] muted [color:var(--color-muted)] [font-size:0.88rem]"}>
          {pendingStart ? `再点返回日期（最多 ${maxDays} 天）` : `已选：${startDate} ~ ${endDate}`}
        </div>
      ) : (
        footSlot
      )}
    </div>
  );
}
