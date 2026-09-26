import { describe, expect, it } from 'vitest';
import { buildLiteralAlignments, type AlignmentGenerator } from '../core/scriptAlignment';
import {
  createScriptProposalArtifact,
  parseScriptProposalArtifact,
  sealScriptInputPacket,
} from './scriptProposalArtifacts';

const generator: AlignmentGenerator = {
  skillId: 'subtitle-orthography', skillVersion: '1', provider: 'deterministic', model: 'literal-v1', configHash: 'a'.repeat(64),
};

function artifact() {
  const packet = sealScriptInputPacket({
    schemaVersion: 1, packetHash: '0'.repeat(64), projectId: 'audit-project', editRevision: 'edit-1',
    source: { id: 'main.mp4', revision: 'source-1', durationMs: 1_000 },
    script: { schemaVersion: 1, documentId: 'script', revision: 'script-1', text: 'はい',
      passages: [{ id: 'passage-1', range: { start: 0, end: 2 } }] },
    transcript: { revision: 'transcript-1', words: [{ index: 0, text: 'はい', startMs: 100, endMs: 300 }] },
  });
  return createScriptProposalArtifact(packet, buildLiteralAlignments(packet, generator));
}

describe('script proposal artifact identity audit', () => {
  it('binds the app-owned proposal identity to the fixed packet and passage', () => {
    const original = artifact();
    const relabelled = structuredClone(original);
    relabelled.proposals[0]!.proposalId = 'model-chosen-second-identity';

    // A model may add a reasoned correspondence candidate, but must not mint a second identity
    // for the same fixed proposal: later acceptance retries use that identity for one application.
    expect(() => parseScriptProposalArtifact(relabelled)).toThrow(/PROPOSAL_ID_CONFLICT/);
  });
});
