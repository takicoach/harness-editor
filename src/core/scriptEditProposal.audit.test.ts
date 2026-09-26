import { describe, expect, it } from 'vitest';
import { buildLiteralAlignments } from './scriptAlignment';
import { createScriptProposalArtifact, sealScriptInputPacket } from '../server/scriptProposalArtifacts';
import { sealScriptEditInput } from '../server/scriptEditArtifacts';
import { deriveScriptStructurePlan, validateScriptEditInput, validateScriptEditProposal } from './scriptEditProposal';

function input() {
  const packet = sealScriptInputPacket({ schemaVersion: 1, packetHash: '0'.repeat(64), projectId: 'audit',
    editRevision: 'e', source: { id: 'a.mp4', revision: 'v', durationMs: 2000 },
    script: { schemaVersion: 1, documentId: 's', revision: 's1', text: 'はい\n😀',
      passages: [{ id: 'p1', range: { start: 0, end: 2 } }, { id: 'p2', range: { start: 3, end: 5 } }] },
    transcript: { revision: 't', words: [
      { index: 0, text: '😀', startMs: 100, endMs: 200 },
      { index: 1, text: 'はい', startMs: 500, endMs: 900 },
    ] } });
  const alignment = createScriptProposalArtifact(packet, buildLiteralAlignments(packet, {
    skillId: 'script-structure', skillVersion: '1', provider: 'deterministic', model: 'audit', configHash: 'b'.repeat(64),
  }));
  return sealScriptEditInput({ schemaVersion: 1, inputHash: '0'.repeat(64), alignment,
    editing: { fps: 30, totalFrames: 60, cutRegions: [], cutOrder: [],
      telops: [{ id: 1, text: 'ハイ', originalStart: 15, originalEnd: 27 }, { id: 2, text: '笑顔', originalStart: 3, originalEnd: 6 }] } });
}

function plan(value: ReturnType<typeof input>) {
  return { schemaVersion: 1, kind: 'structure', proposalId: `script-edit:structure:${value.inputHash}`, inputHash: value.inputHash,
    generator: { skillId: 'script-structure', skillVersion: '1', provider: 'deterministic', model: 'audit', configHash: 'b'.repeat(64) },
    passages: [{ passageId: 'p1', action: 'use', candidateIndex: 0, reason: '台本の前段に対応する発話' }, { passageId: 'p2', action: 'use', candidateIndex: 0, reason: '台本の後段に対応する発話' }] };
}

describe('independent script edit proposal audit', () => {
  it('retains lawful adjacent cut-data boundaries in the input while requiring complete nonoverlapping source coverage', () => {
    const value = input();
    value.editing.cutOrder = [{ originalStart: 30, originalEnd: 60 }, { originalStart: 0, originalEnd: 30 }];
    expect(validateScriptEditInput(value).editing.cutOrder).toEqual(value.editing.cutOrder);
    value.editing.cutOrder[1]!.originalEnd = 29;
    expect(() => validateScriptEditInput(value)).toThrow();
  });

  it('derives a reversed script order and exact complement without mutating the fixed snapshot', () => {
    const value = input(), before = JSON.stringify(value);
    expect(deriveScriptStructurePlan(value, plan(value))).toEqual({
      cutRegions: [{ start: 0, end: 3 }, { start: 6, end: 15 }, { start: 27, end: 60 }],
      cutOrder: [{ originalStart: 15, originalEnd: 27 }, { originalStart: 3, originalEnd: 6 }],
    });
    expect(JSON.stringify(value)).toBe(before);
    const missing = plan(value); missing.passages.pop();
    expect(() => validateScriptEditProposal(value, missing)).toThrow();
    expect(() => validateScriptEditProposal(value, { ...plan(value), proposalId: 'renamed' })).toThrow();
    expect(() => validateScriptEditProposal(value, { ...plan(value), frames: [{ start: 0, end: 60 }] })).toThrow();
  });

  it('rejects caption evidence from a different take, a different time, and a partial surrogate', () => {
    const value = input();
    const base = { ...plan(value), kind: 'caption', proposalId: `script-edit:caption:${value.inputHash}`,
      generator: { ...plan(value).generator, skillId: 'subtitle-orthography' },
      passages: [{ passageId: 'p1', action: 'use', candidateIndex: 0, reason: '字幕の表記を台本に揃える' }, { passageId: 'p2', action: 'skip', reason: '今回は変更しない' }],
      changes: [{ telopId: 1, before: 'ハイ', after: 'はい', passageId: 'p1', scriptRange: { start: 0, end: 2 },
        wordRef: { transcriptRevision: 't', startIndex: 1, endIndex: 2 } }] };
    expect(validateScriptEditProposal(value, base).kind).toBe('caption');
    expect(() => validateScriptEditProposal(value, { ...base, changes: [{ ...base.changes[0],
      wordRef: { transcriptRevision: 't', startIndex: 0, endIndex: 1 } }] })).toThrow();
    expect(() => validateScriptEditProposal(value, { ...base, changes: [{ ...base.changes[0], telopId: 2, before: '笑顔' }] })).toThrow();
    expect(() => validateScriptEditProposal(value, { ...base,
      passages: [{ passageId: 'p1', action: 'skip', reason: '今回は変更しない' }, { passageId: 'p2', action: 'use', candidateIndex: 0, reason: '絵文字表記を合わせる' }],
      changes: [{ telopId: 2, before: '笑顔', after: '\ud83d', passageId: 'p2', scriptRange: { start: 3, end: 4 },
        wordRef: { transcriptRevision: 't', startIndex: 0, endIndex: 1 } }] })).toThrow('UTF16');
  });

  it('rejects both repeated use of one word span and distinct words that round onto the same frame', () => {
    const reseal = (value: ReturnType<typeof input>) => {
      const packet = sealScriptInputPacket(value.alignment.packet);
      const alignment = createScriptProposalArtifact(packet, buildLiteralAlignments(packet, value.alignment.proposals[0]!.generator));
      return sealScriptEditInput({ ...value, alignment });
    };
    const repeated = input();
    repeated.alignment.packet.script.text = 'はい\nはい';
    const repeatedInput = reseal(repeated);
    expect(() => deriveScriptStructurePlan(repeatedInput, plan(repeatedInput))).toThrow('STRUCTURE_WORD_OVERLAP');
    const rounded = input();
    rounded.alignment.packet.transcript.words[0]!.startMs = 100;
    rounded.alignment.packet.transcript.words[0]!.endMs = 115;
    rounded.alignment.packet.transcript.words[1]!.startMs = 116;
    rounded.alignment.packet.transcript.words[1]!.endMs = 130;
    const roundedInput = reseal(rounded);
    expect(() => deriveScriptStructurePlan(roundedInput, plan(roundedInput))).toThrow('STRUCTURE_FRAME_OVERLAP');
    const valid = input(), noReason = plan(valid);
    noReason.passages[0]!.reason = '';
    expect(() => validateScriptEditProposal(valid, noReason)).toThrow();
  });
});
