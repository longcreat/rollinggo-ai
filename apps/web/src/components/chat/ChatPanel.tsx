import { Fragment, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TaskCard } from './TaskCard';
import { suggestionText, uid, type AgentQuestionAnswer, type DetailChatRequest, type PendingQuestionView, type SendMessageResult, type Trip, type TripOperationResult } from '@tripweaver/shared';
import { keys, useConversation, useTripVersions } from '../../api/hooks';
import { answerQuestion, pendingQuestion, recoverChat, rewindVersion, stopChat, streamChat } from '../../api/detailChat';
import { QuestionCard } from './QuestionCard';
import { chatErrorMessage } from '../../lib/chatDerive';
import { stepsFromSummary, upsertAgentStep } from '../../lib/agentActivity';
import { AgentActivity } from './AgentActivity';
import { ChatText } from './ChatText';
import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import { PendingAnswer, type PendingExchange } from './PendingAnswer';
import { FoodCard } from './FoodCard';
import { Button } from '../ui/Button';
import { EditorIcon } from '../editor/EditorIcon';
import { Compass } from 'lucide-react';

interface Props {
  conversationId: string; trip: Trip; dayId?: string; readOnly: boolean; busy: boolean;
  begin: () => Promise<Trip>; end: () => void;
  onTrip: (id: string, result?: TripOperationResult) => Promise<void>;
  /** 生成直播期：复用同一个主 Agent 对话，只读并实时更新任务节点。 */
  live?: boolean;
  liveStatus?: 'running' | 'done' | 'error' | 'cancelled';
  /** 直播停止/失败后继续向主 Agent 提要求；成功后由页面切到新任务。 */
  liveSend?: (text: string) => Promise<void>;
}
const labels = { food: '推荐美食', explore: '看看沿途玩法', pace: '检查行程节奏', more_food: '再推荐几家', light_food: '换成清淡口味', dinner: '看看晚餐' };
const initialSuggestions = ['food', 'explore', 'pace'] as const;

export function ChatPanel({ conversationId, trip, dayId, readOnly, busy, begin, end, onTrip, live = false, liveStatus = 'running', liveSend }: Props) {
  const qc = useQueryClient();
  const detail = useConversation(conversationId);
  const versions = useTripVersions(trip.id);
  const versionIds = versions.data ? new Set(versions.data.versions.map((version) => version.id)) : null;
  const [pending, setPending] = useState<PendingExchange | null>(null);
  const [error, setError] = useState('');
  const [restoreDraft, setRestoreDraft] = useState<{ text: string; key: number }>();
  const [stopping, setStopping] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [questionError, setQuestionError] = useState('');
  const [recovered, setRecovered] = useState<PendingQuestionView | null>(null);
  const [recoveredState, setRecoveredState] = useState<'pending' | 'answered' | 'expired'>('pending');
  const [recoveredAnswers, setRecoveredAnswers] = useState<AgentQuestionAnswer[] | undefined>();
  const [liveSending, setLiveSending] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const allMessages = detail.data?.messages ?? [];
  const generated = allMessages.findIndex((message) => message.relatedTripId);
  // relatedTripId 也会标在真实修改回答上；仅跳过无附件的初始关联记录，不能把最新回答截掉。
  const messages = generated < 0 || allMessages[generated]?.attachment ? allMessages : allMessages.slice(generated + 1);
  const running = pending?.state === 'running';
  // 问题卡在输入框上方的 dock 里显示（对齐 opencode session question dock），不在消息流中。
  const activeQuestion = pending?.question && pending.questionState === 'pending' ? pending.question : null;
  const recoveredPending = !pending && recovered && recoveredState === 'pending' ? recovered : null;
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (following.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [messages.length, pending, recovered]);
  // 刷新/断线后恢复待回答问题：Agent 回合仍在服务端等待，答案通过独立接口回注。
  useEffect(() => {
    if (readOnly || pending) return;
    let alive = true;
    void pendingQuestion(conversationId).then((question) => {
      if (alive && question) { setRecovered(question); setRecoveredState('pending'); setRecoveredAnswers(undefined); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [conversationId, readOnly, pending]);

  // 撤销「本轮改动」：恢复改动前那一版（服务端会校验 updatedAt，冲突则报错不做覆盖）
  const undoEdit = async (previousTripId: string, editVersionTripId?: string) => {
    if (undoing || busy || readOnly) return;
    setUndoing(true); setError('');
    let acquired = false;
    try {
      const current = await begin();
      acquired = true;
      // 撤销只能作用于“产生当前版本的那次修改”。旧消息/旧标签页即使按钮残留，
      // 也不能拿 v2 的撤销目标去把 v1 反复恢复成 v4/v5。
      if (editVersionTripId && current.id !== editVersionTripId) {
        setError('该修改已不是当前版本，请通过「历史版本」选择要恢复的版本');
        return;
      }
      const result = await rewindVersion(editVersionTripId ?? current.id, {
        operationId: `undo-${editVersionTripId ?? current.id}-${previousTripId}`.slice(0, 100),
        expectedTripId: editVersionTripId ?? current.id,
        updatedAt: current.updatedAt,
        targetTripId: previousTripId,
      });
      await qc.invalidateQueries({ queryKey: keys.conversation(conversationId) });
      await onTrip(result.trip.id, result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销失败，请重试');
    } finally {
      setUndoing(false);
      if (acquired) end();
    }
  };

  const accept = async (result: SendMessageResult) => {
    await qc.invalidateQueries({ queryKey: keys.conversation(conversationId) });
    void qc.invalidateQueries({ queryKey: keys.me });
    if (result.editResult && result.editResult.tripId !== trip.id) await onTrip(result.editResult.tripId);
    setPending(null);
    setRecovered(null);
    setQuestionError('');
    setAnswering(false);
  };

  // 原 SSE 已断开时，Agent 回合仍在服务端继续；轮询操作结果直到提交。
  const waitForResult = async (requestId: string) => {
    const started = Date.now();
    while (Date.now() - started < 90_000) {
      const result = await recoverChat(conversationId, requestId).catch(() => null);
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return null;
  };

  const answerCurrent = async (answers: AgentQuestionAnswer[]) => {
    const question = pending?.question;
    if (!question || answering) return;
    const streamGone = pending?.state !== 'running';
    const requestId = pending?.input.requestId;
    setAnswering(true); setQuestionError('');
    try {
      await answerQuestion(conversationId, question.id, answers);
      if (!streamGone) {
        setPending((current) => current?.question ? { ...current, questionState: 'answered', questionAnswers: answers } : current);
        return;
      }
      setPending((current) => current?.question ? { ...current, questionState: 'answered', questionAnswers: answers } : current);
      const result = requestId ? await waitForResult(requestId) : null;
      if (result) { await accept(result); return; }
      setPending(null);
      setError('回答已提交，结果正在同步，请稍后刷新页面。');
    } catch (err) {
      setQuestionError(err instanceof Error ? err.message : '回答提交失败，请重试');
    } finally {
      setAnswering(false);
    }
  };

  const answerRecovered = async (answers: AgentQuestionAnswer[]) => {
    if (!recovered || answering) return;
    setAnswering(true); setQuestionError('');
    try {
      await answerQuestion(conversationId, recovered.id, answers);
      setRecoveredState('answered');
      setRecoveredAnswers(answers);
      const result = await waitForResult(recovered.requestId);
      if (result) { await accept(result); return; }
      setRecovered(null);
      setError('回答已提交，结果正在同步，请稍后刷新页面。');
      void qc.invalidateQueries({ queryKey: keys.conversation(conversationId) });
    } catch (err) {
      setQuestionError(err instanceof Error ? err.message : '回答提交失败，请重试');
    } finally {
      setAnswering(false);
    }
  };
  const send = async (text: string, suggestion?: DetailChatRequest['suggestion'], retry?: DetailChatRequest, scopeDayId: string | null = dayId ?? null) => {
    if (submitting.current || busy || readOnly) return;
    submitting.current = true; setError(''); setStopping(false);
    setRecovered(null); setQuestionError(''); setAnswering(false);
    let input: DetailChatRequest | undefined;
    let acquired = false;
    try {
      const saved = await begin();
      acquired = true;
      input = retry ?? { requestId: uid(), text, tripId: saved.id, updatedAt: saved.updatedAt, ...(scopeDayId ? { dayId: scopeDayId } : {}), ...(suggestion ? { suggestion } : {}) };
      setPending({ input, parts: [], textOpen: false, state: 'running' });
      controller.current = new AbortController();
      const result = await streamChat(conversationId, input, controller.current.signal, (event) => {
        if (event.type === 'answer_delta') setPending((p) => {
          if (!p || !event.text) return p;
          const parts = [...p.parts];
          const last = parts.at(-1);
          if (event.replace) {
            if (p.textOpen && last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: event.text };
            else parts.push({ type: 'text', text: event.text });
          } else if (p.textOpen && last?.type === 'text') {
            parts[parts.length - 1] = { type: 'text', text: last.text + event.text };
          } else {
            parts.push({ type: 'text', text: event.text });
          }
          return { ...p, parts, textOpen: true };
        });
        if (event.type === 'progress' && event.step) {
          const step = event.step;
          setPending((p) => {
            if (!p) return p;
            const parts = [...p.parts];
            const existing = parts.findIndex((part) => part.type === 'steps' && part.steps.some((item) => item.id === step.id));
            if (existing >= 0) {
              const part = parts[existing];
              if (part && part.type === 'steps') parts[existing] = { type: 'steps', steps: upsertAgentStep(part.steps, step) };
              return { ...p, parts };
            }
            const last = parts.at(-1);
            if (last?.type === 'steps') parts[parts.length - 1] = { type: 'steps', steps: upsertAgentStep(last.steps, step) };
            else parts.push({ type: 'steps', steps: [step] });
            return { ...p, parts, textOpen: step.status === 'running' ? false : p.textOpen };
          });
        }
        if (event.type === 'question') setPending((p) => p ? {
          ...p,
          question: event.question,
          questionState: 'pending',
          questionAnswers: undefined,
          // 问题出现即关闭当前正文段；回答后的新 generation 会开启下一段。
          textOpen: false,
        } : p);
        if (event.type === 'question_answered') setPending((p) => p ? { ...p, questionState: 'answered', questionAnswers: event.answers } : p);
        if (event.type === 'question_expired') setPending((p) => p ? { ...p, questionState: 'expired', questionExpiredReason: event.reason } : p);
      });
      await accept(result);
    } catch (err) {
      const recovered = input ? await recoverChat(conversationId, input.requestId).catch(() => null) : null;
      if (recovered) {
        try { await accept(recovered); return; }
        catch { err = new Error('结果已保存，页面同步失败，请重试'); }
      }
      const message = chatErrorMessage(err);
      setError(message);
      // 网络断流时有 pending 问题的话服务端会保留回合；不要把它标成 expired，
      // 问题卡仍可通过 answerQuestion 回注（服务端会校验是否真的过期）。
      setPending((p) => p ? { ...p, state: message.includes('已停止') ? 'stopped' : 'error' } : p);
      if (!input) setRestoreDraft({ text, key: Date.now() });
    } finally { controller.current = null; submitting.current = false; setStopping(false); if (acquired) end(); }
  };
  const renderSuggestions = (scopeDayId: string | undefined) => {
    const scopeDay = trip.days.find((d) => d.id === scopeDayId);
    return <div className="chat-suggestions mt-2 flex flex-col gap-1.5" aria-label="起始建议">
      {initialSuggestions.map((kind) => (
        <Button
          variant="plain"
          type="button"
          key={kind}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200/80 bg-slate-50/70 hover:bg-slate-100 hover:border-slate-300 px-3 py-2 text-left text-xs text-slate-700 hover:text-slate-950 transition-all group disabled:opacity-50"
          disabled={busy || readOnly || running || Boolean(scopeDayId && !scopeDay)}
          onClick={() => void send(suggestionText(kind, scopeDay?.dayIndex), kind, undefined, scopeDayId ?? null)}
        >
          <EditorIcon
            name={kind === 'food' ? 'food' : kind === 'pace' ? 'clock' : 'pin'}
            className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-700 shrink-0"
          />
          <span className="truncate">{labels[kind]}</span>
        </Button>
      ))}
    </div>;
  };

  return <div className="chat-panel flex min-h-0 flex-1 flex-col gap-3 p-4 text-sm leading-relaxed max-sm:p-3">
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scroll} className="chat-stream flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-1 no-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }} onScroll={() => {
      const node = scroll.current;
      const near = !node || node.scrollHeight - node.clientHeight - node.scrollTop < 70;
      following.current = near; setAtBottom(near);
    }}>
      {detail.isPending && <p className="text-xs text-slate-400">正在加载对话…</p>}
      {detail.isError && <p className="text-xs text-red-500" role="alert">对话加载失败 <Button variant="ghost" onClick={() => void detail.refetch()}>重试</Button></p>}
      {!live && !detail.isPending && !detail.isError && <div className="chat-welcome pb-2 pt-1">
        <h2 className="m-0 flex items-start gap-2 text-sm font-semibold leading-snug text-slate-800"><span className="mt-0.5 text-slate-800" aria-hidden="true"><Compass className="w-4 h-4" /></span>{live
          ? liveStatus === 'cancelled' ? '规划已停止。'
            : liveStatus === 'error' ? '规划未完成。'
              : liveStatus === 'done' ? '行程已生成。'
                : '正在为你规划行程。'
          : '行程已生成，可以继续完善沿途安排。'}</h2>
        <p className="mb-0 mt-1.5 text-xs leading-relaxed text-slate-500">
          {live
            ? liveStatus === 'cancelled' ? '可以返回首页调整条件后重新开始。'
              : liveStatus === 'error' ? '可以返回首页调整条件后重试。'
                : liveStatus === 'done' ? '正在打开行程…'
                  : '规划过程会实时更新；完成后可以继续调整。'
            : `我为你整理了 ${trip.days.length} 天的行程安排，已包含主要景点与交通安排，你可以根据需要进一步调整。`}
        </p>
        {messages.length === 0 && !pending && renderSuggestions(dayId)}</div>}
      {messages.map((message) => {
        const content = message.content.trim();
        // 版本操作是系统动作，不应渲染成带“复制”的普通回答气泡。
        const restoreNotice = message.role === 'assistant' && !message.attachment
          && (/^已从 v\d+ 恢复为 v\d+$/.test(content) || /^已恢复到 v\d+ 的内容（新版本 v\d+）$/.test(content));
        if (restoreNotice) return null;
        const activitySteps = message.role === 'assistant' && message.attachment
          ? message.attachment.steps ?? stepsFromSummary(message.attachment.summary)
          : [];
        const parts = message.role === 'assistant' ? message.attachment?.parts : undefined;
        const lastTextIndex = parts?.map((part, index) => part.type === 'text' ? index : -1).filter((index) => index >= 0).at(-1);
        // HITL 问答按真实位置渲染：新回合在 parts 里写 question 标记；
        // 旧消息没有标记时锚到 ask_user 工具段之后，实在找不到才退回回答末尾。
        const questionRecords = message.attachment?.questions ?? [];
        const hasQuestionParts = parts?.some((part) => part.type === 'question') ?? false;
        const questionRow = (item: (typeof questionRecords)[number], key: string) => (
          <div key={key} className="flex flex-col gap-0.5">
            <p className="m-0"><span className="text-white/50">问：</span><span className="text-white/85">{item.question}</span></p>
            <p className="m-0"><span className="text-white/50">答：</span><span className="font-medium">{item.selected.join('、') || item.custom || '未回答'}</span></p>
          </div>
        );
        // 用户回答本身就是一条用户消息：复用用户气泡样式，不另造卡片。
        const questionsCard = (records: typeof questionRecords, key: string) => records.length ? (
          <div key={key} className="chat-msg chat-msg-user mb-1.5 ml-auto flex max-w-[85%] min-w-0 flex-col items-end gap-1.5">
            <div className="chat-bubble break-words rounded-2xl bg-slate-900 px-3.5 py-2.5 text-sm leading-relaxed text-white shadow-2xs">
              <div className="flex flex-col gap-1.5">{records.map((item, i) => questionRow(item, `${key}-${i}`))}</div>
            </div>
          </div>
        ) : null;
        const legacyAnchor = !hasQuestionParts && parts?.length && questionRecords.length
          ? parts.findIndex((part) => part.type === 'steps' && part.steps.some((step) => step.name === 'ask_user'))
          : -1;
        return <div key={message.id} className="min-w-0">
        {parts?.length ? parts.map((part, index) => {
          if (part.type === 'question') {
            const record = questionRecords[part.index];
            return record ? questionsCard([record], `q-${message.id}-${index}`) : null;
          }
          if (part.type === 'text') {
            return index === lastTextIndex
              ? <div key={`text-${index}`} className="mb-1.5"><MessageBubble message={{ ...message, content: part.text }} copyText={message.content} onUndo={(previousTripId) => undoEdit(previousTripId, message.relatedTripId)} undoing={undoing} canUndo={!readOnly && message.relatedTripId === trip.id} editExists={!versionIds || !message.relatedTripId || versionIds.has(message.relatedTripId)} /></div>
              : <div key={`text-${index}`} className="chat-bubble mb-1.5 break-words rounded-2xl bg-slate-50/90 px-3.5 py-2.5 text-sm leading-relaxed text-slate-800"><ChatText text={part.text} markdown /></div>;
          }
          return <Fragment key={`steps-${index}`}>
            <AgentActivity steps={part.steps} state="completed" />
            {index === legacyAnchor && questionsCard(questionRecords, `q-${message.id}`)}
          </Fragment>;
        }) : <>
            {activitySteps.length > 0 && <AgentActivity steps={activitySteps} state="completed" />}
            <MessageBubble message={message} onUndo={(previousTripId) => undoEdit(previousTripId, message.relatedTripId)} undoing={undoing} canUndo={!readOnly && message.relatedTripId === trip.id} editExists={!versionIds || !message.relatedTripId || versionIds.has(message.relatedTripId)} />
          </>}
        {!hasQuestionParts && legacyAnchor < 0 && questionsCard(questionRecords, `q-${message.id}-tail`)}
        {message.attachment?.notice && <p className="mb-0 mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">{message.attachment.notice}</p>}
        {message.attachment?.task && <TaskCard jobId={message.attachment.task.jobId} conversationId={conversationId} />}
        {message.attachment?.candidates.map((candidate) => <FoodCard key={candidate.id} candidate={candidate} trip={trip} conversationId={conversationId} disabled={busy || readOnly} readOnly={readOnly} begin={begin} end={end} onTrip={onTrip} />)}
        {message.role === 'assistant' && message.attachment?.clarification && <div className="chat-answer-options mt-3 flex flex-wrap gap-1.5" role="group" aria-label={message.attachment.clarification.question}>
          {message.attachment.clarification.options.map((option) => <button type="button" key={option} className="rounded-full border border-slate-200 bg-white hover:bg-slate-50 px-3 py-1.5 text-left text-xs font-medium text-slate-800 transition-colors cursor-pointer shadow-2xs" disabled={busy || readOnly || running || message.id !== messages.at(-1)?.id} onClick={() => void send(option, undefined, undefined, message.attachment?.dayId ?? null)}>{option}</button>)}
        </div>}
      </div>;
      })}
      {pending && <PendingAnswer pending={pending} busy={busy} readOnly={readOnly}
        onRetry={() => void send(pending.input.text, pending.input.suggestion, pending.input)}
        onRestore={() => setRestoreDraft({ text: pending.input.text, key: Date.now() })} />}
    </div>
    {!atBottom && <>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white via-white/95 to-transparent" />
      <Button variant="plain" className="absolute bottom-1.5 left-1/2 z-10 inline-flex h-7 -translate-x-1/2 items-center justify-center gap-1 rounded-full border border-slate-200/90 bg-white/95 px-2.5 text-[11px] font-medium text-slate-600 shadow-sm backdrop-blur transition-colors hover:bg-white hover:text-slate-900" onClick={() => { following.current = true; setAtBottom(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }}>回到最新 ↓</Button>
    </>}
    </div>
    {error && !(pending?.state === 'stopped' && error === '已停止') && <p className="m-0 text-xs text-[var(--color-danger)]" role="alert">{error}</p>}
    {readOnly && !live && <p className="m-0 text-xs text-ink-muted">返回最新版本或恢复此版本后继续对话</p>}

    {activeQuestion && <div className="chat-question-dock shrink-0 overflow-y-auto" style={{ maxHeight: '45vh' }}>
      <QuestionCard key={activeQuestion.id} question={activeQuestion} state="pending"
        submitting={answering} disabled={readOnly} error={questionError} onSubmit={(answers) => void answerCurrent(answers)} />
    </div>}
    {recoveredPending && <div className="chat-question-dock shrink-0 overflow-y-auto" style={{ maxHeight: '45vh' }}>
      <QuestionCard key={recoveredPending.id} question={recoveredPending} state="pending"
        submitting={answering} disabled={readOnly} error={questionError} onSubmit={(answers) => void answerRecovered(answers)} />
    </div>}

    <ChatInput
      disabled={live
        ? liveStatus === 'running' || liveSending || !liveSend
        : readOnly || detail.isPending || detail.isError || (busy && !running) ||
          Boolean(pending?.questionState === 'pending') ||
          Boolean(recovered && (recoveredState === 'pending' || recoveredState === 'answered'))}
      sending={live ? false : running}
      stopping={stopping}
      restoreDraft={restoreDraft}
      placeholder={live
        ? liveStatus === 'running' ? '正在规划…' : liveSending ? '正在理解你的调整…' : '让 RollingGo 继续调整行程…'
        : undefined}
      onSend={(text) => {
        if (!live) { void send(text); return; }
        if (!liveSend || liveSending) return;
        setError('');
        setLiveSending(true);
        void liveSend(text)
          .catch((err) => setError(err instanceof Error ? err.message : '发送失败，请重试'))
          .finally(() => setLiveSending(false));
      }}
      onStop={live ? undefined : () => {
        if (!pending || stopping) return;
        setStopping(true);
        void stopChat(conversationId, pending.input.requestId).catch(() => { controller.current?.abort(); });
      }}
    />
  </div>;
}
