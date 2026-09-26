import { createScriptDocument } from '../../core/scriptDocumentData';
import type { EditState } from './editState';

/** Updating the shooting script changes no captions, cuts, timings, or selection. */
export function setShootingScriptText(state: EditState, text: string): EditState {
  if ((state.scriptDocument?.text ?? '') === text) return state;
  if (!text.trim()) return state.scriptDocument ? { ...state, scriptDocument: null } : state;
  return { ...state, scriptDocument: createScriptDocument(text, {
    documentId: state.scriptDocument?.documentId ?? crypto.randomUUID(),
    revision: crypto.randomUUID(),
  }) };
}
