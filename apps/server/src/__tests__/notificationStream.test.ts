// 单测：通知推送订阅表（纯内存，不碰库）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  notificationSubscriberCount,
  publishNotification,
  subscribeNotifications,
  type NotificationEvent,
} from '../services/notificationStream';

test('订阅后能收到该用户的通知，退订后不再收到', () => {
  const got: NotificationEvent[] = [];
  const off = subscribeNotifications('u1', (event) => got.push(event));
  publishNotification('u1', { kind: 'success', title: '成都 3 日 · 已完成', tripId: 't1' });
  off();
  publishNotification('u1', { kind: 'error', title: '不应收到' });
  assert.deepEqual(got, [{ kind: 'success', title: '成都 3 日 · 已完成', tripId: 't1' }]);
});

test('订阅按 userId 隔离：别人的通知不会推到我的连接', () => {
  const mine: NotificationEvent[] = [];
  const other: NotificationEvent[] = [];
  const offMine = subscribeNotifications('u2', (event) => mine.push(event));
  const offOther = subscribeNotifications('u3', (event) => other.push(event));
  publishNotification('u2', { kind: 'success', title: '只给 u2' });
  offMine();
  offOther();
  assert.equal(mine.length, 1);
  assert.equal(other.length, 0);
});

test('同一用户多标签页各自收到一份；退订只摘掉自己', () => {
  const a: NotificationEvent[] = [];
  const b: NotificationEvent[] = [];
  const offA = subscribeNotifications('u4', (event) => a.push(event));
  const offB = subscribeNotifications('u4', (event) => b.push(event));
  publishNotification('u4', { kind: 'success', title: 'x' });
  offA();
  publishNotification('u4', { kind: 'success', title: 'y' });
  offB();
  assert.deepEqual(a.map((e) => e.title), ['x']);
  assert.deepEqual(b.map((e) => e.title), ['x', 'y']);
});

test('坏监听器（已断开的连接）不能拖垮其他监听器与写入方', () => {
  const fine: NotificationEvent[] = [];
  const offBroken = subscribeNotifications('u5', () => {
    throw new Error('连接已断开');
  });
  const offFine = subscribeNotifications('u5', (event) => fine.push(event));
  assert.doesNotThrow(() => publishNotification('u5', { kind: 'error', title: 'ok' }));
  offBroken();
  offFine();
  assert.equal(fine.length, 1);
});

test('最后一个监听器退订后订阅表不再残留该用户', () => {
  const before = notificationSubscriberCount();
  const off = subscribeNotifications('u6', () => {});
  assert.equal(notificationSubscriberCount(), before + 1);
  off();
  assert.equal(notificationSubscriberCount(), before);
});
