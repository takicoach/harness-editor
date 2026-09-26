import { describe, expect, it } from 'vitest';
import {
  alignmentProposalSchema,
  buildLiteralAlignments,
  deriveCandidateTimeRange,
  normalizeScriptAlignmentText,
  scriptDocumentSchema,
  scriptInputPacketSchema,
  validateAlignmentProposal,
  validateAlignmentProposals,
  type AlignmentGenerator,
  type AlignmentProposal,
  type ScriptInputPacket,
} from './scriptAlignment';

const HASH = 'a'.repeat(64);
const generator: AlignmentGenerator = {
  skillId: 'subtitle-orthography',
  skillVersion: '1',
  provider: 'fixture-provider',
  model: 'fixture-model',
  configHash: 'b'.repeat(64),
};

function packet(overrides: Partial<ScriptInputPacket> = {}): ScriptInputPacket {
  return {
    schemaVersion: 1,
    packetHash: HASH,
    projectId: 'project-1',
    editRevision: 'edit-1',
    source: { id: 'main.mp4', revision: 'source-1', durationMs: 5_000 },
    script: {
      schemaVersion: 1,
      documentId: 'script-1',
      revision: 'script-1-rev-1',
      text: '価格は 1.50 -12.5% です',
      passages: [{ id: 'line-1', range: { start: 0, end: 18 } }],
    },
    transcript: {
      revision: 'transcript-1',
      words: [
        { index: 0, text: '価格は', startMs: 100, endMs: 500 },
        { index: 1, text: '1.50', startMs: 500, endMs: 800 },
        { index: 2, text: '-12.5%', startMs: 800, endMs: 1_200 },
        { index: 3, text: 'です', startMs: 1_200, endMs: 1_500 },
      ],
    },
    ...overrides,
  };
}

describe('script alignment schemas', () => {
  it('rejects unknown keys at every public input boundary', () => {
    expect(() => scriptDocumentSchema.parse({ ...packet().script, extra: true })).toThrow();
    expect(() => scriptInputPacketSchema.parse({ ...packet(), extra: true })).toThrow();
    const proposal = buildLiteralAlignments(packet(), generator)[0]!;
    expect(() => alignmentProposalSchema.parse({ ...proposal, extra: true })).toThrow();
    expect(() => alignmentProposalSchema.parse({ ...proposal,
      candidates: [{ ...proposal.candidates[0], startMs: 100 }] })).toThrow();
  });

  it('requires well-formed UTF-16 passage boundaries inside the canonical text', () => {
    const text = 'A😀B';
    expect(scriptDocumentSchema.parse({ schemaVersion: 1, documentId: 's', revision: 'r', text,
      passages: [{ id: 'ok', range: { start: 1, end: 3 } }] }).passages[0]?.range).toEqual({ start: 1, end: 3 });
    expect(() => scriptDocumentSchema.parse({ schemaVersion: 1, documentId: 's', revision: 'r', text,
      passages: [{ id: 'split', range: { start: 1, end: 2 } }] })).toThrow(/UTF-16/);
    expect(() => scriptDocumentSchema.parse({ schemaVersion: 1, documentId: 's', revision: 'r', text: '\ud83d',
      passages: [{ id: 'bad', range: { start: 0, end: 1 } }] })).toThrow(/UTF-16/);
  });

  it('rejects invalid word indexes, non-finite or unordered times, and source overflow', () => {
    const base = packet();
    expect(() => scriptInputPacketSchema.parse({ ...base, transcript: { ...base.transcript,
      words: base.transcript.words.map((word, index) => index === 1 ? { ...word, index: 4 } : word) } })).toThrow(/index/);
    expect(() => scriptInputPacketSchema.parse({ ...base, transcript: { ...base.transcript,
      words: base.transcript.words.map((word, index) => index === 1 ? { ...word, startMs: Number.NaN } : word) } })).toThrow();
    expect(() => scriptInputPacketSchema.parse({ ...base, transcript: { ...base.transcript,
      words: base.transcript.words.map((word, index) => index === 1 ? { ...word, startMs: 50 } : word) } })).toThrow(/順/);
    expect(() => scriptInputPacketSchema.parse({ ...base, source: { ...base.source, durationMs: 1_000 } })).toThrow(/durationMs/);
    expect(() => scriptInputPacketSchema.parse({ ...base, transcript: { ...base.transcript,
      words: base.transcript.words.map((word, index) => index === 1 ? { ...word, text: '   ' } : word) } })).toThrow(/空白/);
  });
});

describe('literal alignment', () => {
  it('removes only whitespace and preserves decimals, minus signs, percent signs and punctuation', () => {
    expect(normalizeScriptAlignmentText(' 1.50\n -12.5% ／ −12％ ')).toBe('1.50-12.5%／−12％');
    expect(normalizeScriptAlignmentText('1.50')).not.toBe(normalizeScriptAlignmentText('1.5'));
    expect(normalizeScriptAlignmentText('-12%')).not.toBe(normalizeScriptAlignmentText('−12％'));
  });

  it('returns one literal word range and derives milliseconds only from packet words', () => {
    const input = packet();
    const result = buildLiteralAlignments(input, generator);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      inputHash: HASH,
      passageId: 'line-1',
      status: 'unique',
      candidates: [{ match: 'literal', wordRef: { transcriptRevision: 'transcript-1', startIndex: 0, endIndex: 4 } }],
      generator,
    });
    expect(deriveCandidateTimeRange(input, result[0]!.candidates[0]!)).toEqual({ startMs: 100, endMs: 1_500 });
  });

  it('retains every repeated literal candidate and marks the proposal ambiguous', () => {
    const input = packet({
      script: { schemaVersion: 1, documentId: 's', revision: 'sr', text: 'はい',
        passages: [{ id: 'p', range: { start: 0, end: 2 } }] },
      transcript: { revision: 'tr', words: [
        { index: 0, text: 'はい', startMs: 0, endMs: 100 },
        { index: 1, text: 'いいえ', startMs: 100, endMs: 200 },
        { index: 2, text: 'はい', startMs: 200, endMs: 300 },
      ] },
    });
    const proposal = buildLiteralAlignments(input, generator)[0]!;
    expect(proposal.status).toBe('ambiguous');
    expect(proposal.candidates.map((candidate) => candidate.wordRef)).toEqual([
      { transcriptRevision: 'tr', startIndex: 0, endIndex: 1 },
      { transcriptRevision: 'tr', startIndex: 2, endIndex: 3 },
    ]);
  });

  it('marks an absent literal as unmatched without inventing source time', () => {
    const input = packet({
      script: { schemaVersion: 1, documentId: 's', revision: 'sr', text: '未発話',
        passages: [{ id: 'p', range: { start: 0, end: 3 } }] },
    });
    expect(buildLiteralAlignments(input, generator)[0]).toMatchObject({ status: 'unmatched', candidates: [] });
  });

  it('does not coerce numeric notation into a false literal match', () => {
    const input = packet({
      script: { schemaVersion: 1, documentId: 's', revision: 'sr', text: '1.50 -12%',
        passages: [{ id: 'p', range: { start: 0, end: 9 } }] },
      transcript: { revision: 'tr', words: [
        { index: 0, text: '1.5', startMs: 0, endMs: 100 },
        { index: 1, text: '−12％', startMs: 100, endMs: 200 },
      ] },
    });
    expect(buildLiteralAlignments(input, generator)[0]?.status).toBe('unmatched');
  });

  it('keeps packet identity independent from generator metadata', () => {
    const input = packet();
    const other = { ...generator, provider: 'other-provider', model: 'other-model' };
    const first = buildLiteralAlignments(input, generator)[0]!;
    const second = buildLiteralAlignments(input, other)[0]!;
    expect(second.inputHash).toBe(first.inputHash);
    expect(second.proposalId).toBe(first.proposalId);
    expect(second.candidates).toEqual(first.candidates);
    expect(second.generator).toEqual(other);
  });
});

describe('proposal validation against a fixed packet', () => {
  const modelPacket = () => packet({
    script: { schemaVersion: 1, documentId: 's', revision: 'script-1-rev-1', text: '台本の言い換え',
      passages: [{ id: 'line-1', range: { start: 0, end: 7 } }] },
  });
  const validModelProposal = (): AlignmentProposal => ({
    ...buildLiteralAlignments(modelPacket(), generator)[0]!,
    status: 'unique',
    generator: { ...generator, model: 'replacement-model' },
    candidates: [{ match: 'model_suggested', rationale: '表記差として同じ発話を参照',
      wordRef: { transcriptRevision: 'transcript-1', startIndex: 0, endIndex: 4 } }],
  });

  it('accepts a model candidate only when every packet revision and word boundary agrees', () => {
    expect(validateAlignmentProposal(modelPacket(), validModelProposal())).toEqual(validModelProposal());
    expect(() => validateAlignmentProposal(modelPacket(), { ...validModelProposal(), editRevision: 'old' })).toThrow(/editRevision/);
    expect(() => validateAlignmentProposal(modelPacket(), { ...validModelProposal(), inputHash: 'c'.repeat(64) })).toThrow(/packetHash/);
    expect(() => validateAlignmentProposal(modelPacket(), { ...validModelProposal(), candidates: [{
      ...validModelProposal().candidates[0]!, wordRef: { transcriptRevision: 'transcript-1', startIndex: 0, endIndex: 99 },
    }] })).toThrow(/word/);
  });

  it('rejects forged status counts, duplicate candidates, wrong passages, and missing model rationale', () => {
    const proposal = validModelProposal();
    expect(() => validateAlignmentProposal(modelPacket(), { ...proposal, status: 'ambiguous' })).toThrow();
    expect(() => validateAlignmentProposal(modelPacket(), { ...proposal, status: 'ambiguous',
      candidates: [proposal.candidates[0]!, proposal.candidates[0]!] })).toThrow(/重複/);
    expect(() => validateAlignmentProposal(modelPacket(), { ...proposal, passageId: 'missing' })).toThrow(/passage/);
    expect(() => validateAlignmentProposal(modelPacket(), { ...proposal,
      candidates: [{ ...proposal.candidates[0]!, rationale: undefined }] })).toThrow(/rationale/);
  });

  it('does not let a model hide a known repeated literal to forge unique status', () => {
    const repeated = packet({
      script: { schemaVersion: 1, documentId: 's', revision: 'sr', text: 'はい',
        passages: [{ id: 'p', range: { start: 0, end: 2 } }] },
      transcript: { revision: 'tr', words: [
        { index: 0, text: 'はい', startMs: 0, endMs: 100 },
        { index: 1, text: 'いいえ', startMs: 100, endMs: 200 },
        { index: 2, text: 'はい', startMs: 200, endMs: 300 },
      ] },
    });
    const complete = buildLiteralAlignments(repeated, generator)[0]!;
    const hidden = { ...complete, status: 'unique' as const, candidates: complete.candidates.slice(0, 1) };
    expect(() => validateAlignmentProposal(repeated, hidden)).toThrow(/LITERAL_CANDIDATE_MISSING/);
    const relabelled = { ...complete, candidates: [complete.candidates[0]!, {
      match: 'model_suggested' as const, rationale: 'モデルが選択', wordRef: complete.candidates[1]!.wordRef,
    }] };
    expect(() => validateAlignmentProposal(repeated, relabelled)).toThrow(/LITERAL_CANDIDATE_MISSING/);
  });

  it('batch-validates multiple passages with one fixed packet and fails the whole batch on stale content', () => {
    const input = packet({
      script: { schemaVersion: 1, documentId: 's', revision: 'sr', text: '価格\nです', passages: [
        { id: 'p1', range: { start: 0, end: 2 } },
        { id: 'p2', range: { start: 3, end: 5 } },
      ] },
    });
    const proposals = buildLiteralAlignments(input, generator);
    expect(validateAlignmentProposals(input, proposals)).toEqual(proposals);
    expect(() => validateAlignmentProposals(input, [proposals[0], { ...proposals[1], editRevision: 'stale' }]))
      .toThrow(/editRevision/);
  });
});
