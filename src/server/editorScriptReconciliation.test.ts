import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLiteralAlignments, type AlignmentGenerator } from '../core/scriptAlignment';
import type { ScriptEditArtifact } from '../core/scriptEditArtifact';
import type { ScriptEditProposal } from '../core/scriptEditProposal';
import { createScriptEditArtifact, sealScriptEditInput } from './scriptEditArtifacts';
import { createScriptProposalArtifact, sealScriptInputPacket } from './scriptProposalArtifacts';
import { inspectSavedScriptEdit, type SavedScriptEditingState } from './editorAgentContext';
import { EditorAgentService } from './editorAgentService';
import { EditorOperationStore } from './editorOperationStore';
import { scriptEditingPresenceHash } from '../shared/editorSessions';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function generator(skillId: AlignmentGenerator['skillId']): AlignmentGenerator {
  return { skillId, skillVersion: '1', provider: 'fixture', model: 'fixture', configHash: 'b'.repeat(64) };
}

function artifact(kind: 'caption' | 'structure'): ScriptEditArtifact {
  const skillId = kind === 'caption' ? 'subtitle-orthography' : 'script-structure';
  const packet = sealScriptInputPacket({
    schemaVersion: 1, packetHash: '0'.repeat(64), projectId: 'project', editRevision: 'edit-1',
    source: { id: 'main.mp4', revision: 'source-1', durationMs: 4_000 },
    script: { schemaVersion: 1, documentId: 'script', revision: 'script-1', text: '正しいA\n正しいB',
      passages: [{ id: 'a', range: { start: 0, end: 4 } }, { id: 'b', range: { start: 5, end: 9 } }] },
    transcript: { revision: 'transcript-1', words: [
      { index: 0, text: '正しいA', startMs: 400, endMs: 1_200 },
      { index: 1, text: '正しいB', startMs: 2_400, endMs: 3_200 },
    ] },
  });
  const alignment = createScriptProposalArtifact(packet, buildLiteralAlignments(packet, generator(skillId)));
  const input = sealScriptEditInput({ schemaVersion: 1, inputHash: '0'.repeat(64), alignment,
    editing: { fps: 30, totalFrames: 120,
      telops: [{ id: 1, originalStart: 0, originalEnd: 50, text: '誤A' }, { id: 2, originalStart: 60, originalEnd: 120, text: '誤B' }],
      cutRegions: [{ start: 50, end: 60 }], cutOrder: [] } });
  const passages = [
    { passageId: 'a', action: 'use' as const, candidateIndex: 0, reason: '台本と一致' },
    { passageId: 'b', action: 'use' as const, candidateIndex: 0, reason: '台本と一致' },
  ];
  const proposal: ScriptEditProposal = kind === 'structure'
    ? { schemaVersion: 1, kind, proposalId: `script-edit:${kind}:${input.inputHash}`, inputHash: input.inputHash,
      generator: generator(skillId), passages }
    : { schemaVersion: 1, kind, proposalId: `script-edit:${kind}:${input.inputHash}`, inputHash: input.inputHash,
      generator: generator(skillId), passages, changes: [
        { telopId: 1, before: '誤A', after: '正しいA', passageId: 'a', scriptRange: { start: 0, end: 4 },
          wordRef: { transcriptRevision: 'transcript-1', startIndex: 0, endIndex: 1 } },
        { telopId: 2, before: '誤B', after: '正しいB', passageId: 'b', scriptRange: { start: 5, end: 9 },
          wordRef: { transcriptRevision: 'transcript-1', startIndex: 1, endIndex: 2 } },
      ] };
  return createScriptEditArtifact(input, proposal);
}

function stateOf(value: ScriptEditArtifact): SavedScriptEditingState {
  return { scriptDocument: value.input.alignment.packet.script, fps: value.input.editing.fps,
    totalFrames: value.input.editing.totalFrames, telops: structuredClone(value.input.editing.telops),
    cutRegions: structuredClone(value.input.editing.cutRegions), cutOrder: structuredClone(value.input.editing.cutOrder) };
}

describe('saved script edit inspection', () => {
  it('compares saved captions to the human correction while retaining the original AI wording', () => {
    const value = artifact('caption'); const saved = stateOf(value);
    const modification = { kind: 'caption' as const, changes: [{ telopId: 1, after: '人のA' }, { telopId: 2, after: '正しいB' }] };
    saved.telops[0]!.text = '人のA'; saved.telops[1]!.text = '正しいB';
    const result = inspectSavedScriptEdit(saved, {}, value, modification);
    expect(result).toMatchObject({ modified: true, savedState: 'proposal', current: { targetTelops: [
      { id: 1, proposedAfter: '正しいA', after: '人のA' }, { id: 2, proposedAfter: '正しいB', after: '正しいB' },
    ] } });
    expect(inspectSavedScriptEdit(saved, {}, value).savedState).toBe('diverged');
    saved.telops[0]!.text = '正しいA';
    expect(inspectSavedScriptEdit(saved, {}, value, modification).savedState).toBe('diverged');
  });
  it('compares a human reordered structure to its final ranges rather than the AI order', () => {
    const value = artifact('structure'); const saved = stateOf(value);
    const modification = { kind: 'structure' as const, cutOrder: [{ originalStart: 72, originalEnd: 90 }, { originalStart: 12, originalEnd: 36 }] };
    saved.cutOrder = modification.cutOrder;
    saved.cutRegions = [{ start: 0, end: 12 }, { start: 36, end: 72 }, { start: 90, end: 120 }];
    expect(inspectSavedScriptEdit(saved, {}, value, modification)).toMatchObject({ modified: true, savedState: 'proposal' });
    expect(inspectSavedScriptEdit(saved, {}, value).savedState).toBe('diverged');
  });
  it('distinguishes caption input, proposal, and partial/diverged disk states', () => {
    const value = artifact('caption'); const before = stateOf(value);
    expect(inspectSavedScriptEdit(before, { marker: 'fp-a' }, value).savedState).toBe('input');
    const after = structuredClone(before); after.telops[0]!.text = '正しいA'; after.telops[1]!.text = '正しいB';
    const applied = inspectSavedScriptEdit(after, { marker: 'fp-b' }, value);
    expect(applied.savedState).toBe('proposal');
    expect(applied.current.targetTelops.map(target => target.current?.text)).toEqual(['正しいA', '正しいB']);
    after.telops[1]!.text = '人が別に修正';
    expect(inspectSavedScriptEdit(after, { marker: 'fp-c' }, value).savedState).toBe('diverged');
  });

  it('distinguishes structure input and derived proposal order without treating settings as a save receipt', () => {
    const value = artifact('structure'); const before = stateOf(value);
    const first = inspectSavedScriptEdit(before, { marker: 'fp-a' }, value);
    expect(first).toMatchObject({ kind: 'structure', savedState: 'input' });
    expect(first.current).toMatchObject({ fps: 30, totalFrames: 120 });
    const after = structuredClone(before);
    after.cutRegions = [{ start: 0, end: 12 }, { start: 36, end: 72 }, { start: 96, end: 120 }];
    after.cutOrder = [{ originalStart: 12, originalEnd: 36 }, { originalStart: 72, originalEnd: 96 }];
    expect(inspectSavedScriptEdit(after, { marker: 'fp-b' }, value).savedState).toBe('proposal');
    expect(first).not.toHaveProperty('saved');
  });

  it('uses the same script-state digest in the browser presence and server disk inspection', async () => {
    const value = artifact('caption'); const saved = stateOf(value);
    const inspected = inspectSavedScriptEdit(saved, { marker: 'fp-a' }, value);
    expect(await scriptEditingPresenceHash({ ...saved, originalTotalFrames: saved.totalFrames })).toBe(inspected.presenceHash);
  });
});

describe('script operation unknown reconciliation', () => {
  it('stores the stable disk assessment while retaining unknown and unconfirmed receipt facts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'editor-script-reconcile-')); directories.push(directory);
    const value = artifact('caption'); const saved = inspectSavedScriptEdit(stateOf(value), { marker: 'fp-a' }, value);
    const store = new EditorOperationStore(join(directory, 'operations.json'), 'server');
    const context = { review: (operations: unknown[]) => operations, inspectSavedScriptEdit: () => saved };
    const service = new EditorAgentService(store, () => {}, Date.now, 15_000,
      () => ({ elements: value.input.editing.telops.map(t => ({ id: String(t.id), text: t.text,
        sourceFrameRange: { start: t.originalStart, end: t.originalEnd } })), fingerprint: saved.fingerprintHash }),
      context as never);
    const heartbeat = { sessionId: 'window', sessionKey: 'a'.repeat(32), sequence: 1,
      snapshot: { status: 'ready' as const, projectId: 'project', revision: 'r1', dirty: false, saving: false,
        humanBusy: false, scriptEditingHash: saved.presenceHash,
        elements: value.input.editing.telops.map(t => ({ id: String(t.id), text: t.text,
          sourceFrameRange: { start: t.originalStart, end: t.originalEnd } })) } };
    service.heartbeat(heartbeat);
    const request = { schemaVersion: 1 as const, operationId: 'script:judgment-1', projectId: 'project', baseRevision: 'r1',
      script: { judgmentId: 'judgment-1', artifact: value }, changes: [] };
    const queued = store.enqueue(request); const running = store.claim(queued.runId, 'window');
    store.disconnect('window');
    const { scriptEditingHash: _hash, ...withoutHash } = heartbeat.snapshot;
    service.heartbeat({ ...heartbeat, sequence: 2, snapshot: withoutHash });
    expect(() => service.prepareReconciliation('window', running.runId)).toThrow(/REVIEW_UNAVAILABLE/);
    service.heartbeat({ ...heartbeat, sequence: 3, snapshot: { ...heartbeat.snapshot, scriptEditingHash: '0'.repeat(64) } });
    expect(() => service.prepareReconciliation('window', running.runId)).toThrow(/SAVED_STATE_MISMATCH/);
    service.heartbeat({ ...heartbeat, sequence: 4 });

    const preview = service.prepareReconciliation('window', running.runId);
    if (!preview.script) throw new Error('script review expected');
    expect(preview.script).toEqual(saved);
    expect(preview.script.current).toMatchObject({ scriptDocumentMatchesInput: true, telopsMatchInput: true,
      cutRegionsMatchInput: true, cutOrderMatchInput: true });
    const reconciled = service.reconcile('window', heartbeat.sessionKey, running.runId, 'review-1', preview.snapshotHash, 'synthetic');
    const { current: _current, ...compact } = saved;
    expect(reconciled).toMatchObject({ phase: 'unknown', confirmed: { applied: false, saved: false },
      reconciliation: { script: compact } });
  });
});
