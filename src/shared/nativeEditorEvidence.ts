import {z} from 'zod';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
/** Minted by the editing authority, never accepted from an agent request. */
export const nativeEditorEvidenceSchema=z.object({documentId:z.string().min(1).max(256),beforeHash:hash,afterHash:hash}).strict();
export type NativeEditorEvidence=z.infer<typeof nativeEditorEvidenceSchema>;
export const nativeEditorReconciliationSchema=z.object({documentId:z.string().min(1).max(256),contentHash:hash,
  savedState:z.enum(['input','proposal','diverged'])}).strict();
export type NativeEditorReconciliation=z.infer<typeof nativeEditorReconciliationSchema>;
