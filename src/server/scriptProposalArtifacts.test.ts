import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLiteralAlignments, type AlignmentGenerator } from '../core/scriptAlignment';
import {
  assertScriptArtifactCurrent, createScriptProposalArtifact, parseScriptProposalArtifact,
  saveScriptProposalArtifact, scriptContentHash, sealScriptInputPacket, verifyScriptInputPacket,
} from './scriptProposalArtifacts';

const generator: AlignmentGenerator = { skillId: 'subtitle-orthography', skillVersion: '1',
  provider: 'deterministic', model: 'literal-v1', configHash: 'c'.repeat(64) };
function packet() {
  return sealScriptInputPacket({ schemaVersion: 1, packetHash: '0'.repeat(64), projectId: 'owned-fixture',
    editRevision: 'edit-content-1', source: { id: 'owned.mp4', revision: 'source-content-1', durationMs: 2000 },
    script: { schemaVersion: 1, documentId: 'shooting', revision: 'script-content-1', text: 'はい\n未撮影',
      passages: [{ id: 'p1', range: { start: 0, end: 2 } }, { id: 'p2', range: { start: 3, end: 6 } }] },
    transcript: { revision: 'transcript-content-1', words: [
      { index: 0, text: 'はい', startMs: 100, endMs: 300 },
      { index: 1, text: 'はい', startMs: 900, endMs: 1100 },
    ] } });
}
function artifact() { const p = packet(); return createScriptProposalArtifact(p, buildLiteralAlignments(p, generator)); }
const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), 'script-artifact-test-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('script proposal artifacts', () => {
  it('binds actual packet content and rejects tampering even if declared revisions do not change', () => {
    const p = packet();
    expect(verifyScriptInputPacket(p)).toEqual(p);
    const changed = structuredClone(p);
    changed.transcript.words[0]!.text = 'いいえ';
    expect(() => verifyScriptInputPacket(changed)).toThrow('PACKET_HASH_MISMATCH');
    expect(() => assertScriptArtifactCurrent(artifact(), sealScriptInputPacket(changed))).toThrow('STALE_SCRIPT_PROPOSAL');
  });

  it.each(['project', 'source', 'edit', 'script', 'wordTime'] as const)('rejects a proposal after %s changes', field => {
    const changed = packet();
    if (field === 'project') changed.projectId = 'other';
    if (field === 'source') changed.source.revision = 'relinked-video';
    if (field === 'edit') changed.editRevision = 'cut-order-changed';
    if (field === 'script') changed.script.text = 'はい\n要撮影';
    if (field === 'wordTime') changed.transcript.words[0]!.startMs = 101;
    expect(() => assertScriptArtifactCurrent(artifact(), sealScriptInputPacket(changed))).toThrow('STALE_SCRIPT_PROPOSAL');
  });

  it('keeps ambiguous and unspoken passages, and refuses omissions, duplicates or false applied status', () => {
    const a = artifact();
    expect(a.proposals.map(p => p.status)).toEqual(['ambiguous', 'unmatched']);
    expect(() => parseScriptProposalArtifact({ ...a, proposals: a.proposals.slice(0, 1) })).toThrow('INCOMPLETE_PROPOSALS');
    expect(() => parseScriptProposalArtifact({ ...a, proposals: [a.proposals[0], a.proposals[0]] })).toThrow('DUPLICATE_PROPOSAL');
    expect(() => parseScriptProposalArtifact({ ...a, state: 'applied' })).toThrow();
    expect(() => parseScriptProposalArtifact({ ...a, learningConsent: true })).toThrow();
  });

  it('saves once, survives reload, allows exact retry and preserves bytes on conflict or corrupt input', () => {
    const file = join(directory(), 'proposal.json');
    const a = artifact();
    saveScriptProposalArtifact(file, a);
    const bytes = readFileSync(file, 'utf8');
    expect(parseScriptProposalArtifact(JSON.parse(bytes))).toEqual(a);
    saveScriptProposalArtifact(file, a);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    const changed = structuredClone(a);
    changed.proposals[0]!.generator.model = 'another-model';
    expect(() => saveScriptProposalArtifact(file, changed)).toThrow('ARTIFACT_CONFLICT');
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    writeFileSync(file, '{broken');
    expect(() => saveScriptProposalArtifact(file, a)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('hashes object key order consistently and rejects values JSON would lose', () => {
    expect(scriptContentHash({ b: [2, 1], a: '台本' })).toBe(scriptContentHash({ a: '台本', b: [2, 1] }));
    expect(scriptContentHash([1, 2])).not.toBe(scriptContentHash([2, 1]));
    for (const invalid of [NaN, Infinity, undefined, { a: undefined }, new Date(), Array(2),
      { [Symbol('hidden')]: 'lost' }, Object.assign(Array(2), { 0: 1, extra: 2 })]) {
      expect(() => scriptContentHash(invalid)).toThrow('INVALID_JSON');
    }
  });

  it('runs the real CLI for creation, model-output validation, exact retry and stale rejection', () => {
    const dir = directory();
    const p = packet();
    const input = join(dir, 'packet.json'), gen = join(dir, 'generator.json'), output = join(dir, 'proposal.json');
    writeFileSync(input, JSON.stringify(p));
    writeFileSync(gen, JSON.stringify(generator));
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/script-workspace.ts'), ...args], { encoding: 'utf8' });
    const made = cli('literal', input, gen, output);
    expect(made.status, made.stderr).toBe(0);
    expect(JSON.parse(made.stdout)).toMatchObject({ state: 'unapplied', ambiguous: 1, unmatched: 1 });
    const bytes = readFileSync(output, 'utf8');
    expect(cli('literal', input, gen, output).status).toBe(0);
    expect(cli('validate', output, input).status).toBe(0);
    const modelOutput = parseScriptProposalArtifact(JSON.parse(bytes));
    modelOutput.proposals[0]!.generator.model = 'fixture-model-two';
    // A second generator must retain all known literal takes; changing provenance is not a license to hide one.
    const modelFile = join(dir, 'model.json');
    writeFileSync(modelFile, JSON.stringify(modelOutput));
    const stored = cli('store', modelFile, input, join(dir, 'model-saved.json'));
    expect(stored.status, stored.stderr).toBe(0);
    p.editRevision = 'later-edit';
    writeFileSync(input, JSON.stringify(sealScriptInputPacket(p)));
    const stale = cli('validate', output, input);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('STALE_SCRIPT_PROPOSAL');
    expect(readFileSync(output, 'utf8')).toBe(bytes);
  });
});
