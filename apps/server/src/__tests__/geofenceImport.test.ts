// 景区细分点位导入：设施点/远点/重复坐标不进候选池。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSubPoiRows, classifySubPoi, coordinateKey, normalizeName } from '../services/geofenceImport';
import type { SourcedPoi } from '../integrations/geoContracts';

const poi = (name: string, lng: number, lat: number, type = '风景名胜;风景名胜;公园'): SourcedPoi => ({
  name, type, address: '', rating: '', cost: '', opentime: '', photoUrls: [], location: { lng, lat }, adcode: '330100',
});

const parent = { center: { lat: 30.2437, lng: 120.1479 } };
const parentId = 'parent-1';

test('设施类名称与类型被拒绝', () => {
  assert.equal(classifySubPoi(poi('花港码头售票亭', 120.14, 30.23), parent), 'blacklisted-name');
  assert.equal(classifySubPoi(poi('西湖游船码头', 120.14, 30.23), parent), 'blacklisted-name');
  assert.equal(classifySubPoi(poi('停车场入口', 120.14, 30.23), parent), 'blacklisted-name');
  assert.equal(classifySubPoi(poi('某某广场', 120.14, 30.23, '交通设施服务;停车场'), parent), 'blacklisted-type');
  assert.equal(classifySubPoi(poi('断桥残雪', 120.151, 30.258), parent), null);
});

test('超出片区半径与缺坐标被拒绝', () => {
  assert.equal(classifySubPoi(poi('远方景点', 120.25, 30.30), parent), 'too-far');
  const missing = { ...poi('无坐标', 0, 0), location: null };
  assert.equal(classifySubPoi(missing, parent), 'no-location');
});

test('同坐标与同名重复被拒绝，报告计数准确', () => {
  const { rows, report } = buildSubPoiRows({
    city: '杭州',
    parentId,
    parentCenter: parent.center,
    pois: [
      poi('苏堤春晓', 120.136, 30.238),
      poi('苏堤春晓', 120.136, 30.238),
      poi('花港观鱼', 120.139, 30.23),
      poi('花港观鱼', 120.1391, 30.23),
      poi('雷峰塔', 120.1497, 30.2316),
    ],
    existingNames: ['雷峰塔'],
  });
  assert.deepEqual(rows.map((row) => row.name), ['苏堤春晓', '花港观鱼']);
  assert.equal(report.accepted, 2);
  assert.equal(report.rejected['duplicate-coordinate'], 1);
  assert.equal(report.rejected['duplicate-name'], 2);
});

test('生成的行带父点、去重键与真实坐标', () => {
  const { rows } = buildSubPoiRows({
    city: '杭州', parentId, parentCenter: parent.center, pois: [poi('断桥残雪', 120.151, 30.258)],
  });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.parentId, parentId);
  assert.equal(row.source, 'amap-area');
  assert.equal(row.verified, true);
  assert.equal(row.dedupeKey, coordinateKey({ lng: 120.151, lat: 30.258 }));
  assert.deepEqual({ lng: row.lng, lat: row.lat }, { lng: 120.151, lat: 30.258 });
  assert.equal(row.payload.parentPlaceId, parentId);
});

test('名称归一化：空白与大小写不影响去重', () => {
  assert.equal(normalizeName(' West Lake '), 'westlake');
  const { rows, report } = buildSubPoiRows({
    city: '杭州', parentId, parentCenter: parent.center,
    pois: [poi('West Lake', 120.14, 30.24), poi('westlake', 120.15, 30.25)],
  });
  assert.equal(rows.length, 1);
  assert.equal(report.rejected['duplicate-name'], 1);
});
