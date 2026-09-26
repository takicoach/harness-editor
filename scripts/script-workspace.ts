import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildLiteralAlignments, alignmentGeneratorSchema } from '../src/core/scriptAlignment';
import {
  assertScriptArtifactCurrent, createScriptProposalArtifact, parseScriptProposalArtifact,
  saveScriptProposalArtifact, sealScriptInputPacket, verifyScriptInputPacket,
} from '../src/server/scriptProposalArtifacts';
import {
  assertScriptEditArtifactCurrent, createScriptEditArtifact, parseScriptEditArtifact,
  saveScriptEditArtifact, sealScriptEditInput, verifyScriptEditInput,
} from '../src/server/scriptEditArtifacts';

const usage = `node --import tsx scripts/script-workspace.ts <command> <arguments>
  seal <draft-packet.json>                  Print a content-bound packet as JSON.
  literal <packet.json> <generator.json> <new-artifact.json>
  validate <artifact.json> <current-packet.json>
  store <artifact.json> <current-packet.json> <new-artifact.json>
  edit-seal <draft-edit-input.json>        Print a content-bound editing snapshot.
  edit-create <edit-input.json> <proposal.json> <new-edit-artifact.json>
  edit-validate <edit-artifact.json> <current-edit-input.json>
  edit-store <edit-artifact.json> <current-edit-input.json> <new-edit-artifact.json>
All proposals remain unapplied. No project edits or human decisions are performed.
Source/edit revisions must come from a trusted current snapshot; this tool does not collect it.`;

function read(file: string): unknown { return JSON.parse(readFileSync(resolve(file), 'utf8')); }
function report(value: ReturnType<typeof parseScriptProposalArtifact>): void {
  console.log(JSON.stringify({ state: value.state, packetHash: value.packet.packetHash,
    passages: value.proposals.length,
    unique: value.proposals.filter(p => p.status === 'unique').length,
    ambiguous: value.proposals.filter(p => p.status === 'ambiguous').length,
    unmatched: value.proposals.filter(p => p.status === 'unmatched').length }));
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h' || command === undefined) console.log(usage);
  else if (command === 'seal' && args.length === 1) console.log(JSON.stringify(sealScriptInputPacket(read(args[0]!)), null, 2));
  else if (command === 'edit-seal' && args.length === 1) console.log(JSON.stringify(sealScriptEditInput(read(args[0]!)), null, 2));
  else if (command === 'edit-create' && args.length === 3) {
    const artifact = createScriptEditArtifact(verifyScriptEditInput(read(args[0]!)), read(args[1]!));
    const saved = saveScriptEditArtifact(resolve(args[2]!), artifact);
    console.log(JSON.stringify({ state: saved.state, inputHash: saved.input.inputHash, proposalKind: saved.proposal.kind }));
  } else if ((command === 'edit-validate' && args.length === 2) || (command === 'edit-store' && args.length === 3)) {
    const artifact = parseScriptEditArtifact(read(args[0]!));
    assertScriptEditArtifactCurrent(artifact, read(args[1]!));
    const saved = command === 'edit-store' ? saveScriptEditArtifact(resolve(args[2]!), artifact) : artifact;
    console.log(JSON.stringify({ state: saved.state, inputHash: saved.input.inputHash, proposalKind: saved.proposal.kind }));
  }
  else if (command === 'literal' && args.length === 3) {
    const packet = verifyScriptInputPacket(read(args[0]!));
    const generator = alignmentGeneratorSchema.parse(read(args[1]!));
    const artifact = createScriptProposalArtifact(packet, buildLiteralAlignments(packet, generator));
    report(saveScriptProposalArtifact(resolve(args[2]!), artifact));
  } else if ((command === 'validate' && args.length === 2) || (command === 'store' && args.length === 3)) {
    const artifact = parseScriptProposalArtifact(read(args[0]!));
    assertScriptArtifactCurrent(artifact, read(args[1]!));
    report(command === 'store' ? saveScriptProposalArtifact(resolve(args[2]!), artifact) : artifact);
  } else throw new Error(`INVALID_ARGUMENTS\n${usage}`);
} catch (error) {
  // Schema errors may contain draft text. Keep CLI diagnostics bounded and do not dump the input.
  console.error(error instanceof Error && error.name === 'ZodError' ? 'INVALID_SCHEMA: 入力または提案の形式を確認してください' : String(error));
  process.exitCode = 1;
}
