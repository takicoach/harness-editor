import { z } from 'zod';
import { alignmentProposalSchema, scriptInputPacketSchema, validateAlignmentProposals } from './scriptAlignment';

export const scriptProposalArtifactSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('script-alignment-proposals'), state: z.literal('unapplied'),
  packet: scriptInputPacketSchema, proposals: z.array(alignmentProposalSchema).max(20000),
}).strict();
export type ScriptProposalArtifact = z.infer<typeof scriptProposalArtifactSchema>;

/** Browser-safe structural validation. Node verifies the content hash at collection/storage boundaries. */
export function validateScriptProposalArtifact(input: unknown): ScriptProposalArtifact {
  const artifact = scriptProposalArtifactSchema.parse(input);
  const { packet } = artifact;
  validateAlignmentProposals(packet, artifact.proposals);
  const ids = new Set<string>(), passages = new Set<string>();
  for (const proposal of artifact.proposals) {
    if (proposal.proposalId !== `literal:${proposal.passageId}:${packet.packetHash}`) {
      throw new Error('PROPOSAL_ID_CONFLICT: 入力と文章に紐付いた提案IDを維持してください');
    }
    if (ids.has(proposal.proposalId) || passages.has(proposal.passageId)) throw new Error('DUPLICATE_PROPOSAL: 同じ文章の候補は一つの提案へまとめてください');
    ids.add(proposal.proposalId);
    passages.add(proposal.passageId);
  }
  if (passages.size !== packet.script.passages.length) throw new Error('INCOMPLETE_PROPOSALS: 未対応の文章も提案に残してください');
  return artifact;
}
