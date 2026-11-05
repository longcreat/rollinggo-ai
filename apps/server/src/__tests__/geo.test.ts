// 单测：WGS-84 → GCJ-02 转换 / Haversine / 通勤启发式估算（node:test，经 tsx 运行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gcj02ToWgs84, haversineMeters, wgs84ToGcj02 } from '@tripweaver/shared';
import { estimateLeg } from '../generation/legEstimator';

test('wgs84ToGcj02：已知基准点误差 < 1e-4 度（上海，eviltransform 测试向量）', () => {
  const { lat, lng } = wgs84ToGcj02(31.1774276, 121.5272106);
  assert.ok(Math.abs(lat - 31.17530398364597) < 1e-4, `lat 偏差过大：${lat}`);
  assert.ok(Math.abs(lng - 121.53154299111314) < 1e-4, `lng 偏差过大：${lng}`);
});

test('wgs84ToGcj02：偏移方向与量级合理（北京，约 200~800 米级）', () => {
  const wgs = { lat: 39.907333, lng: 116.391083 };
  const gcj = wgs84ToGcj02(wgs.lat, wgs.lng);
  const shift = haversineMeters(wgs, gcj);
  assert.ok(shift > 100 && shift < 1000, `偏移量异常：${shift}m`);
});

test('wgs84ToGcj02：中国境外坐标不偏移（东京）', () => {
  const gcj = wgs84ToGcj02(35.6895, 139.6917);
  assert.deepEqual(gcj, { lat: 35.6895, lng: 139.6917 });
});

test('gcj02ToWgs84：已知基准点反解回 WGS-84（上海，同一 eviltransform 向量）', () => {
  // 容差 1e-5（而非往返测试的 1e-6）：外部参考向量的 lng 本身与我们的正向实现相差
  // 1.13e-6 度（约 0.1m），反解精度无法优于参考值本身的精度。自洽性由下一个用例卡到 1e-6。
  const { lat, lng } = gcj02ToWgs84(31.17530398364597, 121.53154299111314);
  assert.ok(Math.abs(lat - 31.1774276) < 1e-5, `lat 反解偏差过大：${lat}`);
  assert.ok(Math.abs(lng - 121.5272106) < 1e-5, `lng 反解偏差过大：${lng}`);
});

test('gcj02ToWgs84：与正向互为逆运算，往返误差 < 1e-6 度（多城市采样）', () => {
  const samples = [
    { lat: 39.907333, lng: 116.391083 },     // 北京
    { lat: 31.1774276, lng: 121.5272106 },   // 上海
    { lat: 22.5431, lng: 114.0579 },         // 深圳
    { lat: 29.5630, lng: 106.5516 },         // 重庆（大市域）
    { lat: 43.8256, lng: 87.6168 },          // 乌鲁木齐
  ];
  for (const wgs of samples) {
    const gcj = wgs84ToGcj02(wgs.lat, wgs.lng);
    const back = gcj02ToWgs84(gcj.lat, gcj.lng);
    assert.ok(Math.abs(back.lat - wgs.lat) < 1e-6, `lat 往返偏差过大：${back.lat} vs ${wgs.lat}`);
    assert.ok(Math.abs(back.lng - wgs.lng) < 1e-6, `lng 往返偏差过大：${back.lng} vs ${wgs.lng}`);
  }
});

test('gcj02ToWgs84：中国境外坐标不偏移（东京）', () => {
  assert.deepEqual(gcj02ToWgs84(35.6895, 139.6917), { lat: 35.6895, lng: 139.6917 });
});

test('haversineMeters：赤道上 0.009 度纬差 ≈ 1000 米', () => {
  const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0.009, lng: 0 });
  assert.ok(Math.abs(d - 1000.75) < 1, `距离异常：${d}`);
});

test('estimateLeg：三模式时长/距离（直线 1000.75m × 1.4 绕行）', () => {
  const a = { lat: 0, lng: 0 };
  const b = { lat: 0.009, lng: 0 };
  const walk = estimateLeg(a, b, 'walk');
  assert.equal(walk.distanceM, 1401);
  assert.equal(walk.durationMin, 19);   // 1.401km / 4.5km/h × 60
  assert.equal(walk.source, 'heuristic');
  assert.equal(estimateLeg(a, b, 'transit').durationMin, 14);   // 4.2 + 10 换乘
  assert.equal(estimateLeg(a, b, 'drive').durationMin, 8);      // 2.8 + 5
});

test('estimateLeg：零距离也至少 1 分钟', () => {
  const leg = estimateLeg({ lat: 30, lng: 120 }, { lat: 30, lng: 120 }, 'walk');
  assert.equal(leg.durationMin, 1);
  assert.equal(leg.distanceM, 0);
});
