import { apiSuccess, apiFailure } from '../../../scripts/lib/api-contract.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const amapMode = process.argv.includes('--amap');
const out = path.resolve('.trellis/tasks/archive/2026-10/09-29-ui-consistency/research/editor-verification', amapMode ? 'amap-contract' : '.');
await fs.mkdir(out, { recursive: true });
const names = ['故宫博物院', '景山公园', '北海公园'];
const coords = [[39.916,116.397],[39.925,116.397],[39.925,116.389]];
const trip = { id: 'editor-ui-test', title: '北京 · 四日漫游', destination: '北京', startDate: '2026-10-16', partySize: 2, preferences: [], budgetLevel: '舒适', totalBudget: 0, extraNotes: '', createdAt: 0, updatedAt: 0, meta: {usedXhs: false, reviewNotes: []},
  days: [1,2,3,4].map((n) => ({id: `day-${n}`, dayIndex: n, title: ['沿着中轴线，走进老北京','胡同深处，寻味京城','湖光山色，慢游颐和园','收集最后一程的风景'][n-1], activities: n === 1 ? names.map((name,i)=>({ id: `a${i}`, name, description: ['从午门开启今日漫游，感受宫殿建筑与中轴秩序。','登上万春亭，俯瞰故宫与北京中轴线。','漫步湖畔，欣赏白塔与园林景色。'][i], category:'文化', lat:coords[i][0], lng:coords[i][1], coordSource:'manual', coordSystem:'gcj02', startTime:'', endTime:'', sourceNotes:[] })) : [], legs: n===1 ? [{fromActivityId:'a0',toActivityId:'a1',mode:'walk',durationMin:15,distanceM:900,source:'heuristic'}] : [] })),
  overview: names.map((name,i)=>({id:`p${i}`,name,category:'attraction',coverUrl:`/fixture-photo-${i}.jpg`,intro:`${name}的完整调研介绍。`,reservation:i===0?'required':'none',sourceLinks:[]}))
};
const messages = ['请帮我看看第1天的行程安排，有什么可以调整的吗？','好的，已为您整理了第1天的详细行程安排。整体节奏比较合理，如果想更轻松一些，可以把景山公园调整到下午，或者增加1小时的休息时间。','好的，暂时没问题，我们就按这个走。','好的，我会继续为您优化后续行程。如有其他调整需求，随时告诉我～'].map((content,i)=>({id:`m${i}`, role:i%2?'assistant':'user',content,createdAt:0}));
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1672,height:941}, reducedMotion:'reduce'});
 const errors=[]; let saves=0; let failSave=false; let noChat=false; let broken=false;
 page.on('pageerror',e=>{errors.push(e.message); console.log('PAGE ERROR', e.message);});
 if (amapMode) await page.route('https://webapi.amap.com/maps?**', route => route.fulfill({contentType:'text/javascript',body:`
 window.amapCalls=[];
 class TestMap {
   constructor(host,options){this.zoom=12;window.amapCalls.push(['create',options.features]);}
   add(){} remove(){} resize(){} destroy(){} on(){} off(){}
   getZoom(){return this.zoom;}
   setZoom(value){this.zoom=value;window.amapCalls.push(['zoom',value]);}
   setCenter(value){window.amapCalls.push(['center',value]);}
   setFitView(overlays){window.amapCalls.push(['fit',overlays.length]);}
 }
 class Overlay {constructor(options){this.options=options;}setMap(){}on(){}}
 window.AMap={Map:TestMap,Marker:Overlay,Polyline:Overlay,Pixel:class{}};
 `}));
 await page.route('**/fixture-photo-*.jpg' ,async route=>{
  if(broken) return route.fulfill({status:404,body:''});
  const index=Number(route.request().url().match(/photo-(\d)/)[1]);
  const photos=['01-gugong.jpg','07-jingshan.jpg','05-beihai.jpg'];
  return route.fulfill({contentType:'image/jpeg',body:await fs.readFile(path.resolve('.trellis/tasks/archive/2026-09/09-26-wikimedia-photo-fallback/research/preview',photos[index]))});
 });
 await page.route(/^http:\/\/127\.0\.0\.1:5173\/api\//,async route=>{
  const url=new URL(route.request().url()); let data={};
  if(url.pathname==='/api/auth/me') data={id:'test',email:'ui@example.test'};
  else if(url.pathname==='/api/usage') data={remaining:1,dailyLimit:4};
  else if(url.pathname==='/api/settings/config') data={amapJsKey:amapMode?'fixture-key':'',amapJsSecurityCode:amapMode?'fixture-code':''};
  else if(url.pathname==='/api/trips/editor-ui-test/versions') data={versions:[{id:'editor-ui-test',version:1}]};
  else if(url.pathname==='/api/trips/editor-ui-test/conversation') data={conversationId:noChat?null:'fixture-chat'};
  else if(url.pathname==='/api/conversations/fixture-chat') data={messages};
  else if(url.pathname==='/api/trips/editor-ui-test') {
    if(route.request().method()==='PUT') { saves++; if(failSave) return route.fulfill({status: 500, json: apiFailure(500, '测试保存失败')}); data=route.request().postDataJSON(); }
    else data=trip;
  }
  return route.fulfill({json: apiSuccess(data) });
 });
 await page.goto('http://127.0.0.1:5173/trips/editor-ui-test');
 const itinerary=page.getByRole('group',{name:'行程天数'});
 await itinerary.getByRole('button',{name:'第1天',exact:true}).click();
 await page.locator('.activity-card').first().waitFor({timeout:10000}).catch(async error => { console.log(await page.locator('body').innerText()); await page.screenshot({path:path.join(out,'failure.png')}); throw error; });
 await page.evaluate(()=>document.fonts.ready);
 await page.locator('.activity-card img').first().evaluate(img=>img.decode());
 assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'document must not scroll vertically');
 assert.equal(await itinerary.getByRole('button',{name:'第1天',exact:true}).getAttribute('aria-pressed'),'true');
 assert.ok(await page.locator('.activity-card').first().evaluate(card=>{const c=card.getBoundingClientRect(), m=card.querySelector('summary').getBoundingClientRect(); return m.right<=c.right && m.top<c.top+60 && m.left>c.left+c.width/2;}),'more menu must be at card top right');
 const tilesLoaded = amapMode ? null : await page.waitForFunction(()=>[...document.querySelectorAll('.leaflet-tile')].some(img=>img.complete && img.naturalWidth>0),{},{timeout:8000}).then(()=>true,()=>false);
 if (amapMode) await page.locator('.amap-host').waitFor();
 console.log('Map tiles loaded:',tilesLoaded);
 if (tilesLoaded) await page.waitForFunction(()=>[...document.querySelectorAll('.leaflet-tile-loaded')].every(img=>Number(getComputedStyle(img).opacity)===1),{},{timeout:3000}).catch(()=>{});
 if(!amapMode) {
  await page.locator('summary[aria-label="分享行程"]').click();
  await page.getByRole('button',{name:'AI 生成海报',exact:true}).click();
  await page.getByRole('dialog',{name:'AI 生成海报',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'开始生成',exact:true}).isEnabled(),true);
  assert.equal(await page.getByRole('button',{name:'JSON 备份',exact:true}).count(),0,'JSON 备份入口已移除');
  // Generation and download are covered with mocked upstream in trip-share-image-browser.mjs.
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).last().click();
  await page.evaluate(()=>{window.printCount=0;window.print=()=>{window.printCount++;}});
  await page.locator('summary[aria-label="分享行程"]').click();
  await page.getByRole('button',{name:/导出 PDF/}).click();
  assert.equal(await page.evaluate(()=>window.printCount),1);
  assert.ok(await page.locator('.print-host').evaluate(el=>el.parentElement===document.body));
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('.print-host .pv').evaluate(el=>getComputedStyle(el).visibility),'visible');
  await page.emulateMedia({media:'screen'});
 }
 await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
 for(const [name,width,height] of [['laptop',1280,800],['tablet',900,1000],['mobile',390,844]]) {
  await page.setViewportSize({width,height});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),`${name}: vertical document overflow`);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name}: horizontal overflow`);
  assert.ok(await page.locator('.editor-body').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight),`${name}: body below viewport`);
  await page.screenshot({path:path.join(out,`${name}.png`),fullPage:true});
 }
 await page.setViewportSize({width:1672,height:941});
 assert.equal(await page.getByRole('group',{name:'地图天数'}).count(),0,'地图上方不再有天数页签');
 await itinerary.getByRole('button',{name:'第2天',exact:true}).click();
 assert.equal(await itinerary.getByRole('button',{name:'第2天',exact:true}).getAttribute('aria-pressed'),'true');
 await itinerary.getByRole('button',{name:'第3天',exact:true}).click();
 assert.equal(await itinerary.getByRole('button',{name:'第3天',exact:true}).getAttribute('aria-pressed'),'true');
 await itinerary.getByRole('button',{name:'总览',exact:true}).click();
 await page.getByRole('region',{name:'行程总览'}).waitFor();
 assert.equal(saves,0,'filter changes must not autosave');
 await itinerary.getByRole('button',{name:'第1天',exact:true}).click();
 await page.getByLabel('当天更多操作').click();
 await page.getByRole('button',{name:'修改当日主题',exact:true}).click();
 await page.getByRole('dialog',{name:'修改当日主题',exact:true}).waitFor();
 await page.getByRole('textbox',{name:'修改当日主题',exact:true}).fill('取消后不保存');
 await page.keyboard.press('Escape');
 assert.equal(await page.getByLabel('当天更多操作').evaluate(el=>el===document.activeElement),true,'dialog restores collapsed menu trigger');
 assert.equal(saves,0,'cancelled prompt must not save');
 await itinerary.getByRole('button',{name:'总览',exact:true}).click();
 await page.getByRole('button',{name:'＋ 添加一天',exact:true}).click();
 await itinerary.getByRole('button',{name:'第5天',exact:true}).click();
 await page.getByLabel('当天更多操作').click();
 await page.getByRole('button',{name:'删除这一天',exact:true}).click();
 await page.getByRole('dialog',{name:'删除这一天',exact:true}).getByRole('button',{name:'确认删除',exact:true}).click();
 assert.equal(await itinerary.getByRole('button',{name:'第1天',exact:true}).getAttribute('aria-pressed'),'true');
 await page.getByLabel('故宫博物院更多操作').click();
 assert.equal(await page.getByRole('button',{name:/^(查看完整信息|编辑活动)$/}).count(),0);
 await page.getByRole('button',{name:'下移',exact:true}).click();
 assert.equal(await page.locator('.activity-name').first().innerText(),'景山公园');
 assert.equal(await page.locator('.editor-transit').filter({hasText:'约15 分钟'}).count(),0,'stale adjacent leg must disappear');
 await page.getByLabel('景山公园更多操作').click();
 await page.getByRole('article',{name:'景山公园',exact:true}).getByLabel('移至其他天').selectOption('day-2');
 await itinerary.getByRole('button',{name:'第2天',exact:true}).click();
 assert.equal(await page.locator('.activity-name').first().innerText(),'景山公园');
 assert.equal(await page.getByRole('button',{name:'＋ 添加活动',exact:true}).count(),0,'活动添加入口已移除');
 await page.getByRole('button',{name:'放大地图',exact:true}).click();
 await page.getByRole('button',{name:'默认视图',exact:true}).click();
 if(amapMode) {const calls=await page.evaluate(()=>window.amapCalls); assert.ok(calls.some(c=>c[0]==='zoom')); assert.ok(calls.some(c=>c[0]==='fit' && c[1]>0)); assert.ok(calls.some(c=>c[0]==='create' && c[1].includes('road')));}
 if(!amapMode) {
  // 点地图地点：中间行程栏切到那天并滚到对应景点，不再弹气泡
  await itinerary.getByRole('button',{name:'总览',exact:true}).click();
  await page.getByRole('region',{name:'行程总览'}).waitFor();
  const marker=page.locator('.map-marker .marker-pin');
  // setFitView 有 60ms 延迟，等有 pin 真的落在画布内再点
  await page.waitForFunction(()=>{
    const c=document.querySelector('.editor-map-canvas')?.getBoundingClientRect();
    return !!c&&[...document.querySelectorAll('.map-marker .marker-pin')].some(p=>{const r=p.getBoundingClientRect();return r.width>0&&r.left>=c.left&&r.right<=c.right&&r.top>=c.top&&r.bottom<=c.bottom;});
  });
  const picked=await page.evaluate(()=>{
    const c=document.querySelector('.editor-map-canvas').getBoundingClientRect();
    const pins=[...document.querySelectorAll('.map-marker .marker-pin')];
    const i=pins.findIndex(p=>{const r=p.getBoundingClientRect();return r.width>0&&r.left>=c.left&&r.right<=c.right&&r.top>=c.top&&r.bottom<=c.bottom;});
    return {i,label:pins[i].parentElement.querySelector('.map-label').textContent};
  });
  await marker.nth(picked.i).click();
  assert.equal(await page.locator('.leaflet-popup').count(),0,'点地点不再弹气泡');
  assert.equal(await itinerary.getByRole('button',{name:'总览',exact:true}).getAttribute('aria-pressed'),'false');
  const target=page.getByRole('article',{name:picked.label,exact:true});
  await target.waitFor();
  assert.ok(await target.evaluate(el=>{const box=el.parentElement.parentElement.getBoundingClientRect(),r=el.getBoundingClientRect();return r.top>=box.top-1&&r.bottom<=box.bottom+1;}),'对应景点滚进视野');
  await itinerary.getByRole('button',{name:'第2天',exact:true}).click();
 }
 failSave=true;
 await page.getByLabel('景山公园更多操作').click();
 await page.getByRole('button',{name:'删除活动',exact:true}).click();
 await page.getByRole('dialog',{name:'删除活动',exact:true}).getByRole('button',{name:'确认删除',exact:true}).click();
 await page.getByRole('alert').waitFor();
 failSave=false;
 await page.getByRole('button',{name:'重试保存',exact:true}).click();
 await page.getByRole('alert').waitFor({state:'detached'});
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'地图',exact:true}).click();
 await page.getByRole('button',{name:'默认视图',exact:true}).waitFor({state:'visible'});
 await page.screenshot({path:path.join(out,'mobile-map.png')});
 await page.getByRole('button',{name:'对话',exact:true}).click();
 await page.getByLabel('输入你的行程想法').waitFor({state:'visible'});
 await page.screenshot({path:path.join(out,'mobile-chat.png')});
 trip.days[3].activities=Array.from({length:30},(_,i)=>({...trip.days[0].activities[0],id:`long-${i}`,name:`长行程活动${i}`,description:'很长的行程内容。'.repeat(20),lat:0,lng:0}));
 noChat=true; broken=true;
 await page.setViewportSize({width:1672,height:941});
 await page.reload();
 await page.getByRole('button',{name:'开启行程对话',exact:true}).waitFor();
 await itinerary.getByRole('button',{name:'第1天',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.poi-photo-trigger').length===0);
 await page.screenshot({path:path.join(out,'no-chat-broken-photos.png')});
 assert.equal(await page.locator('.activity-entry').count(),3);
 assert.ok(await page.locator('.print-host').evaluate(el=>el.scrollHeight>innerHeight),'fixture must exercise long offscreen export');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'long export must not cause page scrolling');
 for(const width of [390,1280]) {await page.setViewportSize({width,height:844}); assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1 && document.documentElement.scrollWidth<=innerWidth+1),'long export: viewport stays bounded');}
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify({status:'passed',saves,errors,tilesLoaded,checks:['export dialog/print export','long itinerary without document scrolling','four viewports','day tabs drive the map filter (no map day tabs)','add/delete day','details','edit and add activity','reorder','cross-day move','stale transit hiding','map marker jumps to the activity','map controls','save failure/retry','mobile panels','missing conversation and broken images']},null,2));
 console.log('Editor browser checks passed. Screenshots:',out);
} finally {await browser.close();}
