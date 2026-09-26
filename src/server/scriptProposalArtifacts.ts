import { createHash } from 'node:crypto';
import {
  scriptInputPacketSchema,
  type AlignmentProposal, type ScriptInputPacket,
} from '../core/scriptAlignment';
import { readAtomicJsonFile, updateAtomicJsonFile } from '../shared/atomicJsonFile.node';
import { validateScriptProposalArtifact, type ScriptProposalArtifact } from '../core/scriptProposalArtifact';
export type { ScriptProposalArtifact } from '../core/scriptProposalArtifact';

/** Canonical JSON only: rejects data that JSON would silently omit or coerce. */
export function scriptContentHash(value: unknown): string {
  function canonical(input: unknown): string {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (input && typeof input === 'object' && Object.getOwnPropertySymbols(input).length) throw new Error('INVALID_JSON: symbol property');
    if (Array.isArray(input)) {
      const keys = Object.keys(input);
      if (keys.length !== input.length || keys.some((key, index) => key !== String(index))) throw new Error('INVALID_JSON: sparse or decorated array');
      return `[${input.map(canonical).join(',')}]`;
    }
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
      if (Object.getOwnPropertyNames(input).length !== Object.keys(input).length) throw new Error('INVALID_JSON: non-enumerable property');
      return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    throw new Error('INVALID_JSON: expected finite JSON data');
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Hash parsed schema data, independent of object-key order and model metadata. */
export function sealScriptInputPacket(input: unknown): ScriptInputPacket {
  const draft = scriptInputPacketSchema.parse(input);
  const { packetHash: _hash, ...content } = draft;
  return { ...draft, packetHash: scriptContentHash(content) };
}

export function verifyScriptInputPacket(input: unknown): ScriptInputPacket {
  const packet = scriptInputPacketSchema.parse(input);
  if (sealScriptInputPacket(packet).packetHash !== packet.packetHash) throw new Error('PACKET_HASH_MISMATCH: 入力の内容が変わっています');
  return packet;
}

/** This records correspondence proposals, never acceptance, execution, or learning consent. */
export function parseScriptProposalArtifact(input: unknown): ScriptProposalArtifact {
  const artifact = validateScriptProposalArtifact(input);
  verifyScriptInputPacket(artifact.packet);
  return artifact;
}

export function createScriptProposalArtifact(packet: ScriptInputPacket, proposals: AlignmentProposal[]): ScriptProposalArtifact {
  return parseScriptProposalArtifact({ schemaVersion: 1, kind: 'script-alignment-proposals', state: 'unapplied', packet, proposals });
}

export function assertScriptArtifactCurrent(artifact: ScriptProposalArtifact, current: unknown): void {
  const checked = parseScriptProposalArtifact(artifact);
  const packet = verifyScriptInputPacket(current);
  if (checked.packet.packetHash !== packet.packetHash) throw new Error('STALE_SCRIPT_PROPOSAL: 現在の台本・発話・素材・編集内容と一致しません');
}

/** Immutable local artifact: exact retries succeed; differing data or corrupt files remain intact. */
export function saveScriptProposalArtifact(file: string, input: unknown): ScriptProposalArtifact {
  const next = parseScriptProposalArtifact(input);
  return updateAtomicJsonFile<ScriptProposalArtifact | null>(file,
    () => readAtomicJsonFile(file, parseScriptProposalArtifact, () => null),
    current => {
      if (current === null) return next;
      if (scriptContentHash(current) !== scriptContentHash(next)) throw new Error('ARTIFACT_CONFLICT: 既存の提案を上書きせず別ファイルへ保存してください');
      return current;
    })!;
}
