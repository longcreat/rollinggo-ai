import type { GoldenCase } from './golden/cases';
import { GOLDEN_CASES, SMOKE_CASE_IDS } from './golden/cases';

// 当前冻结库的城市矩阵；云南按用户要求排除。新增城市须显式加入，不能悄悄扩大真实调用。
export const MATRIX_CITIES = [
  ['beijing', '北京'], ['shanghai', '上海'], ['xiamen', '厦门'], ['guangzhou', '广州'],
  ['chengdu', '成都'], ['hangzhou', '杭州'], ['chongqing', '重庆'], ['jinan', '济南'],
  ['suzhou', '苏州'], ['xian', '西安'], ['qingdao', '青岛'],
] as const;
export const MATRIX_PROFILES = [
  { id: 'none', label: '无偏好', preferences: [], notes: '' },
  { id: 'food', label: '美食', preferences: ['美食'], notes: '' },
  { id: 'history', label: '历史', preferences: ['文化'], notes: '侧重历史文化、古迹和博物馆。' },
  { id: 'nature', label: '自然', preferences: ['自然'], notes: '' },
] as const;
const base = { startDate: '2026-10-19', partySize: 2, pace: 'moderate', transportMode: 'transit',
  budgetLevel: '舒适', totalBudget: 0 } as const;
export const MATRIX_CASES: GoldenCase[] = MATRIX_CITIES.flatMap(([slug, destination]) => [3, 5].flatMap((days) =>
  MATRIX_PROFILES.map((profile) => ({ id: `matrix-${slug}-${days}d-${profile.id}`, note: `${destination} ${days} 日 / ${profile.label}；同城同天数对照`,
    form: { ...base, destination, days, preferences: [...profile.preferences], extraNotes: profile.notes } }))));

export const NOTE_EXPECTATIONS = [
  { id: 'require-palace', notes: '必须去故宫博物院，其他景点顺路安排。', require: ['故宫博物院', '故宫'], avoid: [] },
  { id: 'avoid-palace', notes: '不要去故宫博物院，已经去过了。', require: [], avoid: ['故宫博物院', '故宫'] },
  { id: 'require-summer-avoid-palace', notes: '必须安排颐和园，不要去故宫博物院。', require: ['颐和园'], avoid: ['故宫博物院', '故宫'] },
  { id: 'avoid-remote', notes: '不去八达岭长城、慕田峪长城和北京环球影城，只在市区活动。', require: [], avoid: ['八达岭长城', '慕田峪长城', '北京环球影城', '环球影城', '环球度假区'] },
  { id: 'food-no-spicy', notes: '想吃北京本地美食，不能吃辣，不要安排购物。', require: [], avoid: [] },
  { id: 'nature-no-hiking', notes: '喜欢自然风景和公园，但膝盖不好，不爬山、不安排长城。', require: [], avoid: ['八达岭长城', '慕田峪长城'] },
  { id: 'history-with-child', notes: '主要看历史古迹和博物馆，同行有一个8岁孩子；不安排游乐园。', require: [], avoid: ['北京环球影城', '环球影城', '环球度假区', '北京欢乐谷'] },
  { id: 'no-preference-with-notes', notes: '没有特别主题偏好，必须安排天坛，不要去故宫博物院。', require: ['天坛', '天坛公园'], avoid: ['故宫博物院', '故宫'] },
] as const;
export const NOTE_CASES: GoldenCase[] = NOTE_EXPECTATIONS.map((item) => ({ id: `beijing-notes-${item.id}`, note: item.notes,
  form: { ...base, destination: '北京', days: 3, extraNotes: item.notes,
    preferences: item.id === 'food-no-spicy' ? ['美食'] : item.id === 'nature-no-hiking' ? ['自然'] : item.id === 'history-with-child' ? ['文化'] : [] } }));
export const SUITES = { full: GOLDEN_CASES, smoke: GOLDEN_CASES.filter((c) => SMOKE_CASE_IDS.includes(c.id)), matrix: MATRIX_CASES, notes: NOTE_CASES };
export type Suite = keyof typeof SUITES;
export const ALL_CASES = [...GOLDEN_CASES, ...MATRIX_CASES, ...NOTE_CASES];
