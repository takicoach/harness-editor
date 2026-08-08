import { describe, expect, it } from 'vitest';
import {
  addVideoInsert, removeVideoInsert, selectVideoInsert, moveVideoInsert,
  retimeVideoInsert, setVideoInsertInPoint, setVideoInsertPosition,
  setVideoInsertScale, setVideoInsertFile, applySourceOffsetToFile,
  setVideoInsertEnter, setVideoInsertExit, setVideoInsertPlaybackRate,
} from './videoInsertOps';
import type { EditState } from './editState';

function st(over: Partial<EditState> = {}): EditState {
  return {
    telops: [], cutRegions: [], se: [], images: [], videoInserts: [], bgm: [],
    selection: null, nextTelopId: 1, nextSeId: 1, nextImageId: 1, nextVideoInsertId: 1, nextBgmId: 1,
    titles: [], nextTitleId: 1,
    shapes: [], nextShapeId: 1,
    sceneTransitions: [], nextTransitionId: 1,
    ducking: { enabled: true, strength: 'mid' as const },
    mainSpeed: 1,
    segmentSpeeds: {},
    segmentLayouts: {}, layoutKeyframes: [],
    ...over,
  };
}

describe('videoInsertOps', () => {
  it('addVideoInsert が既定長で追加し選択する', () => {
    const s = addVideoInsert(st(), 'sub/cam2.mp4', 100);
    expect(s.videoInserts).toHaveLength(1);
    expect(s.videoInserts[0]).toMatchObject({ id: 1, originalStart: 100, file: 'sub/cam2.mp4', sourceInFrame: 0 });
    expect(s.videoInserts[0]?.originalEnd).toBeGreaterThan(100);
    expect(s.nextVideoInsertId).toBe(2);
    expect(s.selection).toEqual({ kind: 'videoInsert', id: 1 });
  });

  it('addVideoInsert は file 空・非有限 start を無視', () => {
    expect(addVideoInsert(st(), '', 100).videoInserts).toHaveLength(0);
    expect(addVideoInsert(st(), 'a.mp4', NaN).videoInserts).toHaveLength(0);
  });

  it('removeVideoInsert が削除し選択を外す', () => {
    const s0 = addVideoInsert(st(), 'a.mp4', 0);
    const s1 = removeVideoInsert(s0, 1);
    expect(s1.videoInserts).toHaveLength(0);
    expect(s1.selection).toBeNull();
  });

  it('moveVideoInsert は長さを保ち平行移動・0クランプ', () => {
    const s0 = addVideoInsert(st(), 'a.mp4', 100);
    const len = (s0.videoInserts[0]!.originalEnd) - (s0.videoInserts[0]!.originalStart);
    const s1 = moveVideoInsert(s0, 1, 300);
    expect(s1.videoInserts[0]?.originalStart).toBe(300);
    expect(s1.videoInserts[0]?.originalEnd).toBe(300 + len);
    const s2 = moveVideoInsert(s0, 1, -50);
    expect(s2.videoInserts[0]?.originalStart).toBe(0);
  });

  it('retimeVideoInsert は両端設定・end>=start を保証', () => {
    const s0 = addVideoInsert(st(), 'a.mp4', 0);
    const s1 = retimeVideoInsert(s0, 1, 50, 40);
    expect(s1.videoInserts[0]?.originalStart).toBe(50);
    expect(s1.videoInserts[0]?.originalEnd).toBe(51);
  });

  it('setVideoInsertInPoint は 0 以上へクランプ・丸め', () => {
    const s0 = addVideoInsert(st(), 'a.mp4', 0);
    expect(setVideoInsertInPoint(s0, 1, 12.6).videoInserts[0]?.sourceInFrame).toBe(13);
    expect(setVideoInsertInPoint(s0, 1, -5).videoInserts[0]?.sourceInFrame).toBe(0);
  });

  it('setVideoInsertPosition と setVideoInsertScale', () => {
    const s0 = addVideoInsert(st(), 'a.mp4', 0);
    expect(setVideoInsertPosition(s0, 1, 0.2, -0.3).videoInserts[0]?.position).toEqual({ x: 0.2, y: -0.3 });
    expect(setVideoInsertScale(s0, 1, 0.5).videoInserts[0]?.scale).toBe(0.5);
    expect(setVideoInsertScale(s0, 1, 99).videoInserts[0]?.scale).toBe(5);
  });

  it('setVideoInsertFile は空文字を無視', () => {
    const s0 = addVideoInsert(st(), 'a.mp4', 0);
    expect(setVideoInsertFile(s0, 1, '').videoInserts[0]?.file).toBe('a.mp4');
    expect(setVideoInsertFile(s0, 1, 'b.mp4').videoInserts[0]?.file).toBe('b.mp4');
  });

  it('selectVideoInsert', () => {
    const s0 = addVideoInsert(st(), 'a.mp4', 0);
    expect(selectVideoInsert(s0, 1).selection).toEqual({ kind: 'videoInsert', id: 1 });
  });

  it('applySourceOffsetToFile は同ファイルの各クリップへ線形オフセットを適用する', () => {
    let s = st();
    s = addVideoInsert(s, 'a.mp4', 100); // id=1
    s = setVideoInsertInPoint(s, 1, 130); // offset = 130-100 = 30
    s = addVideoInsert(s, 'a.mp4', 300); // id=2 同ファイル
    s = addVideoInsert(s, 'b.mp4', 500); // id=3 別ファイル
    s = applySourceOffsetToFile(s, 1);
    expect(s.videoInserts.find((v) => v.id === 2)?.sourceInFrame).toBe(330); // 300+30
    expect(s.videoInserts.find((v) => v.id === 3)?.sourceInFrame).toBe(0);   // 別ファイルは不変
  });

  it('applySourceOffsetToFile は基準 ID 不在ならそのまま', () => {
    const s = addVideoInsert(st(), 'a.mp4', 100);
    expect(applySourceOffsetToFile(s, 999)).toBe(s);
  });

  it('applySourceOffsetToFile は負オフセットを 0 へクランプする', () => {
    let s = st();
    s = addVideoInsert(s, 'c.mp4', 500); // id=1 originalStart=500
    s = setVideoInsertInPoint(s, 1, 50); // sourceInFrame=50, offset=50-500=-450
    s = addVideoInsert(s, 'c.mp4', 200); // id=2 同ファイル originalStart=200
    s = applySourceOffsetToFile(s, 1);
    // 200 + (-450) = -250 → max(0, round(-250)) = 0
    expect(s.videoInserts.find((v) => v.id === 2)?.sourceInFrame).toBe(0);
  });
});

describe('setVideoInsertPlaybackRate', () => {
  it('0.5x で尺が 2 倍に伸び playbackRate が入る（D_source 保持）', () => {
    const s = addVideoInsert(st(), 'a.mp4', 100); // originalStart=100, originalEnd=220 (default 120fr)
    const id = s.videoInserts[0]!.id;
    const out = setVideoInsertPlaybackRate(s, id, 0.5);
    const v = out.videoInserts.find((x) => x.id === id)!;
    expect(v.playbackRate).toBe(0.5);
    expect(v.originalEnd - v.originalStart).toBe(240); // 120 / 0.5
  });

  it('2x で尺が半分に縮む', () => {
    const s = addVideoInsert(st(), 'a.mp4', 100);
    const id = s.videoInserts[0]!.id;
    const out = setVideoInsertPlaybackRate(s, id, 2);
    const v = out.videoInserts.find((x) => x.id === id)!;
    expect(v.originalEnd - v.originalStart).toBe(60); // 120 / 2
  });

  it('範囲外はクランプ（0.05→0.1 / 20→16）', () => {
    const s = addVideoInsert(st(), 'a.mp4', 100);
    const id = s.videoInserts[0]!.id;
    expect(setVideoInsertPlaybackRate(s, id, 0.05).videoInserts.find((x) => x.id === id)!.playbackRate).toBe(0.1);
    expect(setVideoInsertPlaybackRate(s, id, 20).videoInserts.find((x) => x.id === id)!.playbackRate).toBe(16);
  });

  it('同値設定は no-op（同一 state 参照を返し履歴に積まない）', () => {
    const s = addVideoInsert(st(), 'a.mp4', 100);
    const id = s.videoInserts[0]!.id;
    const out = setVideoInsertPlaybackRate(s, id, 1); // 既定 1.0 と同値
    expect(out).toBe(s);
  });

  it('0.5x → 1x で元の尺へ戻る（D_source 保持の往復）', () => {
    const s = addVideoInsert(st(), 'a.mp4', 100);
    const id = s.videoInserts[0]!.id;
    const slow = setVideoInsertPlaybackRate(s, id, 0.5);
    const back = setVideoInsertPlaybackRate(slow, id, 1);
    const v = back.videoInserts.find((x) => x.id === id)!;
    expect(v.originalEnd - v.originalStart).toBe(120);
  });

  it('非有限レート（NaN）は no-op（同一 state 参照）', () => {
    const s = addVideoInsert(st(), 'a.mp4', 100);
    const id = s.videoInserts[0]!.id;
    const out = setVideoInsertPlaybackRate(s, id, NaN);
    expect(out).toBe(s);
  });

  it('存在しない id は no-op（同一 state 参照）', () => {
    const s = addVideoInsert(st(), 'a.mp4', 100);
    const out = setVideoInsertPlaybackRate(s, 999, 0.5);
    expect(out).toBe(s);
  });
});

describe('setVideoInsertEnter / setVideoInsertExit', () => {
  it('登場/退場アニメを設定する', () => {
    const base = addVideoInsert(st(), 'b.mp4', 0);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const id = base.videoInserts[0]!.id;
    const e = setVideoInsertEnter(base, id, { kind: 'slideIn', frames: 10, direction: 'right' });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(e.videoInserts[0]!.enter).toEqual({ kind: 'slideIn', frames: 10, direction: 'right' });
    const x = setVideoInsertExit(e, id, { kind: 'fade', frames: 8 });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(x.videoInserts[0]!.exit).toEqual({ kind: 'fade', frames: 8 });
  });

  it('不在 ID はそのまま（参照同一）', () => {
    const base = addVideoInsert(st(), 'a.mp4', 0);
    expect(setVideoInsertEnter(base, 999, { kind: 'fade', frames: 8 })).toBe(base);
    expect(setVideoInsertExit(base, 999, { kind: 'fade', frames: 8 })).toBe(base);
  });
});
