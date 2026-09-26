import { describe, expect, it } from 'vitest';
import {
  anchorVideoInserts,
  projectVideoInserts,
  clampVideoInserts,
  videoInsertInCutRegion,
  videoInsertSourceOverflowFrames,
  clampVideoInsertSourceEnd,
  clampVideoInsertsToSourceLength,
  videoInsertHasNoPlayableFrames,
  consumedSourceFrames,
} from './videoInsertEngine';
import type { CutRegion, EditorVideoInsert, VideoInsert } from './types';

const noCuts: CutRegion[] = [];

it('clamps independent subvideo on its final clock while preserving the archived source anchor', () => {
  const item: EditorVideoInsert = { id: 1, file: 'sub.mp4', originalStart: 0, originalEnd: 10, sourceInFrame: 12, playbackRate: 2,
    timelinePlacement: { startFrame: 101, endFrame: 141 } };
  expect(consumedSourceFrames(item)).toBe(80);
  const result = clampVideoInsertsToSourceLength([item], { 'sub.mp4': 52 });
  expect(result.clampedIds).toEqual([1]);
  expect(result.videoInserts[0]).toEqual({ ...item, timelinePlacement: { startFrame: 101, endFrame: 121 } });
  expect(videoInsertSourceOverflowFrames(result.videoInserts[0]!, 52)).toBe(0);
});

describe('anchorVideoInserts', () => {
  it('カット無しでは再生フレーム＝原本フレーム・sourceInFrame は不変', () => {
    const items: VideoInsert[] = [
      { id: 1, startFrame: 100, endFrame: 200, file: 'sub/cam2.mp4', sourceInFrame: 30 },
    ];
    expect(anchorVideoInserts(items, noCuts)).toEqual([
      { id: 1, originalStart: 100, originalEnd: 200, file: 'sub/cam2.mp4', sourceInFrame: 30 },
    ]);
  });

  it('先頭カット区間ぶん再生フレームが原本で後ろへずれる', () => {
    const cuts: CutRegion[] = [{ start: 0, end: 50 }];
    const items: VideoInsert[] = [
      { id: 1, startFrame: 0, endFrame: 10, file: 'sub/cam2.mp4', sourceInFrame: 5 },
    ];
    const r = anchorVideoInserts(items, cuts);
    expect(r[0]?.originalStart).toBe(50);
    expect(r[0]?.originalEnd).toBe(60);
    expect(r[0]?.sourceInFrame).toBe(5);
  });

  it('position / scale を保持する', () => {
    const items: VideoInsert[] = [
      { id: 2, startFrame: 0, endFrame: 10, file: 'a.mp4', sourceInFrame: 0, position: { x: 0.2, y: -0.3 }, scale: 0.5 },
    ];
    const r = anchorVideoInserts(items, noCuts);
    expect(r[0]?.position).toEqual({ x: 0.2, y: -0.3 });
    expect(r[0]?.scale).toBe(0.5);
  });
});

describe('projectVideoInserts', () => {
  it('anchor の逆変換で元の再生フレームへ戻る（往復）', () => {
    const cuts: CutRegion[] = [{ start: 0, end: 50 }];
    const editor: EditorVideoInsert[] = [
      { id: 1, originalStart: 50, originalEnd: 60, file: 'sub/cam2.mp4', sourceInFrame: 5 },
    ];
    expect(projectVideoInserts(editor, cuts)).toEqual([
      { id: 1, startFrame: 0, endFrame: 10, file: 'sub/cam2.mp4', sourceInFrame: 5 },
    ]);
  });
});

describe('clampVideoInserts', () => {
  it('カット区間にかかる start を区間外へ寄せる', () => {
    const cuts: CutRegion[] = [{ start: 100, end: 200 }];
    const editor: EditorVideoInsert[] = [
      { id: 1, originalStart: 150, originalEnd: 250, file: 'a.mp4', sourceInFrame: 0 },
    ];
    const r = clampVideoInserts(editor, cuts);
    expect(r.videoInserts[0]?.originalStart).toBe(200);
    expect(r.videoInserts[0]?.originalEnd).toBe(250);
    expect(r.flaggedIds).toEqual([]);
  });

  it('カット区間に完全に飲まれたクリップは flagged・原形保持', () => {
    const cuts: CutRegion[] = [{ start: 100, end: 300 }];
    const editor: EditorVideoInsert[] = [
      { id: 7, originalStart: 150, originalEnd: 250, file: 'a.mp4', sourceInFrame: 0 },
    ];
    const r = clampVideoInserts(editor, cuts);
    expect(r.flaggedIds).toEqual([7]);
    expect(r.videoInserts[0]?.originalStart).toBe(150);
  });

  it('別々の2カットが start と end を両方とも区間外へ寄せる', () => {
    // start は前カット[100,160)で160へ、end は後カット[200,300)で200へ寄る（flagged にならない）。
    const cuts: CutRegion[] = [{ start: 100, end: 160 }, { start: 200, end: 300 }];
    const editor: EditorVideoInsert[] = [
      { id: 1, originalStart: 150, originalEnd: 250, file: 'a.mp4', sourceInFrame: 0 },
    ];
    const r = clampVideoInserts(editor, cuts);
    expect(r.videoInserts[0]?.originalStart).toBe(160);
    expect(r.videoInserts[0]?.originalEnd).toBe(200);
    expect(r.flaggedIds).toEqual([]);
  });
});

// 保存経路の契約: serializeProject は必ず clamp → project の順で呼ぶ。
// カットに飲まれたクリップは clamp で flagged になり（原形保持）、project すると退化区間
// （startFrame === endFrame）へ落ちる。最終 render は playbackEnd > playbackStart で描画スキップ
// するため、「カットで消えたクリップは映さない」が正しく表現される（挿入画像と同じ確立パターン）。
describe('clamp→project 契約（カット飲み込みは退化区間として落ちる）', () => {
  it('飲まれたクリップは flagged、project で start===end の退化区間になる', () => {
    const cuts: CutRegion[] = [{ start: 100, end: 300 }];
    const editor: EditorVideoInsert[] = [
      { id: 7, originalStart: 150, originalEnd: 250, file: 'a.mp4', sourceInFrame: 9 },
    ];
    const { videoInserts: clamped, flaggedIds } = clampVideoInserts(editor, cuts);
    expect(flaggedIds).toEqual([7]);
    const projected = projectVideoInserts(clamped, cuts);
    // 退化（start===end）＝最終 render の playbackEnd>playbackStart フィルタで描かれない。
    expect(projected[0]?.startFrame).toBe(projected[0]?.endFrame);
    // sourceInFrame は退化区間でも carry-through される。
    expect(projected[0]?.sourceInFrame).toBe(9);
  });
});

describe('videoInsertInCutRegion', () => {
  it('両端がカット区間内なら true', () => {
    const cuts: CutRegion[] = [{ start: 100, end: 300 }];
    expect(videoInsertInCutRegion(150, 250, cuts)).toBe(true);
  });
  it('区間外を含むなら false', () => {
    const cuts: CutRegion[] = [{ start: 100, end: 300 }];
    expect(videoInsertInCutRegion(50, 250, cuts)).toBe(false);
  });
});

describe('videoInsertSourceOverflowFrames（A-2）', () => {
  it('sourceLengthFrames が null なら判定不能で null（長さ未計測）', () => {
    const v: EditorVideoInsert = { id: 1, originalStart: 0, originalEnd: 100, file: 'a.mp4', sourceInFrame: 0 };
    expect(videoInsertSourceOverflowFrames(v, null)).toBeNull();
  });
  it('sourceInFrame + 消費長 がソース長以内なら 0', () => {
    const v: EditorVideoInsert = { id: 1, originalStart: 0, originalEnd: 100, file: 'a.mp4', sourceInFrame: 10 };
    expect(videoInsertSourceOverflowFrames(v, 110)).toBe(0);
    expect(videoInsertSourceOverflowFrames(v, 200)).toBe(0);
  });
  it('超過分をフレーム数で返す', () => {
    const v: EditorVideoInsert = { id: 1, originalStart: 0, originalEnd: 100, file: 'a.mp4', sourceInFrame: 10 };
    expect(videoInsertSourceOverflowFrames(v, 90)).toBe(20); // 10+100=110, 90超え=20
  });
  it('playbackRate を消費長へ反映する（2倍速は消費が2倍）', () => {
    const v: EditorVideoInsert = { id: 1, originalStart: 0, originalEnd: 50, file: 'a.mp4', sourceInFrame: 0, playbackRate: 2 };
    // 消費 = 50*2 = 100
    expect(videoInsertSourceOverflowFrames(v, 100)).toBe(0);
    expect(videoInsertSourceOverflowFrames(v, 80)).toBe(20);
  });
});

describe('clampVideoInsertSourceEnd（A-2・保存時クランプ）', () => {
  it('sourceLengthFrames が null なら無変更（同一参照）', () => {
    const v: EditorVideoInsert = { id: 1, originalStart: 10, originalEnd: 40, file: 'a.mp4', sourceInFrame: 5 };
    expect(clampVideoInsertSourceEnd(v, null)).toBe(v);
  });
  it('超過していなければ無変更（同一参照）', () => {
    const v: EditorVideoInsert = { id: 1, originalStart: 10, originalEnd: 40, file: 'a.mp4', sourceInFrame: 5 };
    expect(clampVideoInsertSourceEnd(v, 100)).toBe(v);
  });
  it('超過していれば originalEnd を縮める。originalStart・sourceInFrame は不変', () => {
    // sourceInFrame(5) + 消費(30) = 35 > sourceLength(30) → 5 フレーム超過
    const v: EditorVideoInsert = { id: 1, originalStart: 10, originalEnd: 40, file: 'a.mp4', sourceInFrame: 5 };
    const clamped = clampVideoInsertSourceEnd(v, 30);
    expect(clamped.originalStart).toBe(10);
    expect(clamped.sourceInFrame).toBe(5);
    expect(clamped.originalEnd).toBe(35); // 消費が 25 まで縮む
    expect(clamped.sourceInFrame + (clamped.originalEnd - clamped.originalStart)).toBeLessThanOrEqual(30);
  });
  it('sourceInFrame が既にソース長以上＝再生可能フレームがゼロなら原形のまま返す（C-1・問題2: 1フレーム捏造の廃止）', () => {
    // 旧実装は maxDSource を Math.max(1, …) で底上げし newEnd=11 を作っていたが、
    // sourceInFrame(100) 自体が既にソース末尾(30)を超えているため、その1フレームも
    // 実在しない source 位置を指す＝「クランプしたのに直っていない」捏造だった。
    // 再生可能フレームが無い場合はクランプで直せる範囲ではないので、原形のまま返し
    // clampVideoInsertsToSourceLength 側の unplayableIds で明示的に扱う（非破壊方針）。
    const v: EditorVideoInsert = { id: 1, originalStart: 10, originalEnd: 40, file: 'a.mp4', sourceInFrame: 100 };
    const clamped = clampVideoInsertSourceEnd(v, 30);
    expect(clamped).toBe(v);
  });

  it('境界: sourceInFrame がソース末尾ちょうど（残0フレーム）でも原形のまま返す', () => {
    const v: EditorVideoInsert = { id: 1, originalStart: 10, originalEnd: 40, file: 'a.mp4', sourceInFrame: 30 };
    const clamped = clampVideoInsertSourceEnd(v, 30);
    expect(clamped).toBe(v);
  });
});

describe('clampVideoInsertSourceEnd（C-1・rate>1 の丸めがソース長を超える不具合の修正）', () => {
  it('残ソース101フレーム・rate2: round()だと51→消費102で超過する。floor()で50→消費100に収める', () => {
    // Codex 指摘の実例そのもの。sourceLengthFrames=200, sourceInFrame=99 → 残り101フレーム。
    const v: EditorVideoInsert = {
      id: 1,
      originalStart: 0,
      originalEnd: 200,
      file: 'a.mp4',
      sourceInFrame: 99,
      playbackRate: 2,
    };
    const clamped = clampVideoInsertSourceEnd(v, 200);
    const consumed = consumedSourceFrames(clamped);
    // 受け入れ基準: どの playbackRate でもクランプ後の消費ソースフレーム数がソース長を超えない。
    expect(v.sourceInFrame + consumed).toBeLessThanOrEqual(200);
    expect(clamped.originalEnd).toBe(50); // floor(101/2) = 50（round だと 51 になり不合格）
    expect(consumed).toBe(100);
  });

  it('rate<1（低速）でも消費がソース長を超えない', () => {
    const v: EditorVideoInsert = {
      id: 1,
      originalStart: 0,
      originalEnd: 200,
      file: 'a.mp4',
      sourceInFrame: 0,
      playbackRate: 0.5,
    };
    const clamped = clampVideoInsertSourceEnd(v, 50);
    const consumed = consumedSourceFrames(clamped);
    expect(v.sourceInFrame + consumed).toBeLessThanOrEqual(50);
    expect(clamped.originalEnd).toBe(100); // floor(50/0.5) = 100 → 消費 round(100*0.5)=50 ちょうど
  });

  it('端数ぴったり（割り切れる）場合は丸めの影響を受けずソース長ちょうどまで使う', () => {
    const v: EditorVideoInsert = {
      id: 1,
      originalStart: 0,
      originalEnd: 999,
      file: 'a.mp4',
      sourceInFrame: 0,
      playbackRate: 2,
    };
    const clamped = clampVideoInsertSourceEnd(v, 100);
    const consumed = consumedSourceFrames(clamped);
    expect(consumed).toBeLessThanOrEqual(100);
    expect(clamped.originalEnd).toBe(50); // floor(100/2)=50, 消費=100 ちょうど
  });

  it('rate が大きく残ソースが1フレーム未満しか無い場合は「1フレーム捏造」せず原形のまま返す', () => {
    // 残り1フレームしか無いのに rate=2 だと1タイムラインフレームでも2フレーム消費して超過する。
    // floor(1/2)=0 → 収まる整数フレームが無いので原形のまま返す（unplayable 側で扱う）。
    const v: EditorVideoInsert = {
      id: 1,
      originalStart: 10,
      originalEnd: 40,
      file: 'a.mp4',
      sourceInFrame: 29,
      playbackRate: 2,
    };
    const clamped = clampVideoInsertSourceEnd(v, 30);
    expect(clamped).toBe(v);
  });
});

describe('clampVideoInsertsToSourceLength（A-2・保存時のバッチ版）', () => {
  it('マップに無い file は無変更で通す（長さ不明＝安全側）', () => {
    const items: EditorVideoInsert[] = [
      { id: 1, originalStart: 10, originalEnd: 40, file: 'unknown.mp4', sourceInFrame: 5 },
    ];
    const { videoInserts, clampedIds } = clampVideoInsertsToSourceLength(items, {});
    expect(videoInserts).toEqual(items);
    expect(clampedIds).toEqual([]);
  });
  it('該当ファイルだけクランプし、clampedIds に id を積む', () => {
    const items: EditorVideoInsert[] = [
      { id: 1, originalStart: 10, originalEnd: 40, file: 'a.mp4', sourceInFrame: 5 }, // 超過
      { id: 2, originalStart: 0, originalEnd: 20, file: 'a.mp4', sourceInFrame: 0 }, // 超過しない
    ];
    const { videoInserts, clampedIds } = clampVideoInsertsToSourceLength(items, { 'a.mp4': 30 });
    expect(clampedIds).toEqual([1]);
    expect(videoInserts[0]?.originalEnd).toBe(35);
    expect(videoInserts[1]).toBe(items[1]); // 変更なしは同一参照
  });
  it('再生可能フレームがゼロのクリップは unplayableIds に積み、データは変更しない（C-1・問題2）', () => {
    const items: EditorVideoInsert[] = [
      { id: 1, originalStart: 10, originalEnd: 40, file: 'a.mp4', sourceInFrame: 100 }, // 残0フレーム
      { id: 2, originalStart: 0, originalEnd: 20, file: 'a.mp4', sourceInFrame: 0 }, // 正常
    ];
    const { videoInserts, clampedIds, unplayableIds } = clampVideoInsertsToSourceLength(items, { 'a.mp4': 30 });
    expect(clampedIds).toEqual([]);
    expect(unplayableIds).toEqual([1]);
    expect(videoInserts[0]).toBe(items[0]); // 捏造せず原形保持
    expect(videoInserts[1]).toBe(items[1]);
  });
});

/**
 * X-2(a): 「クランプでは直せない＝再生できるフレームが1枚も残っていない」の判定を
 * 単一の述語として公開する。保存時（clampVideoInsertsToSourceLength）と
 * Inspector の警告文言が同じ基準で動くことを保証するための共有部品。
 */
describe('videoInsertHasNoPlayableFrames', () => {
  const base = { id: 1, originalStart: 0, originalEnd: 30, file: 'a.mp4', sourceInFrame: 0 };

  it('イン点がソース終端以降なら true', () => {
    expect(videoInsertHasNoPlayableFrames({ ...base, sourceInFrame: 30 }, 30)).toBe(true);
    expect(videoInsertHasNoPlayableFrames({ ...base, sourceInFrame: 45 }, 30)).toBe(true);
  });

  it('倍率が高すぎて1タイムラインフレーム分も残ソースに収まらないなら true', () => {
    expect(
      videoInsertHasNoPlayableFrames({ ...base, sourceInFrame: 29, playbackRate: 4 }, 30),
    ).toBe(true);
  });

  it('末尾を詰めれば再生できるなら false（クランプで直せる＝再生不能ではない）', () => {
    expect(videoInsertHasNoPlayableFrames({ ...base, sourceInFrame: 5 }, 30)).toBe(false);
  });

  it('そもそも超過していなければ false', () => {
    expect(videoInsertHasNoPlayableFrames(base, 100)).toBe(false);
  });

  it('ソース長が不明（null）なら false（安全側・警告を出さない）', () => {
    expect(videoInsertHasNoPlayableFrames({ ...base, sourceInFrame: 999 }, null)).toBe(false);
  });
});
