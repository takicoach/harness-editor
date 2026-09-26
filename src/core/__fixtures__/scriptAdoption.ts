import { buildLiteralAlignments } from '../scriptAlignment';
import { createScriptDocument } from '../scriptDocumentData';
import { createScriptEditArtifact, sealScriptEditInput } from '../../server/scriptEditArtifacts';
import { createScriptProposalArtifact, sealScriptInputPacket } from '../../server/scriptProposalArtifacts';
import type { ScriptJudgmentExample } from '../../learning/scriptDecisions';

/** Synthetic, sealed fixture. Never an owner's preference label. */
export function scriptAdoptionFixture(kind: 'caption' | 'structure' = 'caption') {
  const script = createScriptDocument('はい', { documentId: 'script', revision: 'script-1' });
  const generator = { skillId: kind === 'caption' ? 'subtitle-orthography' as const : 'script-structure' as const,
    skillVersion: '1', provider: 'fixture', model: 'fixture', configHash: '0'.repeat(64) };
  const packet = sealScriptInputPacket({ schemaVersion: 1, packetHash: '0'.repeat(64), projectId: 'project', editRevision: 'edit-1',
    source: { id: 'main.mp4', revision: 'source-1', durationMs: 2000 }, script,
    transcript: { revision: 'transcript-1', words: [{ index: 0, text: 'はい', startMs: 500, endMs: 1500 }] } });
  const input = sealScriptEditInput({ schemaVersion: 1, inputHash: '0'.repeat(64),
    alignment: createScriptProposalArtifact(packet, buildLiteralAlignments(packet, generator)),
    editing: { fps: 30, totalFrames: 60, telops: [{ id: 1, text: 'ハイ', originalStart: 15, originalEnd: 45 }], cutRegions: [], cutOrder: [] } });
  const common = { schemaVersion: 1 as const, inputHash: input.inputHash, proposalId: `script-edit:${kind}:${input.inputHash}`, generator,
    passages: [{ passageId: script.passages[0]!.id, action: 'use' as const, candidateIndex: 0, reason: '台本の表記を使う' }] };
  return createScriptEditArtifact(input, kind === 'structure' ? { ...common, kind } : { ...common, kind,
    changes: [{ telopId: 1, before: 'ハイ', after: 'はい', passageId: script.passages[0]!.id, scriptRange: { start: 0, end: 2 },
      wordRef: { transcriptRevision: 'transcript-1', startIndex: 0, endIndex: 1 } }] });
}
export function scriptJudgmentFixture(): ScriptJudgmentExample {
  return { schemaVersion: 1, type: 'script_judgment', id: 'judgment', operationId: 'record-judgment', createdAt: '2026-09-08T00:00:00Z',
    actor: { kind: 'human', id: 'fixture-user' }, projectId: 'project', projectRevision: 'edit-1', artifact: scriptAdoptionFixture(),
    decision: 'accepted', reasonCode: 'unspecified', note: '', learningConsent: false,
    scope: { kind: 'project', id: 'project' }, provenance: { kind: 'synthetic' }, application: { sessionId: 'browser', baseRevision: 'r1' } };
}
