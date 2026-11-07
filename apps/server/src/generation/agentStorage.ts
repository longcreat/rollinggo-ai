// durable 存储路径：详情对话与生成任务共用一份（pi-durable 要求单进程独占一份存储）。
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRoot } from '../lib/dataStore';

const AGENT_RUNS_DIR = join(dataRoot, 'agent-runs');

function safeId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 单用户对话存储：文件名只保留安全字符，避免路径注入。 */
export function agentStoragePath(userId: string): string {
  return join(AGENT_RUNS_DIR, `${safeId(userId)}.sqlite`);
}

/**
 * 生成任务独立存储：生成阶段的工具是每阶段闭包，而 pi-durable 按名字从共享 registry 解析工具，
 * 与对话工具同名（search_area_places / web_search）会互相覆盖。分文件后两套 registry 互不干扰。
 */
export function generationStoragePath(userId: string): string {
  return join(AGENT_RUNS_DIR, `${safeId(userId)}.generation.sqlite`);
}

export async function ensureAgentStorageDir(): Promise<void> {
  await mkdir(AGENT_RUNS_DIR, { recursive: true });
}