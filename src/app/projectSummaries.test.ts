import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../shared/types';
import { applyStatusPatch, mergeProjectSummaries } from './projectSummaries';

const summary = (seq: number, extra: Partial<ProjectSummary> = {}): ProjectSummary =>
  ({ id: 'p', name: 'p', orientation: 'h', durationLabel: '0:01', sizeLabel: '1 MB', videoFile: null, status: 'telop' as ProjectSummary['status'], statusSeq: seq, ...extra });

describe('カードの画像（thumbnailCover）のライブ更新', () => {
  it('差分で付き、差分で消える', () => {
    const list = mergeProjectSummaries([], [summary(1)]);
    const added = applyStatusPatch(list, 'p', { statusSeq: 2, thumbnailCover: { file: 'サムネ/サムネ_p.png', mtimeMs: 5 } });
    expect(added[0]!.thumbnailCover).toEqual({ file: 'サムネ/サムネ_p.png', mtimeMs: 5 });
    expect(applyStatusPatch(added, 'p', { statusSeq: 3, thumbnailCover: undefined })[0]!.thumbnailCover).toBeUndefined();
  });
  it('遅れて届いた古い一覧は、新しい差分で付いた画像を巻き戻さない', () => {
    const patched = applyStatusPatch(mergeProjectSummaries([], [summary(1)]), 'p', { statusSeq: 3, thumbnailCover: { file: 'サムネ/サムネ_p.png', mtimeMs: 9 } });
    expect(mergeProjectSummaries(patched, [summary(2)])[0]!.thumbnailCover).toEqual({ file: 'サムネ/サムネ_p.png', mtimeMs: 9 });
    expect(mergeProjectSummaries(patched, [summary(4)])[0]!.thumbnailCover).toBeUndefined();
  });
});
