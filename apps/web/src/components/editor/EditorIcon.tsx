/** 行程手册中的统一细线图标。 */
export function EditorIcon({ name, className }: { name: 'pin' | 'calendar' | 'back' | 'send' | 'walk' | 'cycle' | 'drive' | 'route' | 'place' | 'reset' | 'export' | 'history' | 'food' | 'clock' | 'sparkle' | 'forward' | 'alert' | 'bulb'; className?: string }) {
  const paths = {
    pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    calendar: 'M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2ZM7 2v4M17 2v4M3 9h18M7 13h3M14 13h3M7 17h3',
    back: 'M20 12H4m7-7-7 7 7 7',
    send: 'm21 3-7 18-4-8-8-4 19-6ZM10 13 21 3',
    walk: 'M14 3h.01M13 7l-2 6 4 4 1 5M11 13l-3 8M13 7l4 5 3 1M12 8l-5 3-2 4',
    route: 'M5 5h14v14H5ZM5 11h14M8 19v3M16 19v3M8 15h.01M16 15h.01',
    drive: 'm5 10 2-5h10l2 5M4 10h16v8H4ZM6 18v3M18 18v3M7 14h2M15 14h2',
    cycle: 'M9 17a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM23 17a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5 17l5-8 5 8H5M8 6h4M10 9l7-1 2 9M16 4h2l1 4',
    place: 'm12 3 8 4v10l-8 4-8-4V7l8-4ZM8 10h8v5H8Z',
    reset: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M12 8v8M8 12h8',
    export: 'M12 15V2m-4 4 4-4 4 4M5 10H3v11h18V10h-2',
    history: 'M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2',
    food: 'M5 3v6M8 3v6M11 3v6M5 9a3 3 0 0 0 6 0M8 12v9M19 21V3c-4 3-4 9 0 9',
    clock: 'M21 12a9 9 0 1 1-9-9M12 7v5l3 2M17 3v4h4',
    sparkle: 'm12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3ZM20 2v4M18 4h4',
    forward: 'm9 5 7 7-7 7',
    alert: 'M12 4 2 20h20L12 4ZM12 10v5M12 18h.01',
    bulb: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5a6 6 0 0 0-12 0c0 1.3.5 2.6 1.5 3.5.8.8 1.3 1.5 1.5 2.5M9 18h6M10 22h4',
  };
  return <svg className={`editor-icon inline-block flex-none align-middle ${className || 'w-[20px] h-[20px]'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
