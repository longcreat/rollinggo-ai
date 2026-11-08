// HITL 问题卡：Agent 在工具执行中暂停时显示，用户选择/自定义答案后提交。
// 视觉跟随编辑器：白底、细边框、紧凑表单；选项用纵向列表而不是彩色胶囊。
import { useMemo, useState } from 'react';
import type { AgentQuestionAnswer, PendingQuestionView } from '@tripweaver/shared';

export function QuestionCard(props: {
  question: PendingQuestionView;
  state: 'pending' | 'answered' | 'expired';
  expiredReason?: 'timeout' | 'cancelled';
  answered?: AgentQuestionAnswer[];
  submitting?: boolean;
  disabled?: boolean;
  error?: string;
  onSubmit: (answers: AgentQuestionAnswer[]) => void;
}) {
  const { question, state, answered, submitting, disabled } = props;
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);
  const answeredById = useMemo(() => new Map((answered ?? []).map((answer) => [answer.id, answer])), [answered]);

  const toggle = (id: string, label: string, multi: boolean) => {
    if (state !== 'pending' || disabled || submitting) return;
    setSelected((prev) => {
      const current = prev[id] ?? [];
      if (multi) {
        return { ...prev, [id]: current.includes(label) ? current.filter((item) => item !== label) : [...current, label] };
      }
      return { ...prev, [id]: current.includes(label) ? [] : [label] };
    });
  };

  const submit = () => {
    props.onSubmit(question.questions.map((item) => {
      const picked = selected[item.id] ?? [];
      const text = custom[item.id]?.trim() ?? '';
      return { id: item.id, selected: picked, ...(text ? { custom: text.slice(0, 300) } : {}) };
    }));
  };
  // 每个问题都要有选择或自定义答案；空答会被记录成「未回答」，模型还得再问一遍。
  const ready = question.questions.every((item) => (selected[item.id]?.length ?? 0) > 0 || Boolean(custom[item.id]?.trim()));
  const remaining = question.questions.filter((item) => !((selected[item.id]?.length ?? 0) > 0 || Boolean(custom[item.id]?.trim()))).length;

  if (state !== 'pending') {
    const summary = question.questions
      .map((item) => answeredById.get(item.id))
      .map((answer) => answer?.selected.join('、') || answer?.custom)
      .filter(Boolean)
      .join(' · ');
    const expiredText = props.expiredReason === 'cancelled' ? '本轮已停止' : '本轮已超时';
    return (
      <section className="mt-2 flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200/80 bg-slate-50/60 px-3 py-2 text-xs" aria-label={state === 'answered' ? '已回答' : expiredText}>
        <span className="shrink-0 text-slate-400">{state === 'answered' ? '已回答' : expiredText}</span>
        {state === 'answered' && <span className="min-w-0 truncate text-slate-600">{summary}</span>}
      </section>
    );
  }

  const total = question.questions.length;
  const index = Math.min(active, total - 1);
  const item = question.questions[index]!;
  const picked = selected[item.id] ?? [];
  return (
    <section id="chat-pending-question" className="mt-2 rounded-xl border border-slate-200/80 bg-white p-2.5" aria-label="请选择">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {item.header && <p className="m-0 mb-1 text-[11px] text-slate-400">{item.header}</p>}
          <p className="m-0 text-[13px] font-medium leading-snug text-slate-800">{item.question}</p>
        </div>
        {total > 1 && (
          <div className="flex shrink-0 items-center gap-0.5 text-[11px] text-slate-400" role="group" aria-label="切换问题">
            <button
              type="button"
              aria-label="上一个问题"
              disabled={index === 0}
              onClick={() => setActive(index - 1)}
              className="grid h-5 w-5 cursor-pointer place-items-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-default disabled:opacity-30"
            >
              ‹
            </button>
            <span className="min-w-8 text-center tabular-nums">{index + 1}/{total}</span>
            <button
              type="button"
              aria-label="下一个问题"
              disabled={index === total - 1}
              onClick={() => setActive(index + 1)}
              className="grid h-5 w-5 cursor-pointer place-items-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-default disabled:opacity-30"
            >
              ›
            </button>
          </div>
        )}
      </div>
      <div className="mt-1.5 flex flex-col gap-1" role="group" aria-label={item.question}>
        {item.options.map((option) => {
          const activeOption = picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              aria-pressed={activeOption}
              disabled={disabled || submitting}
              onClick={() => toggle(item.id, option.label, Boolean(item.multiSelect))}
              className={`flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors cursor-pointer disabled:cursor-default ${
                activeOption ? 'border-slate-300 bg-slate-50' : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border text-[10px] leading-none ${
                  item.multiSelect ? 'rounded-[4px]' : 'rounded-full'
                } ${activeOption ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-transparent'}`}
              >
                {item.multiSelect ? '✓' : '•'}
              </span>
              <span className="min-w-0">
                <span className="block text-xs leading-snug text-slate-700">{option.label}</span>
                {option.description && <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">{option.description}</span>}
              </span>
            </button>
          );
        })}
        <input
          value={custom[item.id] ?? ''}
          onChange={(event) => setCustom((prev) => ({ ...prev, [item.id]: event.target.value.slice(0, 300) }))}
          disabled={disabled || submitting}
          placeholder="其他答案（可选）"
          aria-label={`${item.question} 的自定义答案`}
          className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-400 disabled:bg-slate-100"
        />
      </div>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        {props.error && <span className="mr-auto text-xs text-rose-600" role="alert">{props.error}</span>}
        {!props.error && total > 1 && remaining > 0 && (
          <span className="mr-auto text-[11px] text-slate-400">还有 {remaining} 个问题未回答</span>
        )}
        <button
          type="button"
          disabled={disabled || submitting || !ready}
          onClick={submit}
          className="cursor-pointer rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '提交中…' : '提交'}
        </button>
      </div>
    </section>
  );
}
