import type { EditorProject } from '../types';
import { migrateLegacySequence, type LegacyAssetBindings, type LegacyMigrationResult } from './migrateLegacy';
import type { SequenceAsset } from './model';
import { SequenceError } from './errors';

/** Only resource references cross the preparation API. Live positions/text stay local. */
export interface LegacyPreviewReferences {
  main: string;
  telop: boolean;
  image: boolean;
  images: { id: number; file: string }[];
  videoInserts: { id: number; file: string }[];
  bgm: { id: number; file: string }[];
  se: { id: number; file: string }[];
}
export interface LegacyPreviewCatalog {
  /** Display-only omission; saved migration still requires the original main media. */
  missingMain?: true;
  references: LegacyPreviewReferences;
  sourceFingerprint: string;
  assets: SequenceAsset[];
  bindings: LegacyAssetBindings;
  staticFiles: Record<string, string>;
}
export function legacyPreviewReferences(project: EditorProject): LegacyPreviewReferences {
  const files = (items: { id: number; file: string }[]) => items.map(({ id, file }) => ({ id, file })).sort((a, b) => a.id - b.id);
  return { main: project.videoConfig.videoFile, telop: project.telops.length > 0, image: project.images.length > 0,
    images: files(project.images), videoInserts: files(project.videoInserts ?? []), bgm: files(project.bgm ?? []), se: files(project.se) };
}
export function legacyPreviewResourceKey(references: LegacyPreviewReferences): string {
  const files = (items: { id: number; file: string }[]) => [...items].sort((a, b) => a.id - b.id).map(({ id, file }) => [id, file]);
  return JSON.stringify([references.main, references.telop, references.image,
    ...[references.images, references.videoInserts, references.bgm, references.se].map(files)]);
}

/** Draft projection is never persisted by the preview. Its revision is a display
 * generation, not an acknowledgement of a legacy save or a native session edit. */
export function projectLegacyPreview(project: EditorProject, catalog: LegacyPreviewCatalog, id: string, generation: number, name: string): LegacyMigrationResult {
  if (!id || !Number.isSafeInteger(generation) || generation < 1) throw new SequenceError('INVALID_DOCUMENT', 'プレビューの描画世代が不正です');
  if (legacyPreviewResourceKey(legacyPreviewReferences(project)) !== legacyPreviewResourceKey(catalog.references))
    throw new SequenceError('REVISION_CONFLICT', '編集で追加した素材を準備してからプレビューを更新してください');
  const result = migrateLegacySequence({ id, name, project, assets: catalog.assets, bindings: catalog.bindings, sourceFingerprint: catalog.sourceFingerprint, allowMissingMain: catalog.missingMain });
  result.document.revision = generation;
  result.document.rendering = { telopBottomOffset: null, telopFontSize: null, ...result.document.rendering, staticFiles: { ...catalog.staticFiles } };
  return result;
}
