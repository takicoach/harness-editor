import type { SequenceDocument } from '../../core/sequence/model';
import type { AiScreen } from '../../shared/aiFocus';

/** AI に渡す素材の要約（ファイル名や中身は入れない）。 */
export function materialsSummary(document: Pick<SequenceDocument, 'assets' | 'clips'>): string {
  const media = document.assets.filter(asset => asset.kind === 'media').length, images = document.assets.filter(asset => asset.kind === 'image').length;
  return `素材 ${document.assets.length} 件（映像・音声 ${media}、画像 ${images}）・クリップ ${document.clips.length} 件`;
}
export interface NativeAiScreenInput {
  projectId: string; document: SequenceDocument | null; thumbnailOpen: boolean;
  thumbnail: { documentId: string; sessionId: string; revision: number } | null; thumbnailPageId: string | null;
  editorSessionId: string | undefined; frame: number; selected: readonly string[];
}
/** 編集画面（動画・サムネ）の今の状況。文書が読めるまでは null（ホームと同じ扱い）。 */
export function nativeAiScreen(input: NativeAiScreenInput): AiScreen | null {
  const document = input.document;
  if (!document) return null;
  const base = { projectId: input.projectId, projectName: (document.name || input.projectId).slice(0, 200), materials: materialsSummary(document) };
  if (input.thumbnailOpen) return { ...base, mode: 'thumbnail', playheadSec: null, selection: [],
    target: input.thumbnail ? { kind: 'thumbnail', ...input.thumbnail, pageId: input.thumbnailPageId } : null };
  const fps = document.fps.num / document.fps.den;
  return { ...base, mode: 'video', target: input.editorSessionId ? { kind: 'video', editorSessionId: input.editorSessionId } : null,
    playheadSec: fps > 0 ? Math.round((input.frame / fps) * 10) / 10 : null, selection: input.selected.slice(0, 50) };
}
