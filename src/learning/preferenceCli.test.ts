import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPreferenceCli } from './preferenceCli';
import { PreferenceWorkspaceStore } from './preferenceWorkspaceStore';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'preference-cli-'));
  directories.push(directory);
  const store = new PreferenceWorkspaceStore(directory);
  const base = { operationId: 'profile', at: '2026-09-07T00:00:00Z', actor: { kind: 'human', id: 'software-test-actor' } };
  store.execute({ ...base, kind: 'profile', profileId: 'golf', name: '試験用' });
  // All labels are invented for this software test. Evaluation examples remain synthetic.
  for (let i = 0; i <= 10; i++) {
    const negative = i > 5;
    store.execute({ ...base, operationId: `op-${i}`, kind: 'decision', event: {
      schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id: `d-${i}`, operationId: `op-${i}`,
      createdAt: base.at, actor: base.actor, projectId: i === 0 ? 'training' : negative ? 'negative' : 'positive',
      projectRevision: 'r1', elementId: String(i), sourceFrameRange: { start: i * 30, end: (i + 1) * 30 },
      before: negative ? 'このまま' : '素振りする', proposedAfter: '素振りをする', actualAfter: negative ? null : '素振りをする',
      decision: negative ? 'rejected' : 'accepted', reasonCode: 'wording', note: '', scope: { kind: 'profile', id: 'golf' },
      learningConsent: true, provenance: { kind: i === 0 ? 'human' : 'synthetic' },
    } });
  }
  store.execute({ ...base, operationId: 'candidate', kind: 'candidate', ruleId: 'rule', version: 1, evidenceIds: ['d-0'] });
  store.execute({ ...base, operationId: 'dataset', kind: 'dataset', datasetId: 'set', datasetVersion: 1,
    caseIds: Array.from({ length: 10 }, (_, i) => `d-${i + 1}`) });
  return { store, selection: ['--store', directory, '--rule', 'rule', '--rule-version', '1', '--dataset', 'set', '--dataset-version', '1'] };
}

describe('読み取り専用のモデル評価CLI', () => {
  it('入力を書き出して保存済み出力を再評価し、元記録を一切変えない', async () => {
    const { store, selection } = fixture();
    const original = readFileSync(store.file, 'utf8');
    const inputResult = await runPreferenceCli(['preferences-input', ...selection]);
    expect(inputResult.code).toBe(0);
    const input = JSON.parse(inputResult.message);
    expect(input.cases).toHaveLength(10);
    expect(inputResult.message).not.toContain('actualAfter');
    const outputFile = path.join(store.directory, 'predictions.json');
    writeFileSync(outputFile, JSON.stringify({ schemaVersion: 1, predictions: input.cases.map((c: { caseId: string; text: string }) => ({
      caseId: c.caseId, after: c.text === '素振りする' ? '素振りをする' : null,
    })) }));
    const result = await runPreferenceCli(['preferences-replay', ...selection, '--predictions', outputFile, '--provider', 'fixture', '--model', 'model-a']);
    const report = JSON.parse(result.message);
    expect(report.aggregate.passed).toBe(10);
    expect(report.mode).toBe('replay');
    expect(report.humanCalibrationStatus).toBe('not_calibrated');
    expect(result.code).toBe(1); // Synthetic success is not human-calibrated success.
    expect(readFileSync(store.file, 'utf8')).toBe(original);
  });
  it('同意撤回後は入力の書出しも止める', async () => {
    const { store, selection } = fixture();
    const actor = { kind: 'human', id: 'software-test-actor' };
    const at = '2026-09-07T00:10:00Z';
    store.execute({ kind: 'decision', operationId: 'withdraw', at, actor, event: {
      schemaVersion: 1, type: 'withdrawal', id: 'withdraw', operationId: 'withdraw', createdAt: at,
      actor, targetId: 'd-1', reason: '試験',
    } });
    const result = await runPreferenceCli(['preferences-input', ...selection]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.message).error).toMatch(/同意/);
  });
  it('未知引数・二重指定・版の取り違え・破損を成功扱いしない', async () => {
    const { store, selection } = fixture();
    for (const args of [
      ['preferences-list'], ['preferences-list', '--store', store.directory, '--execute', 'anything'],
      ['preferences-input', ...selection, '--rule', 'another'],
      ['preferences-input', ...selection.map((s) => s === '1' ? '1.5' : s)],
      ['preferences-input', ...selection.map((s) => s === 'rule' ? 'missing' : s)],
    ]) expect((await runPreferenceCli(args)).code).toBe(1);
    writeFileSync(store.file, '{broken');
    const result = await runPreferenceCli(['preferences-list', '--store', store.directory]);
    expect(result.code).toBe(1);
    expect(readFileSync(store.file, 'utf8')).toBe('{broken');
  });
});
