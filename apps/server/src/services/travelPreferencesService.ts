import { eq } from 'drizzle-orm';
import { Value } from '@sinclair/typebox/value';
import { TravelPreferencesSchema, type TravelPreferences } from '@tripweaver/shared';
import { db } from '../db/client';
import { userTravelPreferences } from '../db/schema';

export async function getTravelPreferences(userId: string): Promise<TravelPreferences> {
  const [row] = await db.select().from(userTravelPreferences).where(eq(userTravelPreferences.userId, userId));
  if (!row) return { preferences: [], transportMode: 'transit', pace: null, partySize: 2, extraNotes: '' };
  // 旧行没有 pace / partySize：Value.Default 只补带 default 的缺省字段，未知字段照样过不了 Check ——
  // 因此「上一版格式」能兼容读出，「损坏数据」仍然明确报错。
  const data = Value.Default(TravelPreferencesSchema, row.data);
  if (!Value.Check(TravelPreferencesSchema, data)) throw new Error('Invalid stored travel preferences');
  return data as TravelPreferences;
}

export async function saveTravelPreferences(userId: string, data: TravelPreferences): Promise<TravelPreferences> {
  const updatedAt = new Date();
  await db.insert(userTravelPreferences).values({ userId, data, updatedAt }).onConflictDoUpdate({
    target: userTravelPreferences.userId,
    set: { data, updatedAt },
  });
  return data;
}
