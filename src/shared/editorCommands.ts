import { z } from 'zod';
import { validateScriptEditArtifact } from '../core/scriptEditArtifact';
import { scriptEditModificationSchema, validateScriptEditModification } from '../core/scriptEditModification';
import {nativeEditorEditSchema} from './nativeEditorCommands';

const id = z.string().trim().min(1).max(256);
const time = z.object({ num: z.number().int().nonnegative().safe(), den: z.number().int().positive().safe() }).strict();
export const editorTextReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind:z.literal('source'), assetId:id, occurrenceId:id, start:time, end:time }).strict(),
  z.object({ kind:z.literal('timeline'), startFrame:z.number().int().nonnegative().safe(), endFrame:z.number().int().positive().safe() }).strict(),
]);
export const editorChangeSetSchema = z.object({
  schemaVersion: z.literal(1), projectId: id, operationId: id, baseRevision: id,
  sequence:nativeEditorEditSchema.optional(),
  script: z.object({ judgmentId: id, artifact: z.unknown().transform((value, ctx) => {
    try { return validateScriptEditArtifact(value); }
    catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_SCRIPT_EDIT: 台本案が不正です' }); return z.NEVER; }
  }), modification: scriptEditModificationSchema.optional() }).strict().optional(),
  changes: z.array(z.object({
    type: z.literal('set_telop_text'), elementId: id, before: z.string().max(10000),
    after: z.string().min(1).max(10000),
    sourceFrameRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict(),
    reference: editorTextReferenceSchema.optional(),
  }).strict()).max(100),
}).strict().superRefine((input, ctx) => {
  if(input.sequence&&(input.script||input.changes.length!==0))ctx.addIssue({code:z.ZodIssueCode.custom,
    message:'INVALID_EDITOR_INPUT: タイムライン編集は字幕本文・台本案と別の操作として実行してください'});
  if (input.script) {
    if (input.changes.length !== 0 || input.script.artifact.input.alignment.packet.projectId !== input.projectId
      || input.operationId !== `script:${input.script.judgmentId}`) ctx.addIssue({ code: z.ZodIssueCode.custom,
        message: 'INVALID_SCRIPT_EDIT: 台本案は採用記録に結び付いた単独の操作として実行してください' });
    if (input.script.modification !== undefined) {
      try { validateScriptEditModification(input.script.artifact, input.script.modification); }
      catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'INVALID_SCRIPT_MODIFICATION: 修正内容が不正です' }); }
    }
  } else if (!input.sequence&&input.changes.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '変更を指定してください' });
  const seen = new Set<string>();
  for (const [index, change] of input.changes.entries()) {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index], message });
    if (seen.has(change.elementId)) fail('DUPLICATE_TARGET: 同じ字幕を複数回変更できません');
    seen.add(change.elementId);
    if (change.sourceFrameRange.end <= change.sourceFrameRange.start) fail('INVALID_RANGE: 元素材の範囲が逆転しています');
    if (!change.after.trim()) fail('INVALID_TEXT: 字幕の本文を指定してください');
    if (change.before === change.after) fail('NO_CHANGE: 変更前後の本文が同じです');
  }
});
export type EditorChangeSet = z.infer<typeof editorChangeSetSchema>;
export type EditorTextChange = EditorChangeSet['changes'][number];
export interface EditorChangeContext { projectId: string; revision: string }

export interface EditorTextTarget {
  id: string; text: string; sourceFrameRange: { start: number; end: number };
  reference?: z.infer<typeof editorTextReferenceSchema>;
  referenceRequired?: boolean;
}

/** The browser rechecks this same contract immediately before its synchronous history update. */
export function validateEditorTextTargets(context: EditorChangeContext, elements: EditorTextTarget[], input: unknown): EditorChangeSet {
  const request = editorChangeSetSchema.parse(input);
  if (request.projectId !== context.projectId) throw new Error('PROJECT_MISMATCH: 対象の案件が異なります');
  if (request.baseRevision !== context.revision) throw new Error('REVISION_CONFLICT: 編集状態が変わりました。現在の版を取得してください');
  if (request.script) throw new Error('SCRIPT_REVIEW_REQUIRED: 台本案は人の採用を検証してから実行してください');
  if(request.sequence)throw new Error('NATIVE_EDITOR_REQUIRED: タイムライン編集は独自編集の接続で実行してください');
  for (const change of request.changes) {
    const target = elements.find((element) => element.id === change.elementId);
    if (!target) throw new Error(`TARGET_NOT_FOUND: 字幕がありません: ${change.elementId}`);
    if (target.referenceRequired && !change.reference) throw new Error('SOURCE_REFERENCE_REQUIRED: editor_readのreferenceを指定してください');
    if (change.reference && (!target.reference || JSON.stringify(change.reference) !== JSON.stringify(editorTextReferenceSchema.parse(target.reference))))
      throw new Error('SOURCE_REFERENCE_CONFLICT: 字幕の素材または使用箇所が変わっています');
    if (target.text !== change.before) throw new Error(`CONTENT_CONFLICT: 字幕が変更されています: ${change.elementId}`);
    if (target.sourceFrameRange.start !== change.sourceFrameRange.start || target.sourceFrameRange.end !== change.sourceFrameRange.end) {
      throw new Error(`RANGE_CONFLICT: 字幕の範囲が変更されています: ${change.elementId}`);
    }
  }
  return request;
}
