import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreferenceWorkspaceStore } from '../learning/preferenceWorkspaceStore';
import { scriptAdoptionFixture, scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';
import { scriptApplicationRequest } from '../app/edit/scriptAdoption';
import { EditorOperationStore } from './editorOperationStore';
import { handlePreferenceApi } from './preferenceApi';
import { HttpError, sendJson } from './http';
import { runPreferenceCli } from '../learning/preferenceCli';

let directory: string, root: string, store: PreferenceWorkspaceStore, operations: EditorOperationStore;
let server: Server, origin: string;
const originalMode = process.env.HARNESS_PREFERENCE_TEST_FIXTURE;
const base = { operationId: 'freeze', at: '2026-09-08T00:00:00Z', actor: { kind: 'human' as const, id: 'test' } };
beforeEach(async () => {
  process.env.HARNESS_PREFERENCE_TEST_FIXTURE = '1';
  directory = mkdtempSync(join(tmpdir(), 'script-evaluation-api-')); root = join(directory, 'projects');
  mkdirSync(join(root, 'project'), { recursive: true });
  store = new PreferenceWorkspaceStore(join(directory, 'learning'));
  operations = new EditorOperationStore(join(root, '.sme-editor-operations.json'), 'test');
  server = createServer((req, res) => { void handlePreferenceApi(req, res, new URL(req.url!, 'http://localhost'), root, store)
    .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500,
      { error: error instanceof Error ? error.message : String(error) })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
  if (originalMode === undefined) delete process.env.HARNESS_PREFERENCE_TEST_FIXTURE;
  else process.env.HARNESS_PREFERENCE_TEST_FIXTURE = originalMode;
});
const post = (route: string, body: unknown) => fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function seed(kind: 'caption' | 'structure', consent = true, saved = true) {
  const event = { ...scriptJudgmentFixture(), id: kind, operationId: `record-${kind}`, artifact: scriptAdoptionFixture(kind), learningConsent: consent };
  store.execute({ ...base, operationId: event.operationId, at: event.createdAt, actor: event.actor, kind: 'decision', event });
  if (saved) {
    const queued = operations.enqueue(scriptApplicationRequest(event, 'reloaded-revision'));
    const claimed = operations.claim(queued.runId, 'reloaded-browser');
    operations.acknowledge(claimed.runId, claimed.claim!.sessionId, claimed.claim!.token,
      { phase: 'applied', revision: 'after', code: null, applied: true, saved: false });
    operations.acknowledge(claimed.runId, claimed.claim!.sessionId, claimed.claim!.token,
      { phase: 'saved', revision: 'after', code: null, applied: true, saved: true });
  }
  return event;
}
async function freeze(caseIds: string[]) {
  const response = await post('/api/preferences/script-dataset-prepare', { id: 'dataset', version: 1, frozenAt: base.at, caseIds });
  expect(response.status).toBe(200);
  const { dataset } = await response.json();
  const command = { ...base, kind: 'script_dataset', dataset };
  expect((await post('/api/preferences/command', command)).status).toBe(200);
  return command;
}
describe('script evaluation HTTP connection', () => {
  it('freezes both kinds with references, reloads them and compares the same input without editing', async () => {
    seed('caption'); seed('structure');
    const command = await freeze(['caption', 'structure']);
    expect(command.dataset.labelSource).toBe('synthetic');
    expect(command.dataset.cases.every((c: object) => !('artifact' in c))).toBe(true);
    expect(new PreferenceWorkspaceStore(store.directory).read().scriptDatasets).toEqual([command.dataset]);
    const selection = { datasetId: 'dataset', datasetVersion: 1 };
    const preparedResponse = await post('/api/preferences/script-model-input', selection);
    expect(preparedResponse.status).toBe(200);
    const prepared = await preparedResponse.json();
    expect(JSON.stringify(prepared.input)).not.toContain('learningConsent');
    expect(JSON.stringify(prepared.input)).not.toContain('台本の表記を使う');
    const output = { schemaVersion: 1, inputHash: prepared.inputHash,
      generator: { provider: 'fixture', model: 'synthetic', promptVersion: '1', configHash: 'a'.repeat(64) },
      predictions: prepared.input.cases.map((c: { caseId: string; kind: string }) => ({ caseId: c.caseId, plan: c.kind === 'caption'
        ? { kind: 'caption', changes: [{ telopId: 1, after: 'はい' }] }
        : { kind: 'structure', cutOrder: [{ originalStart: 15, originalEnd: 45 }] } })) };
    const alternate = structuredClone(output); alternate.predictions.forEach((p: { plan: unknown }) => { p.plan = null; });
    const beforeJournal = readFileSync(store.file, 'utf8'), beforeOperations = readFileSync(operations.file, 'utf8');
    const result = await post('/api/preferences/script-model-compare', { ...selection, inputHash: prepared.inputHash,
      outputs: [{ label: 'A', output }, { label: 'B', output: alternate }] });
    expect(result.status).toBe(200);
    const comparison = await result.json();
    expect(comparison.reports[0]).toMatchObject({ aggregate: { knownAccepted: 2 }, activationAuthorized: false });
    expect(comparison.reports[1]).toMatchObject({ aggregate: { unjudged: 2 } });
    expect(comparison.humanCalibrationStatus).toBe('not_calibrated');
    const cliArgs = ['--store', store.directory, '--projects-root', root, '--dataset', 'dataset', '--dataset-version', '1'];
    const cliInput = await runPreferenceCli(['preferences-script-input', ...cliArgs]);
    expect(cliInput.code).toBe(0); expect(JSON.parse(cliInput.message).inputHash).toBe(prepared.inputHash);
    const a = join(directory, 'a.json'), b = join(directory, 'b.json');
    writeFileSync(a, JSON.stringify(output)); writeFileSync(b, JSON.stringify(alternate));
    const cliComparison = await runPreferenceCli(['preferences-script-compare', ...cliArgs, '--predictions-a', a, '--predictions-b', b]);
    expect(cliComparison.code).toBe(1); // Synthetic and unjudged results must not become a quality gate pass.
    expect(JSON.parse(cliComparison.message).reports[0].aggregate.knownAccepted).toBe(2);
    expect(readFileSync(store.file, 'utf8')).toBe(beforeJournal); expect(readFileSync(operations.file, 'utf8')).toBe(beforeOperations);
  });
  it('invalidates current use after withdrawal while keeping idempotent freeze recovery and historical import', async () => {
    const event = seed('caption'); const command = await freeze(['caption']);
    store.execute({ ...base, operationId: 'withdraw', kind: 'decision', event: { schemaVersion: 1, type: 'withdrawal',
      id: 'withdraw', operationId: 'withdraw', createdAt: base.at, actor: base.actor, targetId: event.id, reason: 'synthetic withdrawal test' } });
    const before = store.export();
    expect((await post('/api/preferences/command', command)).status).toBe(200);
    expect((await post('/api/preferences/script-model-input', { datasetId: 'dataset', datasetVersion: 1 })).status).toBe(409);
    const state = await (await fetch(origin + '/api/preferences/script-evaluation')).json();
    expect(state.datasets[0].available).toBe(false);
    expect((await post('/api/preferences/import', { confirmedRestore: true, journal: JSON.parse(before) })).status).toBe(200);
    expect(store.export()).toBe(before);
  });
  it('refuses consentless, unsaved and synthetic production use before freezing', async () => {
    seed('caption', false); seed('structure', true, false);
    for (const caseIds of [['caption'], ['structure']]) {
      expect((await post('/api/preferences/script-dataset-prepare', { id: 'dataset', version: 1, frozenAt: base.at, caseIds })).status).toBe(409);
    }
    delete process.env.HARNESS_PREFERENCE_TEST_FIXTURE;
    const state = await (await fetch(origin + '/api/preferences/script-evaluation')).json();
    expect(state.cases.every((c: { available: boolean }) => !c.available)).toBe(true);
  });
});
