import { describe, expect, it, test } from 'vitest';
import {
  addBgm,
  moveBgm,
  resizeBgm,
  setBgmVolume,
  setBgmFadeIn,
  setBgmFadeOut,
  setBgmFile,
  removeBgm,
  selectBgm,
  normalizeBgmVolume,
} from './bgmOps';
import type { EditState } from './editState';
import type { EditorBgmClip } from '../../core/types';

function st(over: Partial<EditState> = {}): EditState {
  return {
    telops: [], cutRegions: [], se: [], images: [], videoInserts: [], bgm: [],
    selection: null, multiTelopIds: [], nextTelopId: 1, nextSeId: 1, nextImageId: 1, nextVideoInsertId: 1, nextBgmId: 1,
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

describe('addBgm', () => {
  it('再生ヘッド位置に既定区間の BGM を1件足し、選択する', () => {
    const s = addBgm(st(), 'a.mp3', 0);
    expect(s.bgm).toHaveLength(1);
    expect(s.bgm[0]?.file).toBe('a.mp3');
    expect(s.selection).toEqual({ kind: 'bgm', id: s.bgm[0]?.id });
    expect(s.bgm[0]?.volume).toBeGreaterThan(0);
    // EditorBgmClip は原本アンカー（startFrame/endFrame は持たない）
    expect(s.bgm[0]?.originalEnd).toBeGreaterThan(s.bgm[0]?.originalStart ?? -1);
  });

  it('id は nextBgmId を使い、nextBgmId が進む', () => {
    const s = addBgm(st(), 'a.mp3', 0);
    expect(s.bgm[0]?.id).toBe(1);
    expect(s.nextBgmId).toBe(2);
  });

  it('addBgm は file 空・非有限 start を無視', () => {
    expect(addBgm(st(), '', 100).bgm).toHaveLength(0);
    expect(addBgm(st(), 'a.mp3', NaN).bgm).toHaveLength(0);
  });

  it('start は 0 以上へクランプされる', () => {
    const s = addBgm(st(), 'a.mp3', -50);
    expect(s.bgm[0]?.originalStart).toBe(0);
  });

  it('originalStart/End が設定される（既定区間長 > 0）', () => {
    const s = addBgm(st(), 'a.mp3', 100);
    expect(s.bgm[0]?.originalStart).toBe(100);
    expect(s.bgm[0]?.originalEnd).toBeGreaterThan(100);
  });
});

describe('setBgmVolume / setBgmFadeIn / setBgmFadeOut', () => {
  it('音量・フェードを更新する', () => {
    let s = addBgm(st(), 'a.mp3', 0);
    const id = s.bgm[0]!.id;
    s = setBgmVolume(s, id, 0.5);
    s = setBgmFadeIn(s, id, 20);
    s = setBgmFadeOut(s, id, 15);
    expect(s.bgm[0]).toMatchObject({ volume: 0.5, fadeInFrames: 20, fadeOutFrames: 15 });
  });

  it('音量は 0〜1 にクランプ', () => {
    let s = addBgm(st(), 'a.mp3', 0);
    const id = s.bgm[0]!.id;
    expect(setBgmVolume(s, id, 2).bgm[0]?.volume).toBe(1);
    expect(setBgmVolume(s, id, -1).bgm[0]?.volume).toBe(0);
  });

  it('フェードは 0 以上にクランプ', () => {
    let s = addBgm(st(), 'a.mp3', 0);
    const id = s.bgm[0]!.id;
    expect(setBgmFadeIn(s, id, -5).bgm[0]?.fadeInFrames).toBe(0);
    expect(setBgmFadeOut(s, id, -3).bgm[0]?.fadeOutFrames).toBe(0);
  });

  it('不在 ID は state をそのまま返す', () => {
    const s = addBgm(st(), 'a.mp3', 0);
    expect(setBgmVolume(s, 999, 0.5)).toBe(s);
    expect(setBgmFadeIn(s, 999, 10)).toBe(s);
    expect(setBgmFadeOut(s, 999, 10)).toBe(s);
  });
});

describe('setBgmFile / removeBgm / selectBgm', () => {
  it('ファイルを差し替える', () => {
    let s = addBgm(st(), 'a.mp3', 0);
    s = setBgmFile(s, s.bgm[0]!.id, 'b.mp3');
    expect(s.bgm[0]?.file).toBe('b.mp3');
  });

  it('setBgmFile は空文字を無視', () => {
    const s = addBgm(st(), 'a.mp3', 0);
    expect(setBgmFile(s, s.bgm[0]!.id, '').bgm[0]?.file).toBe('a.mp3');
  });

  it('削除すると配列から消え選択も外れる', () => {
    let s = addBgm(st(), 'a.mp3', 0);
    s = removeBgm(s, s.bgm[0]!.id);
    expect(s.bgm).toHaveLength(0);
    expect(s.selection).toBeNull();
  });

  it('別アイテムが選択中なら removeBgm で選択は変わらない', () => {
    let s = addBgm(st(), 'a.mp3', 0);
    const id = s.bgm[0]!.id;
    s = { ...s, selection: { kind: 'telop', id: 99 } };
    s = removeBgm(s, id);
    expect(s.selection).toEqual({ kind: 'telop', id: 99 });
  });

  it('selectBgm で selection が bgm になる', () => {
    let s = addBgm(st(), 'a.mp3', 0);
    s = selectBgm(s, s.bgm[0]!.id);
    expect(s.selection).toEqual({ kind: 'bgm', id: s.bgm[0]!.id });
  });
});

describe('moveBgm', () => {
  it('長さを保ち平行移動する', () => {
    const s0 = addBgm(st(), 'a.mp3', 100);
    const len = s0.bgm[0]!.originalEnd - s0.bgm[0]!.originalStart;
    const s1 = moveBgm(s0, 1, 300);
    expect(s1.bgm[0]?.originalStart).toBe(300);
    expect(s1.bgm[0]?.originalEnd).toBe(300 + len);
  });

  it('負の start は 0 へクランプ', () => {
    const s0 = addBgm(st(), 'a.mp3', 100);
    const s1 = moveBgm(s0, 1, -50);
    expect(s1.bgm[0]?.originalStart).toBe(0);
  });

  it('非有限 start はそのまま返す', () => {
    const s0 = addBgm(st(), 'a.mp3', 100);
    expect(moveBgm(s0, 1, NaN)).toBe(s0);
  });
});

describe('resizeBgm', () => {
  it('両端を独立設定・end >= start + 1 保証', () => {
    const s0 = addBgm(st(), 'a.mp3', 0);
    const s1 = resizeBgm(s0, 1, 50, 40); // end < start → 自動補正
    expect(s1.bgm[0]?.originalStart).toBe(50);
    expect(s1.bgm[0]?.originalEnd).toBe(51);
  });

  it('通常の両端設定', () => {
    const s0 = addBgm(st(), 'a.mp3', 0);
    const s1 = resizeBgm(s0, 1, 10, 200);
    expect(s1.bgm[0]?.originalStart).toBe(10);
    expect(s1.bgm[0]?.originalEnd).toBe(200);
  });

  it('非有限値はそのまま返す', () => {
    const s0 = addBgm(st(), 'a.mp3', 0);
    expect(resizeBgm(s0, 1, NaN, 100)).toBe(s0);
    expect(resizeBgm(s0, 1, 10, Infinity)).toBe(s0);
  });
});

test('addBgm は autoVolume を立てる', () => {
  const s = addBgm(st(), 'b.mp3', 0);
  expect(s.bgm[0]?.autoVolume).toBe(true);
});

test('normalizeBgmVolume は volume 確定＋autoVolume 解除', () => {
  const s = addBgm(st(), 'b.mp3', 0);
  const id = s.bgm[0]!.id;
  const n = normalizeBgmVolume(s, id, 0.33);
  expect(n.bgm[0]?.volume).toBeCloseTo(0.33, 6);
  expect(n.bgm[0]?.autoVolume).toBeUndefined();
});

test('setBgmVolume（手動）は autoVolume を外す', () => {
  const s = addBgm(st(), 'b.mp3', 0);
  const id = s.bgm[0]!.id;
  expect(setBgmVolume(s, id, 0.6).bgm[0]?.autoVolume).toBeUndefined();
});

// --- 重ね禁止（単一トラック運用・spec §9.1）---
// BGM は「1曲ずつ・重ねない」。重なる配置は隣接クリップ端へスナップ（or 収まらなければ据え置き）。
// 参照: BGM トラック設計（内部設計書）§9.1
function bgmClip(id: number, originalStart: number, originalEnd: number): EditorBgmClip {
  return {
    id,
    originalStart,
    originalEnd,
    file: `bgm${id}.mp3`,
    volume: 0.2,
    fadeInFrames: 0,
    fadeOutFrames: 0,
  };
}

/** 全 BGM クリップが半開区間として重ならないことを検証する。 */
function assertNoBgmOverlap(bgm: EditorBgmClip[]): void {
  const sorted = [...bgm].sort((a, b) => a.originalStart - b.originalStart);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i]!.originalStart).toBeGreaterThanOrEqual(sorted[i - 1]!.originalEnd);
  }
}

describe('BGM 重ね禁止（単一トラック）', () => {
  it('addBgm: 既存クリップに重なる位置なら、その後ろの空きへずらす', () => {
    const s0 = st({ bgm: [bgmClip(1, 100, 220)], nextBgmId: 2 });
    const s1 = addBgm(s0, 'new.mp3', 150); // [150,270) は [100,220) と重なる
    const added = s1.bgm.find((b) => b.id === 2)!;
    expect(added.originalStart).toBe(220); // 既存クリップ末尾へスナップ
    expect(added.originalEnd).toBe(340); // 既定長 120 を保つ
    assertNoBgmOverlap(s1.bgm);
  });

  it('addBgm: 空きが既定長より狭ければ次クリップ手前で縮める（開始は再生ヘッド）', () => {
    // 空き [100,160) は幅 60 で既定長 120 より狭い。再生ヘッド 120 は空き内。
    const s0 = st({ bgm: [bgmClip(1, 0, 100), bgmClip(2, 160, 400)], nextBgmId: 3 });
    const s1 = addBgm(s0, 'new.mp3', 120);
    const added = s1.bgm.find((b) => b.id === 3)!;
    expect(added.originalStart).toBe(120); // 再生ヘッド位置から
    expect(added.originalEnd).toBe(160); // 右クリップ手前で切る（既定長より短い）
    assertNoBgmOverlap(s1.bgm);
  });

  it('addBgm: 空きが十分なら指定位置に既定長で置く（従来どおり）', () => {
    const s0 = st({ bgm: [bgmClip(1, 0, 100)], nextBgmId: 2 });
    const s1 = addBgm(s0, 'new.mp3', 500);
    const added = s1.bgm.find((b) => b.id === 2)!;
    expect(added.originalStart).toBe(500);
    expect(added.originalEnd).toBe(620);
  });

  it('moveBgm: 隣接クリップへ寄せると端でスナップして重ならない', () => {
    const s0 = st({ bgm: [bgmClip(1, 0, 100), bgmClip(2, 200, 320)], nextBgmId: 3 });
    const s1 = moveBgm(s0, 2, 50); // 左のクリップ [0,100) へ突っ込む位置
    const moved = s1.bgm.find((b) => b.id === 2)!;
    expect(moved.originalStart).toBe(100); // 左クリップ末尾でスナップ
    expect(moved.originalEnd).toBe(220); // 長さ 120 を保つ
    assertNoBgmOverlap(s1.bgm);
  });

  it('moveBgm: 隙間が長さ未満の位置へは移動しない（据え置き）', () => {
    const s0 = st({
      bgm: [bgmClip(1, 0, 100), bgmClip(2, 110, 230), bgmClip(3, 400, 520)],
      nextBgmId: 4,
    });
    const s1 = moveBgm(s0, 3, 105); // 隙間 [100,110) は幅 10 で長さ 120 が入らない
    const moved = s1.bgm.find((b) => b.id === 3)!;
    expect(moved.originalStart).toBe(400); // 動かさない
    expect(moved.originalEnd).toBe(520);
    assertNoBgmOverlap(s1.bgm);
  });

  it('resizeBgm: 右端は右隣クリップの開始でクランプ', () => {
    const s0 = st({ bgm: [bgmClip(1, 0, 100), bgmClip(2, 150, 300)], nextBgmId: 3 });
    const s1 = resizeBgm(s0, 1, 0, 250); // 右端 250 は右隣 [150,300) に食い込む
    const resized = s1.bgm.find((b) => b.id === 1)!;
    expect(resized.originalStart).toBe(0);
    expect(resized.originalEnd).toBe(150); // 右隣の開始でクランプ
    assertNoBgmOverlap(s1.bgm);
  });

  it('resizeBgm: 左端は左隣クリップの終端でクランプ', () => {
    const s0 = st({ bgm: [bgmClip(1, 0, 100), bgmClip(2, 150, 300)], nextBgmId: 3 });
    const s1 = resizeBgm(s0, 2, 50, 300); // 左端 50 は左隣 [0,100) に食い込む
    const resized = s1.bgm.find((b) => b.id === 2)!;
    expect(resized.originalStart).toBe(100); // 左隣の終端でクランプ
    expect(resized.originalEnd).toBe(300);
    assertNoBgmOverlap(s1.bgm);
  });
});
