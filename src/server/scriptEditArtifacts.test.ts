import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLiteralAlignments } from '../core/scriptAlignment';
import { createScriptProposalArtifact, sealScriptInputPacket } from './scriptProposalArtifacts';
import {
  assertScriptEditArtifactCurrent, createScriptEditArtifact, parseScriptEditArtifact,
  saveScriptEditArtifact, sealScriptEditInput, verifyScriptEditInput,
} from './scriptEditArtifacts';

function fixture(kind: 'caption' | 'structure' = 'caption') {
  const generator = { skillId: kind === 'caption' ? 'subtitle-orthography' as const : 'script-structure' as const,
    skillVersion: '1', provider: 'deterministic', model: 'owned-test', configHash: 'c'.repeat(64) };
  const packet = sealScriptInputPacket({ schemaVersion: 1, packetHash: '0'.repeat(64), projectId: 'owned',
    editRevision: 'edit-1', source: { id: 'main.mp4', revision: 'source-1', durationMs: 2000 },
    script: { schemaVersion: 1, documentId: 's', revision: 's1', text: 'はい\n未撮影',
      passages: [{ id: 'p1', range: { start: 0, end: 2 } }, { id: 'p2', range: { start: 3, end: 6 } }] },
    transcript: { revision: 't1', words: [
      { index: 0, text: 'はい', startMs: 100, endMs: 300 },
      { index: 1, text: 'はい', startMs: 900, endMs: 1100 },
    ] } });
  const input = sealScriptEditInput({ schemaVersion: 1, inputHash: '0'.repeat(64),
    alignment: createScriptProposalArtifact(packet, buildLiteralAlignments(packet, generator)),
    editing: { fps: 30, totalFrames: 60, telops: [{ id: 1, text: 'ハイ', originalStart: 0, originalEnd: 15 }], cutRegions: [], cutOrder: [] } });
  const proposal = { schemaVersion: 1, kind, proposalId: `script-edit:${kind}:${input.inputHash}`, inputHash: input.inputHash, generator,
    passages: [{ passageId: 'p1', action: 'use', candidateIndex: 0, reason: '字幕区間内の最初の発話を候補とする' }, { passageId: 'p2', action: 'skip', reason: '未撮影のため' }],
    ...(kind === 'caption' ? { changes: [{ telopId: 1, before: 'ハイ', after: 'はい', passageId: 'p1',
      scriptRange: { start: 0, end: 2 }, wordRef: { transcriptRevision: 't1', startIndex: 0, endIndex: 1 } }] } : {}),
  };
  return { input, proposal };
}
const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), 'script-edit-artifact-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('script edit artifacts', () => {
  it.each(['caption', 'structure'] as const)('persists a validated unapplied %s proposal and refuses false execution/consent', kind => {
    const { input, proposal } = fixture(kind);
    const artifact = createScriptEditArtifact(input, proposal);
    const file = join(directory(), 'plan.json');
    saveScriptEditArtifact(file, artifact);
    const bytes = readFileSync(file, 'utf8');
    expect(parseScriptEditArtifact(JSON.parse(bytes))).toEqual(artifact);
    saveScriptEditArtifact(file, artifact);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    for (const invalid of [{ ...artifact, state: 'applied' }, { ...artifact, learningConsent: true }]) {
      expect(() => saveScriptEditArtifact(file, invalid)).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    }
    const changed = structuredClone(artifact); changed.proposal.generator.model = 'another-model';
    expect(() => saveScriptEditArtifact(file, changed)).toThrow('SCRIPT_EDIT_ARTIFACT_CONFLICT');
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    writeFileSync(file, '{broken');
    expect(() => saveScriptEditArtifact(file, artifact)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('binds the actual editing snapshot and nested packet, and rejects stale content even if the declared edit revision stays the same', () => {
    const { input, proposal } = fixture();
    const changed = structuredClone(input); changed.editing.telops[0]!.text = '別の編集';
    expect(() => verifyScriptEditInput(changed)).toThrow('SCRIPT_EDIT_INPUT_HASH_MISMATCH');
    expect(() => assertScriptEditArtifactCurrent(createScriptEditArtifact(input, proposal), sealScriptEditInput(changed)))
      .toThrow('STALE_SCRIPT_EDIT');
    const forged = structuredClone(input); forged.alignment.packet.source.revision = 'fake-source';
    expect(() => sealScriptEditInput(forged)).toThrow();
  });

  it('runs the CLI to create, reload, validate and reject a stale plan without editing a project', () => {
    const { input, proposal } = fixture();
    const dir = directory();
    const inputFile = join(dir, 'input.json'), proposalFile = join(dir, 'proposal.json'), artifactFile = join(dir, 'artifact.json');
    writeFileSync(inputFile, JSON.stringify(input)); writeFileSync(proposalFile, JSON.stringify(proposal));
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/script-workspace.ts'), ...args], { encoding: 'utf8' });
    const created = run('edit-create', inputFile, proposalFile, artifactFile);
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).state).toBe('unapplied');
    expect(run('edit-validate', artifactFile, inputFile).status).toBe(0);
    const changed = structuredClone(input); changed.editing.telops[0]!.text = '別の編集';
    writeFileSync(inputFile, JSON.stringify(sealScriptEditInput(changed)));
    const stale = run('edit-validate', artifactFile, inputFile);
    expect(stale.status).toBe(1); expect(stale.stderr).toContain('STALE_SCRIPT_EDIT');
  });

  it('checks current project facts independently of a model-derived candidate set, while binding that set to the stored proposal', () => {
    const { input, proposal } = fixture();
    const draft = structuredClone(input);
    const unmatched = draft.alignment.proposals[1]!;
    unmatched.status = 'unique';
    unmatched.candidates = [{ match: 'model_suggested', rationale: '合成の誤対応候補。品質評価ではない',
      wordRef: { transcriptRevision: 't1', startIndex: 0, endIndex: 1 } }];
    const modelInput = sealScriptEditInput(draft);
    const artifact = createScriptEditArtifact(modelInput, { ...proposal, inputHash: modelInput.inputHash,
      proposalId: `script-edit:caption:${modelInput.inputHash}` });
    expect(() => assertScriptEditArtifactCurrent(artifact, input)).not.toThrow();
    expect(() => createScriptEditArtifact(modelInput, proposal)).toThrow();
  });
});
