import { describe, expect, it } from 'vitest';
import { attachAudio, attachImages, attachShapes, attachTelops, attachTitles, attachVideoInserts, buildExportTimeline } from './exportTimeline';
import type { ImagePlayback, SceneTransition, ShapeSegment, TelopSegment, TitleSegment, VideoInsertPlayback } from './types';

const segs = [
  { originalStart: 0, originalEnd: 100 },
  { originalStart: 200, originalEnd: 300 },
];

describe('buildExportTimeline', () => {
  it('トランジション無しなら恒等（totalFrames = 再生総尺・finalStart = playbackStart）', () => {
    const t = buildExportTimeline({ fps: 30, segments: segs, transitions: [] });
    expect(t.playbackTotal).toBe(200);
    expect(t.totalFrames).toBe(200);
    expect(t.segments.map((s) => s.finalStart)).toEqual([0, 100]);
    expect(t.segments.map((s) => s.finalEnd)).toEqual([100, 200]);
  });

  it('重なり系トランジションで総尺が縮み、後続区間の finalStart が前へ詰まる', () => {
    const tr: SceneTransition[] = [
      { id: 1, at: 100, kind: 'crossfade', durationFrames: 10 },
    ];
    const t = buildExportTimeline({ fps: 30, segments: segs, transitions: tr });
    expect(t.overlaps).toEqual([{ boundary: 100, overlap: 10 }]);
    expect(t.totalFrames).toBe(190);
    expect(t.segments[0]!.finalEnd).toBe(100);   // 前区間は最後まで占める
    expect(t.segments[1]!.finalStart).toBe(90);  // 重なり 10 = finalEnd - finalStart
  });

  it('fade 系（尺不変）は overlaps に入らない', () => {
    const tr: SceneTransition[] = [
      { id: 1, at: 100, kind: 'fadeBlack', durationFrames: 10 },
    ];
    const t = buildExportTimeline({ fps: 30, segments: segs, transitions: tr });
    expect(t.overlaps).toEqual([]);
    expect(t.totalFrames).toBe(200);
  });
});

describe('attachAudio', () => {
  it('重なり系トランジションで SE も BGM も最終座標へ詰まる', () => {
    const t = buildExportTimeline({
      fps: 30,
      segments: [{ originalStart: 0, originalEnd: 100 }, { originalStart: 200, originalEnd: 300 }],
      transitions: [{ id: 1, at: 100, kind: 'crossfade', durationFrames: 10 } as never],
    });
    const out = attachAudio(t,
      [{ id: 1, playbackFrame: 150, playbackEnd: 180, file: 'a.mp3', volume: 1 }],
      [{ id: 2, file: 'b.mp3', startFrame: 120, endFrame: 190, volume: 0.2, fadeInFrames: 0, fadeOutFrames: 0 }],
    );
    expect(out.se[0]!.playbackFrame).toBe(140);
    expect(out.bgm[0]!.startFrame).toBe(110);
    expect(out.bgm[0]!.endFrame).toBe(180);
  });
  it('トランジション無しなら両方恒等', () => {
    const t = buildExportTimeline({ fps: 30, segments: [{ originalStart: 0, originalEnd: 100 }], transitions: [] });
    const se = [{ id: 1, playbackFrame: 10, playbackEnd: 40, file: 'a.mp3', volume: 0.5 }];
    const bgm = [{ id: 2, file: 'b.mp3', startFrame: 0, endFrame: 100, volume: 0.2, fadeInFrames: 6, fadeOutFrames: 9 }];
    const out = attachAudio(t, se, bgm);
    expect(out.se).toEqual(se);
    expect(out.bgm).toEqual(bgm);
  });
});

describe('attachShapes', () => {
  // 共通 timeline: segs = [0-100],[200-300]、crossfade at=100 durationFrames=10
  // → overlaps = [{ boundary: 100, overlap: 10 }]（attachAudio と同一 fixture）
  // playbackToFinal(f) = f - (f>=100 ? 10 : 0)
  const t = buildExportTimeline({
    fps: 30,
    segments: [{ originalStart: 0, originalEnd: 100 }, { originalStart: 200, originalEnd: 300 }],
    transitions: [{ id: 1, at: 100, kind: 'crossfade', durationFrames: 10 } as never],
  });

  const base = { kind: 'rect' as const, x1: 0, y1: 0, x2: 1, y2: 1, color: '#fff', thickness: 'medium' as const };

  it('カット除去区間より後ろの図形が collapse で前に詰まる', () => {
    // startFrame=150 (>=100 → shift10) => 140 / endFrame=180 (>=100 → shift10) => 170
    const shapes: ShapeSegment[] = [{ id: 1, ...base, startFrame: 150, endFrame: 180 }];
    const out = attachShapes(t, shapes);
    expect(out.shapes).toEqual([{ id: 1, ...base, startFrame: 140, endFrame: 170 }]);
  });

  it('除去区間を跨ぐ図形が正しく縮む', () => {
    // startFrame=80 (<100 → shift0) => 80 / endFrame=120 (>=100 → shift10) => 110
    // 元の長さ 40 → collapse 後 30（overlap 10 分だけ縮む）
    const shapes: ShapeSegment[] = [{ id: 2, ...base, startFrame: 80, endFrame: 120 }];
    const out = attachShapes(t, shapes);
    expect(out.shapes).toEqual([{ id: 2, ...base, startFrame: 80, endFrame: 110 }]);
  });

  it('collapse の結果 endFrame <= startFrame に縮退した図形は除外される', () => {
    // 図形A: startFrame=95 (<100 → shift0) => 95 / endFrame=100 (>=100 → shift10) => 90
    //   → 90 <= 95 なので縮退・除外
    // 図形B: startFrame=10 (<100 → shift0) => 10 / endFrame=50 (<100 → shift0) => 50（無傷で残る）
    const shapes: ShapeSegment[] = [
      { id: 3, ...base, startFrame: 95, endFrame: 100 },
      { id: 4, ...base, startFrame: 10, endFrame: 50 },
    ];
    const out = attachShapes(t, shapes);
    expect(out.shapes).toEqual([{ id: 4, ...base, startFrame: 10, endFrame: 50 }]);
  });

  it('shapes 空配列で {...timeline, shapes: []} が返り timeline の他フィールドは同一参照のまま', () => {
    const out = attachShapes(t, []);
    expect(out.shapes).toEqual([]);
    expect(out.segments).toBe(t.segments);
    expect(out.overlaps).toBe(t.overlaps);
    expect(out.fps).toBe(t.fps);
    expect(out.totalFrames).toBe(t.totalFrames);
  });
});

describe('attachTelops', () => {
  // 共通 timeline: attachShapes と同一 fixture（overlaps = [{ boundary: 100, overlap: 10 }]）
  const t = buildExportTimeline({
    fps: 30,
    segments: [{ originalStart: 0, originalEnd: 100 }, { originalStart: 200, originalEnd: 300 }],
    transitions: [{ id: 1, at: 100, kind: 'crossfade', durationFrames: 10 } as never],
  });

  const base = { text: 'てろっぷ' };

  it('カット除去区間より後ろのテロップが collapse で前に詰まる', () => {
    // startFrame=150 (>=100 → shift10) => 140 / endFrame=180 (>=100 → shift10) => 170
    const telops: TelopSegment[] = [{ id: 1, ...base, startFrame: 150, endFrame: 180 }];
    const out = attachTelops(t, telops);
    expect(out.telops).toEqual([{ id: 1, ...base, startFrame: 140, endFrame: 170 }]);
  });

  it('除去区間を跨ぐテロップが正しく縮む', () => {
    // startFrame=80 (<100 → shift0) => 80 / endFrame=120 (>=100 → shift10) => 110
    const telops: TelopSegment[] = [{ id: 2, ...base, startFrame: 80, endFrame: 120 }];
    const out = attachTelops(t, telops);
    expect(out.telops).toEqual([{ id: 2, ...base, startFrame: 80, endFrame: 110 }]);
  });

  it('collapse の結果 endFrame <= startFrame に縮退したテロップは除外される', () => {
    // テロップA: startFrame=95 (<100 → shift0) => 95 / endFrame=100 (>=100 → shift10) => 90
    //   → 90 <= 95 なので縮退・除外
    // テロップB: startFrame=10 (<100 → shift0) => 10 / endFrame=50 (<100 → shift0) => 50（無傷で残る）
    const telops: TelopSegment[] = [
      { id: 3, ...base, startFrame: 95, endFrame: 100 },
      { id: 4, ...base, startFrame: 10, endFrame: 50 },
    ];
    const out = attachTelops(t, telops);
    expect(out.telops).toEqual([{ id: 4, ...base, startFrame: 10, endFrame: 50 }]);
  });

  it('telops 空配列で {...timeline, telops: []} が返り timeline の他フィールドは同一参照のまま', () => {
    const out = attachTelops(t, []);
    expect(out.telops).toEqual([]);
    expect(out.segments).toBe(t.segments);
    expect(out.overlaps).toBe(t.overlaps);
  });
});

describe('attachTitles', () => {
  const t = buildExportTimeline({
    fps: 30,
    segments: [{ originalStart: 0, originalEnd: 100 }, { originalStart: 200, originalEnd: 300 }],
    transitions: [{ id: 1, at: 100, kind: 'crossfade', durationFrames: 10 } as never],
  });

  const base = { text: 'たいとる' };

  it('カット除去区間より後ろのタイトルが collapse で前に詰まる', () => {
    // startFrame=150 (>=100 → shift10) => 140 / endFrame=180 (>=100 → shift10) => 170
    const titles: TitleSegment[] = [{ id: 1, ...base, startFrame: 150, endFrame: 180 }];
    const out = attachTitles(t, titles);
    expect(out.titles).toEqual([{ id: 1, ...base, startFrame: 140, endFrame: 170 }]);
  });

  it('除去区間を跨ぐタイトルが正しく縮む', () => {
    // startFrame=80 (<100 → shift0) => 80 / endFrame=120 (>=100 → shift10) => 110
    const titles: TitleSegment[] = [{ id: 2, ...base, startFrame: 80, endFrame: 120 }];
    const out = attachTitles(t, titles);
    expect(out.titles).toEqual([{ id: 2, ...base, startFrame: 80, endFrame: 110 }]);
  });

  it('collapse の結果 endFrame <= startFrame に縮退したタイトルは除外される', () => {
    const titles: TitleSegment[] = [
      { id: 3, ...base, startFrame: 95, endFrame: 100 },
      { id: 4, ...base, startFrame: 10, endFrame: 50 },
    ];
    const out = attachTitles(t, titles);
    expect(out.titles).toEqual([{ id: 4, ...base, startFrame: 10, endFrame: 50 }]);
  });

  it('titles 空配列で {...timeline, titles: []} が返り timeline の他フィールドは同一参照のまま', () => {
    const out = attachTitles(t, []);
    expect(out.titles).toEqual([]);
    expect(out.segments).toBe(t.segments);
    expect(out.overlaps).toBe(t.overlaps);
  });
});

describe('attachImages', () => {
  const t = buildExportTimeline({
    fps: 30,
    segments: [{ originalStart: 0, originalEnd: 100 }, { originalStart: 200, originalEnd: 300 }],
    transitions: [{ id: 1, at: 100, kind: 'crossfade', durationFrames: 10 } as never],
  });

  const base = { file: 'img.png', type: 'photo' as const, scale: 1 };

  it('カット除去区間より後ろの画像が playbackStart/playbackEnd 名で collapse で前に詰まる', () => {
    // playbackStart=150 (>=100 → shift10) => 140 / playbackEnd=180 (>=100 → shift10) => 170
    const images: ImagePlayback[] = [{ id: 1, ...base, playbackStart: 150, playbackEnd: 180 }];
    const out = attachImages(t, images);
    expect(out.images).toEqual([{ id: 1, ...base, playbackStart: 140, playbackEnd: 170 }]);
  });

  it('除去区間を跨ぐ画像が正しく縮む（playbackStart/playbackEnd ↔ startFrame/endFrame の名称写像 pin）', () => {
    // playbackStart=80 (<100 → shift0) => 80 / playbackEnd=120 (>=100 → shift10) => 110
    const images: ImagePlayback[] = [{ id: 2, ...base, playbackStart: 80, playbackEnd: 120 }];
    const out = attachImages(t, images);
    expect(out.images).toEqual([{ id: 2, ...base, playbackStart: 80, playbackEnd: 110 }]);
    // startFrame/endFrame という名前は images には存在しない（別型であることの直接確認）
    expect(out.images[0]).not.toHaveProperty('startFrame');
    expect(out.images[0]).not.toHaveProperty('endFrame');
  });

  it('collapse の結果 playbackEnd <= playbackStart に縮退した画像は除外される', () => {
    const images: ImagePlayback[] = [
      { id: 3, ...base, playbackStart: 95, playbackEnd: 100 },
      { id: 4, ...base, playbackStart: 10, playbackEnd: 50 },
    ];
    const out = attachImages(t, images);
    expect(out.images).toEqual([{ id: 4, ...base, playbackStart: 10, playbackEnd: 50 }]);
  });

  it('images 空配列で {...timeline, images: []} が返り timeline の他フィールドは同一参照のまま', () => {
    const out = attachImages(t, []);
    expect(out.images).toEqual([]);
    expect(out.segments).toBe(t.segments);
    expect(out.overlaps).toBe(t.overlaps);
  });
});

describe('attachVideoInserts', () => {
  // attachImages と同一 fixture（overlaps = [{ boundary: 100, overlap: 10 }]）。
  const t = buildExportTimeline({
    fps: 30,
    segments: [{ originalStart: 0, originalEnd: 100 }, { originalStart: 200, originalEnd: 300 }],
    transitions: [{ id: 1, at: 100, kind: 'crossfade', durationFrames: 10 } as never],
  });

  const base = { file: 'sub.mp4', sourceInFrame: 3, scale: 1 };

  it('転換より後ろのサブ動画が playbackStart/playbackEnd 名で前へ詰まる（正典⑧）', () => {
    const vi: VideoInsertPlayback[] = [{ id: 1, ...base, playbackStart: 150, playbackEnd: 180 }];
    const out = attachVideoInserts(t, vi);
    expect(out.videoInserts).toEqual([{ id: 1, ...base, playbackStart: 140, playbackEnd: 170 }]);
  });

  it('転換窓を跨ぐサブ動画は最終座標で縮む（sourceInFrame / playbackRate は不変）', () => {
    const vi: VideoInsertPlayback[] = [{ id: 2, ...base, playbackRate: 0.7, playbackStart: 80, playbackEnd: 120 }];
    const out = attachVideoInserts(t, vi);
    expect(out.videoInserts).toEqual([
      { id: 2, ...base, playbackRate: 0.7, playbackStart: 80, playbackEnd: 110 },
    ]);
    // 名称写像の直接確認（startFrame/endFrame という名前は VideoInsertPlayback に無い）
    expect(out.videoInserts[0]).not.toHaveProperty('startFrame');
    expect(out.videoInserts[0]).not.toHaveProperty('endFrame');
  });

  it('collapse の結果 playbackEnd <= playbackStart へ縮退したサブ動画は除外される', () => {
    const vi: VideoInsertPlayback[] = [
      { id: 3, ...base, playbackStart: 95, playbackEnd: 100 },
      { id: 4, ...base, playbackStart: 10, playbackEnd: 50 },
    ];
    const out = attachVideoInserts(t, vi);
    expect(out.videoInserts).toEqual([{ id: 4, ...base, playbackStart: 10, playbackEnd: 50 }]);
  });

  it('空配列なら timeline の他フィールドは同一参照のまま', () => {
    const out = attachVideoInserts(t, []);
    expect(out.videoInserts).toEqual([]);
    expect(out.segments).toBe(t.segments);
    expect(out.overlaps).toBe(t.overlaps);
  });
});
