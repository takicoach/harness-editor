import { describe, expect, it } from 'vitest';
import { applySequenceCommand } from '../sequence/commands';
import type { SequenceDocument } from '../sequence/model';
import { buildSlideImportCommands, type SlideImportRecord } from './videoImport';

const video = (): SequenceDocument => ({ schemaVersion: 2, id: 'video', name: '動画', revision: 3, fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 300,
  background: '#000000', tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' },
  assets: [{ id: 'a1', kind: 'image', name: '講義_001.png', file: `.harness/assets/${'c'.repeat(64)}.png`, fingerprint: 'c'.repeat(64), streams: [] },
    { id: 'a2', kind: 'image', name: '講義_002.png', file: `.harness/assets/${'d'.repeat(64)}.png`, fingerprint: 'd'.repeat(64), streams: [] }] });
const record: SlideImportRecord = { importId: 'imp-1', createdAt: '2026-10-04T00:00:00.000Z', slides: { projectId: '講義', documentId: 'slides-1', revision: 7 }, placed: null,
  pages: [{ pageId: 'page-1', number: 1, assetId: 'a1', fingerprint: 'c'.repeat(64), contentHash: 'h1', name: '講義_001.png' },
    { pageId: 'page-2', number: 2, assetId: 'a2', fingerprint: 'd'.repeat(64), contentHash: 'h2', name: '講義_002.png' }] };

describe('動画への取り込みの操作', () => {
  it('新しい映像トラックに、ページ順に 5 秒ずつ並べる（末尾または再生位置から）。動画の検証も通る', () => {
    let n = 0;
    const built = buildSlideImportCommands(video(), record, 300, prefix => `${prefix}-${++n}`);
    expect(built.commands[0]).toEqual({ type: 'add-track', track: { id: 'slides-track-1', kind: 'visual', name: 'スライド', enabled: true } });
    const next = applySequenceCommand(video(), { type: 'batch', commands: built.commands });
    expect(next.clips.map(clip => [clip.startFrame, clip.durationFrames, clip.content.kind === 'image' ? clip.content.assetId : '', clip.name]))
      .toEqual([[300, 150, 'a1', '講義_001.png'], [450, 150, 'a2', '講義_002.png']]);
    expect([built.clipIds, next.sequenceEndFrame]).toEqual([['slides-clip-2', 'slides-clip-3'], 600]);
  });
  it('動画に登録されていない画像は置かない', () => {
    const document = video(); document.assets = [];
    expect(() => buildSlideImportCommands(document, record, 0, prefix => prefix)).toThrow('スライドの画像が動画に登録されていません');
  });
});
