import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSampleTrip } from '@tripweaver/shared';
import { createPlaceIdentityIndex } from '../lib/placeIdentity';
import { bindEditPlaceIdentities } from '../chat/placeIdentity';
import { applyItineraryEdits, editActivityDrafts, normalizeEditOps } from '../chat/editOps';
import type { RetrievedPlace } from '../generation/placeRetrieval';
import { DraftTrip } from '../generation/draft';

const place: RetrievedPlace = {id:'lake',name:'大明湖',city:'济南',category:'自然',source:'xhs',verified:true,lat:36.67,lng:117.03,
  aliases:['大明湖景区'],evidence:[],payload:{aliases:['大明湖景区'],identity:{version:2,entityId:'lake'}}};
const index = createPlaceIdentityIndex([place]);

test('撤回泛名保留历史引用，新增与追加日期拒绝复活，未收录地点仍兼容', () => {
  const retired: RetrievedPlace={...place,id:'retired',name:'CUIDA',category:'美食',lat:null,lng:null,verified:false,aliases:[],
    payload:{identity:{version:2,entityId:'retired',revision:2,memberIds:['retired'],memberNames:['CUIDA']},
      identityWithdrawal:{version:1,revision:2,reason:'unavailable_source',candidateIds:[]}}};
  const identities=createPlaceIdentityIndex([retired]);
  const trip=makeSampleTrip();trip.destination='济南';
  Object.assign(trip.days[0]!.activities[0]!,{name:'CUIDA',canonicalPlaceId:'retired'});
  const before=structuredClone(trip);
  assert.deepEqual(bindEditPlaceIdentities(trip,[],identities,'保留旧行程'),before);
  for(const raw of [
    [{kind:'add_activity',dayIndex:1,activity:{name:'cuida',category:'美食'}}],
    [{kind:'add_days',dayIndex:trip.days.length+1,days:[{title:'再逛一天',activities:[{name:'CUIDA'}]}]}],
  ]) {
    const ops=normalizeEditOps(raw);
    assert.throws(()=>bindEditPlaceIdentities(trip,editActivityDrafts(ops),identities,'再去CUIDA'),/待核实/);
  }
  const ordinary=normalizeEditOps([{kind:'add_activity',dayIndex:1,activity:{name:'未收录独立餐厅',category:'美食'}}]);
  assert.doesNotThrow(()=>bindEditPlaceIdentities(trip,editActivityDrafts(ordinary),identities,'添加餐厅'));
  assert.deepEqual(trip,before);
});

test('上游景点及英文类别覆盖模型分类；餐厅别名重复也需要明确重访', () => {
  for (const [category, expected] of [['景点', '文化'], ['attraction', '文化'], ['food', '美食'], ['hotel', '住宿'], ['美食', '美食']] as const) {
    const row = { ...place, category };
    const identities = createPlaceIdentityIndex([row]);
    const trip = makeSampleTrip(); trip.destination = '济南';
    Object.assign(trip.days[0]!.activities[0]!, {name: '午餐｜大明湖', canonicalPlaceId: row.id});
    const before = structuredClone(trip);
    const makeOps = () => normalizeEditOps([{kind:'add_activity',dayIndex:1,activity:{name:'大明湖景区',category:'美食'}}]);
    const ops = makeOps();
    const current = bindEditPlaceIdentities(trip,editActivityDrafts(ops),identities,'加上大明湖景区');
    assert.equal(editActivityDrafts(ops)[0]!.category,expected);
    assert.equal(applyItineraryEdits(current,ops).changed,false,category);
    const revisit = makeOps();
    assert.equal(applyItineraryEdits(bindEditPlaceIdentities(trip,editActivityDrafts(revisit),identities,'再次去大明湖'),revisit).changed,true);
    assert.deepEqual(trip,before);
  }
});

test('旧行程按别名补身份，模型伪造ID与美食分类不能绕过重复防线，历史快照不改变', () => {
  const trip = makeSampleTrip(); trip.destination = '济南';
  trip.days[0]!.activities[0]!.name = '大明湖';
  const before = structuredClone(trip);
  const ops = normalizeEditOps([{kind:'add_activity',dayIndex:1,activity:{name:'大明湖景区',category:'美食',canonicalPlaceId:'fake'}}]);
  assert.equal(editActivityDrafts(ops)[0]!.canonicalPlaceId,undefined);
  const current = bindEditPlaceIdentities(trip,editActivityDrafts(ops),index,'加上大明湖景区');
  assert.equal(editActivityDrafts(ops)[0]!.category,'自然');
  assert.equal(applyItineraryEdits(current,ops).changed,false);
  assert.deepEqual(trip,before);
  const revisit = bindEditPlaceIdentities(trip,editActivityDrafts(ops),index,'傍晚再去大明湖');
  assert.equal(applyItineraryEdits(revisit,ops).changed,true);
  bindEditPlaceIdentities(trip,editActivityDrafts(ops),index,'不要再去大明湖');
  assert.equal(applyItineraryEdits(current,ops).changed,false);
});

test('追加多天也按实体去重；同名不同ID不误合并，歧义需要具体分店', () => {
  const trip = makeSampleTrip(); trip.destination = '济南';
  trip.days[0]!.activities[0]!.name = '大明湖';
  const ops = normalizeEditOps([{kind:'add_days',dayIndex:trip.days.length+1,days:[{title:'新一天',activities:[{name:'大明湖景区'}]}]}]);
  assert.equal(applyItineraryEdits(bindEditPlaceIdentities(trip,editActivityDrafts(ops),index,''),ops).changed,false);
  const ambiguous = createPlaceIdentityIndex([place,{...place,id:'other',payload:{}}]);
  assert.throws(()=>bindEditPlaceIdentities(trip,editActivityDrafts(normalizeEditOps([
    {kind:'add_activity',dayIndex:1,activity:{name:'大明湖'}}])),ambiguous,''),/多个同名/);
});

test('排程草稿持久化保留实体ID，换地点清除旧身份，改说明保留身份', () => {
  const draft = new DraftTrip({destination:'济南',days:1,startDate:'',budgetLevel:'舒适',totalBudget:0,preferences:[],partySize:2,extraNotes:''});
  draft.setSkeleton('济南',['游览']);
  draft.addActivity(1,{name:'大明湖',canonicalPlaceId:'lake',category:'自然'});
  draft.updateActivity(1,1,{description:'湖边漫步'});
  assert.equal(draft.toTrip().days[0]!.activities[0]!.canonicalPlaceId,'lake');
  draft.updateActivity(1,1,{name:'五龙潭'});
  assert.equal(draft.toTrip().days[0]!.activities[0]!.canonicalPlaceId,undefined);
});
