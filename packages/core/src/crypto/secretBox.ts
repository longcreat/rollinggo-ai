// LLM API Key 静态加密：AES-256-GCM，主钥来自环境变量 MASTER_KEY
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env';

const ALGO = 'aes-256-gcm';

export function encryptSecret(plain: string): string {
  const key = Buffer.from(env.masterKey, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${enc.toString('base64')}.${tag.toString('base64')}`;
}

export function decryptSecret(box: string): string {
  const [ivB64, encB64, tagB64] = box.split('.');
  if (!ivB64 || !encB64 || !tagB64) throw new Error('密文格式错误');
  const key = Buffer.from(env.masterKey, 'hex');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8');
}
