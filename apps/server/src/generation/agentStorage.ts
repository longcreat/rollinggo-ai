// durable 存储路径：详情对话与生成任务共用一份（pi-durable 要求单进程独占一份存储）。
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRoot } from '../lib/dataStore';

const AGENT_RUNS_DIR = join(dataRoot, 'agent-runs');

/** 单用户存储：文件名只保留安全字符，避免路径注入。 */
export function agentStoragePath(userId: string): string {
  return join(AGENT_RUNS_DIR, `${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.sqlite`);
}

export async function ensureAgentStorageDir(): Promise<void> {
  await mkdir(AGENT_RUNS_DIR, { recursive: true });
}