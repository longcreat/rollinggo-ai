import { timingSafeEqual } from 'node:crypto';
import { env } from '../env';

export function checkInviteCode(code: string): boolean {
  if (env.inviteCode.length === 0) return false;   // 未配置邀请码时任何输入都不通过（防空对空相等）
  const expected = Buffer.from(env.inviteCode, 'utf8');
  const actual = Buffer.from(code, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
