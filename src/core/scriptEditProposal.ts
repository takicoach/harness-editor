import { z } from 'zod';
import { nativeScriptBindingSchema } from './sequence/scriptBinding';
import { timeNumber } from './sequence/time';
import {
  alignmentGeneratorSchema,
  normalizeScriptAlignmentText,
  transcriptWordRefSchema,
  utf16RangeSchema,
  type AlignmentCandidate,
  type TranscriptWordRef,
} from './scriptAlignment';
import {
  scriptProposalArtifactSchema,
  validateScriptProposalArtifact,
} from './scriptProposalArtifact';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().trim().min(1).max(512);
const frameRange = z.object({
  originalStart: z.number().int().nonnegative(),
  originalEnd: z.number().int().positive(),
}).strict().superRefine((range, ctx) => {
  if (range.originalEnd <= range.originalStart) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frame range must not be empty' });
});
const cutRegion = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
  .superRefine((range, ctx) => {
    if (range.end <= range.start) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cut range must not be empty' });
  });
const editingSnapshotSchema = z.object({
  fps: z.number().finite().positive(),
  totalFrames: z.number().int().positive(),
  telops: z.array(frameRange.extend({ id: z.number().int().nonnegative(), text: z.string().max(2_000_000) }).strict()).max(200_000),
  cutRegions: z.array(cutRegion).max(200_000),
  cutOrder: z.array(frameRange).max(200_001),
}).strict();

export const scriptEditInputSchema = z.object({
  schemaVersion: z.literal(1),
  inputHash: sha256,
  alignment: scriptProposalArtifactSchema,
  editing: editingSnapshotSchema,
  native:nativeScriptBindingSchema.optional(),
}).strict();
export type ScriptEditInput = z.infer<typeof scriptEditInputSchema>;
const scriptEditInputEnvelopeSchema = z.object({
  schemaVersion: z.literal(1), inputHash: sha256, alignment: z.unknown(), editing: editingSnapshotSchema,native:nativeScriptBindingSchema.optional(),
}).strict();

const usePassage = z.object({
  passageId: identifier,
  action: z.literal('use'),
  candidateIndex: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(4_000),
}).strict();
const skipPassage = z.object({
  passageId: identifier,
  action: z.literal('skip'),
  reason: z.string().trim().min(1).max(4_000),
}).strict();
const passageDecision = z.discriminatedUnion('action', [usePassage, skipPassage]);

const commonProposal = {
  schemaVersion: z.literal(1),
  proposalId: identifier,
  inputHash: sha256,
  generator: alignmentGeneratorSchema,
  passages: z.array(passageDecision).max(20_000),
};
const captionChange = z.object({
  telopId: z.number().int().nonnegative(),
  before: z.string().max(2_000_000),
  after: z.string().min(1).max(2_000_000),
  passageId: identifier,
  scriptRange: utf16RangeSchema,
  wordRef: transcriptWordRefSchema,
}).strict();
const captionProposalSchema = z.object({
  ...commonProposal,
  kind: z.literal('caption'),
  changes: z.array(captionChange).min(1).max(200_000),
}).strict();
const structureProposalSchema = z.object({ ...commonProposal, kind: z.literal('structure') }).strict();
export const scriptEditProposalSchema = z.discriminatedUnion('kind', [captionProposalSchema, structureProposalSchema]);
export type ScriptEditProposal = z.infer<typeof scriptEditProposalSchema>;

export interface ScriptStructurePlan {
  cutRegions: Array<{ start: number; end: number }>;
  /** Script order. Adjacent spans remain separate so a later receiver cannot silently lose their ordering boundary. */
  cutOrder: Array<{ originalStart: number; originalEnd: number }>;
}

function currentKeptRanges(totalFrames: number, cuts: Array<{ start: number; end: number }>) {
  const kept: Array<{ originalStart: number; originalEnd: number }> = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cursor < cut.start) kept.push({ originalStart: cursor, originalEnd: cut.start });
    cursor = cut.end;
  }
  if (cursor < totalFrames) kept.push({ originalStart: cursor, originalEnd: totalFrames });
  return kept;
}

/** Validates a browser-safe snapshot. The hash itself is sealed and checked by the Node storage boundary. */
export function validateScriptEditInput(value: unknown): ScriptEditInput {
  const envelope = scriptEditInputEnvelopeSchema.parse(value);
  const alignment = validateScriptProposalArtifact(envelope.alignment);
  const input: ScriptEditInput = { ...envelope, alignment };
  const { editing } = input;
  if(input.native) {
    const binding=input.native;
    if(timeNumber(binding.fps)!==editing.fps||binding.wordTimes.length!==alignment.packet.transcript.words.length
      ||binding.captions.length!==editing.telops.length||binding.captions.some(item=>!editing.telops.some(telop=>telop.id===item.telopId)))throw new Error('NATIVE_SCRIPT_BINDING_CONFLICT: 新形式の素材と字幕参照が一致しません');
    binding.wordTimes.forEach((word,index)=>{
      const source=alignment.packet.transcript.words[index]!;
      if(timeNumber(word.start)*1000!==source.startMs||timeNumber(word.end)*1000!==source.endMs)throw new Error('NATIVE_SCRIPT_WORD_CONFLICT: 原音の正確な時刻が一致しません');
    });
  }
  const expectedFrames = alignment.packet.source.durationMs * editing.fps / 1_000;
  if (Math.abs(expectedFrames - editing.totalFrames) > 1) {
    throw new Error('SOURCE_DURATION_CONFLICT: source duration and editing frame count differ by more than one frame');
  }
  const ids = new Set<number>();
  for (const telop of editing.telops) {
    if (ids.has(telop.id)) throw new Error('TELOP_ID_DUPLICATE: telop IDs must be unique');
    ids.add(telop.id);
    if (telop.originalEnd > editing.totalFrames) throw new Error('TELOP_RANGE_INVALID: telop range exceeds the source');
  }
  let previousCutEnd = 0;
  editing.cutRegions.forEach((cut, index) => {
    if (cut.end > editing.totalFrames || (index > 0 && cut.start < previousCutEnd)) {
      throw new Error('CUT_RANGE_INVALID: cuts must be ordered, disjoint, and inside the source');
    }
    previousCutEnd = cut.end;
  });
  if (editing.cutOrder.length > 0) {
    const expected = currentKeptRanges(editing.totalFrames, editing.cutRegions);
    const actual = editing.cutOrder.map((range) => {
      if (range.originalEnd > editing.totalFrames) throw new Error('CUT_ORDER_INVALID: order range exceeds the source');
      return range;
    }).sort((a, b) => a.originalStart - b.originalStart || a.originalEnd - b.originalEnd);
    let expectedIndex = 0;
    let cursor = expected[0]?.originalStart;
    for (const range of actual) {
      const kept = expected[expectedIndex];
      if (!kept || cursor === undefined || range.originalStart !== cursor || range.originalEnd > kept.originalEnd) {
        throw new Error('CUT_ORDER_INVALID: explicit order must partition every current kept frame exactly once');
      }
      cursor = range.originalEnd;
      if (cursor === kept.originalEnd) {
        expectedIndex += 1;
        cursor = expected[expectedIndex]?.originalStart;
      }
    }
    if (expectedIndex !== expected.length) {
      throw new Error('CUT_ORDER_INVALID: explicit order must partition every current kept frame exactly once');
    }
  }
  return input;
}

function selectedCandidates(input: ScriptEditInput, proposal: ScriptEditProposal): Map<string, AlignmentCandidate> {
  const expected = input.alignment.packet.script.passages;
  if (proposal.passages.length !== expected.length) throw new Error('PASSAGE_DECISIONS_INCOMPLETE: every passage needs use or skip');
  const proposals = new Map(input.alignment.proposals.map((item) => [item.passageId, item]));
  const selected = new Map<string, AlignmentCandidate>();
  proposal.passages.forEach((decision, index) => {
    if (decision.passageId !== expected[index]!.id) throw new Error('PASSAGE_ORDER_CONFLICT: decisions must follow canonical script order');
    const alignment = proposals.get(decision.passageId)!;
    if (decision.action === 'use') {
      const candidate = alignment.candidates[decision.candidateIndex];
      if (!candidate) throw new Error('CANDIDATE_NOT_FOUND: candidateIndex is not present in the validated artifact');
      selected.set(decision.passageId, candidate);
    } else if (alignment.candidates.length === 0 && decision.reason.length === 0) {
      throw new Error('SKIP_REASON_REQUIRED');
    }
  });
  return selected;
}

function containsWordRef(container: TranscriptWordRef, child: TranscriptWordRef): boolean {
  return container.transcriptRevision === child.transcriptRevision
    && child.startIndex >= container.startIndex && child.endIndex <= container.endIndex;
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset === 0 || offset === text.length) return true;
  const previous = text.charCodeAt(offset - 1), current = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

function framesForWordRef(input: ScriptEditInput, wordRef: TranscriptWordRef) {
  const words = input.alignment.packet.transcript.words;
  if (wordRef.transcriptRevision !== input.alignment.packet.transcript.revision
    || wordRef.startIndex < 0 || wordRef.endIndex <= wordRef.startIndex || wordRef.endIndex > words.length) {
    throw new Error('WORD_RANGE_INVALID: evidence must use fixed transcript word boundaries');
  }
  const start = Math.max(0, Math.floor(words[wordRef.startIndex]!.startMs * input.editing.fps / 1_000));
  const end = Math.min(input.editing.totalFrames, Math.ceil(words[wordRef.endIndex - 1]!.endMs * input.editing.fps / 1_000));
  if (end <= start) throw new Error('FRAME_RANGE_EMPTY: selected words do not cover a source frame');
  return { originalStart: start, originalEnd: end };
}

function validateCaption(input: ScriptEditInput, proposal: Extract<ScriptEditProposal, { kind: 'caption' }>, selected: Map<string, AlignmentCandidate>) {
  const telops = new Map(input.editing.telops.map((item) => [item.id, item]));
  const passages = new Map(input.alignment.packet.script.passages.map((item) => [item.id, item]));
  const usedTelops = new Set<number>();
  const usedWordRefs: TranscriptWordRef[] = [];
  const scriptRanges: Array<{ start: number; end: number }> = [];
  const changedPassages = new Set<string>();
  for (const change of proposal.changes) {
    const telop = telops.get(change.telopId);
    if (!telop || telop.text !== change.before) throw new Error('TELOP_BASE_CONFLICT: caption before text must match the snapshot');
    if (usedTelops.has(change.telopId)) throw new Error('TELOP_CHANGE_DUPLICATE: one proposal may change each telop once');
    usedTelops.add(change.telopId);
    if (change.before === change.after) throw new Error('CAPTION_NO_OP: unchanged captions must not create an Undo entry');
    const passage = passages.get(change.passageId);
    const candidate = selected.get(change.passageId);
    if (!passage || !candidate) throw new Error('PASSAGE_NOT_SELECTED: caption evidence requires a used passage');
    if (change.scriptRange.start < passage.range.start || change.scriptRange.end > passage.range.end) {
      throw new Error('SCRIPT_RANGE_CONFLICT: caption range must stay inside its passage');
    }
    if (!isUtf16Boundary(input.alignment.packet.script.text, change.scriptRange.start)
      || !isUtf16Boundary(input.alignment.packet.script.text, change.scriptRange.end)) {
      throw new Error('SCRIPT_RANGE_UTF16_INVALID: caption range splits a surrogate pair');
    }
    const originalText = input.alignment.packet.script.text.slice(change.scriptRange.start, change.scriptRange.end);
    if (change.after !== originalText || normalizeScriptAlignmentText(originalText) === '') {
      throw new Error('SCRIPT_TEXT_CONFLICT: after must equal the exact UTF-16 script substring, including whitespace');
    }
    if (!containsWordRef(candidate.wordRef, change.wordRef)) throw new Error('WORD_EVIDENCE_CONFLICT: evidence must be inside the selected candidate');
    const evidence = framesForWordRef(input, change.wordRef);
    if (Math.max(evidence.originalStart, telop.originalStart) >= Math.min(evidence.originalEnd, telop.originalEnd)) {
      throw new Error('TELOP_TIME_CONFLICT: target telop does not overlap the fixed transcript evidence');
    }
    usedWordRefs.push(change.wordRef);
    scriptRanges.push(change.scriptRange);
    changedPassages.add(change.passageId);
  }
  usedWordRefs.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
  for (let index = 1; index < usedWordRefs.length; index += 1) {
    if (usedWordRefs[index]!.startIndex < usedWordRefs[index - 1]!.endIndex) {
      throw new Error('WORD_EVIDENCE_OVERLAP: one transcript word cannot justify two caption changes');
    }
  }
  scriptRanges.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < scriptRanges.length; index += 1) {
    if (scriptRanges[index]!.start < scriptRanges[index - 1]!.end) {
      throw new Error('SCRIPT_RANGE_OVERLAP: caption script ranges must not overlap');
    }
  }
  for (const passageId of selected.keys()) {
    if (!changedPassages.has(passageId)) throw new Error('CAPTION_CHANGE_MISSING: every used passage needs at least one typed caption change');
  }
}

/** Strictly validates a typed, still-unapplied proposal against the exact input snapshot. */
export function validateScriptEditProposal(inputValue: unknown, proposalValue: unknown): ScriptEditProposal {
  const input = validateScriptEditInput(inputValue);
  return validateProposalAgainstInput(input, proposalValue).proposal;
}

function validateProposalAgainstInput(input: ScriptEditInput, proposalValue: unknown) {
  const proposal = scriptEditProposalSchema.parse(proposalValue);
  if (proposal.inputHash !== input.inputHash) throw new Error('SCRIPT_EDIT_INPUT_CONFLICT: proposal is stale');
  if (proposal.proposalId !== `script-edit:${proposal.kind}:${input.inputHash}`) {
    throw new Error('SCRIPT_EDIT_PROPOSAL_ID_CONFLICT: proposal ID must stay bound to kind and input hash');
  }
  if ((proposal.kind === 'caption' && proposal.generator.skillId !== 'subtitle-orthography')
    || (proposal.kind === 'structure' && proposal.generator.skillId !== 'script-structure')) {
    throw new Error('SCRIPT_EDIT_SKILL_CONFLICT: generator skill does not match proposal kind');
  }
  const selected = selectedCandidates(input, proposal);
  if (proposal.kind === 'caption') validateCaption(input, proposal, selected);
  else deriveStructureFromSelected(input, proposal, selected);
  return { proposal, selected };
}

function deriveStructureFromSelected(
  input: ScriptEditInput,
  proposal: Extract<ScriptEditProposal, { kind: 'structure' }>,
  selected: Map<string, AlignmentCandidate>,
): ScriptStructurePlan {
  const ordered = proposal.passages.flatMap((decision) => {
    if (decision.action === 'skip') return [];
    const candidate = selected.get(decision.passageId)!;
    return [{ passageId: decision.passageId, wordRef: candidate.wordRef, frame: framesForWordRef(input, candidate.wordRef) }];
  });
  if (ordered.length === 0) throw new Error('STRUCTURE_EMPTY: structure proposals must retain at least one selected passage');
  const byWord = [...ordered].sort((a, b) => a.wordRef.startIndex - b.wordRef.startIndex || a.wordRef.endIndex - b.wordRef.endIndex);
  const byFrame = [...ordered].sort((a, b) => a.frame.originalStart - b.frame.originalStart || a.frame.originalEnd - b.frame.originalEnd);
  for (let index = 1; index < ordered.length; index += 1) {
    if (byWord[index]!.wordRef.startIndex < byWord[index - 1]!.wordRef.endIndex) {
      throw new Error('STRUCTURE_WORD_OVERLAP: selected passages must not reuse transcript words');
    }
    if (byFrame[index]!.frame.originalStart < byFrame[index - 1]!.frame.originalEnd) {
      throw new Error('STRUCTURE_FRAME_OVERLAP: selected word spans collapse onto overlapping frames');
    }
  }
  const sourceOrder = byFrame.map((item) => item.frame);
  const cutRegions: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const range of sourceOrder) {
    if (cursor < range.originalStart) cutRegions.push({ start: cursor, end: range.originalStart });
    cursor = range.originalEnd;
  }
  if (cursor < input.editing.totalFrames) cutRegions.push({ start: cursor, end: input.editing.totalFrames });
  return { cutRegions, cutOrder: ordered.map((item) => ({ ...item.frame })) };
}

/** Derives all source frames from fixed transcript words; proposals cannot provide frame or time values. */
export function deriveScriptStructurePlan(inputValue: unknown, proposalValue: unknown): ScriptStructurePlan {
  const input = validateScriptEditInput(inputValue);
  const { proposal, selected } = validateProposalAgainstInput(input, proposalValue);
  if (proposal.kind !== 'structure') throw new Error('SCRIPT_EDIT_KIND_CONFLICT: structure proposal required');
  return deriveStructureFromSelected(input, proposal, selected);
}
