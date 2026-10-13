import { describe, expect, it } from 'vitest';
import type { SequenceDocument } from '../../core/sequence/model';
import { materialsSummary, nativeAiScreen } from './aiScreen';

const document = { name: '10月の講義', fps: { num: 30, den: 1 },
  assets: [{ id: 'a1', kind: 'media' }, { id: 'a2', kind: 'image' }, { id: 'a3', kind: 'media' }],
  clips: [{ id: 'c1' }, { id: 'c2' }] } as unknown as SequenceDocument;
const base = { projectId: 'lesson-1010', document, thumbnailOpen: false, thumbnail: null, thumbnailPageId: null, editorSessionId: 'window-1', frame: 75, selected: ['c1'] };

describe('動画・サムネの画面の状況', () => {
  it('素材の要約', () => {
    expect(materialsSummary(document)).toBe('素材 3 件（映像・音声 2、画像 1）・クリップ 2 件');
  });
  it('動画: 編集画面の sessionId・再生位置（秒・小数 1 桁）・選択', () => {
    expect(nativeAiScreen(base)).toEqual({ projectId: 'lesson-1010', projectName: '10月の講義', mode: 'video',
      target: { kind: 'video', editorSessionId: 'window-1' }, playheadSec: 2.5, selection: ['c1'], materials: '素材 3 件（映像・音声 2、画像 1）・クリップ 2 件' });
  });
  it('サムネ: サムネの文書の照合情報と案。読み込み前は書き込み先なし', () => {
    expect(nativeAiScreen({ ...base, thumbnailOpen: true, thumbnail: { documentId: 't1', sessionId: 's1', revision: 4 }, thumbnailPageId: 'page-2' }))
      .toMatchObject({ mode: 'thumbnail', target: { kind: 'thumbnail', documentId: 't1', sessionId: 's1', revision: 4, pageId: 'page-2' }, playheadSec: null, selection: [] });
    expect(nativeAiScreen({ ...base, thumbnailOpen: true })?.target).toBeNull();
  });
  it('文書が無ければ null（ホーム扱い）。名前が空なら案件 ID。sessionId が無ければ書き込み先なし', () => {
    expect(nativeAiScreen({ ...base, document: null })).toBeNull();
    expect(nativeAiScreen({ ...base, document: { ...document, name: '' } as SequenceDocument })?.projectName).toBe('lesson-1010');
    expect(nativeAiScreen({ ...base, editorSessionId: undefined })?.target).toBeNull();
  });
});
