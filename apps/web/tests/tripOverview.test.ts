import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { simplifyPlaceName } from '../src/components/editor/TripOverview';

describe('simplifyPlaceName', () => {
  it('智能剥离冗长的风景区/旅游区前缀', () => {
    assert.equal(simplifyPlaceName('杭州西湖风景名胜区-断桥残雪'), '断桥残雪');
    assert.equal(simplifyPlaceName('杭州西湖风景名胜区-白堤'), '白堤');
    assert.equal(simplifyPlaceName('西湖风景区-苏堤'), '苏堤');
    assert.equal(simplifyPlaceName('中山公园-西泠印社社址'), '西泠印社社址');
  });

  it('规范化餐饮前缀并剥离分店名与商业营销副标', () => {
    assert.equal(simplifyPlaceName('午餐 | 印湖饭店·传承经典杭帮菜(西湖断桥店)'), '午餐 · 印湖饭店');
    assert.equal(simplifyPlaceName('晚餐 | 外婆家(西湖断桥店)'), '晚餐 · 外婆家');
  });

  it('常规地名保持原样', () => {
    assert.equal(simplifyPlaceName('岳王庙'), '岳王庙');
    assert.equal(simplifyPlaceName('灵隐寺'), '灵隐寺');
  });
});
