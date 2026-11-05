import { eq } from 'drizzle-orm';
import type { SettingsPut } from '@tripweaver/shared';
import { db } from '../db/client';
import { userSettings } from '../db/schema';
import { decryptSecret, encryptSecret } from '../crypto/secretBox';
import { assertSafeBaseUrl } from '../integrations/ssrfGuard';
import { DEFAULT_SEARCH_API_BASE_URL, env, hasSiteLlm } from '../env';

export interface SettingsView {
  byokEnabled: boolean;
  baseUrl: string;
  model: string;
  apiKeyLast4: string;
  hasSiteKey: boolean;
  hasPersonalAmapKey: boolean;
  amapApiKeyLast4: string;
  hasSiteAmapKey: boolean;
  hasPersonalSearchKey: boolean;
  searchApiKeyLast4: string;
  searchApiBaseUrl: string;
  hasSiteSearchKey: boolean;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  byok: boolean;
}

export interface AmapCredential {
  apiKey: string;
  origin: 'personal' | 'site';
  revision: string;
}

export interface SearchCredential {
  baseUrl: string;
  apiKey: string;
  origin: 'personal' | 'site';
  revision: string;
}

async function getRow(userId: string) {
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return row;
}

export async function getSettingsView(userId: string): Promise<SettingsView> {
  const row = await getRow(userId);
  return {
    byokEnabled: row?.byokEnabled ?? false,
    baseUrl: row?.baseUrl ?? '',
    model: row?.model ?? '',
    apiKeyLast4: row?.apiKeyLast4 ?? '',
    hasSiteKey: hasSiteLlm(),
    hasPersonalAmapKey: Boolean(row?.amapApiKeyCiphertext),
    amapApiKeyLast4: row?.amapApiKeyLast4 ?? '',
    hasSiteAmapKey: Boolean(env.amapKey),
    hasPersonalSearchKey: Boolean(row?.searchApiKeyCiphertext && row.searchApiBaseUrl),
    searchApiKeyLast4: row?.searchApiKeyLast4 ?? '',
    searchApiBaseUrl: row?.searchApiBaseUrl ?? '',
    hasSiteSearchKey: Boolean(env.searchApiKey),
  };
}

export async function upsertSettings(userId: string, body: SettingsPut): Promise<SettingsView> {
  const prev = await getRow(userId);
  const baseUrl = body.baseUrl?.trim() ?? prev?.baseUrl ?? '';
  const model = body.model?.trim() ?? prev?.model ?? '';

  // 保存时即做 SSRF 校验（使用时会二次校验，防 DNS 重绑定）
  if (baseUrl) await assertSafeBaseUrl(baseUrl);

  let apiKeyCiphertext = prev?.apiKeyCiphertext ?? '';
  let apiKeyLast4 = prev?.apiKeyLast4 ?? '';
  if (body.apiKey !== undefined && body.apiKey !== '') {
    apiKeyCiphertext = encryptSecret(body.apiKey);
    apiKeyLast4 = body.apiKey.slice(-4);
  }

  if (body.byokEnabled && (!baseUrl || !model || !apiKeyCiphertext)) {
    throw Object.assign(new Error('启用自有 Key 需要完整填写 Base URL、API Key 和模型名'), { statusCode: 400 });
  }

  if (body.clearAmapApiKey && body.amapApiKey?.trim()) {
    throw Object.assign(new Error('不能同时保存并清除高德 Key'), { statusCode: 400 });
  }

  let amapApiKeyCiphertext = prev?.amapApiKeyCiphertext ?? '';
  let amapApiKeyLast4 = prev?.amapApiKeyLast4 ?? '';
  let amapKeyRevision = prev?.amapKeyRevision ?? 0;
  const submittedAmapApiKey = body.amapApiKey?.trim() ?? '';
  if (body.clearAmapApiKey) {
    amapApiKeyCiphertext = '';
    amapApiKeyLast4 = '';
    amapKeyRevision += 1;
  } else if (submittedAmapApiKey) {
    amapApiKeyCiphertext = encryptSecret(submittedAmapApiKey);
    amapApiKeyLast4 = submittedAmapApiKey.slice(-4);
    amapKeyRevision += 1;
  }

  const submittedSearchApiKey = body.searchApiKey?.trim() ?? '';
  const submittedSearchBaseUrl = body.searchApiBaseUrl?.trim();
  if (body.clearSearchConfig && (submittedSearchApiKey || submittedSearchBaseUrl)) {
    throw Object.assign(new Error('不能同时保存并清除个人搜索配置'), { statusCode: 400 });
  }

  let searchApiKeyCiphertext = prev?.searchApiKeyCiphertext ?? '';
  let searchApiKeyLast4 = prev?.searchApiKeyLast4 ?? '';
  let searchApiBaseUrl = prev?.searchApiBaseUrl ?? '';
  let searchCredentialRevision = prev?.searchCredentialRevision ?? 0;

  if (body.clearSearchConfig) {
    searchApiKeyCiphertext = '';
    searchApiKeyLast4 = '';
    searchApiBaseUrl = '';
    searchCredentialRevision += 1;
  } else if (submittedSearchApiKey) {
    const nextSearchBaseUrl = submittedSearchBaseUrl || searchApiBaseUrl || DEFAULT_SEARCH_API_BASE_URL;
    await assertSafeBaseUrl(nextSearchBaseUrl);
    searchApiKeyCiphertext = encryptSecret(submittedSearchApiKey);
    searchApiKeyLast4 = submittedSearchApiKey.slice(-4);
    searchApiBaseUrl = nextSearchBaseUrl.replace(/\/+$/, '');
    searchCredentialRevision += 1;
  } else if (body.searchApiBaseUrl !== undefined) {
    if (!searchApiKeyCiphertext && submittedSearchBaseUrl) {
      throw Object.assign(new Error('设置个人搜索 Base URL 需要同时提供 API Key'), { statusCode: 400 });
    }
    if (searchApiKeyCiphertext && !submittedSearchBaseUrl) {
      throw Object.assign(new Error('个人搜索 Base URL 不能为空；如需删除请显式清除个人搜索配置'), { statusCode: 400 });
    }
    if (searchApiKeyCiphertext && submittedSearchBaseUrl && submittedSearchBaseUrl !== searchApiBaseUrl) {
      await assertSafeBaseUrl(submittedSearchBaseUrl);
      searchApiBaseUrl = submittedSearchBaseUrl.replace(/\/+$/, '');
      searchCredentialRevision += 1;
    }
  }

  const now = new Date();
  const values = {
    userId,
    byokEnabled: Boolean(body.byokEnabled),
    baseUrl,
    apiKeyCiphertext,
    apiKeyLast4,
    model,
    amapApiKeyCiphertext,
    amapApiKeyLast4,
    amapKeyRevision,
    searchApiKeyCiphertext,
    searchApiKeyLast4,
    searchApiBaseUrl,
    searchCredentialRevision,
    updatedAt: now,
  };
  await db.insert(userSettings)
    .values(values)
    .onConflictDoUpdate({ target: userSettings.userId, set: values });
  return getSettingsView(userId);
}

/** Key 双轨解析：用户 BYOK → 站点 Key → null（调用方负责给出 PRD F1 的对应文案） */
export async function resolveLlmConfig(userId: string): Promise<LlmConfig | null> {
  const row = await getRow(userId);
  if (row?.byokEnabled && row.baseUrl && row.model && row.apiKeyCiphertext) {
    try {
      return { baseUrl: row.baseUrl, apiKey: decryptSecret(row.apiKeyCiphertext), model: row.model, byok: true };
    } catch {
      // 密文解不开（典型：换过 MASTER_KEY、或从别的环境导过库）不能把整次生成打成 500；
      // 按「未配置 BYOK」继续走站点 Key，两者都没有时调用方会给出「没有可用的 AI 配置」文案。
      console.warn(`[settings] 用户 ${userId} 的 LLM Key 密文无法解密，已按未配置个人 Key 处理`);
    }
  }
  if (hasSiteLlm()) {
    return { baseUrl: env.siteLlm.baseUrl, apiKey: env.siteLlm.apiKey, model: env.siteLlm.model, byok: false };
  }
  return null;
}

/** 高德 Key 双轨解析：当前用户个人 Key → 站点 AMAP_KEY → null。 */
export async function resolveAmapCredential(userId: string): Promise<AmapCredential | null> {
  const row = await getRow(userId);
  if (row?.amapApiKeyCiphertext) {
    try {
      return {
        apiKey: decryptSecret(row.amapApiKeyCiphertext),
        origin: 'personal',
        revision: `personal:${row.amapKeyRevision}`,
      };
    } catch {
      // 密文损坏不应阻断生成；按未配置个人 Key 继续走站点回退或 Null 源。
    }
  }
  if (env.amapKey) {
    return { apiKey: env.amapKey, origin: 'site', revision: 'site' };
  }
  return null;
}

/** Web 搜索配置双轨解析：当前用户个人配置 → 站点 SEARCH_API_* → null。 */
export async function resolveSearchCredential(userId: string): Promise<SearchCredential | null> {
  const row = await getRow(userId);
  if (row?.searchApiKeyCiphertext && row.searchApiBaseUrl) {
    try {
      return {
        baseUrl: row.searchApiBaseUrl,
        apiKey: decryptSecret(row.searchApiKeyCiphertext),
        origin: 'personal',
        revision: `personal:${row.searchCredentialRevision}`,
      };
    } catch {
      // 密文损坏按未配置个人搜索凭据处理，继续走站点回退或 Null 源。
    }
  }
  if (env.searchApiKey) {
    return {
      baseUrl: env.searchApiBaseUrl,
      apiKey: env.searchApiKey,
      origin: 'site',
      revision: 'site',
    };
  }
  return null;
}
