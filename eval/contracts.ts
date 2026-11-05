import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { GenerateFormSchema, ResearchPoiSchema, TripSchema } from '@tripweaver/shared';

const Counter = Type.Number({ minimum: 0 });
export const TimingSchema = Type.Object({
  phases: Type.Record(Type.String(), Counter),
  totalMs: Type.Optional(Counter), tokensIn: Type.Optional(Counter), tokensOut: Type.Optional(Counter),
  providerCalls: Type.Optional(Type.Record(Type.String(), Counter)),
});
export const ExecutionSchema = Type.Object({
  tasks: Type.Record(Type.String(), Type.Object({ ok: Counter, errors: Counter })),
  planLlmCalls: Counter,
  terminal: Type.String(),
  tripReadBack: Type.Boolean(), auditCommitted: Type.Boolean(), overviewMatches: Type.Boolean(),
});
export type Execution = Static<typeof ExecutionSchema>;
export const FlowCheckSchema = Type.Object({
  id: Type.String(), label: Type.String(),
  status: Type.Union(['PASS', 'FAIL', 'DEGRADED', 'UNAVAILABLE', 'NOT_APPLICABLE'].map((s) => Type.Literal(s))),
  detail: Type.String(),
});
export type FlowCheck = Static<typeof FlowCheckSchema>;
export const SnapshotSchema = Type.Object({
  schemaVersion: Type.Optional(Type.Literal(3)),
  caseId: Type.String(), generatedAt: Counter, model: Type.String(),
  form: GenerateFormSchema, trip: TripSchema,
  research: Type.Optional(Type.Object({ candidates: Type.Array(ResearchPoiSchema) })),
  timing: Type.Optional(TimingSchema),
  execution: Type.Optional(ExecutionSchema),
});
export type Snapshot = Static<typeof SnapshotSchema>;
export const RunCaseSchema = Type.Object({
  caseId: Type.String(), inputHash: Type.String(),
  status: Type.Union([Type.Literal('PASS'), Type.Literal('FAIL'), Type.Literal('ERROR'), Type.Literal('SKIPPED')]),
  problems: Type.Array(Type.String()), unavailable: Type.Array(Type.String()),
  limitations: Type.Optional(Type.Array(Type.String())),
  flow: Type.Optional(Type.Array(FlowCheckSchema)),
  metrics: Type.Record(Type.String(), Type.Union([Type.Number(), Type.Null()])),
  snapshotHash: Type.Union([Type.String(), Type.Null()]),
  source: Type.Union([Type.Object({ generatedAt: Counter, model: Type.String() }), Type.Null()]),
});
export type RunCase = Static<typeof RunCaseSchema>;
export const ManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1), snapshotVersion: Type.Literal(3),
  runId: Type.String(), startedAt: Type.String(),
  mode: Type.Union([Type.Literal('offline'), Type.Literal('live')]),
  suite: Type.Union([Type.Literal('smoke'), Type.Literal('full'), Type.Literal('matrix'), Type.Literal('notes')]),
  caseIds: Type.Array(Type.String()), datasetHash: Type.String(), checksHash: Type.String(),
  promptHash: Type.String(), runtimeHash: Type.String(),
  code: Type.Object({ head: Type.Union([Type.String(), Type.Null()]), dirty: Type.Union([Type.Boolean(), Type.Null()]) }),
  knowledge: Type.Object({ mode: Type.String(), hash: Type.String(), rows: Type.Number(),
    snapshotName: Type.Optional(Type.String()), snapshotHash: Type.Optional(Type.String()), exportedAt: Type.Optional(Type.String()),
    cities: Type.Optional(Type.Array(Type.String())), evidenceRows: Type.Optional(Counter), relationRows: Type.Optional(Counter),
    vectorMode: Type.Optional(Type.String()), placeVectors: Type.Optional(Counter), evidenceVectors: Type.Optional(Counter),
  }),
  configuration: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
});
export type Manifest = Static<typeof ManifestSchema>;
export const ReportSchema = Type.Object({
  schemaVersion: Type.Literal(1), manifest: ManifestSchema, finishedAt: Type.String(),
  gate: Type.Object({ pass: Type.Boolean(), totalHard: Counter, totalSoft: Counter,
    counts: Type.Record(Type.String(), Counter) }),
  errors: Type.Array(Type.String()), cases: Type.Array(RunCaseSchema),
});
export type Report = Static<typeof ReportSchema>;

export function parseSnapshot(value: unknown): Snapshot {
  if (!Value.Check(SnapshotSchema, value)) {
    const first = Value.Errors(SnapshotSchema, value).First();
    // 只输出路径和规则，不回显潜在含敏感数据的原始值。
    throw new Error(`快照格式错误：${first?.path ?? '/'} ${first?.message ?? ''}`);
  }
  return value;
}
export function parseReport(value: unknown): Report {
  if (!Value.Check(ReportSchema, value)) throw new Error('报告格式不兼容：需要新版 eval report.json');
  const ids = value.cases.map((c) => c.caseId);
  if (new Set(ids).size !== ids.length || ids.length !== value.manifest.caseIds.length ||
    value.manifest.caseIds.some((id) => !ids.includes(id))) throw new Error('报告用例集合不完整或重复');
  return value;
}
