import { describe, expect, it } from 'vitest';
import { buildLiteralAlignments, type AlignmentGenerator, type ScriptInputPacket } from './scriptAlignment';
import type { ScriptProposalArtifact } from './scriptProposalArtifact';
import {
  deriveScriptStructurePlan,
  validateScriptEditInput,
  validateScriptEditProposal,
  type ScriptEditInput,
  type ScriptEditProposal,
} from './scriptEditProposal';

const INPUT_HASH = 'c'.repeat(64);
const generator = (skillId: AlignmentGenerator['skillId']): AlignmentGenerator => ({
  skillId, skillVersion: '1', provider: 'fixture', model: 'fixture', configHash: 'b'.repeat(64),
});

function alignment(skillId: AlignmentGenerator['skillId'] = 'script-structure'): ScriptProposalArtifact {
  const packet: ScriptInputPacket = {
    schemaVersion: 1, packetHash: 'a'.repeat(64), projectId: 'p', editRevision: 'edit-1',
    source: { id: 'main.mp4', revision: 'source-1', durationMs: 4_000 },
    script: { schemaVersion: 1, documentId: 'script', revision: 'script-1', text: 'こんにちは\n世界', passages: [
      { id: 'hello', range: { start: 0, end: 5 } }, { id: 'world', range: { start: 6, end: 8 } },
    ] },
    transcript: { revision: 'transcript-1', words: [
      { index: 0, text: 'こんにちは', startMs: 0, endMs: 1_000 },
      { index: 1, text: 'つなぎ', startMs: 1_000, endMs: 2_000 },
      { index: 2, text: '世界', startMs: 2_000, endMs: 3_000 },
    ] },
  };
  return { schemaVersion: 1, kind: 'script-alignment-proposals', state: 'unapplied',
    packet, proposals: buildLiteralAlignments(packet, generator(skillId)) };
}

function input(skillId: AlignmentGenerator['skillId'] = 'script-structure'): ScriptEditInput {
  return {
    schemaVersion: 1, inputHash: INPUT_HASH, alignment: alignment(skillId),
    editing: {
      fps: 30, totalFrames: 120,
      telops: [
        { id: 1, originalStart: 0, originalEnd: 30, text: 'こんにちわ' },
        { id: 2, originalStart: 60, originalEnd: 90, text: 'せかい' },
      ],
      cutRegions: [{ start: 30, end: 60 }, { start: 90, end: 120 }],
      cutOrder: [{ originalStart: 60, originalEnd: 90 }, { originalStart: 0, originalEnd: 30 }],
    },
  };
}

function structure(): ScriptEditProposal {
  return {
    schemaVersion: 1, kind: 'structure', proposalId: `script-edit:structure:${INPUT_HASH}`,
    inputHash: INPUT_HASH, generator: generator('script-structure'), passages: [
      { passageId: 'hello', action: 'use', candidateIndex: 0, reason: '冒頭の発話に一致' },
      { passageId: 'world', action: 'use', candidateIndex: 0, reason: '後半の発話に一致' },
    ],
  };
}

function caption(): ScriptEditProposal {
  return {
    schemaVersion: 1, kind: 'caption', proposalId: `script-edit:caption:${INPUT_HASH}`,
    inputHash: INPUT_HASH, generator: generator('subtitle-orthography'), passages: [
      { passageId: 'hello', action: 'use', candidateIndex: 0, reason: '字幕の発話に一致' },
      { passageId: 'world', action: 'skip', reason: '変更しない' },
    ], changes: [{ telopId: 1, before: 'こんにちわ', after: 'こんにちは', passageId: 'hello',
      scriptRange: { start: 0, end: 5 }, wordRef: { transcriptRevision: 'transcript-1', startIndex: 0, endIndex: 1 } }],
  };
}

describe('script edit input', () => {
  it('accepts an exact saved snapshot and implicit source-order cutOrder', () => {
    expect(validateScriptEditInput(input()).editing.cutOrder).toHaveLength(2);
    expect(validateScriptEditInput({ ...input(), editing: { ...input().editing, cutOrder: [] } }).editing.cutOrder).toEqual([]);
    expect(validateScriptEditInput({ ...input(), editing: {
      ...input().editing, cutRegions: [], cutOrder: [
        { originalStart: 30, originalEnd: 120 }, { originalStart: 0, originalEnd: 30 },
      ],
    } }).editing.cutOrder).toHaveLength(2);
  });

  it('rejects source duration drift, duplicate IDs, bad cuts, and incomplete explicit order', () => {
    expect(() => validateScriptEditInput({ ...input(), editing: { ...input().editing, totalFrames: 100 } })).toThrow(/DURATION/);
    expect(() => validateScriptEditInput({ ...input(), editing: { ...input().editing,
      telops: [...input().editing.telops, { ...input().editing.telops[0]! }] } })).toThrow(/ID_DUPLICATE/);
    expect(() => validateScriptEditInput({ ...input(), editing: { ...input().editing,
      cutRegions: [{ start: 40, end: 70 }, { start: 60, end: 80 }] } })).toThrow(/CUT_RANGE/);
    expect(() => validateScriptEditInput({ ...input(), editing: { ...input().editing,
      cutOrder: [{ originalStart: 0, originalEnd: 30 }] } })).toThrow(/CUT_ORDER/);
  });
});

describe('typed script edit proposals', () => {
  it('requires every passage in canonical order and binds stable ID/kind/input/generator', () => {
    expect(validateScriptEditProposal(input(), structure())).toEqual(structure());
    expect(() => validateScriptEditProposal(input(), { ...structure(), passages: structure().passages.slice(0, 1) })).toThrow(/INCOMPLETE/);
    expect(() => validateScriptEditProposal(input(), { ...structure(), passages: [...structure().passages].reverse() })).toThrow(/ORDER/);
    expect(() => validateScriptEditProposal(input(), { ...structure(), proposalId: 'replacement' })).toThrow(/PROPOSAL_ID/);
    expect(() => validateScriptEditProposal(input(), { ...structure(), inputHash: 'd'.repeat(64) })).toThrow(/INPUT_CONFLICT/);
  });

  it('requires explicit candidate selection and a reason for skip, and rejects all-skip structure', () => {
    expect(() => validateScriptEditProposal(input(), { ...structure(), passages: [
      { passageId: 'hello', action: 'use', candidateIndex: 99, reason: '候補を選択' }, structure().passages[1],
    ] })).toThrow(/CANDIDATE/);
    expect(() => validateScriptEditProposal(input(), { ...structure(), passages: structure().passages.map((p) => ({
      passageId: p.passageId, action: 'skip', reason: '除外',
    })) })).toThrow(/STRUCTURE_EMPTY/);
    expect(() => validateScriptEditProposal(input(), { ...structure(), passages: [
      { passageId: 'hello', action: 'skip', reason: '' }, structure().passages[1],
    ] })).toThrow();
  });

  it('derives structure frames only from fixed transcript words and preserves script order anchors', () => {
    expect(deriveScriptStructurePlan(input(), structure())).toEqual({
      cutRegions: [{ start: 30, end: 60 }, { start: 90, end: 120 }],
      cutOrder: [{ originalStart: 0, originalEnd: 30 }, { originalStart: 60, originalEnd: 90 }],
    });
    expect(() => validateScriptEditProposal(input(), { ...structure(), startMs: 0 })).toThrow();
  });

  it('accepts exact caption text/evidence without changing timing', () => {
    const value = input('subtitle-orthography');
    expect(validateScriptEditProposal(value, caption())).toEqual(caption());
    expect(() => validateScriptEditProposal(value, { ...caption(), changes: [] })).toThrow();
  });

  it('rejects stale text, candidate escape, time mismatch, no-op, and unknown time fields', () => {
    const value = input('subtitle-orthography');
    const base = caption() as Extract<ScriptEditProposal, { kind: 'caption' }>;
    const change = base.changes[0]!;
    expect(() => validateScriptEditProposal(value, { ...base, changes: [{ ...change, before: '古い' }] })).toThrow(/BASE/);
    expect(() => validateScriptEditProposal(value, { ...base, changes: [{ ...change,
      wordRef: { transcriptRevision: 'transcript-1', startIndex: 0, endIndex: 2 } }] })).toThrow(/EVIDENCE/);
    expect(() => validateScriptEditProposal(value, { ...base, changes: [{ ...change, telopId: 2, before: 'せかい' }] })).toThrow(/TIME/);
    const noOpInput = { ...value, editing: { ...value.editing, telops: value.editing.telops.map((item) =>
      item.id === 1 ? { ...item, text: 'こんにちは' } : item) } };
    expect(() => validateScriptEditProposal(noOpInput, { ...base, changes: [{ ...change, before: 'こんにちは' }] })).toThrow(/NO_OP/);
    expect(() => validateScriptEditProposal(value, { ...base, changes: [{ ...change, startMs: 0 }] })).toThrow();
  });

  it('rejects duplicate telop changes and overlapping word/script evidence', () => {
    const value = input('subtitle-orthography');
    const base = caption() as Extract<ScriptEditProposal, { kind: 'caption' }>;
    expect(() => validateScriptEditProposal(value, { ...base, changes: [...base.changes, { ...base.changes[0]! }] }))
      .toThrow(/TELOP_CHANGE_DUPLICATE/);
  });
});
