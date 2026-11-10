// 子 Agent transcript 归一化：只保留工具调用/状态/耗时，不输出参数、正文或内部上下文。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryRecord } from '@earendil-works/pi-durable';
import { normalizeAgentTranscript } from '@tripweaver/agent/generation/agentTranscript';

function entries(): EntryRecord[] {
  return [
    {
      id: 'e1', conversationId: 'c1', kind: 'assistant', model: [{
        role: 'assistant', content: [
          { type: 'toolCall', id: 't1', name: 'list_areas', arguments: { secret: 'args' } },
          { type: 'text', text: 'internal assistant prose' },
        ],
      }],
    },
    {
      id: 'e2', conversationId: 'c1', kind: 'toolResult', model: [{
        role: 'toolResult', toolCallId: 't1', toolName: 'list_areas',
        content: [{ type: 'text', text: 'tool output body' }], isError: false, timestamp: 1, durationMs: 12,
      }],
    },
    {
      id: 'e3', conversationId: 'c1', kind: 'assistant', model: [{
        role: 'assistant', content: [{ type: 'toolCall', id: 't2', name: 'search_area_places', arguments: {} }],
      }],
    },
  ] as unknown as EntryRecord[];
}

test('工具调用按顺序输出，结果补状态与耗时，运行中在终态收口', () => {
  const steps = normalizeAgentTranscript(entries(), true);
  assert.deepEqual(steps, [
    { id: 't1', label: 'list_areas', status: 'done', durationMs: 12 },
    { id: 't2', label: 'search_area_places', status: 'done' },
  ]);
});

test('不输出参数、工具结果正文或 assistant 正文', () => {
  const serialized = JSON.stringify(normalizeAgentTranscript(entries(), true));
  assert.ok(!serialized.includes('secret'));
  assert.ok(!serialized.includes('tool output body'));
  assert.ok(!serialized.includes('internal assistant prose'));
});

test('工具结果错误保留 error 状态', () => {
  const fixture = entries();
  (fixture[1]!.model![0] as { isError: boolean }).isError = true;
  assert.equal(normalizeAgentTranscript(fixture, true)[0]!.status, 'error');
});
