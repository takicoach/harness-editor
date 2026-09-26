import { z } from 'zod';
import { validateScriptEditArtifact, type ScriptEditArtifact } from './scriptEditArtifact';
import { deriveScriptStructurePlan } from './scriptEditProposal';
import { nativeScriptStructureRanges,type NativeScriptRange } from './sequence/scriptBinding';

const frameRangeSchema = z.object({
  originalStart: z.number().int().nonnegative(),
  originalEnd: z.number().int().positive(),
}).strict();

const captionModificationSchema = z.object({
  kind: z.literal('caption'),
  changes: z.array(z.object({
    telopId: z.number().int().nonnegative(),
    after: z.string().max(10_000),
  }).strict()).max(200_000),
}).strict();

const structureModificationSchema = z.object({
  kind: z.literal('structure'),
  cutOrder: z.array(frameRangeSchema).max(200_001),
}).strict();

/** The human-authored delta stored beside the immutable model artifact. */
export const scriptEditModificationSchema = z.discriminatedUnion('kind', [
  captionModificationSchema,
  structureModificationSchema,
]);
export type ScriptEditModification = z.infer<typeof scriptEditModificationSchema>;

/** A model-comparison plan has the same editable surface as a human correction,
 * but may intentionally reproduce the proposal or the current input. */
export const scriptEditCandidatePlanSchema = scriptEditModificationSchema;
export type ScriptEditCandidatePlan = z.infer<typeof scriptEditCandidatePlanSchema>;

export type ResolvedScriptEditPlan = ({
  kind: 'caption';
  changes: Array<{ telopId: number; before: string; after: string }>;
} | {
  kind: 'structure';
  cutRegions: Array<{ start: number; end: number }>;
  cutOrder: Array<{ originalStart: number; originalEnd: number }>;
}) & {native?:{documentId:string;contentHash:string;occurrenceId:string;ranges?:NativeScriptRange[];targets?:Array<{telopId:number;clipId:string}>}};

function sameRanges(
  left: ReadonlyArray<{ originalStart: number; originalEnd: number }>,
  right: ReadonlyArray<{ originalStart: number; originalEnd: number }>,
): boolean {
  return left.length === right.length && left.every((range, index) => {
    const other = right[index];
    return other !== undefined
      && range.originalStart === other.originalStart
      && range.originalEnd === other.originalEnd;
  });
}

function keptRanges(totalFrames: number, cuts: ReadonlyArray<{ start: number; end: number }>) {
  const result: Array<{ originalStart: number; originalEnd: number }> = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cursor < cut.start) result.push({ originalStart: cursor, originalEnd: cut.start });
    cursor = cut.end;
  }
  if (cursor < totalFrames) result.push({ originalStart: cursor, originalEnd: totalFrames });
  return result;
}

function cutsOutside(
  totalFrames: number,
  sourceOrderedRanges: ReadonlyArray<{ originalStart: number; originalEnd: number }>,
) {
  const cutRegions: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const range of sourceOrderedRanges) {
    if (cursor < range.originalStart) cutRegions.push({ start: cursor, end: range.originalStart });
    cursor = range.originalEnd;
  }
  if (cursor < totalFrames) cutRegions.push({ start: cursor, end: totalFrames });
  return cutRegions;
}

function parseModification(value: unknown): ScriptEditModification {
  const parsed = scriptEditModificationSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('INVALID_SCRIPT_MODIFICATION: 修正内容の形式が不正です');
  }
  return parsed.data;
}

function resolveCaptionChanges(
  artifact: ScriptEditArtifact,
  modification: Extract<ScriptEditModification, { kind: 'caption' }>,
) {
  if (artifact.proposal.kind !== 'caption') {
    throw new Error('SCRIPT_MODIFICATION_KIND_MISMATCH: 変更案と修正内容の種類が一致しません');
  }
  const proposedChanges = artifact.proposal.changes;
  const proposedById = new Map(proposedChanges.map(change => [change.telopId, change]));
  const modifiedById = new Map<number, string>();
  for (const change of modification.changes) {
    if (modifiedById.has(change.telopId)) {
      throw new Error('SCRIPT_MODIFICATION_TARGET_DUPLICATE: 同じ字幕を複数回修正できません');
    }
    if (!proposedById.has(change.telopId)) {
      throw new Error(`SCRIPT_MODIFICATION_TARGET_UNKNOWN: 変更案にない字幕です: ${change.telopId}`);
    }
    if (!change.after.trim()) {
      throw new Error(`SCRIPT_MODIFICATION_TEXT_REQUIRED: 字幕 ${change.telopId} の修正文を入力してください`);
    }
    modifiedById.set(change.telopId, change.after);
  }
  if (modifiedById.size !== proposedChanges.length) {
    throw new Error('SCRIPT_MODIFICATION_TARGETS_INCOMPLETE: 変更案の字幕をすべて1回ずつ指定してください');
  }
  return proposedChanges.map(change => ({
    telopId: change.telopId,
    before: change.before,
    after: modifiedById.get(change.telopId)!,
  }));
}

function validateStructureCutOrder(
  artifact: ScriptEditArtifact,
  modification: Extract<ScriptEditModification, { kind: 'structure' }>,
) {
  if (artifact.proposal.kind !== 'structure') {
    throw new Error('SCRIPT_MODIFICATION_KIND_MISMATCH: 変更案と修正内容の種類が一致しません');
  }
  if (modification.cutOrder.length === 0) {
    throw new Error('SCRIPT_MODIFICATION_STRUCTURE_EMPTY: 構成には残す元素材区間を1件以上指定してください');
  }
  const seen = new Set<string>();
  const sourceOrdered = modification.cutOrder.map(range => ({ ...range }))
    .sort((a, b) => a.originalStart - b.originalStart || a.originalEnd - b.originalEnd);
  for (const range of sourceOrdered) {
    if (range.originalEnd <= range.originalStart || range.originalEnd > artifact.input.editing.totalFrames) {
      throw new Error('SCRIPT_MODIFICATION_RANGE_INVALID: 元素材区間は素材内の空でない範囲を指定してください');
    }
    const key = `${range.originalStart}:${range.originalEnd}`;
    if (seen.has(key)) {
      throw new Error('SCRIPT_MODIFICATION_RANGE_DUPLICATE: 同じ元素材区間を複数回指定できません');
    }
    seen.add(key);
  }
  for (let index = 1; index < sourceOrdered.length; index += 1) {
    if (sourceOrdered[index]!.originalStart < sourceOrdered[index - 1]!.originalEnd) {
      throw new Error('SCRIPT_MODIFICATION_RANGE_OVERLAP: 元素材区間を重ねて指定できません');
    }
  }
  return sourceOrdered;
}

/** Validates a human correction against the exact immutable model artifact. */
export function validateScriptEditModification(
  artifactValue: unknown,
  value: unknown,
): ScriptEditModification {
  const artifact = validateScriptEditArtifact(artifactValue);
  const modification = parseModification(value);
  if (modification.kind !== artifact.proposal.kind) {
    throw new Error('SCRIPT_MODIFICATION_KIND_MISMATCH: 変更案と修正内容の種類が一致しません');
  }

  if (modification.kind === 'caption' && artifact.proposal.kind === 'caption') {
    const proposal = artifact.proposal;
    const changes = resolveCaptionChanges(artifact, modification);
    if (changes.every((change, index) => change.after === proposal.changes[index]!.after)) {
      throw new Error('NO_SCRIPT_MODIFICATION: 修正内容が元の提案と同じです。通常の「採用」を選んでください');
    }
    if (changes.every(change => change.after === change.before)) {
      throw new Error('NO_SCRIPT_MODIFICATION: 字幕が現在の内容と同じです。反映せず「却下」を選んでください');
    }
    return { kind: 'caption', changes: changes.map(({ telopId, after }) => ({ telopId, after })) };
  }

  if (modification.kind === 'structure' && artifact.proposal.kind === 'structure') {
    validateStructureCutOrder(artifact, modification);
    if(artifact.input.native)nativeScriptStructureRanges(artifact,modification);

    const cutOrder = modification.cutOrder.map(range => ({ ...range }));
    const proposed = deriveScriptStructurePlan(artifact.input, artifact.proposal);
    if (sameRanges(cutOrder, proposed.cutOrder)) {
      throw new Error('NO_SCRIPT_MODIFICATION: 修正内容が元の提案と同じです。通常の「採用」を選んでください');
    }
    const currentOrder = artifact.input.editing.cutOrder.length > 0
      ? artifact.input.editing.cutOrder
      : keptRanges(artifact.input.editing.totalFrames, artifact.input.editing.cutRegions);
    if (sameRanges(cutOrder, currentOrder)) {
      throw new Error('NO_SCRIPT_MODIFICATION: 構成が現在の編集と同じです。反映せず「却下」を選んでください');
    }
    return { kind: 'structure', cutOrder };
  }

  // The matching branches above are exhaustive, but keep a runtime guard for untyped callers.
  throw new Error('SCRIPT_MODIFICATION_KIND_MISMATCH: 変更案と修正内容の種類が一致しません');
}

/** Resolve a comparison candidate without turning it into a human correction.
 * Exact proposal/current-input reproductions remain valid so the evaluator can classify them. */
function resolveScriptEditCandidatePlanBase(
  artifactValue: unknown,
  planValue: unknown,
): ResolvedScriptEditPlan {
  const artifact = validateScriptEditArtifact(artifactValue);
  const plan = parseModification(planValue);
  if (plan.kind !== artifact.proposal.kind) {
    throw new Error('SCRIPT_MODIFICATION_KIND_MISMATCH: 変更案と修正内容の種類が一致しません');
  }
  if (plan.kind === 'caption') {
    return { kind: 'caption', changes: resolveCaptionChanges(artifact, plan) };
  }
  const sourceOrdered = validateStructureCutOrder(artifact, plan);
  return {
    kind: 'structure',
    cutRegions: cutsOutside(artifact.input.editing.totalFrames, sourceOrdered),
    cutOrder: plan.cutOrder.map(range => ({ ...range })),
  };
}

/** Resolves the model proposal or its reviewed human correction without mutating either input. */
function resolveScriptEditPlanBase(
  artifactValue: unknown,
  modificationValue?: unknown,
): ResolvedScriptEditPlan {
  const artifact: ScriptEditArtifact = validateScriptEditArtifact(artifactValue);
  if (modificationValue === undefined) {
    if (artifact.proposal.kind === 'caption') {
      return {
        kind: 'caption',
        changes: artifact.proposal.changes.map(change => ({
          telopId: change.telopId,
          before: change.before,
          after: change.after,
        })),
      };
    }
    const plan = deriveScriptStructurePlan(artifact.input, artifact.proposal);
    return {
      kind: 'structure',
      cutRegions: plan.cutRegions.map(region => ({ ...region })),
      cutOrder: plan.cutOrder.map(range => ({ ...range })),
    };
  }

  const modification = validateScriptEditModification(artifact, modificationValue);
  if (modification.kind === 'caption' && artifact.proposal.kind === 'caption') {
    const byId = new Map(modification.changes.map(change => [change.telopId, change.after]));
    return {
      kind: 'caption',
      changes: artifact.proposal.changes.map(change => ({
        telopId: change.telopId,
        before: change.before,
        after: byId.get(change.telopId)!,
      })),
    };
  }
  if (modification.kind === 'structure') {
    const sourceOrdered = [...modification.cutOrder]
      .sort((a, b) => a.originalStart - b.originalStart || a.originalEnd - b.originalEnd);
    return {
      kind: 'structure',
      cutRegions: cutsOutside(artifact.input.editing.totalFrames, sourceOrdered),
      cutOrder: modification.cutOrder.map(range => ({ ...range })),
    };
  }
  throw new Error('SCRIPT_MODIFICATION_KIND_MISMATCH: 変更案と修正内容の種類が一致しません');
}

function withNativePlan(plan:ResolvedScriptEditPlan,artifact:ScriptEditArtifact,modification?:ScriptEditModification):ResolvedScriptEditPlan {
  const binding=artifact.input.native;if(!binding)return plan;
  return {...plan,native:{documentId:binding.documentId,contentHash:binding.contentHash,occurrenceId:binding.source.occurrenceId,
    ...(plan.kind==='structure'?{ranges:nativeScriptStructureRanges(artifact,modification)}:
      {targets:plan.changes.map(change=>({telopId:change.telopId,clipId:binding.captions.find(item=>item.telopId===change.telopId)!.clipId}))})}};
}
export function resolveScriptEditCandidatePlan(artifactValue:unknown,planValue:unknown):ResolvedScriptEditPlan {
  return withNativePlan(resolveScriptEditCandidatePlanBase(artifactValue,planValue),validateScriptEditArtifact(artifactValue),parseModification(planValue));
}
export function resolveScriptEditPlan(artifactValue:unknown,modificationValue?:unknown):ResolvedScriptEditPlan {
  return withNativePlan(resolveScriptEditPlanBase(artifactValue,modificationValue),validateScriptEditArtifact(artifactValue),modificationValue===undefined?undefined:parseModification(modificationValue));
}
