/** 分享菜单与海报操作使用同一套细线图标。 */
export function ShareIcon({ name }: { name: 'share' | 'pdf' | 'image' | 'shuffle' | 'refresh' }) {
  const paths = {
    share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 10.5l6.8-4M8.6 13.5l6.8 4',
    pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 12h4M8 16h8',
    image: 'M20 9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10M3 16l5-5 5 5 3-3 4 4M19 2v6M16 5h6',
    shuffle: 'M3 6h3c4 0 8 12 12 12h3M17 14l4 4-4 4M3 18h3c1.5 0 3-1.7 4.5-4M14 8c1.5-1.3 2.8-2 4-2h3M17 2l4 4-4 4',
    refresh: 'M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7',
  };
  return <svg aria-hidden="true" className="h-[18px] w-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
