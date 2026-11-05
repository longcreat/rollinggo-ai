import { uid } from './utils';
import type { Activity, Trip } from './types';

type ActivitySeed = Omit<Activity, 'id' | 'sourceNotes'> & Partial<Pick<Activity, 'sourceNotes'>>;

function act(seed: ActivitySeed): Activity {
  return { sourceNotes: [], ...seed, id: uid() };
}

// 上海 3 日示例行程（真实经纬度）—— 无 Key / 无小红书环境下的完整功能演示数据
export function makeSampleTrip(now = Date.now()): Trip {
  return {
    id: uid(),
    title: '上海 3 日经典漫游（示例）',
    destination: '上海',
    startDate: '',
    budgetLevel: '舒适',
    totalBudget: 3000,
    preferences: ['美食', '文化'],
    partySize: 2,
    extraNotes: '',
    meta: { usedXhs: false, reviewNotes: [] },
    createdAt: now,
    updatedAt: now,
    days: [
      {
        id: uid(),
        dayIndex: 1,
        title: '外滩与豫园',
        activities: [
          act({ name: '豫园 · 城隍庙', startTime: '09:30', endTime: '12:00', description: '江南园林与老城厢，九曲桥拍照，顺路南翔小笼。', lat: 31.2271, lng: 121.4921, coordSource: 'manual', cost: 80, category: '文化' }),
          act({ name: '南京东路步行街', startTime: '13:00', endTime: '15:00', description: '从河南中路一路逛到外滩口，老字号与百货云集。', lat: 31.2359, lng: 121.4802, coordSource: 'manual', cost: 0, category: '购物' }),
          act({ name: '外滩漫步', startTime: '15:30', endTime: '17:30', description: '万国建筑博览群，江对岸即陆家嘴天际线。', lat: 31.2403, lng: 121.4905, coordSource: 'manual', cost: 0, category: '文化' }),
          act({ name: '外滩夜景 + 晚餐', startTime: '18:00', endTime: '20:30', description: '日落后华灯初上是最佳观景窗口，附近本帮菜晚餐。', lat: 31.2385, lng: 121.4869, coordSource: 'manual', cost: 260, category: '美食' }),
        ],
      },
      {
        id: uid(),
        dayIndex: 2,
        title: '法租界与滨江',
        activities: [
          act({ name: '武康路 · 武康大楼', startTime: '09:30', endTime: '11:30', description: '梧桐区 citywalk 起点，沿线洋房与咖啡馆密布。', lat: 31.2075, lng: 121.4370, coordSource: 'manual', cost: 0, category: '文化' }),
          act({ name: '安福路 · 五原路午餐', startTime: '11:30', endTime: '13:30', description: '话剧院一带小馆与面包房，随性挑一家。', lat: 31.2136, lng: 121.4453, coordSource: 'manual', cost: 160, category: '美食' }),
          act({ name: '田子坊', startTime: '14:30', endTime: '16:30', description: '石库门弄堂改造的文创街区，手作与小店适合淘礼物。', lat: 31.2103, lng: 121.4692, coordSource: 'manual', cost: 100, category: '购物' }),
          act({ name: '西岸滨江骑行', startTime: '17:00', endTime: '19:00', description: '沿黄浦江骑行看日落，龙美术馆一带江景开阔。', lat: 31.1811, lng: 121.4560, coordSource: 'manual', cost: 40, category: '自然' }),
        ],
      },
      {
        id: uid(),
        dayIndex: 3,
        title: '陆家嘴与返程',
        activities: [
          act({ name: '陆家嘴天际线', startTime: '09:30', endTime: '11:30', description: '上海中心/环球金融中心观景台任选其一登高。', lat: 31.2336, lng: 121.5055, coordSource: 'manual', cost: 360, category: '娱乐' }),
          act({ name: '船厂 1862 / 滨江大道', startTime: '12:00', endTime: '14:00', description: '老船厂改造艺术空间，江边午餐收尾。', lat: 31.2412, lng: 121.5030, coordSource: 'manual', cost: 180, category: '美食' }),
          act({ name: '上海博物馆东馆', startTime: '14:30', endTime: '17:00', description: '青铜与书画馆藏一流，记得提前预约。', lat: 31.2225, lng: 121.5453, coordSource: 'manual', cost: 0, category: '文化' }),
        ],
      },
    ],
  };
}
