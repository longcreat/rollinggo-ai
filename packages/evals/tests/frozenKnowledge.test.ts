import assert from 'node:assert/strict';
import { currentFixture } from './currentFixture';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { EVAL_DIR, createManifest, createRunDirectory, hash, readReport, writeJson } from '../artifacts';
import { acceptBaseline } from '../baseline';
import { parseSnapshot } from '../contracts';
import { GOLDEN_CASES } from '../golden/cases';
import { loadKnowledge } from '../knowledge';
import { readFrozen, saveFrozen, summarizeFrozen, validateFrozen, type FrozenData, type FrozenKnowledge } from '../frozenKnowledge';
import { buildReport, evaluateCase, saveReport } from '../runner';

function temporary(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollinggo-trip-frozen-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^rollinggo-trip-frozen-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function fixture(): FrozenKnowledge {
  const data: FrozenData = { version: 1, cities: ['北京'],
    vectors: { included: true, configuredModel: 'test-model', placeDimensions: 3, evidenceDimensions: 3 },
    places: [{ id: 'place-a', city: '北京', name: '故宫', category: '文化', lat: 39.91, lng: 116.4,
      source: 'xhs', verified: true, createdAt: '2026-01-01T00:00:00.000Z', embedding: '[1,0,0]',
      payload: { aliases: ['紫禁城'], recommendScore: 91, typicalVisitMinutes: 240, reservation: 'required',
        content: { version: 1, intro: '明清宫殿。' } } }],
    evidence: [{ id: 'evidence-a', placeId: 'place-a', city: '北京', kind: 'official', strength: 'direct',
      content: '周一闭馆', sourceUrl: 'https://example.test/palace', fetchedAt: '2026-01-01T00:00:00.000Z', embedding: '[0,1,0]' }],
    relations: [{ id: 'relation-a', city: '北京', fromName: '故宫', toName: '景山', strength: 'direct', noteCount: 5, createdAt: '2026-01-01T00:00:00.000Z' }],
  };
  return { format: 'rollinggo-trip-knowledge', version: 1, name: 'frozen-test', exportedAt: '2026-10-04T00:00:00.000Z', sourceId: 'source-fingerprint', contentHash: hash(data), data };
}

test('冻结副本压缩往返保留 ID、证据、关系与向量，同名拒绝覆盖', (t) => {
  const root = temporary(t), source = fixture();
  const directory = saveFrozen(source, root);
  assert.deepEqual(readFrozen(directory), source);
  const summary = summarizeFrozen(source);
  assert.deepEqual(summary.counts, { places: 1, evidence: 1, relations: 1, placeVectors: 1, evidenceVectors: 1 });
  assert.deepEqual(summary.coverage[0]!.sources, { xhs: 1 });
  assert.throws(() => saveFrozen(source, root), /EEXIST/);
  assert.throws(() => saveFrozen({ ...source, name: '../escape' }, root), /名称/);
});

test('加载冻结副本需覆盖用例城市，显式去向量产生不同评估 hash', (t) => {
  const directory = saveFrozen(fixture(), temporary(t));
  const full = loadKnowledge('frozen', { snapshot: directory, cities: ['北京'] });
  const reduced = loadKnowledge('frozen', { snapshot: directory, skipVectors: true });
  assert.ok(full.kind === 'frozen' && reduced.kind === 'frozen');
  assert.equal(full.manifest.evidenceRows, 1);
  assert.equal(full.manifest.placeVectors, 1);
  assert.equal(reduced.manifest.placeVectors, 0);
  assert.equal(reduced.manifest.vectorMode, 'omitted');
  assert.notEqual(full.manifest.hash, reduced.manifest.hash);
  assert.equal(readFrozen(directory).data.places[0]!.embedding, '[1,0,0]');
  assert.throws(() => loadKnowledge('frozen', { snapshot: directory, cities: ['上海'] }), /未覆盖/);
  assert.throws(() => loadKnowledge('frozen'), /需要/);
  assert.throws(() => loadKnowledge('golden', { snapshot: directory }), /只能/);
});

test('副本篡改、私有字段、孤立证据与重复 ID 均拒绝', () => {
  const tampered = fixture();
  tampered.data.places[0]!.name = '被修改';
  assert.throws(() => validateFrozen(tampered), /hash/);
  const privateField = fixture();
  privateField.data.places[0]!.payload!.userToken = 'private';
  assert.throws(() => validateFrozen(privateField), /不允许/);
  const dangling = fixture();
  dangling.data.evidence[0]!.placeId = 'missing';
  assert.throws(() => validateFrozen(dangling), /关联/);
  const duplicate = fixture();
  duplicate.data.places.push(duplicate.data.places[0]!);
  assert.throws(() => validateFrozen(duplicate), /重复/);
});

test('向量声明和维度必须一致，旧/损坏文件不能悄悄降级', (t) => {
  const wrongDimensions = fixture();
  wrongDimensions.data.places[0]!.embedding = '[1,0]';
  assert.throws(() => validateFrozen(wrongDimensions), /维度/);
  const withoutVectors = fixture();
  withoutVectors.data.vectors.included = false;
  assert.throws(() => validateFrozen(withoutVectors), /声明/);
  const invalidTime = fixture();
  invalidTime.data.places[0]!.createdAt = 'invalid';
  assert.throws(() => validateFrozen(invalidTime), /时间戳/);
  const directory = saveFrozen(fixture(), temporary(t));
  fs.writeFileSync(path.join(directory, 'knowledge.json.gz'), 'broken');
  assert.throws(() => readFrozen(directory));
});

test('冻结基线必须携带匹配副本，完整与去向量运行都能独立保存', (t) => {
  const root = temporary(t);
  const gc = GOLDEN_CASES.find((item) => item.form.destination === '北京')!;
  const frozen = fixture();
  const source = saveFrozen(frozen, root);
  const snapshot = currentFixture(gc);
  snapshot.research = { candidates: [{ id: 'place-a', name: '故宫', category: 'attraction', intro: '测试', reservation: 'unknown', sourceLinks: [] }] };
  snapshot.timing = { phases: { 'research#1': 1, 'plan#1': 2, 'review#1': 3 }, totalMs: 4,
    tokensIn: 100, tokensOut: 20, providerCalls: { amap: 0, search: 0, xhs: 0 } };
  for (const skipVectors of [false, true]) {
    const manifest = createManifest([gc], 'live', 'full');
    manifest.knowledge = loadKnowledge('frozen', { snapshot: source, skipVectors }).manifest;
    const run = createRunDirectory(manifest, path.join(root, 'runs'));
    const report = buildReport(manifest, [evaluateCase(gc, snapshot, true).outcome], []);
    writeJson(path.join(run, 'snapshots', `${gc.id}.json`), snapshot);
    saveReport(run, report);
    const baselines = path.join(root, 'baselines');
    assert.throws(() => acceptBaseline(run, 'missing', baselines), /ENOENT/);
    saveFrozen({ ...frozen, name: 'knowledge' }, run);
    const expectedHash = report.manifest.knowledge.hash;
    report.manifest.knowledge.hash = 'wrong-effective-hash';
    saveReport(run, report);
    assert.throws(() => acceptBaseline(run, 'mismatch', baselines), /不一致/);
    assert.ok(!fs.existsSync(path.join(baselines, 'mismatch')));
    report.manifest.knowledge.hash = expectedHash;
    saveReport(run, report);
    const accepted = acceptBaseline(run, skipVectors ? 'omitted' : 'preserved', baselines);
    assert.equal(readFrozen(path.join(accepted, 'knowledge')).contentHash, frozen.contentHash);
    assert.equal(readReport(accepted).manifest.knowledge.vectorMode, skipVectors ? 'omitted' : 'preserved');
  }
});
