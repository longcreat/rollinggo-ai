// 打印/长图共用的线性排版视图（全文，不含地图与概览候选池）——常驻离屏渲染
import type { Trip } from '@tripweaver/shared';
import { dayColor } from '../lib/colors';
import { DATA_SOURCE_LABEL } from '../lib/poi';

function timeRange(start: string, end: string): string {
  if (!start && !end) return '';
  return `${start || '--:--'} ~ ${end || '--:--'}`;
}

export function PrintView({ trip }: { trip: Trip }) {
  // 数据来源标注（依 meta.dataSources；旧行程无该字段则不显示）
  const sources = trip.meta.dataSources ?? [];
  return (
    <div className={"pv [padding:28px_32px] [color:var(--color-pv-color-18)] [font-size:14px] [line-height:1.6] [&_h1]:[font-size:1.5rem] [&_h1]:[margin:0_0_4px] [&_h2]:[font-size:1.05rem] [&_h2]:[margin:0_0_8px]"}>
      <header className={"pv-head [border-bottom:2px_solid_var(--color-pv-head-border-bottom-20)] [padding-bottom:12px] [margin-bottom:16px]"}>
        <h1>{trip.title}</h1>
        <p className={"pv-sub [color:var(--color-pv-sub-color-19)] [margin:0_0_6px]"}>
          {trip.destination} · {trip.days.length} 天 · {trip.partySize} 人
          {trip.startDate ? ` · ${trip.startDate} 出发` : ''}
        </p>
        {sources.length > 0 && <p className={"pv-tag [color:var(--color-tag-source-color-5)] [font-size:0.85rem] m-0"}>🧭 行程参考了{sources.map((s) => DATA_SOURCE_LABEL[s]).join('与')}</p>}
      </header>

      {trip.days.map((day) => (
        <section key={day.id} className={"pv-day [margin-bottom:18px] [&_h2]:[border-left:4px_solid_var(--color-pv-head-border-bottom-20)] [&_h2]:[padding-left:8px] [@media_print]:[&_h2]:[break-after:avoid] [@media_print]:[&_h2]:[page-break-after:avoid]"}>
          <h2 style={{ borderLeftColor: dayColor(day.dayIndex) }}>
            第 {day.dayIndex} 天{day.title ? ` · ${day.title}` : ''}
          </h2>
          {day.activities.length === 0 && <p className={"pv-empty [color:var(--color-pv-sub-color-19)] m-0"}>（本日暂无安排）</p>}
          {day.activities.map((a) => (
            <div key={a.id} className={"pv-activity [padding:6px_0_6px_12px] [border-bottom:1px_dashed_var(--color-pv-activity-border-bottom-21)] [@media_print]:[break-inside:avoid] [@media_print]:[page-break-inside:avoid]"}>
              <div className={"pv-activity-line flex [gap:10px] [align-items:baseline] flex-wrap"}>
                <span className={"pv-time [color:var(--color-pv-sub-color-19)] [font-variant-numeric:tabular-nums] [min-width:96px]"}>{timeRange(a.startTime, a.endTime)}</span>
                <strong className="pv-name">{a.name}</strong>
                <span className={"pv-cat [color:var(--color-pv-sub-color-19)] [font-size:0.82rem]"}>{a.category}</span>
              </div>
              {a.description && <p className={"pv-desc [margin:2px_0_0] [color:var(--color-pv-desc-color-22)] [font-size:0.88rem]"}>{a.description}</p>}
              {a.sourceNotes.length > 0 && (
                <p className={"pv-notes [margin:2px_0_0] [color:var(--color-tag-source-color-5)] [font-size:0.8rem]"}>
                  来源：
                  {a.sourceNotes.map((n) => (
                    <span key={n.url}>🔗 {n.title || n.url} </span>
                  ))}
                </p>
              )}
            </div>
          ))}
        </section>
      ))}

      {trip.meta.reviewNotes.length > 0 && (
        <section className={"pv-review [margin-top:14px] [&_p]:[margin:2px_0] [&_p]:[color:var(--color-pv-desc-color-22)] [@media_print]:[break-inside:avoid] [@media_print]:[page-break-inside:avoid]"}>
          <h2>小贴士</h2>
          {trip.meta.reviewNotes.map((n, i) => (
            <p key={i}>· {n}</p>
          ))}
        </section>
      )}

      <footer className={"pv-foot [margin-top:20px] text-center [color:var(--color-pv-foot-color-23)] [font-size:0.8rem]"}>由 RollingGo 生成</footer>
    </div>
  );
}
