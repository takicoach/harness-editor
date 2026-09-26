import { validateScriptEditArtifact, type ScriptEditArtifact } from '../core/scriptEditArtifact';
export type { ScriptEditArtifact } from '../core/scriptEditArtifact';
import {
  validateScriptEditInput,
  type ScriptEditInput,
} from '../core/scriptEditProposal';
import { readAtomicJsonFile, updateAtomicJsonFile } from '../shared/atomicJsonFile.node';
import { parseScriptProposalArtifact, scriptContentHash } from './scriptProposalArtifacts';

/** Sealing caller data is not proof that it came from the current project. */
export function sealScriptEditInput(value: unknown): ScriptEditInput {
  const input = validateScriptEditInput(value);
  parseScriptProposalArtifact(input.alignment);
  const { inputHash: _hash, ...content } = input;
  return { ...input, inputHash: scriptContentHash(content) };
}

export function verifyScriptEditInput(value: unknown): ScriptEditInput {
  const input = validateScriptEditInput(value);
  if (sealScriptEditInput(input).inputHash !== input.inputHash) {
    throw new Error('SCRIPT_EDIT_INPUT_HASH_MISMATCH: 変更案の入力内容が変わっています');
  }
  return input;
}

/** No apply receipt, owner judgment, or learning consent can be smuggled into a proposal. */
export function parseScriptEditArtifact(value: unknown): ScriptEditArtifact {
  const artifact = validateScriptEditArtifact(value);
  verifyScriptEditInput(artifact.input);
  return artifact;
}

export function createScriptEditArtifact(input: ScriptEditInput, proposal: unknown): ScriptEditArtifact {
  return parseScriptEditArtifact({ schemaVersion: 1, kind: 'script-edit-proposal', state: 'unapplied', input, proposal });
}

export function assertScriptEditArtifactCurrent(value: unknown, current: unknown): void {
  const artifact = parseScriptEditArtifact(value);
  const live = verifyScriptEditInput(current);
  // Alignment candidates are model output, not current project state. A fresh
  // literal collector need not reproduce that output; the sealed stored input
  // still binds precisely which candidates the proposal selected.
  if (artifact.input.alignment.packet.packetHash !== live.alignment.packet.packetHash
    || scriptContentHash(artifact.input.editing) !== scriptContentHash(live.editing)
    || scriptContentHash(artifact.input.native??null)!==scriptContentHash(live.native??null)) {
    throw new Error('STALE_SCRIPT_EDIT: 現在の台本・発話・字幕・構成と変更案の入力が異なります');
  }
}

/** Immutable draft persistence only. Exact retries preserve the original artifact. */
export function saveScriptEditArtifact(file: string, value: unknown): ScriptEditArtifact {
  const next = parseScriptEditArtifact(value);
  return updateAtomicJsonFile<ScriptEditArtifact | null>(file,
    () => readAtomicJsonFile(file, parseScriptEditArtifact, () => null),
    previous => {
      if (previous === null) return next;
      if (scriptContentHash(previous) !== scriptContentHash(next)) {
        throw new Error('SCRIPT_EDIT_ARTIFACT_CONFLICT: 保存済みの変更案と異なります。別のファイルへ保存してください');
      }
      return previous;
    })!;
}
