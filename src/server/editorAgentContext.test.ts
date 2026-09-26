import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreferenceWorkspaceStore } from '../learning/preferenceWorkspaceStore';
import { EditorAgentContext } from './editorAgentContext';
import { EditorAgentService } from './editorAgentService';
import { EditorOperationStore } from './editorOperationStore';
import { scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';
import { scriptApplicationRequest } from '../app/edit/scriptAdoption';

let directory: string; let store: PreferenceWorkspaceStore; let context: EditorAgentContext;
const at = '2026-09-07T00:00:00Z';
const actor = { kind: 'human' as const, id: 'contract-test-only' };
const fixtureRoot = new URL('./__fixtures__/', import.meta.url).pathname;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'editor-context-'));
  store = new PreferenceWorkspaceStore(directory);
  context = new EditorAgentContext(fixtureRoot, store);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function seed() {
  store.execute({ kind: 'profile', operationId: 'profile', at, actor, profileId: 'golf', name: 'ゴルフ' });
  store.execute({ kind: 'assign', operationId: 'assign', at, actor, projectId: 'sample-project', profileId: 'golf' });
  // Invented human-branch fixtures exercise the contract; never used as calibration data.
  for (const id of ['d1', 'd2']) store.execute({ kind: 'decision', operationId: id, at, actor,
    event: { schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id, operationId: id,
      createdAt: at, actor, projectId: 'training', projectRevision: 'r1', elementId: id,
      sourceFrameRange: { start: 0, end: 30 }, before: '素振りする', proposedAfter: '素振りをする', actualAfter: '素振りをする',
      decision: 'accepted', reasonCode: 'wording', note: 'Private note is unnecessary for this read contract',
      scope: { kind: 'profile', id: 'golf' }, learningConsent: true, provenance: { kind: 'human' } } });
  store.execute({ kind: 'candidate', operationId: 'candidate', at, actor, ruleId: 'rule', version: 1,
    evidenceIds: ['d1', 'd2'], exceptions: { projectIds: ['sample-project'] } });
}
describe('AI向け案件・方針の読み取り', () => {
  it('binds modified adoption to the stored human correction and invalidates superseded decisions', () => {
    const event = { ...scriptJudgmentFixture(), decision: 'accepted_modified' as const,
      modification: { kind: 'caption' as const, changes: [{ telopId: 1, after: 'はい、確認しました' }] } };
    store.execute({ kind: 'decision', operationId: event.operationId, at: event.createdAt, actor: event.actor, event });
    const request = scriptApplicationRequest(event);
    expect(() => context.validateScriptDecision(request)).not.toThrow();
    const changed = structuredClone(request);
    changed.script!.modification = { kind: 'caption', changes: [{ telopId: 1, after: '別の内容' }] };
    expect(() => context.validateScriptDecision(changed)).toThrow(/SCRIPT_REVIEW_REQUIRED/);
    delete changed.script!.modification;
    expect(() => context.validateScriptDecision(changed)).toThrow(/SCRIPT_REVIEW_REQUIRED/);
    const { modification: _modification, ...base } = event;
    const rejected = { ...base, id: 'rejected', operationId: 'rejected-record', supersedes: event.id, decision: 'rejected' as const };
    store.execute({ kind: 'decision', operationId: rejected.operationId, at: rejected.createdAt, actor: rejected.actor, event: rejected });
    expect(() => context.validateScriptDecision(request)).toThrow(/SCRIPT_REVIEW_REQUIRED/);
  });
  it('安定した順序でページ分割し、絶対パスや接続キーを返さない', () => {
    const first = context.projects(0, 1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).not.toHaveProperty('dir');
    expect(first.items[0]).not.toHaveProperty('videoLink');
    expect(context.projects(0, 1).snapshotHash).toBe(first.snapshotHash);
    expect(context.projects(999, 1).items).toEqual([]);
    for (const [offset, limit] of [[-1, 20], [0, 101], [0, 0], [NaN, 20]]) expect(() => context.projects(offset, limit)).toThrow(/INVALID_PAGE/);
  });
  it('候補と例外を明示し、方針未割当へ別の方針を混ぜない', () => {
    expect(context.readPreferences('sample-project')).toMatchObject({ profile: null, total: 0, items: [] });
    seed();
    const result = context.readPreferences('sample-project');
    expect(result).toMatchObject({ section: 'rules', automaticActivation: false, total: 1,
      items: [{ id: 'rule', availability: 'candidate', excludedForProject: true, evidenceCount: 2 }] });
    expect(() => context.readPreferences('other')).toThrow(/PROJECT_NOT_FOUND/);
    expect(() => context.readPreferences('sample-project', { ruleId: 'another-profile-rule', version: 1 })).toThrow(/RULE_NOT_FOUND/);
  });
  it('根拠をページ分割し、同意撤回した瞬間から返さず、読み取りで保存を変更しない', () => {
    seed();
    const before = readFileSync(store.file, 'utf8');
    const first = context.readPreferences('sample-project', { ruleId: 'rule', version: 1, limit: 1 });
    expect(first).toMatchObject({ section: 'examples', total: 2, nextOffset: 1, items: [{ id: 'd1' }] });
    expect(first.items[0]).not.toHaveProperty('note');
    expect(first.items[0]).not.toHaveProperty('actor');
    expect(readFileSync(store.file, 'utf8')).toBe(before);
    store.execute({ kind: 'decision', operationId: 'withdraw', at, actor,
      event: { schemaVersion: 1, type: 'withdrawal', id: 'withdraw', operationId: 'withdraw', createdAt: at,
        actor, targetId: 'd1', reason: '今回だけ' } });
    const current = context.readPreferences('sample-project', { ruleId: 'rule', version: 1 });
    expect(current).toMatchObject({ total: 1, items: [{ id: 'd2' }] });
    expect(current.snapshotHash).not.toBe(first.snapshotHash);
  });
  it('ルールIDと版の片方だけ、または不正な版を拒否する', () => {
    for (const options of [{ ruleId: 'rule' }, { version: 1 }, { ruleId: 'rule', version: NaN }, { ruleId: 'rule', version: 0 }]) {
      expect(() => context.readPreferences('sample-project', options)).toThrow(/INVALID_RULE_REFERENCE/);
    }
  });
  it('一覧を現在の接続画面へ結び付け、未知の案件の方針を読ませない', () => {
    const service = new EditorAgentService(new EditorOperationStore(join(directory, 'operations.json'), 'server'),
      (id) => { if (id !== 'sample-project') throw new Error('PROJECT_NOT_FOUND: missing'); }, Date.now, 15000, undefined, context);
    service.heartbeat({ sessionId: 'window', sessionKey: 'k'.repeat(32), sequence: 1,
      snapshot: { status: 'loading', projectId: 'sample-project' } });
    const project = service.projects().items.find((item) => item.id === 'sample-project');
    expect(project?.sessions).toMatchObject([{ sessionId: 'window', status: 'loading', projectId: 'sample-project' }]);
    expect(JSON.stringify(project)).not.toContain('k'.repeat(32));
    expect(() => service.preferences('unknown')).toThrow(/PROJECT_NOT_FOUND/);
  });
});
