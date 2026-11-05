import { useState } from 'react';
import { handwritingFallback } from '../lib/handwriting';

// Only files supplied locally are included; unknown destinations never request a guessed URL.
const landmarks = import.meta.glob<string>('../assets/city-landmarks/*.{svg,png,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
});

export function TripCover({ destination, daysCount }: { destination: string; daysCount: number }) {
  const city = destination.trim().replace(/市$/, '');
  const landmark = landmarks[`../assets/city-landmarks/${city}.svg`]
    ?? landmarks[`../assets/city-landmarks/${city}.png`]
    ?? landmarks[`../assets/city-landmarks/${city}.webp`];
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const hasIllustration = Boolean(landmark && loadedUrl === landmark);
  const nameLength = Array.from(destination.trim()).length;
  const nameSize = hasIllustration
    ? nameLength > 3
      ? 'text-[28px] max-[600px]:text-[24px]'
      : 'text-[clamp(40px,2.9vw,52px)] max-[600px]:text-[40px]'
    : nameLength > 6
      ? 'text-[clamp(28px,2vw,36px)] max-[600px]:text-[28px]'
      : nameLength > 3
        ? 'text-[clamp(34px,2.5vw,46px)] max-[600px]:text-[32px]'
        : 'text-[clamp(44px,3.2vw,58px)] max-[600px]:text-[40px]';

  return (
    <div
      className="collection-cover relative isolate flex min-h-[230px] min-w-0 flex-col items-center justify-center overflow-hidden rounded-[15px] bg-[linear-gradient(125deg,var(--cover-a),var(--cover-b))] px-5 py-[60px] pl-7 text-[color:var(--cover-ink)] shadow-[inset_0_1px_0_var(--color-cover-highlight),inset_0_-1px_0_var(--color-cover-edge),2px_1px_3px_var(--color-collection-cover-box-shadow-141)] max-[600px]:min-h-[250px] max-[600px]:px-3 max-[600px]:pl-6"
      data-illustrated={hasIllustration}
    >
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-6 rounded-l-[15px] bg-[linear-gradient(90deg,color-mix(in_srgb,currentColor_12%,transparent)_0%,var(--color-cover-highlight)_20%,transparent_40%,color-mix(in_srgb,currentColor_18%,transparent)_64%,color-mix(in_srgb,currentColor_7%,transparent)_80%,transparent_100%)]" />
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-9 left-[2px] w-[15px] before:absolute before:inset-x-0 before:top-0 before:h-1 before:rounded-sm before:bg-[var(--color-cover-binding)] before:shadow-[0_1px_1px_var(--color-cover-edge),inset_0_1px_0_var(--color-cover-highlight)] before:content-[''] after:absolute after:inset-x-0 after:bottom-0 after:h-1 after:rounded-sm after:bg-[var(--color-cover-binding)] after:shadow-[0_1px_1px_var(--color-cover-edge),inset_0_1px_0_var(--color-cover-highlight)] after:content-['']" />
      <span style={handwritingFallback(destination)} className={`collection-destination z-[1] text-center [font-family:'Youran_Handwriting','Noto_Serif_SC_Variable',serif] font-normal leading-[1.1] tracking-[1px] [overflow-wrap:anywhere] ${nameSize} ${hasIllustration
        ? 'absolute left-[9%] top-[19%] w-[70%] -rotate-3'
        : 'relative'}`}>
        {destination}
      </span>
      {landmark && <>
        <img
          key={landmark}
          src={landmark}
          alt=""
          aria-hidden="true"
          className="hidden"
          onLoad={() => setLoadedUrl(landmark)}
          onError={() => setLoadedUrl(undefined)}
        />
        {hasIllustration && <>
          <svg aria-hidden="true" viewBox="0 0 64 120" fill="none" className="collection-cover-route pointer-events-none absolute left-[21%] top-[41%] h-[39%] w-[23%] overflow-visible text-current opacity-50" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            <path d="M48 17C32 29 17 47 14 65C9 90 26 108 55 109" strokeDasharray="3 4" />
            <path d="M48 5c-6 0-7 7 0 13c7-6 6-13 0-13Z" />
            <path d="M14 77c-5 0-6 6 0 11c6-5 5-11 0-11Z" />
            <circle cx="48" cy="10" r="1.7" />
            <circle cx="14" cy="81" r="1.3" />
          </svg>
          <span
            aria-hidden="true"
            className="collection-landmark pointer-events-none absolute bottom-[12%] left-[29%] h-[46%] w-[64%] bg-current opacity-60 [mask-mode:alpha] [mask-size:contain] [mask-position:center_bottom] [mask-repeat:no-repeat]"
            style={{ maskImage: `url(${JSON.stringify(landmark)})` }}
          />
        </>}
      </>}
      <span className="collection-duration absolute right-[8%] top-[8%] flex h-[34px] min-w-[58px] items-center justify-center rounded-full bg-[var(--color-collection-duration-background-162)] px-3 text-base font-medium leading-none text-[color:var(--color-collection-card-cover-ink-124)] max-[600px]:h-[30px] max-[600px]:min-w-[50px] max-[600px]:px-2 max-[600px]:text-sm">
        {daysCount} 天
      </span>
    </div>
  );
}
