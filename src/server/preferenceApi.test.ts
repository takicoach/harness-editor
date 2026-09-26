import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreferenceWorkspaceStore } from '../learning/preferenceWorkspaceStore';
import { handlePreferenceApi } from './preferenceApi';
import { HttpError, sendJson } from './http';
import { isAllowedLocalRequest } from './localGuard';
import { scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';

let server: Server; let directory: string; let baseUrl: string; let root: string;
let preferenceStore: PreferenceWorkspaceStore;
const originalFixtureMode = process.env.HARNESS_PREFERENCE_TEST_FIXTURE;
beforeEach(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'preference-api-'));
  root = path.join(directory, 'projects'); mkdirSync(path.join(root, 'video'), { recursive: true });
  writeFileSync(path.join(root, 'video', 'unchanged.txt'), 'untouched');
  preferenceStore = new PreferenceWorkspaceStore(path.join(directory, 'learning'));
  server = createServer((req, res) => {
    if (!isAllowedLocalRequest(req.headers)) { sendJson(res, 403, { error: 'LOCAL_REQUEST_REQUIRED' }); return; }
    void handlePreferenceApi(req, res, new URL(req.url!, 'http://localhost'), root, preferenceStore)
      .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof Error ? error.message : String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  rmSync(directory, { recursive: true, force: true });
  if (originalFixtureMode === undefined) delete process.env.HARNESS_PREFERENCE_TEST_FIXTURE;
  else process.env.HARNESS_PREFERENCE_TEST_FIXTURE = originalFixtureMode;
});
const base = { operationId: 'op1', at: '2026-09-07T00:00:00Z', actor: { kind: 'human', id: 'test-user' } };
const post = (route: string, body: unknown) => fetch(baseUrl + route, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

it.each(['packet', 'editing'] as const)('rejects %s hash corruption at HTTP import without changing the existing journal', async corruption => {
  const event = scriptJudgmentFixture();
  const command = { kind: 'decision' as const, operationId: event.operationId, at: event.createdAt, actor: event.actor, event };
  preferenceStore.execute(command);
  const previous = readFileSync(preferenceStore.file, 'utf8');
  const bad = structuredClone(command);
  bad.operationId = bad.event.operationId = 'different-operation'; bad.event.id = 'different-judgment';
  if (corruption === 'packet') bad.event.artifact.input.alignment.packet.source.id = 'different-source.mp4';
  else bad.event.artifact.input.editing.telops[0]!.originalEnd += 1;
  const response = await post('/api/preferences/import', { confirmedRestore: true, journal: { schemaVersion: 1, commands: [bad] } });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('HASH_MISMATCH') });
  expect(readFileSync(preferenceStore.file, 'utf8')).toBe(previous);
  const valid = await post('/api/preferences/import', { confirmedRestore: true, journal: JSON.parse(previous) });
  expect(valid.status).toBe(200);
  expect(readFileSync(preferenceStore.file, 'utf8')).toBe(previous);
});

function seedActivatedRule(): void {
  preferenceStore.execute({ ...base, kind: 'profile', profileId: 'golf', name: 'ゴルフ解説' });
  preferenceStore.execute({ ...base, operationId: 'assign', kind: 'assign', projectId: 'video', profileId: 'golf' });
  for (let index = 0; index <= 10; index += 1) {
    const negative = index > 5;
    const operationId = `decision-${index}`;
    preferenceStore.execute({ ...base, operationId, kind: 'decision', event: {
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
  preferenceStore.execute({ ...base, operationId: 'candidate', kind: 'candidate', ruleId: 'rule1', version: 1, evidenceIds: ['d0'] });
  preferenceStore.execute({ ...base, operationId: 'dataset', kind: 'dataset', datasetId: 'set1', datasetVersion: 1,
    caseIds: Array.from({ length: 10 }, (_, index) => `d${index + 1}`) });
  preferenceStore.execute({ ...base, operationId: 'activation', kind: 'activate', ruleId: 'rule1', version: 1,
    datasetId: 'set1', datasetVersion: 1 });
}

describe('保存済みモデル出力の比較API（人操作を模したソフトウェアfixture）', () => {
  const selection = { ruleId: 'rule1', ruleVersion: 1, datasetId: 'set1', datasetVersion: 1 };
  it('同じ固定入力で2出力を比較し、外部実行や有効化をせず、元記録を変えない', async () => {
    seedActivatedRule();
    const before = preferenceStore.export();
    const response = await post('/api/preferences/model-input', selection);
    expect(response.status).toBe(200);
    const prepared = await response.json();
    expect(JSON.stringify(prepared.input)).not.toMatch(/actualAfter|proposedAfter|decision|heldout-positive/);
    const output = { schemaVersion: 1, predictions: prepared.input.cases.map((c: { caseId: string; text: string }) =>
      ({ caseId: c.caseId, after: c.text === '素振りする' ? '素振りをする' : null })) };
    const outputs = [{ label: '申告されたモデルA', output },
      { label: '申告されたモデルB', output: { schemaVersion: 1, predictions: output.predictions.map((p: { caseId: string }) => ({ caseId: p.caseId, after: '勝手な変更' })) } }];
    const compared = await post('/api/preferences/model-compare', { ...selection, inputHash: prepared.inputHash, outputs });
    expect(compared.status).toBe(200);
    const result = await compared.json();
    expect(result.reports.map((r: { aggregate: { passed: number } }) => r.aggregate.passed)).toEqual([10, 0]);
    expect(result.reports.every((r: { mode: string; inputHash: string; activationAuthorized: boolean }) =>
      r.mode === 'replay' && r.inputHash === prepared.inputHash && r.activationAuthorized === false)).toBe(true);
    expect(result.outputs).toEqual(outputs);
    expect(preferenceStore.export()).toBe(before);
    expect(readFileSync(path.join(root, 'video', 'unchanged.txt'), 'utf8')).toBe('untouched');
  });
  it('古い入力・実行mode偽装・欠落出力を合格として返さない', async () => {
    seedActivatedRule();
    const response = await post('/api/preferences/model-input', selection);
    expect(response.status).toBe(200);
    const prepared = await response.json();
    const outputs = ['A', 'B'].map((label) => ({ label, output: { schemaVersion: 1, predictions: [] } }));
    expect((await post('/api/preferences/model-compare', { ...selection, inputHash: 'old-input', outputs })).status).toBe(409);
    expect((await post('/api/preferences/model-compare', { ...selection, inputHash: prepared.inputHash, outputs, mode: 'live' })).status).toBe(400);
    const result = await (await post('/api/preferences/model-compare', { ...selection, inputHash: prepared.inputHash, outputs })).json();
    expect(result.reports.map((r: { status: string }) => r.status)).toEqual(['invalid_output', 'invalid_output']);
  });
  it('書き出した後に同意を撤回すると、入力の再取得も比較も拒否する', async () => {
    seedActivatedRule();
    const response = await post('/api/preferences/model-input', selection);
    expect(response.status).toBe(200);
    const prepared = await response.json();
    preferenceStore.execute({ ...base, operationId: 'withdraw-model-case', kind: 'decision', event: {
      schemaVersion: 1, type: 'withdrawal', id: 'withdraw-model-case', operationId: 'withdraw-model-case',
      createdAt: base.at, actor: base.actor, targetId: 'd1', reason: 'withdrawn in test',
    } });
    const before = preferenceStore.export();
    expect((await post('/api/preferences/model-input', selection)).status).toBe(409);
    expect((await post('/api/preferences/model-compare', { ...selection, inputHash: prepared.inputHash,
      outputs: ['A', 'B'].map((label) => ({ label, output: {} })) })).status).toBe(409);
    expect(preferenceStore.export()).toBe(before);
  });
});

describe('ローカルの構造化好みAPI', () => {
  it('記録と復元を明示操作にし、案件ファイルを書き換えない', async () => {
    expect((await post('/api/preferences/command', { ...base, kind: 'profile', profileId: 'golf', name: 'ゴルフ解説' })).status).toBe(200);
    const exported = await fetch(baseUrl + '/api/preferences/export');
    expect(exported.headers.get('content-disposition')).toContain('editor-preferences.v1.json');
    const journal = await exported.json();
    expect((await post('/api/preferences/import', { journal })).status).toBe(400);
    expect((await post('/api/preferences/import', { confirmedRestore: true, journal })).status).toBe(200);
    const state = await (await fetch(baseUrl + '/api/preferences')).json();
    expect(state.operations).toHaveLength(1);
    expect(state.profiles[0].name).toBe('ゴルフ解説');
    expect(readFileSync(path.join(root, 'video', 'unchanged.txt'), 'utf8')).toBe('untouched');
  });
  it('未知案件、パス逸脱、別サイトからの要求を拒否する', async () => {
    const assign = { ...base, kind: 'assign', profileId: null };
    expect((await post('/api/preferences/command', { ...assign, projectId: 'missing' })).status).toBe(404);
    expect((await post('/api/preferences/command', { ...assign, projectId: '../../outside' })).status).toBe(400);
    expect((await fetch(baseUrl + '/api/preferences', { headers: { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  });
  it('未有効ルールや未指定方針から提案を出さず、捏造した提案は適用確認を通さない', async () => {
    const target = { projectId: 'video', projectRevision: 'revision-1',
      elements: [{ id: '1', text: '素振りする', sourceFrameRange: { start: 0, end: 30 } }] };
    const response = await post('/api/preferences/proposals', target);
    expect(await response.json()).toEqual({ proposals: [], conflicts: [] });
    const fake = { projectId: 'video', projectRevision: 'revision-1', elementId: '1',
      before: '素振りする', after: '素振りをする', sourceFrameRange: { start: 0, end: 30 }, rule: { id: 'fake', version: 1 }, evidenceIds: ['fake'] };
    expect((await post('/api/preferences/validate', { target, proposal: fake })).status).toBe(409);
    expect((await post('/api/preferences/proposals', { ...target, profileId: 'hijacked' })).status).toBe(400);
  });
  it('評価ケース撤回後はavailabilityと提案を止め、撤回前の提案をvalidateで拒否する', async () => {
    seedActivatedRule();
    const target = { projectId: 'video', projectRevision: 'revision-1',
      elements: [{ id: '1', text: '素振りする', sourceFrameRange: { start: 0, end: 30 } }] };
    const proposalResponse = await post('/api/preferences/proposals', target);
    const proposalBody = await proposalResponse.json() as { proposals: unknown[] };
    expect(proposalBody.proposals).toHaveLength(1);
    expect(proposalBody.proposals[0]).toMatchObject({ activationEvaluationId: 'activation' });

    const withdrawal = { ...base, operationId: 'withdraw-d1', kind: 'decision', event: {
      schemaVersion: 1, type: 'withdrawal', id: 'withdraw-d1', operationId: 'withdraw-d1', createdAt: base.at,
      actor: base.actor, targetId: 'd1', reason: '評価例への同意を撤回',
    } };
    expect((await post('/api/preferences/command', withdrawal)).status).toBe(200);
    const state = await (await fetch(baseUrl + '/api/preferences')).json();
    expect(state.availability).toEqual([{ id: 'rule1', version: 1, status: 'evaluation_invalidated' }]);
    expect((await post('/api/preferences/proposals', target).then((response) => response.json()))).toEqual({ proposals: [], conflicts: [] });
    expect((await post('/api/preferences/validate', { target, proposal: proposalBody.proposals[0] })).status).toBe(409);

    preferenceStore.execute({ ...base, operationId: 'replacement-d11', kind: 'decision', event: {
      schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id: 'd11', operationId: 'replacement-d11',
      createdAt: base.at, actor: base.actor, projectId: 'heldout-positive', projectRevision: 'r2', elementId: '11',
      sourceFrameRange: { start: 330, end: 360 }, before: '素振りする', proposedAfter: '素振りをする',
      actualAfter: '素振りをする', decision: 'accepted', scope: { kind: 'profile', id: 'golf' },
      reasonCode: 'wording', note: '', learningConsent: true, provenance: { kind: 'human' },
    } });
    preferenceStore.execute({ ...base, operationId: 'dataset-2', kind: 'dataset', datasetId: 'set1', datasetVersion: 2,
      caseIds: [...Array.from({ length: 9 }, (_, index) => `d${index + 2}`), 'd11'] });
    preferenceStore.execute({ ...base, operationId: 'activation-2', kind: 'activate', ruleId: 'rule1', version: 1,
      datasetId: 'set1', datasetVersion: 2 });
    expect((await post('/api/preferences/validate', { target, proposal: proposalBody.proposals[0] })).status).toBe(409);
    const refreshed = await post('/api/preferences/proposals', target).then((response) => response.json()) as { proposals: unknown[] };
    expect(refreshed.proposals[0]).toMatchObject({ activationEvaluationId: 'activation-2' });
    expect((await post('/api/preferences/validate', { target, proposal: refreshed.proposals[0] })).status).toBe(200);
  });
  it('開発fixtureモードでは判断の出所をsyntheticへ強制して応答にも明示する', async () => {
    process.env.HARNESS_PREFERENCE_TEST_FIXTURE = '1';
    const profile = await post('/api/preferences/command', { ...base, kind: 'profile', profileId: 'golf', name: 'ゴルフ解説' });
    expect((await profile.json()).recordingProvenance).toBe('synthetic');
    const operationId = 'fixture-decision';
    const response = await post('/api/preferences/command', { ...base, operationId, kind: 'decision', event: {
      schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id: 'fixture-d1', operationId,
      createdAt: base.at, actor: base.actor, projectId: 'video', projectRevision: 'r1', elementId: '1',
      sourceFrameRange: { start: 0, end: 30 }, before: '素振りする', proposedAfter: '素振りをする',
      actualAfter: '素振りをする', decision: 'accepted', scope: { kind: 'profile', id: 'golf' },
      reasonCode: 'wording', note: '', learningConsent: true, provenance: { kind: 'human' },
    } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recordingProvenance).toBe('synthetic');
    expect(body.decisions.events[0].provenance).toEqual({ kind: 'synthetic' });
    expect((await (await fetch(baseUrl + '/api/preferences')).json()).recordingProvenance).toBe('synthetic');
  });
});
