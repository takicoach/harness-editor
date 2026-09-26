import { z } from 'zod';
import { validateScriptEditInput, validateScriptEditProposal, type ScriptEditInput, type ScriptEditProposal } from './scriptEditProposal';

export interface ScriptEditArtifact {
  schemaVersion: 1;
  kind: 'script-edit-proposal';
  state: 'unapplied';
  input: ScriptEditInput;
  proposal: ScriptEditProposal;
}

const envelopeSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('script-edit-proposal'), state: z.literal('unapplied'),
  input: z.unknown(), proposal: z.unknown(),
}).strict();

/** Browser-safe structure checks. The server must additionally verify hashes and current project facts. */
export function validateScriptEditArtifact(value: unknown): ScriptEditArtifact {
  const envelope = envelopeSchema.parse(value);
  const input = validateScriptEditInput(envelope.input);
  const proposal = validateScriptEditProposal(input, envelope.proposal);
  return { schemaVersion: 1, kind: 'script-edit-proposal', state: 'unapplied', input, proposal };
}
