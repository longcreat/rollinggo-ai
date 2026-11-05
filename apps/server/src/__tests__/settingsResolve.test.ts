// 单测：LLM Key 双轨解析对坏密文的容忍度（自带夹具，不依赖应用库数据）
//
// 背景：换过 MASTER_KEY 或从别的环境导库后，api_key_ciphertext 会解不开。
// 以前这条异常没人接，会一路抛到全局 errorHandler 变成 500「服务器内部错误」，
// 用户侧表现为「明明填过 Key，生成却报服务器错误」。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/client';
import { encryptSecret } from '../crypto/secretBox';
import { resolveLlmConfig } from '../services/settingsService';

after(() => pool.end());

async function fixture(apiKeyCiphertext: string): Promise<string> {
  const userId = randomUUID();
  await pool.query('INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,$3,now())', [
    userId,
    `${userId}@test.dev`,
    '',
  ]);
  await pool.query(
    `INSERT INTO user_settings(user_id, byok_enabled, base_url, api_key_ciphertext, api_key_last4, model, updated_at)
     VALUES($1,true,'https://api.deepseek.com/v1',$2,'1234','deepseek-chat',now())`,
    [userId, apiKeyCiphertext],
  );
  return userId;
}

test('密文损坏时不抛异常，按未配置 BYOK 处理', async () => {
  // 结构合法（三段 base64）但认证标签对不上：模拟旧 MASTER_KEY 加密的历史数据
  const userId = await fixture('AAAAAAAAAAAAAAAAAAAAAA==.AAAAAAAAAAAAAAAAAAAAAA==.AAAAAAAAAAAAAAAAAAAAAA==');
  const cfg = await resolveLlmConfig(userId);
  // 隔离库里没有站点 Key，回退链终点是 null（路由层据此返回 400 no_llm，而不是 500）
  assert.equal(cfg, null);
});

test('密文正常时返回 BYOK 配置，Key 明文还原', async () => {
  const userId = await fixture(encryptSecret('sk-test-abcdef1234'));
  const cfg = await resolveLlmConfig(userId);
  assert.deepEqual(cfg, {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-abcdef1234',
    model: 'deepseek-chat',
    byok: true,
  });
});

test('未开启 BYOK 时忽略密文（即使密文损坏也不解密）', async () => {
  const userId = randomUUID();
  await pool.query('INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,$3,now())', [
    userId,
    `${userId}@test.dev`,
    '',
  ]);
  await pool.query(
    `INSERT INTO user_settings(user_id, byok_enabled, base_url, api_key_ciphertext, model, updated_at)
     VALUES($1,false,'https://api.deepseek.com/v1','broken.not.a.box','deepseek-chat',now())`,
    [userId],
  );
  assert.equal(await resolveLlmConfig(userId), null);
});
