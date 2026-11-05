// 真实组件 + 隔离 API/SSE fixture；不修改用户账号，不调用生成模型。
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeSampleTrip } from '../../../packages/shared/src/sample.ts';
import { apiSuccess, apiFailure } from '../../../scripts/lib/api-contract.mjs';

const base = process.env.NAVIGATION_TEST_URL ?? 'http://127.0.0.1:5173';
const output = path.resolve('.trellis/tasks/10-05-navigation-generation-notifications/research/verification');
await mkdir(output, { recursive: true });
const now = Date.now();
const sample = makeSampleTrip(now);
const trips = [
  ['济南', '济南三日泉湖山水行'], ['济南', '济南三日 · 泉城寻味慢游'], ['北京', '北京购物三日游'],
  ['北京', '京城三日美食文化漫游'], ['北京', '北京皇城古迹三日漫游'], ['北京', '京城三日经典名胜之旅'],
].map(([destination, title], index) => ({ ...structuredClone(sample), id: `trip-${index}`, title, destination, updatedAt: now - index * 3600000 }));
let notes = [
  { id: 'note-2', sequence: 2, jobId: 'old-2', kind: 'success', tripId: 'trip-0', title: '杭州 3 天行程已生成', message: '路线与每日安排已准备好。', createdAt: now, readAt: null },
  { id: 'note-1', sequence: 1, jobId: 'old-1', kind: 'success', tripId: 'trip-1', title: '北京 4 天行程已生成', message: '路线与每日安排已准备好。', createdAt: now - 86400000, readAt: now - 80000000 },
  { id: 'note-0', sequence: 0, jobId: 'old-0', kind: 'success', tripId: 'trip-1', title: '厦门 2 天行程已生成', message: '路线与每日安排已准备好。', createdAt: now - 4 * 86400000, readAt: now - 4 * 86400000 },
];
let job = null;
let starts = 0;
let notificationsFail = false;
let saveFails = false;
let savedDays = null;
const errors = [];
const requests = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
  const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, reducedMotion: 'reduce' });
  await context.route(`${base}/api/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    requests.push(`${req.method()} ${p}`);
    let data = {};
    if (p === '/api/auth/me') data = { id: 'nav-test', email: 'nav@example.test' };
    else if (p === '/api/usage') data = { remaining: 4, dailyLimit: 5 };
    else if (p === '/api/settings/travel-preferences') data = { preferences: [], transportMode: 'transit', extraNotes: '', pace: 'moderate', partySize: 2 };
    else if (p === '/api/settings/config') data = { amapJsKey: '', amapJsSecurityCode: '' };
    else if (p === '/api/destinations/covered') data = { cities: ['北京', '杭州', '济南'] };
    else if (p === '/api/notifications') {
      if (notificationsFail) return route.fulfill({ status: 503, json: apiFailure(503, '暂时无法读取通知') });
      const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      data = { items: notes.filter(n => n.sequence < before).sort((a,b) => b.sequence-a.sequence), hasUnread: notes.some(n=>n.readAt===null), readThrough: Math.max(0,...notes.map(n=>n.sequence)), nextCursor: null };
    } else if (p === '/api/notifications/read-all') {
      const { through } = req.postDataJSON();
      notes.forEach(n => { if(n.sequence<=through) n.readAt=Date.now(); });
      data = { ok: true };
    } else if (/\/api\/notifications\/[^/]+\/read$/.test(p)) {
      const n = notes.find(n=>n.id===p.split('/')[3]); if(n) n.readAt=Date.now(); data={ok:true};
    } else if (p === '/api/generations/current') data = job?.status === 'running' ? job : null;
    else if (p === '/api/generations' && req.method()==='POST') { starts++; data={jobId:job?.jobId}; }
    else if (p.endsWith('/events')) {
      const events = [
        {type:'job_start',destination:'杭州',days:3,xhsEnabled:false,dataSources:[],at:now},
        {type:'phase_start',phase:'research',round:1,at:now},
        {type:'phase_end',phase:'research',round:1,at:now+100},
        {type:'phase_start',phase:'plan',round:1,at:now+200},
      ];
      if(job?.status==='done') events.push({type:'job_done',tripId:'trip-2',usedXhs:false,dataSources:[],reviewNotes:[],at:Date.now()});
      return route.fulfill({contentType:'text/event-stream',body:'retry: 250\n\n'+events.map((ev,i)=>`id: ${i+1}\ndata: ${JSON.stringify(ev)}\n\n`).join('')});
    } else if (p.startsWith('/api/generations/')) {
      if(!job) return route.fulfill({status:404,json:apiFailure(404,'任务已过期')});
      data=job;
    } else if (p === '/api/trips') {
      const q=url.searchParams.get('q')??''; const city=url.searchParams.get('city')??'';
      const items=trips.filter(t=>(!city||t.destination===city)&&(!q||`${t.title}${t.destination}`.includes(q)));
      data={items:items.map(t=>({...t,daysCount:t.days.length,activityCount:t.days.reduce((n,d)=>n+d.activities.length,0),totalCost:0,usedXhs:false})),total:items.length,destinations:['济南','北京']};
    } else if (p.endsWith('/versions')) { const id=p.split('/')[3]; data={versions:[{id,version:1,title:'行程',createdAt:now}]}; }
    else if (p.endsWith('/conversation')) data={conversationId:null};
    else if (p.endsWith('/weather')) return route.fulfill({status:503,json:apiFailure(503,'天气暂不可用')});
    else if (/^\/api\/trips\/[^/]+$/.test(p)) {
      const id=p.split('/')[3]; const trip=trips.find(t=>t.id===id);
      if(!trip) return route.fulfill({status:404,json:apiFailure(404,'行程不存在')});
      if(req.method()==='PUT') {
        if(saveFails) return route.fulfill({status:503,json:apiFailure(503,'保存失败，请重试')});
        Object.assign(trip,req.postDataJSON()); savedDays=trip.days.length;
      }
      data=trip;
    }
    return route.fulfill({json:apiSuccess(data)});
  });
  let page = await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(12000);
  await page.goto(`${base}/trips`);
  await page.locator('.collection-card').first().waitFor();
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator('.brand').innerText(),'');
  assert.equal(await page.getByRole('button',{name:'个人资料',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'设置',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'退出登录'}).innerText(),'');
  await page.getByLabel('通知，有未读消息',{exact:true}).click();
  await page.getByRole('region',{name:'通知面板'}).waitFor();
  assert.equal(await page.locator('[data-testid=notification-dot]').innerText(),'');
  assert.equal(await page.locator('.notification-item',{hasText:'杭州 3 天行程已生成'}).locator('time').innerText(),'刚刚');
  assert.match(await page.locator('.notification-item',{hasText:'北京 4 天行程已生成'}).locator('time').innerText(),/^昨天 \d{2}:\d{2}$/);
  assert.match(await page.locator('.notification-item',{hasText:'厦门 2 天行程已生成'}).locator('time').innerText(),/^\d+\/\d+ \d{2}:\d{2}$/);
  await page.locator('.notification-item',{hasText:'厦门 2 天行程已生成'}).locator('time').click();
  await page.waitForTimeout(300);
  assert.equal(new URL(page.url()).pathname,'/trips');
  assert.equal(await page.locator('.notification-disclosure').getAttribute('open'),'');
  await page.mouse.move(700,140);
  await page.screenshot({path:path.join(output,'desktop-notifications.png')});
  await page.getByRole('button',{name:'全部已读',exact:true}).click();
  await page.getByLabel('通知，无未读消息',{exact:true}).waitFor();
  assert.equal(await page.locator('.notification-disclosure').getAttribute('open'),'');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.notification-disclosure').getAttribute('open'),null);
  assert.equal(await page.locator('summary').evaluate(e=>e===document.activeElement),true);
  console.log('PASS 图标导航、未读红点、面板、全部已读及 Escape 焦点返回');

  notes[0].readAt=null;
  await page.reload();
  await page.getByLabel('通知，有未读消息',{exact:true}).click();
  await page.getByRole('button',{name:/查看行程：杭州 3 天行程已生成（未读）/}).click();
  await page.waitForURL('**/trips/trip-0');
  await page.locator('.editor-page').waitFor();
  assert.ok(notes[0].readAt);
  console.log('PASS 点击消息打开正确详情并持久化已读');

  await page.getByRole('link',{name:'我的行程',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.getByLabel('通知，无未读消息',{exact:true}).click();
  await page.getByRole('dialog',{name:'通知',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const mobileRect=await page.getByRole('dialog',{name:'通知',exact:true}).boundingBox();
  assert.ok(mobileRect.y+mobileRect.height<=845 && mobileRect.x>=0);
  await page.screenshot({path:path.join(output,'mobile-notifications.png')});
  await page.keyboard.press('Escape');
  await page.getByRole('dialog',{name:'通知',exact:true}).waitFor({state:'detached'});
  console.log('PASS 手机通知抽屉、安全边界与关闭');

  await page.setViewportSize({width:1536,height:864});
  job={jobId:'active-job',status:'running',tripId:null,createdAt:now,destination:'杭州',days:3};
  await page.reload();
  await page.locator('.generation-nav:visible').click();
  await page.waitForURL('**/generations/active-job');
  await page.getByText('安排每日路线',{exact:true}).waitFor();
  await page.getByRole('link',{name:'我的行程',exact:true}).click();
  await page.getByRole('heading',{name:'我的行程',exact:true}).waitFor();
  await page.locator('.generation-nav:visible').click();
  await page.getByText('安排每日路线',{exact:true}).waitFor();
  assert.equal(starts,0);
  await page.getByRole('link',{name:'我的行程',exact:true}).click();
  await page.bringToFront();
  notes.unshift({id:'new-done',sequence:3,jobId:'active-job',kind:'success',tripId:'trip-2',title:'杭州 3 天行程已生成',message:'路线与每日安排已准备好。',createdAt:Date.now(),readAt:null});
  job={...job,status:'done',tripId:'trip-2'};
  await page.locator('.notification-toast').waitFor();
  assert.equal(new URL(page.url()).pathname,'/trips');
  assert.equal(await page.locator('.generation-nav:visible').count(),0);
  await page.screenshot({path:path.join(output,'completion-toast.png')});
  await page.getByRole('button',{name:'关闭完成提醒'}).click();
  assert.equal(notes[0].readAt,null);
  console.log('PASS 离开与恢复生成不中断、不重发，后台完成提示不抢页面');

  await page.close();
  page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/trips`);
  await page.getByLabel('通知，有未读消息',{exact:true}).waitFor();
  assert.equal(await page.locator('.notification-toast').count(),0);
  await page.getByLabel('通知，有未读消息',{exact:true}).click();
  await page.getByRole('button',{name:/查看行程：杭州 3 天行程已生成（未读）/}).click();
  await page.waitForURL('**/trips/trip-2');
  console.log('PASS 关闭重开保留未读，旧通知不重放弹窗，点击打开完成行程');

  // 在途保存失败不能把用户带离正在编辑的行程。
  await page.locator('.editor-page').waitFor();
  saveFails=true;
  await page.getByRole('button',{name:'＋ 添加一天',exact:true}).click();
  await page.getByRole('button',{name:'第4天',exact:true}).waitFor();
  await page.getByRole('link',{name:'我的行程',exact:true}).click();
  await page.getByRole('alert').first().waitFor();
  assert.equal(new URL(page.url()).pathname,'/trips/trip-2');
  saveFails=false;
  await page.getByRole('link',{name:'我的行程',exact:true}).click();
  await page.waitForURL('**/trips');
  assert.equal(savedDays,4);
  console.log('PASS 导航先保存，失败保留原页面和草稿，重试成功再离开');

  notes=[];
  await page.reload();
  await page.getByLabel('通知，无未读消息',{exact:true}).click();
  await page.getByText('暂无通知',{exact:true}).waitFor();
  notificationsFail=true;
  await page.reload();
  await page.getByLabel('通知，无未读消息',{exact:true}).click();
  await page.getByText('通知暂时无法加载',{exact:true}).waitFor();
  notificationsFail=false;
  await page.getByRole('button',{name:'重新加载',exact:true}).click();
  await page.getByText('暂无通知',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS 通知空态、错误、重试；浏览器无未捕获异常');
  console.log(`截图：${output}`);
} catch (error) {
  const failedPage=browser.contexts().flatMap(c=>c.pages()).at(-1);
  if(failedPage) { console.error((await failedPage.locator('body').innerText()).slice(0,5000)); await failedPage.screenshot({path:path.join(output,'failure.png')}); }
  console.error(errors);
  throw error;
} finally { await browser.close(); }
