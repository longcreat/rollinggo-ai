import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { TravelPreferences } from '@tripweaver/shared';
import { useSaveTravelPreferences, useTravelPreferences } from '../api/hooks';

interface PreferencesContext {
  value: TravelPreferences | undefined;
  /** 只改本地草稿，不写账号。首页的选择要等生成行程成功后才提交（见 persist）。 */
  change: (value: TravelPreferences) => void;
  /** 立即把当前草稿写入账号：个人资料弹窗自动保存、生成行程成功后记忆首页选择。 */
  persist: (snapshot?: TravelPreferences) => Promise<void>;
  /** 正在写库（不含仅存在本地草稿的状态） */
  saving: boolean;
  error: string | null;
  retry: () => void;
}

const GUEST_PREFERENCES: TravelPreferences = { pace: null, partySize: 2, preferences: [], transportMode: 'transit', extraNotes: '' };

const Context = createContext<PreferencesContext | null>(null);

/** 放在布局层：切页后当前账号的草稿与在途写入都还在。 */
export function TravelPreferencesProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const query = useTravelPreferences(userId);
  const { mutateAsync } = useSaveTravelPreferences(userId);
  const [draft, setDraft] = useState<TravelPreferences | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 草稿同时存 ref：persist 在 change 之后同一 tick 调用时也要拿到新值。
  const draftRef = useRef(draft);
  const failedSnapshot = useRef<TravelPreferences | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const change = (value: TravelPreferences) => {
    setSaveError(null);
    failedSnapshot.current = null;
    draftRef.current = value;
    setDraft(value);
  };

  const persist = useCallback(async (submitted?: TravelPreferences) => {
    const snapshot = submitted ?? draftRef.current;
    if (!snapshot) return;
    setSaving(true);
    setSaveError(null);
    failedSnapshot.current = null;
    try {
      // React Query 的 mutation scope 串行提交；只有实际写过的这一份才能被清除。
      await mutateAsync(snapshot);
      if (mounted.current && draftRef.current === snapshot) {
        draftRef.current = null;
        setDraft(null);
      }
    } catch {
      if (mounted.current) {
        failedSnapshot.current = snapshot;
        setSaveError('保存失败，当前修改尚未记住');
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [mutateAsync]);

  return <Context.Provider value={{
    value: draft ?? (userId ? query.data : GUEST_PREFERENCES),
    change,
    persist,
    saving,
    error: saveError ?? (query.isError ? '偏好加载失败，请重试' : null),
    retry: () => {
      if (saveError && failedSnapshot.current) { void persist(failedSnapshot.current); }
      else void query.refetch();
    },
  }}>{children}</Context.Provider>;
}

export function useTravelPreferencesDraft() {
  const context = useContext(Context);
  if (!context) throw new Error('TravelPreferencesProvider is required');
  return context;
}
