import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import { useState, type FormEvent } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { Modal } from '../Modal';

export function TripMetaDialog({ onClose }: { onClose: () => void }) {
  const trip = useEditorStore((s) => s.trip);
  const updateMeta = useEditorStore((s) => s.updateMeta);
  const updateLodging = useEditorStore((s) => s.updateLodging);
  const updateDayLodging = useEditorStore((s) => s.updateDayLodging);

  const [title, setTitle] = useState(trip?.title ?? '');
  const [destination, setDestination] = useState(trip?.destination ?? '');
  const [startDate, setStartDate] = useState(trip?.startDate ?? '');
  const [partySize, setPartySize] = useState(String(trip?.partySize ?? 2));
  // 住宿锚点（ST3）：改名即清空坐标并丢弃相关住宿 leg（保存时经 store 处理，无客户端重编码）
  const [lodgingName, setLodgingName] = useState(trip?.lodging?.name ?? '');
  const [dayLodgings, setDayLodgings] = useState<Record<string, string>>(() =>
    Object.fromEntries((trip?.days ?? []).filter((d) => d.lodging).map((d) => [d.id, d.lodging!.name])),
  );
  const [error, setError] = useState('');

  if (!trip) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError('请填写行程名称');
    if (!destination.trim()) return setError('请填写目的地');
    const partyNum = Math.min(50, Math.max(1, Math.round(Number(partySize) || 1)));
    updateMeta({
      title: title.trim(),
      destination: destination.trim(),
      startDate,
      partySize: partyNum,
    });
    updateLodging(lodgingName);
    for (const day of trip.days) {
      updateDayLodging(day.id, dayLodgings[day.id] ?? '');
    }
    onClose();
  };

  return (
    <Modal title="行程信息" onClose={onClose}>
      <form onSubmit={submit} className={"form flex flex-col [gap:12px] [&_label]:flex [&_label]:flex-col [&_label]:[gap:5px] [&_label]:[font-size:0.88rem] [&_label]:[color:var(--color-muted)]"}>
        <label>
          行程名称
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} />
        </label>
        <div className={"form-grid-2 grid [grid-template-columns:1fr_1fr] [gap:10px]"}>
          <label>
            目的地
            <Input value={destination} onChange={(e) => setDestination(e.target.value)} maxLength={40} />
          </label>
          <label>
            出发日期
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
        </div>
        <label>
          出行人数
          <Input inputMode="numeric" value={partySize} onChange={(e) => setPartySize(e.target.value)} />
        </label>
        <label>
          住宿位置（通勤锚点，可选）
          <Input
            value={lodgingName}
            onChange={(e) => setLodgingName(e.target.value)}
            maxLength={60}
            placeholder="酒店名或大致区域，如「西湖景区周边」"
          />
        </label>
        {lodgingName.trim() !== (trip.lodging?.name ?? '') && (
          <p className={"muted [color:var(--color-muted)] [font-size:0.88rem]"}>修改住宿位置后将清除原坐标与住宿通勤段（重新生成行程可恢复）。</p>
        )}
        <details className="form-day-lodging">
          <summary className={"muted [color:var(--color-muted)] [font-size:0.88rem]"}>按天覆盖住宿（多城市场景，可选）</summary>
          {trip.days.map((d) => (
            <label key={d.id}>
              Day {d.dayIndex} 住宿
              <Input
                value={dayLodgings[d.id] ?? ''}
                onChange={(e) => setDayLodgings((prev) => ({ ...prev, [d.id]: e.target.value }))}
                maxLength={60}
                placeholder="留空则用整程住宿"
              />
            </label>
          ))}
        </details>
        {error && <p className={"form-error [color:var(--color-danger)] [font-size:0.85rem] m-0"}>{error}</p>}
        <div className={"form-foot flex items-center [justify-content:flex-end] [gap:12px]"}>
          <Button variant="secondary" type="button" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" type="submit">
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}
