// durable 存储路径：详情对话、子代理与生成任务共用同一份（pi-durable 要求单进程独占一份存储）。
// 隔离靠会话显式选择自己的工具扩展，而不是按用途拆文件 —— 一个用户一个 Harness。
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

export async function ensureAgentStorageDir(): Promise<void> {
  await mkdir(AGENT_RUNS_DIR, { recursive: true });
}