import { describe, it, expect } from 'vitest';
import { anchorTelops, projectTelops } from './telopEngine';
import { clampTelops, clampSubtitleRange, clampSubtitleMove } from './telopEngine';
import type { EditorTelop, TelopSegment } from './types';

const regions = [{ start: 300, end: 500 }];

describe('anchorTelops', () => {
  it('再生フレームを原本フレームアンカーへ変換する', () => {
    const telops: TelopSegment[] = [
      { id: 1, startFrame: 100, endFrame: 200, text: 'a' },
      { id: 2, startFrame: 350, endFrame: 450, text: 'b' },
    ];
    const anchored = anchorTelops(telops, regions);
    expect(anchored[0]).toMatchObject({ id: 1, originalStart: 100, originalEnd: 200 });
    expect(anchored[1]).toMatchObject({ id: 2, originalStart: 550, originalEnd: 650 });
  });

  it('startFrame / endFrame は EditorTelop に残さない', () => {
    const anchored = anchorTelops([{ id: 1, startFrame: 0, endFrame: 60, text: 'a' }], []);
    expect('startFrame' in anchored[0]!).toBe(false);
  });
});

describe('projectTelops', () => {
  it('原本アンカーを再生フレームへ射影する', () => {
    const telops: EditorTelop[] = [
      { id: 1, originalStart: 100, originalEnd: 200, text: 'a' },
      { id: 2, originalStart: 550, originalEnd: 650, text: 'b' },
    ];
    const projected = projectTelops(telops, regions);
    expect(projected[0]).toMatchObject({ id: 1, startFrame: 100, endFrame: 200 });
    expect(projected[1]).toMatchObject({ id: 2, startFrame: 350, endFrame: 450 });
  });

  it('anchorTelops と往復一致する', () => {
    const telops: TelopSegment[] = [{ id: 1, startFrame: 350, endFrame: 450, text: 'b' }];
    expect(projectTelops(anchorTelops(telops, regions), regions)).toEqual(telops);
  });

  it('任意フィールド（style/position 等）を保持する', () => {
    const telops: EditorTelop[] = [
      { id: 1, originalStart: 0, originalEnd: 60, text: 'a', style: 'emphasis', scale: 1.2 },
    ];
    expect(projectTelops(telops, [])[0]).toMatchObject({ style: 'emphasis', scale: 1.2 });
  });

  it('originalEnd がカット開始位置と一致するテロップを壊さず射影する', () => {
    const result = projectTelops(
      [{ id: 1, originalStart: 100, originalEnd: 300, text: 'a' }],
      [{ start: 300, end: 500 }],
    );
    expect(result[0]!).toMatchObject({ startFrame: 100, endFrame: 299 });
  });

  it('フレーム0がカット内でも startFrame が負にならない', () => {
    const result = projectTelops(
      [{ id: 1, originalStart: 0, originalEnd: 100, text: 'a' }],
      [{ start: 0, end: 50 }],
    );
    expect(result[0]!.startFrame).toBeGreaterThanOrEqual(0);
  });
});

describe('anchorTelops - originalStart/originalEnd 明示フィールド', () => {
  it('TelopSegment に originalStart/originalEnd が両方存在する場合は逆射影せず直接使う', () => {
    // flagged テロップ: 再生フレームは 0/0 に潰れているが originalStart/originalEnd は原本値を持つ
    const telops: TelopSegment[] = [
      {
        id: 7,
        startFrame: 0,
        endFrame: 0,
        text: 'カットされたテロップ',
        originalStart: 350,
        originalEnd: 450,
      },
    ];
    const anchored = anchorTelops(telops, regions);
    // 逆射影すると 0→0 になるが、明示フィールドがあるので 350/450 を直接使う
    expect(anchored[0]).toMatchObject({ id: 7, originalStart: 350, originalEnd: 450 });
  });

  it('originalStart のみ存在（片方欠け）は逆射影フォールバックする', () => {
    const telops: TelopSegment[] = [
      { id: 8, startFrame: 100, endFrame: 200, text: 'a', originalStart: 350 } as TelopSegment,
    ];
    // originalEnd が無いので通常の逆射影: regions=[{start:300,end:500}] → 100→100, 200→200
    const anchored = anchorTelops(telops, regions);
    expect(anchored[0]).toMatchObject({ id: 8, originalStart: 100, originalEnd: 200 });
  });

  it('originalEnd のみ存在（片方欠け）も逆射影フォールバックする', () => {
    const telops: TelopSegment[] = [
      { id: 9, startFrame: 100, endFrame: 200, text: 'a', originalEnd: 450 } as TelopSegment,
    ];
    const anchored = anchorTelops(telops, regions);
    expect(anchored[0]).toMatchObject({ id: 9, originalStart: 100, originalEnd: 200 });
  });

  it('明示フィールドを持つ TelopSegment に startFrame/endFrame は EditorTelop に残さない', () => {
    const telops: TelopSegment[] = [
      { id: 10, startFrame: 0, endFrame: 0, text: 'a', originalStart: 100, originalEnd: 200 },
    ];
    const anchored = anchorTelops(telops, []);
    expect('startFrame' in anchored[0]!).toBe(false);
    expect('endFrame' in anchored[0]!).toBe(false);
  });
});

describe('clampTelops', () => {
  const regions = [{ start: 300, end: 500 }];

  it('カット区間に踏み込んだ端を区間外へ寄せる', () => {
    const telops: EditorTelop[] = [{ id: 1, originalStart: 250, originalEnd: 400, text: 'a' }];
    const result = clampTelops(telops, regions);
    expect(result.telops[0]).toMatchObject({ originalStart: 250, originalEnd: 300 });
    expect(result.flaggedIds).toEqual([]);
  });

  it('開始端がカット内なら区間の後ろへ寄せる', () => {
    const telops: EditorTelop[] = [{ id: 1, originalStart: 350, originalEnd: 600, text: 'a' }];
    expect(clampTelops(telops, regions).telops[0]).toMatchObject({
      originalStart: 500,
      originalEnd: 600,
    });
  });

  it('完全にカットへ飲まれたテロップは flaggedIds に入れて残す', () => {
    const telops: EditorTelop[] = [{ id: 7, originalStart: 350, originalEnd: 450, text: 'a' }];
    const result = clampTelops(telops, regions);
    expect(result.flaggedIds).toEqual([7]);
    expect(result.telops).toHaveLength(1);
  });

  it('カットに掛からないテロップは変更しない', () => {
    const telops: EditorTelop[] = [{ id: 1, originalStart: 0, originalEnd: 200, text: 'a' }];
    expect(clampTelops(telops, regions)).toEqual({ telops, flaggedIds: [] });
  });
});

describe('clampSubtitleRange（隣接字幕との重なりクランプ・装飾テロップは対象外）', () => {
  it('直前の字幕へ食い込む開始位置は直前の originalEnd へ寄せる', () => {
    const telops: EditorTelop[] = [
      { id: 1, originalStart: 0, originalEnd: 200, text: 'a' },
      { id: 2, originalStart: 300, originalEnd: 400, text: 'b' },
    ];
    expect(clampSubtitleRange(telops, 2, 150, 400)).toEqual({ originalStart: 200, originalEnd: 400 });
  });

  it('直後の字幕へ食い込む終了位置は直後の originalStart へ寄せる', () => {
    const telops: EditorTelop[] = [
      { id: 1, originalStart: 0, originalEnd: 200, text: 'a' },
      { id: 2, originalStart: 300, originalEnd: 400, text: 'b' },
    ];
    expect(clampSubtitleRange(telops, 1, 0, 350)).toEqual({ originalStart: 0, originalEnd: 300 });
  });

  it('前後どちらへも食い込む不正区間は両側クランプする', () => {
    const telops: EditorTelop[] = [
      { id: 1, originalStart: 0, originalEnd: 100, text: 'a' },
      { id: 2, originalStart: 200, originalEnd: 300, text: 'b' },
      { id: 3, originalStart: 400, originalEnd: 500, text: 'c' },
    ];
    expect(clampSubtitleRange(telops, 2, 50, 450)).toEqual({ originalStart: 100, originalEnd: 400 });
  });

  it('隣接（装飾＝manual）テロップとの重なりは無視する', () => {
    const telops: EditorTelop[] = [
      { id: 1, originalStart: 0, originalEnd: 300, text: '装飾', manual: true },
      { id: 2, originalStart: 300, originalEnd: 400, text: 'b' },
    ];
    // id:2 の字幕が装飾テロップの区間へ広がっても、装飾はクランプ対象に含まない。
    expect(clampSubtitleRange(telops, 2, 100, 400)).toEqual({ originalStart: 100, originalEnd: 400 });
  });

  it('自身が装飾テロップ（manual）の場合はクランプせずそのまま返す', () => {
    const telops: EditorTelop[] = [
      { id: 1, originalStart: 0, originalEnd: 100, text: 'a' },
      { id: 2, originalStart: 200, originalEnd: 300, text: 'b' },
      { id: 3, originalStart: 0, originalEnd: 400, text: '装飾', manual: true },
    ];
    expect(clampSubtitleRange(telops, 3, 0, 400)).toEqual({ originalStart: 0, originalEnd: 400 });
  });

  it('クランプ後に start>=end となる不正区間は最低 1 フレームを確保する', () => {
    const telops: EditorTelop[] = [
      { id: 1, originalStart: 0, originalEnd: 200, text: 'a' },
      { id: 2, originalStart: 200, originalEnd: 300, text: 'b' },
    ];
    // id:1 を id:2 の区間内へ丸ごとずらす不正入力（隣接テロップに食い込みすぎて潰れるケース）。
    const result = clampSubtitleRange(telops, 1, 250, 280);
    expect(result.originalEnd).toBeGreaterThan(result.originalStart);
  });

  it('隣接するテロップが無ければクランプしない', () => {
    const telops: EditorTelop[] = [{ id: 1, originalStart: 100, originalEnd: 200, text: 'a' }];
    expect(clampSubtitleRange(telops, 1, 50, 500)).toEqual({ originalStart: 50, originalEnd: 500 });
  });
});

describe('clampSubtitleMove（本体ドラッグ用・区間長を保って境界で止める）', () => {
  const telops: EditorTelop[] = [
    { id: 1, originalStart: 0, originalEnd: 200, text: 'a' },
    { id: 2, originalStart: 300, originalEnd: 400, text: 'b' },
    { id: 3, originalStart: 600, originalEnd: 700, text: 'c' },
  ];

  it('隙間の中の移動は尺を保ってそのまま通す', () => {
    expect(clampSubtitleMove(telops, 2, 350, 100)).toEqual({ originalStart: 350, originalEnd: 450 });
  });

  it('直後の字幕へ食い込む移動は尺を保って手前で止める', () => {
    // id:2 (尺100) を 550 へ → id:3 の 600 にぶつかるので 500 で止まり尺は 100 のまま。
    expect(clampSubtitleMove(telops, 2, 550, 100)).toEqual({ originalStart: 500, originalEnd: 600 });
  });

  it('直前の字幕へ食い込む移動は尺を保って直前の end で止める', () => {
    expect(clampSubtitleMove(telops, 2, 150, 100)).toEqual({ originalStart: 200, originalEnd: 300 });
  });

  it('隙間が尺より狭い場合は隙間いっぱいに収める', () => {
    // id:2 (200..500 の隙間ではなく) 尺 150 を id:1〜id:3 間の狭い隙間へ… 400..600 の隙間(200)より広い尺 250 → 隙間いっぱい。
    const tight: EditorTelop[] = [
      { id: 1, originalStart: 0, originalEnd: 200, text: 'a' },
      { id: 2, originalStart: 210, originalEnd: 460, text: 'b' },
      { id: 3, originalStart: 250, originalEnd: 350, text: 'c' },
    ];
    expect(clampSubtitleMove(tight, 2, 210, 250)).toEqual({ originalStart: 200, originalEnd: 250 });
  });

  it('装飾テロップ（manual）は制限なしで移動できる', () => {
    const withManual: EditorTelop[] = [
      ...telops,
      { id: 9, originalStart: 0, originalEnd: 100, text: '装飾', manual: true },
    ];
    expect(clampSubtitleMove(withManual, 9, 350, 100)).toEqual({ originalStart: 350, originalEnd: 450 });
  });
});
