import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ruleAvailability } from './preferenceRules';
import { PreferenceWorkspaceStore } from './preferenceWorkspaceStore';

const directories: string[] = [];
function store() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'preference-workspace-'));
  directories.push(dir); return new PreferenceWorkspaceStore(dir);
}
const base = { operationId: 'op1', at: '2026-09-07T00:00:00Z', actor: { kind: 'human', id: 'test-human' } };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function seedActivatedRule(s: PreferenceWorkspaceStore): void {
  s.execute({ ...base, kind: 'profile', profileId: 'golf', name: 'ゴルフ解説' });
  for (let index = 0; index <= 10; index += 1) {
    const negative = index > 5;
    const operationId = `decision-${index}`;
    s.execute({ ...base, operationId, kind: 'decision', event: {
      schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id: `d${index}`, operationId,
      createdAt: base.at, actor: base.actor,
      projectId: index === 0 ? 'training' : negative ? 'heldout-negative' : 'heldout-positive',
      projectRevision: 'r1', elementId: `${index}`, sourceFrameRange: { start: index * 30, end: (index + 1) * 30 },
      before: negative ? 'そのままでよい' : '素振りする', proposedAfter: '素振りをする',
      actualAfter: negative ? null : '素振りをする', decision: negative ? 'rejected' : 'accepted',
      scope: { kind: 'profile', id: 'golf' }, reasonCode: 'wording', note: '',
      learningConsent: true, provenance: { kind: 'human' },
    } });
  }
  s.execute({ ...base, operationId: 'candidate', kind: 'candidate', ruleId: 'rule1', version: 1, evidenceIds: ['d0'] });
  s.execute({ ...base, operationId: 'dataset', kind: 'dataset', datasetId: 'set1', datasetVersion: 1,
    caseIds: Array.from({ length: 10 }, (_, index) => `d${index + 1}`) });
  s.execute({ ...base, operationId: 'activation', kind: 'activate', ruleId: 'rule1', version: 1,
    datasetId: 'set1', datasetVersion: 1 });
}

describe('好みの一巡を保持する単一トランザクション', () => {
  it('方針と案件の割当を再起動後も保持し、再送は一度だけ処理する', () => {
    const s = store();
    s.execute({ ...base, kind: 'profile', profileId: 'golf', name: 'ゴルフ解説' });
    const assignment = { ...base, operationId: 'op2', kind: 'assign', projectId: 'video-b', profileId: 'golf' };
    s.execute(assignment); s.execute(assignment);
    const reopened = new PreferenceWorkspaceStore(s.directory);
    expect(reopened.read().projectProfiles['video-b']).toBe('golf');
    expect(reopened.read().operations).toHaveLength(2);
    expect(() => s.execute({ ...assignment, profileId: null })).toThrow(/OPERATION_CONFLICT/);
  });
  it('判断記録・候補・評価なしの有効化拒否を同じ永続状態へ反映する', () => {
    const s = store();
    s.execute({ ...base, kind: 'profile', profileId: 'golf', name: 'ゴルフ解説' });
    s.execute({ ...base, operationId: 'op2', kind: 'decision', event: {
      schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id: 'd1', operationId: 'op2', createdAt: base.at, actor: base.actor,
      projectId: 'train', projectRevision: 'r1', elementId: '1', sourceFrameRange: { start: 0, end: 30 },
      before: '素振りする', proposedAfter: '素振りをする', actualAfter: '素振りをする', decision: 'accepted',
      scope: { kind: 'profile', id: 'golf' }, reasonCode: 'wording', note: '', learningConsent: true, provenance: { kind: 'human' },
    } });
    s.execute({ ...base, operationId: 'op3', kind: 'candidate', ruleId: 'rule1', version: 1, evidenceIds: ['d1'] });
    const saved = readFileSync(s.file, 'utf8');
    expect(() => s.execute({ ...base, operationId: 'op4', kind: 'activate', ruleId: 'rule1', version: 1, datasetId: 'missing', datasetVersion: 1 })).toThrow(/DATASET_NOT_FOUND/);
    expect(readFileSync(s.file, 'utf8')).toBe(saved);
    expect(s.read().rules[0]?.status).toBe('candidate');
  });
  it('未知版と破損は拒否し、状態不変でexport/importできる', () => {
    const a = store(); a.execute({ ...base, kind: 'profile', profileId: 'golf', name: 'ゴルフ解説' });
    const b = store(); b.import(JSON.parse(a.export()));
    expect(b.export()).toBe(a.export());
    const saved = b.export();
    expect(() => b.import({ schemaVersion: 2, commands: [] })).toThrow();
    expect(b.export()).toBe(saved);
    writeFileSync(b.file, '{broken');
    expect(() => b.execute({ ...base, operationId: 'op3', kind: 'profile', profileId: 'golf', name: '変更' })).toThrow();
    expect(readFileSync(b.file, 'utf8')).toBe('{broken');
  });
  it('評価ケース撤回の実効停止を再起動・export/import後も再現し、無効ラベルを再利用しない', () => {
    const source = store(); seedActivatedRule(source);
    expect(ruleAvailability(source.read().rules[0]!, source.read().decisions)).toBe('available');
    source.execute({ ...base, operationId: 'withdraw-d1', kind: 'decision', event: {
      schemaVersion: 1, type: 'withdrawal', id: 'withdraw-d1', operationId: 'withdraw-d1', createdAt: base.at,
      actor: base.actor, targetId: 'd1', reason: '評価例への同意を撤回',
    } });
    const after = source.read();
    expect(after.rules[0]?.status).toBe('active');
    expect(ruleAvailability(after.rules[0]!, after.decisions)).toBe('evaluation_invalidated');
    expect(after.evaluations).toHaveLength(1);

    const reopened = new PreferenceWorkspaceStore(source.directory);
    expect(ruleAvailability(reopened.read().rules[0]!, reopened.read().decisions)).toBe('evaluation_invalidated');
    const restored = store(); restored.import(JSON.parse(source.export()));
    expect(ruleAvailability(restored.read().rules[0]!, restored.read().decisions)).toBe('evaluation_invalidated');

    const reevaluated = source.execute({ ...base, operationId: 'reevaluate', kind: 'evaluate', ruleId: 'rule1', version: 1,
      datasetId: 'set1', datasetVersion: 1 });
    expect(reevaluated.evaluations.at(-1)?.failures).toContain('CASE_INVALIDATED');
    const saved = source.export();
    expect(() => source.execute({ ...base, operationId: 'reactivate', kind: 'activate', ruleId: 'rule1', version: 1,
      datasetId: 'set1', datasetVersion: 1 })).toThrow(/CASE_INVALIDATED/);
    expect(source.export()).toBe(saved);
  });
  it('未登録の方針・未知操作・モデルによる有効化を拒否する', () => {
    const s = store();
    expect(() => s.execute({ ...base, kind: 'assign', projectId: 'video', profileId: 'missing' })).toThrow(/PROFILE_NOT_FOUND/);
    expect(() => s.execute({ ...base, kind: 'run_shell', command: 'whatever' })).toThrow();
    expect(() => s.execute({ ...base, kind: 'profile', profileId: 'golf', name: 'ゴルフ', actor: { kind: 'model', id: 'agent' } })).toThrow(/HUMAN_REQUIRED/);
  });
});
