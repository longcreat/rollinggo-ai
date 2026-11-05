import { Button } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Field';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTrips } from '../api/hooks';
import { TripCover } from '../components/TripCover';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

function coverTone(destination: string): number {
  if (destination.includes('北京')) return 0;
  if (destination.includes('杭州')) return 4;
  if (destination.includes('成都')) return 3;
  if (destination.includes('上海') || destination.includes('大理')) return 2;
  return Array.from(destination).reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 4;
}

export function TripListPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [searchInput, setSearchInput] = useState(query);
  const composing = useRef(false);
  // URL stores the committed search; an IME owns the in-progress composition.
  useEffect(() => {
    if (!composing.current) setSearchInput(query);
  }, [query]);
  const city = params.get('city') ?? '';
  const requestedSort = params.get('sort');
  const sort = requestedSort === 'created' || requestedSort === 'name' ? requestedSort : 'updated';
  const trips = useTrips({ q: query, city, sort });

  const items = useMemo(() => trips.data?.pages.flatMap((page) => page.items) ?? [], [trips.data]);
  // 计数与目的地下拉都取第一批：前者是筛选后总数，后者不受筛选影响，翻页时不会变
  const total = trips.data?.pages[0]?.total ?? 0;
  const destinations = trips.data?.pages[0]?.destinations ?? [];

  // 滚到底部自动取下一批：哨兵始终挂载，hasNextPage 为 false 时 fetchNextPage 是空操作
  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchMore = trips.fetchNextPage;
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchMore();
    }, { rootMargin: '400px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchMore]);

  const updateFilter = (key: string, value: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  };
  const clearFilters = () => {
    composing.current = false;
    setSearchInput('');
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('q');
      next.delete('city');
      return next;
    }, { replace: true });
  };
  const hasFilters = Boolean(query || city);

  return (
    <div className={"trip-collection w-full [max-width:1760px] [margin:0_auto] [padding:46px_28px_32px] [color:var(--color-editor-page-editor-ink-55)] [&_:is(a,_button,_input,_select):focus-visible]:[outline:2px_solid_var(--color-brand)] [&_:is(a,_button,_input,_select):focus-visible]:[outline-offset:4px] [@media_(max-width:_1400px)]:[padding-inline:8px] [@media_(max-width:_600px)]:[padding:30px_2px_44px]"}>
      <header className={"collection-heading flex justify-between items-end [gap:24px] [margin:0_0_30px] [&_h1]:[font:600_clamp(34px,_2.7vw,_52px)/1.4_'Noto_Serif_SC_Variable',_SimSun,_serif] [&_h1]:[letter-spacing:2px] [&_h1]:m-0 [&_p]:[margin:12px_0_0] [&_p]:[font:400_30px/1.4_'Youran_Handwriting',_'Noto_Serif_SC_Variable',_serif] [&_p]:[letter-spacing:-0.03em] [&_p]:text-balance [&_p]:[color:var(--color-collection-heading-color-109)] [@media_(max-width:_600px)]:items-start [@media_(max-width:_600px)]:flex-col [@media_(max-width:_600px)]:[gap:12px] [@media_(max-width:_600px)]:[margin-bottom:22px] [@media_(max-width:_600px)]:[&_h1]:[font-size:30px] [@media_(max-width:_600px)]:[&_p]:[font-size:26px]"}>
        <div>
          <h1>我的行程</h1>
          <p>把想去的远方，<br className="hidden max-[600px]:block" />收进一本本旅行手册。
          </p>
        </div>
      </header>

      <form className={"collection-toolbar flex [gap:16px] items-center [padding:10px_14px] [background:var(--color-collection-toolbar-background-112)] [border:1px_solid_var(--color-collection-toolbar-border-113)] [border-radius:22px] [box-shadow:0_8px_30px_var(--color-collection-toolbar-box-shadow-114)] [backdrop-filter:blur(18px)] [@media_(max-width:_1400px)]:flex-wrap [@media_(max-width:_1400px)]:[gap:12px] [@media_(max-width:_600px)]:[padding:12px] [@media_(max-width:_600px)]:[gap:8px] [@media_(max-width:_600px)]:[border-radius:18px]"} role="search" aria-label="查找行程" onSubmit={(event) => event.preventDefault()}>
        <label className={"collection-search flex items-center [gap:12px] flex-1 min-w-0 [&_svg]:[width:21px] [&_svg]:[height:21px] [&_svg]:flex-none [&_svg]:[color:var(--color-collection-search-color-115)] [&_input]:w-full [&_input]:min-w-0 [&_input]:[height:44px] [&_input]:bg-transparent [@media_(max-width:_1400px)]:[flex-basis:100%]"}>
          <span className={"collection-sr-only absolute [width:1px] [height:1px] p-0 [margin:-1px] overflow-hidden [clip-path:inset(50%)] whitespace-nowrap border-0"}>搜索行程</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" strokeLinecap="round" /></svg>
          <Input
            type="search"
            value={searchInput}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={(event) => {
              composing.current = false;
              const value = event.currentTarget.value;
              setSearchInput(value);
              updateFilter('q', value);
            }}
            onChange={(event) => {
              const value = event.target.value;
              setSearchInput(value);
              if (!composing.current) updateFilter('q', value);
            }}
            placeholder="搜索行程名称或目的地"
            maxLength={100}
          />
        </label>
        <label className={"collection-select flex items-center [gap:10px] [border-left:1px_solid_var(--color-collection-select-border-left-117)] [padding-left:20px] [&_>_span]:[font-size:12px] [&_>_span]:[color:var(--color-collection-select-color-118)] [&_select]:[min-width:120px] [&_select]:[max-width:220px] [&_select]:[min-height:44px] [&_select]:cursor-pointer [@media_(max-width:_1400px)]:border-0 [@media_(max-width:_1400px)]:[padding-left:0] [@media_(max-width:_1400px)]:flex-1 [@media_(max-width:_1400px)]:[&_select]:flex-1 [@media_(max-width:_1400px)]:[&_select]:[max-width:none] [@media_(max-width:_1400px)]:[&_select]:min-w-0 [@media_(max-width:_600px)]:min-w-0 [@media_(max-width:_600px)]:flex-col [@media_(max-width:_600px)]:items-stretch [@media_(max-width:_600px)]:[gap:4px] [@media_(max-width:_600px)]:[&_>_span]:[padding-left:4px] [@media_(max-width:_600px)]:[&_select]:w-full [@media_(min-width:_1401px)]:[border-left:0] [@media_(min-width:_1401px)]:[padding-left:0] [@media_(min-width:_1401px)]:[&_>_span]:absolute [@media_(min-width:_1401px)]:[&_>_span]:[width:1px] [@media_(min-width:_1401px)]:[&_>_span]:[height:1px] [@media_(min-width:_1401px)]:[&_>_span]:overflow-hidden [@media_(min-width:_1401px)]:[&_>_span]:[clip-path:inset(50%)] [@media_(min-width:_1401px)]: [@media_(min-width:_1401px)]: [@media_(min-width:_1401px)]:[&_select]:[min-width:180px]"}><span>目的地</span>
          <Select aria-label="目的地" value={city} onChange={(event) => updateFilter('city', event.target.value)}>
            <option value="">全部目的地</option>
            {city && !destinations.includes(city) && <option value={city}>{city}</option>}
            {destinations.map((destination) => <option key={destination} value={destination}>{destination}</option>)}
          </Select>
        </label>
        <label className={"collection-select flex items-center [gap:10px] [border-left:1px_solid_var(--color-collection-select-border-left-117)] [padding-left:20px] [&_>_span]:[font-size:12px] [&_>_span]:[color:var(--color-collection-select-color-118)] [&_select]:[min-width:120px] [&_select]:[max-width:220px] [&_select]:[min-height:44px] [&_select]:cursor-pointer [@media_(max-width:_1400px)]:border-0 [@media_(max-width:_1400px)]:[padding-left:0] [@media_(max-width:_1400px)]:flex-1 [@media_(max-width:_1400px)]:[&_select]:flex-1 [@media_(max-width:_1400px)]:[&_select]:[max-width:none] [@media_(max-width:_1400px)]:[&_select]:min-w-0 [@media_(max-width:_600px)]:min-w-0 [@media_(max-width:_600px)]:flex-col [@media_(max-width:_600px)]:items-stretch [@media_(max-width:_600px)]:[gap:4px] [@media_(max-width:_600px)]:[&_>_span]:[padding-left:4px] [@media_(max-width:_600px)]:[&_select]:w-full [@media_(min-width:_1401px)]:[border-left:0] [@media_(min-width:_1401px)]:[padding-left:0] [@media_(min-width:_1401px)]:[&_>_span]:absolute [@media_(min-width:_1401px)]:[&_>_span]:[width:1px] [@media_(min-width:_1401px)]:[&_>_span]:[height:1px] [@media_(min-width:_1401px)]:[&_>_span]:overflow-hidden [@media_(min-width:_1401px)]:[&_>_span]:[clip-path:inset(50%)] [@media_(min-width:_1401px)]: [@media_(min-width:_1401px)]: [@media_(min-width:_1401px)]:[&_select]:[min-width:180px]"}><span>排序</span>
          <Select aria-label="排序" value={sort} onChange={(event) => updateFilter('sort', event.target.value)}>
            <option value="updated">最近更新</option>
            <option value="created">最近创建</option>
            <option value="name">行程名称</option>
          </Select>
        </label>
      </form>

      <div className={`collection-result-line flex justify-between items-center [min-height:64px] [gap:10px] [font-size:13px] [color:var(--color-collection-result-line-color-121)] [padding:0_4px] [&_p]:m-0 [&_button]:border-0 [&_button]:[background:none] [&_button]:[color:var(--color-brand)] [&_button]:[font:inherit] [&_button]:[font-size:13px] [&_button]:cursor-pointer [&_button]:[min-height:44px] [&_button]:[padding:8px_12px] [&_button]:[border-radius:8px]${!hasFilters && !trips.isPending && !trips.isError ? " collection-result-line-idle [&&]:[min-height:24px] [&_p]:absolute [&_p]:[width:1px] [&_p]:[height:1px] [&_p]:overflow-hidden [&_p]:[clip-path:inset(50%)]" : ""}`}>
        <p role="status">{trips.isPending ? '正在取来你的旅行手册…' : trips.isError ? '暂时无法读取行程' : hasFilters ? `找到 ${total} 份行程` : '所有行程'}</p>
        {hasFilters && <Button variant="plain" type="button" onClick={clearFilters}>清除筛选</Button>}
      </div>

      {trips.isPending && <div className={"collection-grid grid [grid-template-columns:repeat(3,_minmax(0,_1fr))] [gap:20px] [@media_(max-width:_1400px)]:[grid-template-columns:repeat(2,_minmax(0,_1fr))] [@media_(max-width:_600px)]:[grid-template-columns:minmax(0,_1fr)] [@media_(max-width:_600px)]:[gap:18px]"} aria-hidden="true">{[0, 1, 2].map((item) => <div className={"collection-skeleton [padding:8px] [border:1px_solid_var(--color-collection-toolbar-background-112)] [background:var(--color-collection-skeleton-background-151)] [border-radius:20px] [min-height:345px] [&_div]:[height:164px] [&_div]:[border-radius:14px] [&_div]:[background:var(--color-collection-skeleton-background-152)] [&_span]:block [&_span]:[height:14px] [&_span]:[width:75%] [&_span]:[margin:28px_18px_18px] [&_span]:[border-radius:6px] [&_span]:[background:var(--color-collection-skeleton-background-153)] [&_span:last-child]:[width:45%]"} key={item}><div /><span /><span /></div>)}</div>}
      {trips.isError && <div className={"collection-empty [padding:66px_24px] [background:var(--color-collection-empty-background-146)] [border:1px_solid_var(--color-collection-empty-border-147)] [border-radius:24px] text-center [&_h2]:[font:500_23px/1.5_'Noto_Serif_SC_Variable',_SimSun,_serif] [&_h2]:[color:var(--color-collection-empty-color-148)] [&_h2]:[margin:18px_0_12px] [&_p]:[color:var(--color-collection-empty-color-149)] [&_p]:[font-size:14px] [&_p]:[line-height:1.8] [&_p]:[max-width:440px] [&_p]:[margin:0_auto] [@media_(max-width:_600px)]:[padding:40px_20px]"} role="alert"><h2>行程暂时没有加载出来</h2><p>请检查网络连接，再试一次。</p><Button variant="plain" type="button" className={"collection-retry [margin-top:24px] [min-height:44px] [padding:10px_24px] border-0 rounded-full [background:linear-gradient(135deg,_var(--color-brand-light),_var(--color-brand))] [color:white] cursor-pointer [font:inherit] [font-size:14px] [&:disabled]:[opacity:.6] [&:disabled]:[cursor:wait]"} disabled={trips.isFetching} onClick={() => void trips.refetch()}>{trips.isFetching ? '正在重试…' : '重新加载'}</Button></div>}
      {!trips.isPending && !trips.isError && total === 0 && <div className={"collection-empty [padding:66px_24px] [background:var(--color-collection-empty-background-146)] [border:1px_solid_var(--color-collection-empty-border-147)] [border-radius:24px] text-center [&_h2]:[font:500_23px/1.5_'Noto_Serif_SC_Variable',_SimSun,_serif] [&_h2]:[color:var(--color-collection-empty-color-148)] [&_h2]:[margin:18px_0_12px] [&_p]:[color:var(--color-collection-empty-color-149)] [&_p]:[font-size:14px] [&_p]:[line-height:1.8] [&_p]:[max-width:440px] [&_p]:[margin:0_auto] [@media_(max-width:_600px)]:[padding:40px_20px]"}>
        <span className={"collection-empty-mark [font:400_72px/1_'Youran_Handwriting',_serif] [color:var(--color-collection-empty-mark-color-150)]"} aria-hidden="true">旅</span>
        <h2>{hasFilters ? '还没有找到这份旅程' : '你的旅行手册，等待第一段故事'}</h2>
        <p>{hasFilters ? '换个关键词或目的地试试，也可以清除筛选查看全部行程。' : '从顶部「RollingGo」返回首页，规划完成的行程会收在这里。'}</p>
      </div>}

      {items.length > 0 && <div className={"collection-grid grid [grid-template-columns:repeat(3,_minmax(0,_1fr))] [gap:20px] [@media_(max-width:_1400px)]:[grid-template-columns:repeat(2,_minmax(0,_1fr))] [@media_(max-width:_600px)]:[grid-template-columns:minmax(0,_1fr)] [@media_(max-width:_600px)]:[gap:18px]"} aria-label="行程列表">
        {items.map((trip) => (
          <Link key={trip.id} to={`/trips/${trip.id}`} className={"collection-card [--cover-a:var(--color-collection-card-cover-a-122)] [--cover-b:var(--color-collection-card-cover-b-123)] [--cover-ink:var(--color-collection-card-cover-ink-124)] min-w-0 grid [grid-template-columns:46%_minmax(0,_1fr)] [min-height:230px] [background:var(--color-collection-card-background-125)] [border:1px_solid_var(--color-collection-card-border-126)] [border-radius:17px] p-0 [color:inherit] [box-shadow:0_4px_8px_var(--color-collection-card-box-shadow-127),_0_16px_32px_var(--color-collection-card-box-shadow-128)] [transition:transform_180ms_ease,_box-shadow_180ms_ease] [&[data-tone='1']]:[--cover-a:var(--color-collection-card-cover-a-129)] [&[data-tone='1']]:[--cover-b:var(--color-collection-card-cover-b-130)] [&[data-tone='1']]:[--cover-ink:var(--color-collection-card-cover-ink-131)] [&[data-tone='2']]:[--cover-a:var(--color-collection-card-cover-a-132)] [&[data-tone='2']]:[--cover-b:var(--color-collection-card-cover-b-133)] [&[data-tone='2']]:[--cover-ink:var(--color-collection-card-cover-ink-134)] [&[data-tone='3']]:[--cover-a:var(--color-collection-card-cover-a-135)] [&[data-tone='3']]:[--cover-b:var(--color-collection-card-cover-b-136)] [&[data-tone='3']]:[--cover-ink:var(--color-collection-card-cover-ink-137)] [&:hover]:[transform:translateY(-4px)] [&:hover]:[box-shadow:0_6px_12px_var(--color-collection-card-box-shadow-138),_0_20px_36px_var(--color-collection-card-box-shadow-139)] [&_h2]:[color:var(--color-collection-card-color-143)] [&_h2]:[font:600_17px/1.6_'Noto_Sans_SC_Variable',_sans-serif] [&_h2]:[margin:0_0_8px] [&_h2]:[display:-webkit-box] [&_h2]:[-webkit-box-orient:vertical] [&_h2]:[-webkit-line-clamp:2] [&_h2]:overflow-hidden [&_h2]:min-h-0 [&_h2]:[overflow-wrap:anywhere] [@media_(max-width:_600px)]:[min-height:250px] [@media_(max-width:_600px)]:[grid-template-columns:42%_minmax(0,_1fr)] [@media_(max-width:_600px)]:[&_h2]:[font-size:16px] [@media_(max-width:_600px)]:[&_h2]:min-h-0 [@media_(prefers-reduced-motion:_reduce)]:[transition:none] [@media_(prefers-reduced-motion:_reduce)]:[&:hover]:[transform:none] [&[data-tone='4']]:[--cover-a:var(--color-collection-card-cover-a-154)] [&[data-tone='4']]:[--cover-b:var(--color-collection-card-cover-b-155)] [&[data-tone='4']]:[--cover-ink:var(--color-collection-card-cover-ink-156)]"} data-tone={coverTone(trip.destination)} aria-label={`查看行程：${trip.title}`}>
            <TripCover destination={trip.destination} daysCount={trip.daysCount} />
            <div className={"collection-card-body min-w-0 [padding:24px_20px_18px] flex flex-col [@media_(max-width:_600px)]:[padding:22px_14px_18px]"}>
              <h2>{trip.title}</h2>
              <div className={"collection-card-meta [font-size:13px] [color:var(--color-collection-card-meta-color-144)] [margin:14px_0_24px] flex flex-col [gap:12px] [@media_(max-width:_600px)]:[margin-bottom:18px] [&_>_span]:flex [&_>_span]:items-start [&_>_span]:[gap:8px] [&_>_span]:[overflow-wrap:anywhere] [&_svg]:[width:18px] [&_svg]:[height:18px] [&_svg]:flex-none [&_svg]:[color:var(--color-collection-card-meta-color-161)]"}><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 22S3 13 3 9a9 9 0 0 1 18 0c0 4-9 13-9 13Z" /><circle cx="12" cy="9" r="3" /></svg>{trip.destination}</span><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 2v6m10-6v6M3 11h18m-14 4h3m4 0h3" /></svg>{trip.activityCount} 个活动</span></div>
              <div className={"collection-card-foot [margin-top:auto] [padding-top:14px] flex items-center justify-between [gap:8px] flex-wrap [&_time]:[font-size:10px] [&_time]:[color:var(--color-collection-card-foot-color-145)]"}>
                <time dateTime={new Date(trip.updatedAt).toISOString()}>更新于 {dateFormatter.format(trip.updatedAt)}</time>
                <span className={"collection-open [color:var(--color-brand)] [font-size:11px] whitespace-nowrap inline-flex items-center [gap:8px] [&_>_span]:[font-size:19px]"}>翻开行程</span>
              </div>
            </div>
          </Link>
        ))}
      </div>}

      <div ref={sentinelRef} aria-hidden="true" className={"collection-sentinel [height:1px]"} />
      {trips.isFetchingNextPage && <p role="status" className={"collection-more [margin:24px_0_0] text-center [font-size:13px] [color:var(--color-collection-result-line-color-121)]"}>正在加载更多…</p>}
    </div>
  );
}
