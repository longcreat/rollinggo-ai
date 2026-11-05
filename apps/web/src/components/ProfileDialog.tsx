import { Modal } from './Modal';
import { TravelPreferencesFields } from './TravelPreferencesFields';

export function ProfileDialog({ email, onClose }: { email: string; onClose: () => void }) {
  return <Modal title="个人资料" onClose={onClose}>
    <div className="mb-5 rounded-xl bg-brand/5 p-4">
      <p className="m-0 text-xs text-ink-muted">当前账号</p>
      <p className="mb-0 mt-2 break-all text-base font-medium text-ink-strong">{email}</p>
    </div>
    <h3 className="mb-2 text-base text-ink-strong">偏好设置</h3>
    <p className="mb-4 text-sm text-ink-muted">修改会自动保存到账号，用于下一次行程规划。</p>
    <TravelPreferencesFields allowClear autoSave />
  </Modal>;
}
