import { useEffect, useId, useRef, useState } from 'react';
import type { TravelPreferences } from '@tripweaver/shared';
import { PREFERENCE_OPTIONS, TRANSPORT_MODES } from '@tripweaver/shared';
import { TRANSPORT_LABELS } from '../lib/chatDerive';
import { useTravelPreferencesDraft } from './TravelPreferencesProvider';
import { Button } from './ui/Button';
import { Textarea } from './ui/Field';

// 面板内尺寸以设计像素写，按 --ui 缩放；小于 1 时保持基础尺寸（手机上不缩到不可读），
// 离开首页（个人资料弹窗）无 --ui，以 1px 兜底即基础尺寸。
const chipClass = (active: boolean) => `min-h-[calc(44*max(1px,var(--ui,1px)))] rounded-[calc(12*max(1px,var(--ui,1px)))] border border-solid px-[calc(12*max(1px,var(--ui,1px)))] py-[calc(6*max(1px,var(--ui,1px)))] text-[length:calc(14*max(1px,var(--ui,1px)))] transition-colors ${active
  ? 'border-brand bg-brand/10 text-brand'
  : 'border-black/10 bg-white/70 text-ink-strong hover:border-brand hover:text-brand'}`;

const legendClass = 'mb-[calc(8*max(1px,var(--ui,1px)))] text-[length:calc(12*max(1px,var(--ui,1px)))] text-ink-muted';
const chipRowClass = 'flex flex-wrap gap-[calc(8*max(1px,var(--ui,1px)))]';

/** 个人资料弹窗用 autoSave：改动 500ms 后写账号，关闭弹窗时补写未到点的草稿。
 *  首页（默认）只改本地草稿，等生成行程成功后由生成流程调用 persist。 */
export function TravelPreferencesFields({ allowClear = false, autoSave = false }: { allowClear?: boolean; autoSave?: boolean }) {
  const { value, change, persist, saving, error, retry } = useTravelPreferencesDraft();
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const touched = useRef(false);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (autoSave && touched.current) void persistRef.current();
  }, [autoSave]);

  const update = (next: TravelPreferences) => {
    touched.current = true;
    change(next);
    if (!autoSave) return;
    setPending(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void persistRef.current().finally(() => setPending(false));
    }, 500);
  };

  const status = error ?? (pending || saving ? '正在保存…' : !value ? '正在加载偏好…' : null);
  const notesId = useId();
  return <div className="flex flex-col gap-[calc(12*max(1px,var(--ui,1px)))] text-[length:calc(14*max(1px,var(--ui,1px)))]">
    {value && <>
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className={legendClass}>偏好（多选）</legend>
        <div className={chipRowClass}>
          {PREFERENCE_OPTIONS.map((option) => <Button variant="plain" key={option}
            aria-pressed={value.preferences.includes(option)} className={chipClass(value.preferences.includes(option))}
            onClick={() => update({ ...value, preferences: value.preferences.includes(option)
              ? value.preferences.filter((item) => item !== option) : [...value.preferences, option] })}>
            {option}
          </Button>)}
        </div>
      </fieldset>
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className={legendClass}>出行方式</legend>
        <div className={chipRowClass}>
          {TRANSPORT_MODES.map((mode) => <Button variant="plain" key={mode}
            aria-pressed={value.transportMode === mode} className={chipClass(value.transportMode === mode)}
            onClick={() => update({ ...value, transportMode: mode })}>{TRANSPORT_LABELS[mode]}</Button>)}
        </div>
      </fieldset>
      <div>
        <label htmlFor={notesId} className={`block ${legendClass}`}>备注</label>
        <Textarea id={notesId} appearance="panel" rows={3} maxLength={200} value={value.extraNotes}
          placeholder="例如：带小孩一起、少爬台阶、需要午休"
          aria-describedby={`${notesId}-count`}
          className="w-full"
          onChange={(event) => update({ ...value, extraNotes: event.target.value })} />
        <p id={`${notesId}-count`} className="m-0 text-right text-[length:calc(12*max(1px,var(--ui,1px)))] text-ink-muted">{value.extraNotes.length}/200</p>
      </div>
    </>}
    {status && <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-[calc(8*max(1px,var(--ui,1px)))] text-[length:calc(12*max(1px,var(--ui,1px)))] text-ink-muted">
      <span>{status}</span>
      {error && <Button variant="ghost" onClick={retry}>重试</Button>}
    </div>}
    {allowClear && value && <Button variant="ghost" className="self-start" onClick={() => update({
      ...value, preferences: [], transportMode: 'transit', pace: null, partySize: 2, extraNotes: '',
    })}>清空偏好、节奏与备注，恢复公共交通</Button>}
  </div>;
}
