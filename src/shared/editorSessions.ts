import { z } from 'zod';
import type { ScriptDocument } from '../core/scriptAlignment';
import { editorTextReferenceSchema } from './editorCommands';

const id = z.string().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export interface ScriptEditingPresenceSource {
  scriptDocument: ScriptDocument | null;
  originalTotalFrames: number | null;
  telops: Array<{ id: number; text: string; originalStart: number; originalEnd: number }>;
  cutRegions: Array<{ start: number; end: number }>;
  cutOrder?: Array<{ originalStart: number; originalEnd: number }>;
}

/** Stable browser/server payload for proving that the visible script-related edit state matches disk. */
export function scriptEditingPresenceContent(state: ScriptEditingPresenceSource): string {
  const document = state.scriptDocument;
  return JSON.stringify({
    scriptDocument: document ? { schemaVersion: document.schemaVersion, documentId: document.documentId,
      revision: document.revision, text: document.text,
      passages: document.passages.map(passage => ({ id: passage.id, range: { start: passage.range.start, end: passage.range.end } })) } : null,
    totalFrames: state.originalTotalFrames,
    telops: state.telops.map(({ id: elementId, text, originalStart, originalEnd }) => ({ id: elementId, text, originalStart, originalEnd })),
    cutRegions: state.cutRegions.map(({ start, end }) => ({ start, end })),
    cutOrder: (state.cutOrder ?? []).map(({ originalStart, originalEnd }) => ({ originalStart, originalEnd })),
  });
}

export async function scriptEditingPresenceHash(state: ScriptEditingPresenceSource): Promise<string> {
  const bytes = new TextEncoder().encode(scriptEditingPresenceContent(state));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export const editorSessionSnapshotSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('home'), projectId: z.null() }).strict(),
  z.object({ status: z.literal('loading'), projectId: id }).strict(),
  z.object({ status: z.literal('error'), projectId: id }).strict(),
  z.object({ status: z.literal('ready'), projectId: id, revision: id,
    documentFormat:z.literal('sequence-v2').optional(),
    dirty: z.boolean(), saving: z.boolean(), humanBusy: z.boolean(),
    scriptEditingHash: sha256.optional(),
    elements: z.array(z.object({ id, text: z.string().max(10000),
      reference:editorTextReferenceSchema.optional(), referenceRequired:z.boolean().optional(),
      sourceFrameRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
        .refine((range) => range.end > range.start, '素材範囲が逆転しています'),
    }).strict()).max(10000),
  }).strict().refine((snapshot) => new Set(snapshot.elements.map((element) => element.id)).size === snapshot.elements.length,
    '字幕IDが重複しています'),
]);
export type EditorSessionSnapshot = z.infer<typeof editorSessionSnapshotSchema>;
export const editorSessionHeartbeatSchema = z.object({ sessionId: id, sessionKey: z.string().min(32).max(256),
  sequence: z.number().int().nonnegative().safe(), snapshot: editorSessionSnapshotSchema }).strict();
export type EditorSessionHeartbeat = z.infer<typeof editorSessionHeartbeatSchema>;
export interface EditorSessionSummary {
  sessionId: string; status: EditorSessionSnapshot['status']; projectId: string | null;
  revision: string | null; dirty: boolean; saving: boolean; humanBusy: boolean; elementCount: number; expiresAt: number;
}
