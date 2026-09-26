import { editorChangeSetSchema, validateEditorTextTargets, type EditorChangeContext, type EditorTextChange } from '../../shared/editorCommands';
import type { EditState } from './editState';
import { setTelopText } from './textOps';
import { applyScriptEditArtifact } from './scriptEditOps';

/** Check the entire change set before creating a new history entry. Shared by human/agent entry points. */
export function validateEditorChanges(state: EditState, context: EditorChangeContext, input: unknown): EditorTextChange[] {
  const request = editorChangeSetSchema.parse(input);
  if (request.script) {
    if (request.projectId !== context.projectId) throw new Error('PROJECT_MISMATCH: 対象の案件が異なります');
    if (request.baseRevision !== context.revision) throw new Error('REVISION_CONFLICT: 編集状態が変わりました');
    applyScriptEditArtifact(state, request.script.artifact, request.script.modification);
    return [];
  }
  return validateEditorTextTargets(context, state.telops.map((telop) => ({ id: String(telop.id), text: telop.text,
    sourceFrameRange: { start: telop.originalStart, end: telop.originalEnd } })), input).changes;
}

export function applyEditorChanges(state: EditState, context: EditorChangeContext, input: unknown): EditState {
  const changes = validateEditorChanges(state, context, input);
  const request = editorChangeSetSchema.parse(input);
  if (request.script) return applyScriptEditArtifact(state, request.script.artifact, request.script.modification);
  return changes.reduce((current, change) => setTelopText(current, Number(change.elementId), change.after), state);
}
