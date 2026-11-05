// 首页线性图标（09-26 改版）：统一 24x24 视框、currentColor 描边，颜色与尺寸由父级类决定。
// 装饰性图标一律 aria-hidden，避免读屏重复朗读；图标按钮的 aria-label 由调用方提供。
import type { ReactNode } from 'react';

interface IconProps {
  className?: string;
}

export const PeopleIcon = ({ className }: IconProps) => <Icon className={className}><circle cx="9" cy="7" r="3" /><path d="M3 21v-4a6 6 0 0 1 12 0v4M16 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 5v3M7 17v4M11 17v4" /></Icon>;

export const HouseIcon = ({ className }: IconProps) => <Icon className={className}><path d="m3 10 9-7 9 7v11h-6v-7H9v7H3Z" /></Icon>;

function Icon({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

/** 目的地 */
export const PinIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M12 21.4c3.9-3.7 6.6-6.9 6.6-10.4a6.6 6.6 0 1 0-13.2 0c0 3.5 2.7 6.7 6.6 10.4Z" />
    <circle cx="12" cy="10.8" r="2.5" />
  </Icon>
);

/** 出行日期 */
export const CalendarIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <rect x="3.6" y="5.2" width="16.8" height="15.2" rx="3.2" />
    <path d="M8 3.2v3.6M16 3.2v3.6M3.6 10.2h16.8" />
    <path d="m9 15.4 1.9 1.9 3.6-3.8" />
  </Icon>
);

/** 节奏与同行 */
export const GaugeIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 13.6 15.4 8" />
    <circle cx="12" cy="14.6" r="1.5" />
  </Icon>
);

/** 偏好与出行 */
export const ScissorsIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <circle cx="6.4" cy="6.6" r="2.4" />
    <circle cx="6.4" cy="17.4" r="2.4" />
    <path d="M8.6 7.9 19.4 17.4M8.6 16.1 19.4 6.6" />
  </Icon>
);

/** 提交（开始规划） */
export const CompassIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M20.4 3.6 3.8 11.2l6.4 2.3 2.4 6.4Z" />
  </Icon>
);

/** 面板底栏的已选摘要 */
export const ClockIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 7.2V12l3.2 2" />
  </Icon>
);

export const CloseIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6" />
  </Icon>
);

export const ChevronDownIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="m6 9.5 6 6 6-6" />
  </Icon>
);

export const ChevronUpIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="m6 14.5 6-6 6 6" />
  </Icon>
);

/** 地图缩放胶囊 */
export const PlusIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M12 5.2v13.6M5.2 12h13.6" />
  </Icon>
);

export const MinusIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M5.2 12h13.6" />
  </Icon>
);

export const ResetIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v3.2M12 18.2v3.2M2.6 12h3.2M18.2 12h3.2" />
  </Icon>
);

/** AI 灵动图标 */
export const SparkleIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z" />
  </Icon>
);

/** Agent 机器人图标 */
export const BotIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <rect x="3" y="11" width="18" height="10" rx="2" />
    <circle cx="8.5" cy="16" r="1.5" />
    <circle cx="15.5" cy="16" r="1.5" />
    <path d="M12 2v4M12 6h.01M8 11V7a4 4 0 0 1 8 0v4M2 15h1M21 15h1" />
  </Icon>
);

/** 偏好标签图标 */
export const TagIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8 8a2 2 0 0 0 2.828 0l7.172-7.172a2 2 0 0 0 0-2.828l-8-8Z" />
    <circle cx="7.5" cy="7.5" r="1.5" />
  </Icon>
);

/** 备注笔记图标 */
export const NoteIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
  </Icon>
);

/** 发送纸飞机图标 */
export const SendIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </Icon>
);

/** 火箭启动图标 */
export const RocketIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
  </Icon>
);

/** 对勾确认图标 */
export const CheckIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

/** 编辑图标 */
export const EditIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </Icon>
);

/** 重置图标 */
export const RotateCcwIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </Icon>
);

/** 箭头图标 */
export const ArrowRightIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </Icon>
);

