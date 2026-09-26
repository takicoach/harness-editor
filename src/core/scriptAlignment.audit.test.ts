import { describe, expect, it } from 'vitest';
import {
  buildLiteralAlignments, deriveCandidateTimeRange, validateAlignmentProposal, validateAlignmentProposals,
  type AlignmentGenerator, type ScriptInputPacket,
} from './scriptAlignment';

const generator: AlignmentGenerator = { skillId: 'script-structure', skillVersion: 'audit-v1',
  provider: 'synthetic', model: 'no-model-executed', configHash: 'b'.repeat(64) };
function input(scriptText = '右に曲がります'): ScriptInputPacket {
  return { schemaVersion: 1, packetHash: 'a'.repeat(64), projectId: 'audit-owned', editRevision: 'e1',
    source: { id: 'main', revision: 'v1', durationMs: 10000 },
    script: { schemaVersion: 1, documentId: 'script', revision: 's1', text: scriptText,
      passages: [{ id: 'phrase', range: { start: 0, end: scriptText.length } }] },
    transcript: { revision: 't1', words: [
      { index: 0, text: '右に', startMs: 500, endMs: 800 },
      { index: 1, text: '曲がります', startMs: 800, endMs: 1200 },
      { index: 2, text: '右に', startMs: 5000, endMs: 5300 },
      { index: 3, text: '曲がります', startMs: 5300, endMs: 6000 },
    ] } };
}

describe('independent script alignment boundary audit', () => {
  it('batch validation checks later proposals and never trusts caller-marked packets', () => {
    const packet = input();
    const lineLength = packet.script.text.length;
    packet.script.text += `\n${packet.script.text}`;
    packet.script.passages.push({ id: 'second', range: { start: lineLength + 1, end: packet.script.text.length } });
    const proposals = buildLiteralAlignments(packet, generator);
    expect(validateAlignmentProposals(packet, proposals)).toHaveLength(2);
    const corrupted = structuredClone(proposals);
    corrupted[1]!.sourceRevision = 'other-video';
    expect(() => validateAlignmentProposals(packet, corrupted)).toThrow();
    const invalidPacket = structuredClone(packet);
    invalidPacket.transcript.words[0]!.endMs = Number.NaN;
    expect(() => validateAlignmentProposals(invalidPacket, proposals)).toThrow();
  });

  it('cannot turn two literal takes into a unique proposal by dropping one candidate', () => {
    const packet = input();
    const proposal = buildLiteralAlignments(packet, generator)[0]!;
    expect(proposal.candidates).toHaveLength(2);
    expect(() => validateAlignmentProposal(packet, { ...proposal, status: 'unique', candidates: [proposal.candidates[1]!] })).toThrow();
    expect(() => validateAlignmentProposal(packet, { ...proposal, status: 'unmatched', candidates: [] })).toThrow();
  });

  it('cannot hide the first take by calling the remaining take model_suggested', () => {
    const packet = input();
    const proposal = buildLiteralAlignments(packet, generator)[0]!;
    expect(() => validateAlignmentProposal(packet, { ...proposal, status: 'unique', candidates: [
      { ...proposal.candidates[1]!, match: 'model_suggested', rationale: 'これは別のモデルの案です' },
    ] })).toThrow();
  });

  it('distinguishes unspoken substring from a complete timed word and preserves original times', () => {
    const packet = input('曲がり');
    const original = JSON.stringify(packet);
    const proposal = buildLiteralAlignments(packet, generator)[0]!;
    expect(proposal.status).toBe('unmatched');
    expect(proposal.candidates).toEqual([]);
    const complete = input();
    const aligned = buildLiteralAlignments(complete, generator)[0]!;
    expect(deriveCandidateTimeRange(complete, aligned.candidates[1]!)).toEqual({ startMs: 5000, endMs: 6000 });
    expect(JSON.stringify(packet)).toBe(original);
  });

  it('allows an explicitly labelled semantic suggestion without fabricating a timestamp', () => {
    const packet = input('右へ進みます');
    const proposal = buildLiteralAlignments(packet, generator)[0]!;
    const proposed = { ...proposal, status: 'unique' as const, candidates: [{ match: 'model_suggested' as const,
      rationale: '言い換えの候補。意味とテイクは人が確認する',
      wordRef: { transcriptRevision: 't1', startIndex: 0, endIndex: 2 } }] };
    expect(validateAlignmentProposal(packet, proposed).candidates[0]?.match).toBe('model_suggested');
    expect(() => validateAlignmentProposal(packet, { ...proposed, candidates: [
      { ...proposed.candidates[0]!, startMs: 0 },
    ] } as unknown as typeof proposed)).toThrow();
  });
});
