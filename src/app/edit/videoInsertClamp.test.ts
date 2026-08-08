/**
 * サブ動画クリップの「素材の実尺クランプ」回帰（ARCHITECTURE 残課題 #3）。
 *
 * サブ動画は区間長 × 速度がソース残量（実尺 − sourceInFrame）を超えると、
 * 末尾がソース最終フレームで静止する。BGM は loop 定義あり・SE は実尺 auto-fit あり
 * だったのにサブ動画だけ非対称だった。
 *
 * 実尺は App が非表示 video 要素でプローブして供給する。プローブ未完了・
 * 実尺不明のファイルは **クランプしない**（＝従来挙動）ことが安全側の契約。
 */

import { describe, expect, it } from 'vitest';
import { retimeVideoInsert, videoInsertMaxEnd, videoInsertOverflowFrames } from './videoInsertOps';
import type { EditState } from './editState';
import type { EditorVideoInsert } from '../../core/types';
import { videoInsertPlaybackSpan } from '../../core/videoInsertEngine';

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

/** 既定クリップ: 原本 100..220（尺 120）・イン点 0・等速。 */
function clip(over: Partial<EditorVideoInsert> = {}): EditorVideoInsert {
  return { id: 1, originalStart: 100, originalEnd: 220, file: 'sub/cam2.mp4', sourceInFrame: 0, ...over };
}

function withClip(over: Partial<EditorVideoInsert> = {}): EditState {
  return st({ videoInserts: [clip(over)], nextVideoInsertId: 2 });
}

describe('videoInsertMaxEnd — 素材内に収まる originalEnd の上限', () => {
  it('等速・イン点0: 上限 = start + 素材尺', () => {
    expect(videoInsertMaxEnd(clip(), 300, 100, [])).toBe(400);
  });

  it('倍速: ソース消費が尺×速度なので許容尺は 1/2', () => {
    expect(videoInsertMaxEnd(clip({ playbackRate: 2 }), 300, 100, [])).toBe(250);
  });

  it('スロー(0.5x): 許容尺は 2 倍', () => {
    expect(videoInsertMaxEnd(clip({ playbackRate: 0.5 }), 300, 100, [])).toBe(700);
  });

  it('イン点オフセットあり: 残量 = 素材尺 − sourceInFrame', () => {
    expect(videoInsertMaxEnd(clip({ sourceInFrame: 120 }), 300, 100, [])).toBe(280);
  });

  it('端数は切り捨てる（素材の外へ 1 フレームもはみ出さない）', () => {
    // 残量 301、rate 2 → floor(301/2)=150
    expect(videoInsertMaxEnd(clip({ playbackRate: 2 }), 301, 100, [])).toBe(250);
  });

  it('実尺不明（undefined / 非有限 / 0以下）は上限なし＝undefined', () => {
    expect(videoInsertMaxEnd(clip(), undefined, 100, [])).toBeUndefined();
    expect(videoInsertMaxEnd(clip(), Number.NaN, 100, [])).toBeUndefined();
    expect(videoInsertMaxEnd(clip(), 0, 100, [])).toBeUndefined();
    expect(videoInsertMaxEnd(clip(), -5, 100, [])).toBeUndefined();
  });

  it('イン点が素材尺を超えていても start+1 は下回らない（退化ガード）', () => {
    expect(videoInsertMaxEnd(clip({ sourceInFrame: 400 }), 300, 100, [])).toBe(101);
  });

  it('左端ドラッグで start が動いたときは新しい start を基準にする', () => {
    // 同じクリップでも start=50 なら上限も 50 ぶん手前へ動く。
    expect(videoInsertMaxEnd(clip(), 300, 50, [])).toBe(350);
  });
});

describe('videoInsertOverflowFrames — イン点変更で素材外へ出た量', () => {
  it('収まっていれば 0', () => {
    expect(videoInsertOverflowFrames(clip(), 300, [])).toBe(0);
    expect(videoInsertOverflowFrames(clip({ sourceInFrame: 180 }), 300, [])).toBe(0);
  });

  it('イン点を後ろへずらして素材尻を越えた分を返す', () => {
    // 尺 120・イン点 200 → 消費 200..320、素材 300 → 20 超過
    expect(videoInsertOverflowFrames(clip({ sourceInFrame: 200 }), 300, [])).toBe(20);
  });

  it('速度が上がるとソース消費が増え超過も増える', () => {
    // 尺 120 × 2x = 240 消費、イン点 100 → 340、素材 300 → 40 超過
    expect(videoInsertOverflowFrames(clip({ sourceInFrame: 100, playbackRate: 2 }), 300, [])).toBe(40);
  });

  it('実尺不明なら null（判定しない＝警告も出さない）', () => {
    expect(videoInsertOverflowFrames(clip(), undefined, [])).toBeNull();
    expect(videoInsertOverflowFrames(clip(), 0, [])).toBeNull();
  });
});

describe('カット区間を跨ぐクリップ（消費量は再生尺×速度）', () => {
  // クリップ 100..220（原本尺 120）の内側に [150,170) のカット → 再生尺は 100。
  const cuts = [{ start: 150, end: 170 }];

  it('クリップ内部にカット区間があるとき誤警告を出さない', () => {
    // 素材 110f。原本尺 120 で測ると 10f 超過に見えるが、実消費は再生尺 100 なので収まっている。
    expect(videoInsertOverflowFrames(clip(), 110, cuts)).toBe(0);
    // 原本座標のままなら誤警告していたことを対照で示す（カット無しでは超過する）。
    expect(videoInsertOverflowFrames(clip(), 110, [])).toBe(10);
  });

  it('再生尺が本当に足りないときは従来どおり超過を出す', () => {
    // 素材 90f、再生尺 100 → 10f 超過。
    expect(videoInsertOverflowFrames(clip(), 90, cuts)).toBe(10);
  });

  it('上限は再生座標で出してから原本座標へ戻す（カット分だけ後ろへ伸ばせる）', () => {
    // 素材 110f・等速・イン点0 → 許容再生尺 110。playbackStart=100 なので
    // 再生 210 に対応する原本フレーム = 210 + 20（カット長）= 230。
    const max = videoInsertMaxEnd(clip(), 110, 100, cuts);
    expect(max).toBe(230);
    // 実際にその上限まで伸ばすと、再生尺がちょうど許容値になる（射影と一致する）。
    expect(videoInsertPlaybackSpan(100, max as number, cuts)).toBe(110);
  });

  it('クランプ後のクリップは超過警告を出さない（クランプと警告が同じ座標系）', () => {
    const max = videoInsertMaxEnd(clip(), 110, 100, cuts) as number;
    const clamped = retimeVideoInsert(
      st({ videoInserts: [clip()], nextVideoInsertId: 2 }),
      1, 100, 9999, max,
    ).videoInserts[0]!;
    expect(videoInsertOverflowFrames(clamped, 110, cuts)).toBe(0);
  });

  it('倍速でもカット後の再生尺で判定する', () => {
    // 再生尺 100 × 2x = 200 消費。素材 200 ならちょうど収まる。
    expect(videoInsertOverflowFrames(clip({ playbackRate: 2 }), 200, cuts)).toBe(0);
    expect(videoInsertOverflowFrames(clip({ playbackRate: 2 }), 180, cuts)).toBe(20);
  });

  it('start がカット区間内なら上限を出さない（編集不可経路・勝手に縮めない）', () => {
    expect(videoInsertMaxEnd(clip(), 110, 160, cuts)).toBeUndefined();
  });
});

describe('retimeVideoInsert — maxEnd クランプ', () => {
  it('素材尺を超える end は maxEnd までクランプされる（等速）', () => {
    const s = withClip();
    const max = videoInsertMaxEnd(clip(), 300, 100, []);
    const next = retimeVideoInsert(s, 1, 100, 9999, max);
    expect(next.videoInserts[0]?.originalEnd).toBe(400);
  });

  it('倍速では許容尺が半分になる（同じ素材でも上限が違う）', () => {
    const c = clip({ playbackRate: 2 });
    const s = st({ videoInserts: [c], nextVideoInsertId: 2 });
    const next = retimeVideoInsert(s, 1, 100, 9999, videoInsertMaxEnd(c, 300, 100, []));
    expect(next.videoInserts[0]?.originalEnd).toBe(250);
  });

  it('イン点オフセットぶんだけ上限が手前へ寄る', () => {
    const c = clip({ sourceInFrame: 120 });
    const s = st({ videoInserts: [c], nextVideoInsertId: 2 });
    const next = retimeVideoInsert(s, 1, 100, 9999, videoInsertMaxEnd(c, 300, 100, []));
    expect(next.videoInserts[0]?.originalEnd).toBe(280);
  });

  it('実尺不明（maxEnd 未指定）ならクランプせず従来どおり伸ばせる', () => {
    const s = withClip();
    const next = retimeVideoInsert(s, 1, 100, 9999, videoInsertMaxEnd(clip(), undefined, 100, []));
    expect(next.videoInserts[0]?.originalEnd).toBe(9999);
  });

  it('素材内に収まる end は maxEnd があっても素通し（no-op クランプ）', () => {
    const s = withClip();
    const next = retimeVideoInsert(s, 1, 100, 250, videoInsertMaxEnd(clip(), 300, 100, []));
    expect(next.videoInserts[0]?.originalEnd).toBe(250);
  });

  it('maxEnd が start+1 を下回っても end >= start+1 を保つ', () => {
    const s = withClip();
    const next = retimeVideoInsert(s, 1, 100, 9999, 50);
    expect(next.videoInserts[0]?.originalEnd).toBe(101);
  });

  it('maxEnd 非有限はクランプなし（プローブ結果が壊れていても編集を止めない）', () => {
    const s = withClip();
    const next = retimeVideoInsert(s, 1, 100, 500, Number.NaN);
    expect(next.videoInserts[0]?.originalEnd).toBe(500);
  });

  it('maxEnd を渡さない既存呼び出しは挙動が変わらない（後方互換）', () => {
    const s = withClip();
    const next = retimeVideoInsert(s, 1, 100, 500);
    expect(next.videoInserts[0]).toMatchObject({ originalStart: 100, originalEnd: 500 });
  });
});
