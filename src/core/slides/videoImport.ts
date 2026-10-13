import { DEFAULT_MAIN_LAYOUT } from '../mainLayout';
import type { SequenceCommand } from '../sequence/commands';
import type { SequenceClip, SequenceDocument, SequenceTrack } from '../sequence/model';
import { ceilTime, multiplyTime, rational } from '../sequence/time';

export interface SlideImportPage { pageId: string; number: number; assetId: string; fingerprint: string; contentHash: string; name: string }
/** 動画案件側の取り込みの記録。slides.revision が取り込んだ時点の確定版。placed は動画に置いた記録（置くまでは null）。 */
export interface SlideImportRecord {
  importId: string; createdAt: string;
  slides: { projectId: string; documentId: string; revision: number };
  pages: SlideImportPage[];
  placed: { at: string; videoRevision: number; clipIds: string[] } | null;
}
export const SLIDE_IMPORT_SECONDS = 5;
/** 届いた画像を、新しい映像トラックにページ順に並べる操作。素材の登録は別（/api/sequence/register）。表示時間は動画側で直す。 */
export function buildSlideImportCommands(document: SequenceDocument, record: SlideImportRecord, at: number, newId: (prefix: string) => string,
  seconds = SLIDE_IMPORT_SECONDS): { commands: SequenceCommand[]; clipIds: string[]; trackId: string } {
  const assets = new Map(document.assets.map(asset => [asset.id, asset]));
  for (const page of record.pages) if (assets.get(page.assetId)?.kind !== 'image') throw new Error(`スライドの画像が動画に登録されていません（${page.name}）`);
  const duration = ceilTime(multiplyTime(rational(seconds), document.fps)), trackId = newId('slides-track');
  const track: SequenceTrack = { id: trackId, kind: 'visual', name: 'スライド', enabled: true };
  const clips: SequenceClip[] = record.pages.map((page, index) => ({ id: newId('slides-clip'), trackId, name: page.name, startFrame: at + index * duration, durationFrames: duration,
    clock: { offset: rational(0), rate: rational(1), duration: rational(duration) }, visual: { layout: structuredClone(DEFAULT_MAIN_LAYOUT), opacity: 1, keyframes: [] },
    content: { kind: 'image', assetId: page.assetId, style: 'plain' } }));
  return { commands: [{ type: 'add-track', track }, { type: 'insert', clips }], clipIds: clips.map(clip => clip.id), trackId };
}
