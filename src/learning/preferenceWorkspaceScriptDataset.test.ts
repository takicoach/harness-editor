import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';
import { editorOperationSchema } from '../shared/editorOperations';
import { preferenceHash } from './preferenceEvaluation';
import { PreferenceWorkspaceStore } from './preferenceWorkspaceStore';
import { freezeScriptDataset } from './scriptEvaluation';

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });
function store() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'script-dataset-store-'));
  directories.push(directory);
  return new PreferenceWorkspaceStore(directory);
}

describe('script datasets in the preference journal', () => {
  it('replays and imports reference-only datasets while later withdrawal remains readable', () => {
    const source = store();
    const event = { ...scriptJudgmentFixture(), learningConsent: true };
    source.execute({ kind: 'decision', operationId: event.operationId, at: event.createdAt, actor: event.actor, event });
    const operation = editorOperationSchema.parse({
      schemaVersion: 1, runId: 'run', serverInstance: 'server', createdAt: 1, updatedAt: 2,
      request: { schemaVersion: 1, projectId: event.projectId, operationId: `script:${event.id}`, baseRevision: 'rebound',
        script: { judgmentId: event.id, artifact: event.artifact }, changes: [] },
      phase: 'saved', cancelRequested: false, confirmed: { applied: true, saved: true },
      claim: { sessionId: 'rebound-browser', token: 'token' },
      result: { phase: 'saved', revision: 'saved', code: null, applied: true, saved: true },
      lateResult: null, humanReview: 'pending',
    });
    const dataset = freezeScriptDataset(source.read().decisions, [operation], {
      id: 'dataset', version: 1, frozenAt: '2026-09-08T04:00:00Z', caseIds: [event.id],
    }, { includeSynthetic: true });
    source.execute({ kind: 'script_dataset', operationId: 'store-dataset', at: '2026-09-08T04:00:00Z',
      actor: event.actor, dataset });
    source.execute({ kind: 'decision', operationId: 'withdraw', at: '2026-09-08T05:00:00Z', actor: event.actor,
      event: { schemaVersion: 1, type: 'withdrawal', id: 'withdraw', operationId: 'withdraw',
        createdAt: '2026-09-08T05:00:00Z', actor: event.actor, targetId: event.id, reason: '撤回' } });

    expect(new PreferenceWorkspaceStore(source.directory).read().scriptDatasets).toEqual([dataset]);
    const target = store();
    target.import(JSON.parse(source.export()));
    expect(target.read().scriptDatasets).toEqual([dataset]);
    expect(JSON.stringify(dataset)).not.toContain('artifact');
  });

  it('returns an empty array for old journals and rejects forged ledger references and skipped versions', () => {
    const empty = store();
    expect(empty.read().scriptDatasets).toEqual([]);

    const source = store();
    const event = { ...scriptJudgmentFixture(), decision: 'rejected' as const, learningConsent: true, application: undefined };
    source.execute({ kind: 'decision', operationId: event.operationId, at: event.createdAt, actor: event.actor, event });
    const dataset = freezeScriptDataset(source.read().decisions, [], {
      id: 'dataset', version: 1, frozenAt: '2026-09-08T04:00:00Z', caseIds: [event.id],
    }, { includeSynthetic: true });
    const forgedBody = { ...dataset, cases: dataset.cases.map(item => ({ ...item, judgmentHash: 'f'.repeat(64) })) };
    const { hash: _oldHash, ...body } = forgedBody;
    const forged = { ...body, hash: preferenceHash(body) };
    expect(() => source.execute({ kind: 'script_dataset', operationId: 'forged', at: '2026-09-08T04:00:00Z',
      actor: event.actor, dataset: forged })).toThrow(/CASE_REFERENCE_MISMATCH/);
    expect(() => source.execute({ kind: 'script_dataset', operationId: 'skip', at: '2026-09-08T04:00:00Z',
      actor: event.actor, dataset: { ...dataset, version: 2 } })).toThrow();
  });
});
