import { z } from 'zod';

const MAX_TEXT_LENGTH = 2_000_000;
const MAX_PASSAGES = 20_000;
const MAX_WORDS = 200_000;
const MAX_NORMALIZED_TRANSCRIPT_LENGTH = 4_000_000;
const identifier = z.string().trim().min(1).max(256);
const proposalIdentifier = z.string().trim().min(1).max(512);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'SHA-256は小文字16進数64文字で指定してください');

export const utf16RangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).strict().superRefine((range, ctx) => {
  if (range.end <= range.start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end'], message: 'UTF-16範囲のendはstartより後にしてください' });
  }
});
export type Utf16Range = z.infer<typeof utf16RangeSchema>;

const scriptPassageSchema = z.object({ id: identifier, range: utf16RangeSchema }).strict();

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (index + 1 >= text.length || !isLowSurrogate(text.charCodeAt(index + 1))) return false;
      index += 1;
    } else if (isLowSurrogate(code)) return false;
  }
  return true;
}

function isUtf16Boundary(text: string, offset: number): boolean {
  return offset === 0 || offset === text.length
    || !(isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset)));
}

export const scriptDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  documentId: identifier,
  revision: identifier,
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  passages: z.array(scriptPassageSchema).min(1).max(MAX_PASSAGES),
}).strict().superRefine((document, ctx) => {
  if (!isWellFormedUtf16(document.text)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: '台本本文が正しいUTF-16ではありません' });
    return;
  }
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const [index, passage] of document.passages.entries()) {
    if (ids.has(passage.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passages', index, 'id'], message: '文章IDが重複しています' });
    }
    ids.add(passage.id);
    if (passage.range.end > document.text.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passages', index, 'range'], message: 'UTF-16範囲が台本本文を超えています' });
    } else if (!isUtf16Boundary(document.text, passage.range.start) || !isUtf16Boundary(document.text, passage.range.end)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passages', index, 'range'], message: 'UTF-16範囲がsurrogate pairの途中です' });
    }
    if (passage.range.end <= document.text.length
      && normalizeScriptAlignmentText(document.text.slice(passage.range.start, passage.range.end)) === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passages', index, 'range'], message: '文章範囲を空白だけにできません' });
    }
    if (index > 0 && passage.range.start < previousEnd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passages', index, 'range'], message: '文章範囲はUTF-16位置順で重ならないようにしてください' });
    }
    previousEnd = Math.max(previousEnd, passage.range.end);
  }
});
export type ScriptDocument = z.infer<typeof scriptDocumentSchema>;

const sourceSchema = z.object({
  id: identifier,
  revision: identifier,
  durationMs: z.number().finite().positive(),
}).strict();

const transcriptWordSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string().min(1).max(10_000),
  startMs: z.number().finite().nonnegative(),
  endMs: z.number().finite().positive(),
}).strict().superRefine((word, ctx) => {
  if (word.endMs <= word.startMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endMs'], message: 'wordのendMsはstartMsより後にしてください' });
  }
  if (normalizeScriptAlignmentText(word.text) === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'wordを空白だけにできません' });
  }
});

const transcriptPacketSchema = z.object({
  revision: identifier,
  words: z.array(transcriptWordSchema).max(MAX_WORDS),
}).strict();

export const scriptInputPacketSchema = z.object({
  schemaVersion: z.literal(1),
  packetHash: sha256,
  projectId: identifier,
  editRevision: identifier,
  source: sourceSchema,
  script: scriptDocumentSchema,
  transcript: transcriptPacketSchema,
}).strict().superRefine((packet, ctx) => {
  let previousStart = -1;
  let previousEnd = -1;
  let normalizedLength = 0;
  for (const [index, word] of packet.transcript.words.entries()) {
    if (word.index !== index) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transcript', 'words', index, 'index'],
        message: `word indexは配列位置と一致させてください（期待値 ${index}）` });
    }
    if (word.startMs < previousStart || word.endMs < previousEnd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transcript', 'words', index], message: 'word時刻は元音声の順に並べてください' });
    }
    if (word.endMs > packet.source.durationMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transcript', 'words', index, 'endMs'],
        message: 'wordのendMsがsource.durationMsを超えています' });
    }
    normalizedLength += normalizeScriptAlignmentText(word.text).length;
    previousStart = word.startMs;
    previousEnd = word.endMs;
  }
  if (normalizedLength > MAX_NORMALIZED_TRANSCRIPT_LENGTH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transcript', 'words'], message: '対応付けるword本文の合計が上限を超えています' });
  }
});
export type ScriptInputPacket = z.infer<typeof scriptInputPacketSchema>;

export const alignmentGeneratorSchema = z.object({
  skillId: z.enum(['subtitle-orthography', 'script-structure']),
  skillVersion: identifier,
  provider: identifier,
  model: identifier,
  configHash: sha256,
}).strict();
export type AlignmentGenerator = z.infer<typeof alignmentGeneratorSchema>;

export const transcriptWordRefSchema = z.object({
  transcriptRevision: identifier,
  startIndex: z.number().int().nonnegative(),
  endIndex: z.number().int().positive(),
}).strict().superRefine((reference, ctx) => {
  if (reference.endIndex <= reference.startIndex) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endIndex'], message: 'word範囲のendIndexはstartIndexより後にしてください' });
  }
});
export type TranscriptWordRef = z.infer<typeof transcriptWordRefSchema>;

const literalCandidateSchema = z.object({
  match: z.literal('literal'),
  wordRef: transcriptWordRefSchema,
}).strict();
const modelCandidateSchema = z.object({
  match: z.literal('model_suggested'),
  wordRef: transcriptWordRefSchema,
  rationale: z.string().trim().min(1).max(4_000),
}).strict();
export const alignmentCandidateSchema = z.discriminatedUnion('match', [literalCandidateSchema, modelCandidateSchema]);
export type AlignmentCandidate = z.infer<typeof alignmentCandidateSchema>;

export const alignmentProposalSchema = z.object({
  schemaVersion: z.literal(1),
  proposalId: proposalIdentifier,
  inputHash: sha256,
  projectId: identifier,
  editRevision: identifier,
  sourceRevision: identifier,
  scriptRevision: identifier,
  transcriptRevision: identifier,
  passageId: identifier,
  scriptRange: utf16RangeSchema,
  status: z.enum(['unique', 'ambiguous', 'unmatched']),
  candidates: z.array(alignmentCandidateSchema).max(MAX_WORDS),
  generator: alignmentGeneratorSchema,
}).strict().superRefine((proposal, ctx) => {
  const count = proposal.candidates.length;
  if ((proposal.status === 'unique' && count !== 1)
    || (proposal.status === 'ambiguous' && count < 2)
    || (proposal.status === 'unmatched' && count !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: '対応状態と候補数が一致しません' });
  }
});
export type AlignmentProposal = z.infer<typeof alignmentProposalSchema>;

/** Matching removes whitespace only. It never folds case, width, punctuation, decimals, minus, or percent signs. */
export function normalizeScriptAlignmentText(text: string): string {
  return text.replace(/\s/gu, '');
}

function proposalStatus(count: number): AlignmentProposal['status'] {
  return count === 0 ? 'unmatched' : count === 1 ? 'unique' : 'ambiguous';
}

interface PreparedAlignmentPacket {
  packet: ScriptInputPacket;
  passages: Map<string, ScriptDocument['passages'][number]>;
  transcriptText: string;
  boundaryIndexes: Map<number, number>;
}

function prepareAlignmentPacket(input: ScriptInputPacket): PreparedAlignmentPacket {
  const packet = scriptInputPacketSchema.parse(input);
  const offsets = [0];
  const normalizedWords = packet.transcript.words.map((word) => normalizeScriptAlignmentText(word.text));
  for (const word of normalizedWords) offsets.push(offsets[offsets.length - 1]! + word.length);
  return {
    packet,
    passages: new Map(packet.script.passages.map((passage) => [passage.id, passage])),
    transcriptText: normalizedWords.join(''),
    boundaryIndexes: new Map(offsets.map((offset, index) => [offset, index])),
  };
}

function literalWordReferences(prepared: PreparedAlignmentPacket, passage: ScriptDocument['passages'][number]): TranscriptWordRef[] {
  const { packet, transcriptText, boundaryIndexes } = prepared;
  const target = normalizeScriptAlignmentText(packet.script.text.slice(passage.range.start, passage.range.end));
  const references: TranscriptWordRef[] = [];
  let cursor = 0;
  while (cursor <= transcriptText.length - target.length) {
    const startOffset = transcriptText.indexOf(target, cursor);
    if (startOffset < 0) break;
    const startIndex = boundaryIndexes.get(startOffset);
    const endIndex = boundaryIndexes.get(startOffset + target.length);
    if (startIndex !== undefined && endIndex !== undefined && endIndex > startIndex) {
      references.push({ transcriptRevision: packet.transcript.revision, startIndex, endIndex });
    }
    cursor = startOffset + 1;
  }
  return references;
}

/** Deterministic literal matching. Every contiguous matching word range is retained in source order. */
export function buildLiteralAlignments(input: ScriptInputPacket, generatorInput: AlignmentGenerator): AlignmentProposal[] {
  const prepared = prepareAlignmentPacket(input);
  const { packet } = prepared;
  const generator = alignmentGeneratorSchema.parse(generatorInput);
  return packet.script.passages.map((passage) => {
    const candidates: AlignmentCandidate[] = literalWordReferences(prepared, passage)
      .map((wordRef) => ({ match: 'literal' as const, wordRef }));
    return alignmentProposalSchema.parse({
      schemaVersion: 1,
      proposalId: `literal:${passage.id}:${packet.packetHash}`,
      inputHash: packet.packetHash,
      projectId: packet.projectId,
      editRevision: packet.editRevision,
      sourceRevision: packet.source.revision,
      scriptRevision: packet.script.revision,
      transcriptRevision: packet.transcript.revision,
      passageId: passage.id,
      scriptRange: { ...passage.range },
      status: proposalStatus(candidates.length),
      candidates,
      generator,
    });
  });
}

function validateCandidateReference(packet: ScriptInputPacket, candidate: AlignmentCandidate): void {
  const { wordRef } = candidate;
  if (wordRef.transcriptRevision !== packet.transcript.revision) {
    throw new Error('TRANSCRIPT_REVISION_CONFLICT: candidateのtranscriptRevisionがpacketと一致しません');
  }
  if (wordRef.startIndex < 0 || wordRef.endIndex <= wordRef.startIndex || wordRef.endIndex > packet.transcript.words.length) {
    throw new Error('WORD_RANGE_INVALID: candidateのword範囲がpacketのword境界と一致しません');
  }
}

/** Derives source milliseconds from the fixed packet. Candidate/model input cannot supply time values. */
export function deriveCandidateTimeRange(input: ScriptInputPacket, candidateInput: unknown): { startMs: number; endMs: number } {
  const packet = scriptInputPacketSchema.parse(input);
  const candidate = alignmentCandidateSchema.parse(candidateInput);
  validateCandidateReference(packet, candidate);
  const first = packet.transcript.words[candidate.wordRef.startIndex]!;
  const last = packet.transcript.words[candidate.wordRef.endIndex - 1]!;
  return { startMs: first.startMs, endMs: last.endMs };
}

function validatePreparedProposal(prepared: PreparedAlignmentPacket, proposalInput: unknown): AlignmentProposal {
  const { packet } = prepared;
  const proposal = alignmentProposalSchema.parse(proposalInput);
  const equal = (actual: string, expected: string, name: string) => {
    if (actual !== expected) throw new Error(`${name.toUpperCase()}_CONFLICT: proposalの${name}がpacketと一致しません`);
  };
  equal(proposal.inputHash, packet.packetHash, 'packetHash');
  equal(proposal.projectId, packet.projectId, 'projectId');
  equal(proposal.editRevision, packet.editRevision, 'editRevision');
  equal(proposal.sourceRevision, packet.source.revision, 'sourceRevision');
  equal(proposal.scriptRevision, packet.script.revision, 'scriptRevision');
  equal(proposal.transcriptRevision, packet.transcript.revision, 'transcriptRevision');
  const passage = prepared.passages.get(proposal.passageId);
  if (!passage) throw new Error('PASSAGE_NOT_FOUND: proposalのpassageがpacketにありません');
  if (passage.range.start !== proposal.scriptRange.start || passage.range.end !== proposal.scriptRange.end) {
    throw new Error('SCRIPT_RANGE_CONFLICT: proposalのUTF-16範囲がpacketと一致しません');
  }
  const target = normalizeScriptAlignmentText(packet.script.text.slice(passage.range.start, passage.range.end));
  const seen = new Set<string>();
  for (const candidate of proposal.candidates) {
    validateCandidateReference(packet, candidate);
    const key = `${candidate.wordRef.startIndex}:${candidate.wordRef.endIndex}`;
    if (seen.has(key)) throw new Error('CANDIDATE_DUPLICATE: candidateのword範囲が重複しています');
    seen.add(key);
    if (candidate.match === 'literal') {
      const actual = normalizeScriptAlignmentText(packet.transcript.words
        .slice(candidate.wordRef.startIndex, candidate.wordRef.endIndex).map((word) => word.text).join(''));
      if (actual !== target) throw new Error('LITERAL_MISMATCH: literal candidateが台本本文と一致しません');
    }
  }
  const literalKeys = new Set(proposal.candidates.filter((candidate) => candidate.match === 'literal')
    .map((candidate) => `${candidate.wordRef.startIndex}:${candidate.wordRef.endIndex}`));
  for (const expected of literalWordReferences(prepared, passage)) {
    if (!literalKeys.has(`${expected.startIndex}:${expected.endIndex}`)) {
      throw new Error('LITERAL_CANDIDATE_MISSING: packetで確認できるliteral候補をすべて保持してください');
    }
  }
  return proposal;
}

/** Batch boundary: parses the packet and prepares transcript/passages once, then validates every proposal. */
export function validateAlignmentProposals(input: ScriptInputPacket, proposalInputs: readonly unknown[]): AlignmentProposal[] {
  const prepared = prepareAlignmentPacket(input);
  return proposalInputs.map((proposal) => validatePreparedProposal(prepared, proposal));
}

/** Revalidates one stored/model proposal. Kept as a safe compatibility wrapper around the batch boundary. */
export function validateAlignmentProposal(input: ScriptInputPacket, proposalInput: unknown): AlignmentProposal {
  return validateAlignmentProposals(input, [proposalInput])[0]!;
}
