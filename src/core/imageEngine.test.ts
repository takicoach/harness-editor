import { describe, expect, it } from 'vitest';
import { anchorImages, projectImages, clampImages, imageInCutRegion } from './imageEngine';
import type { CutRegion, EditorImage, ImageSegment } from './types';

const REGIONS: CutRegion[] = [{ start: 1000, end: 3000 }];

describe('anchorImages', () => {
  it('再生フレーム区間を原本フレーム区間へ逆射影する', () => {
    const images: ImageSegment[] = [
      { id: 1, startFrame: 500, endFrame: 800, file: 'a.png', type: 'photo' },
      { id: 2, startFrame: 1500, endFrame: 1800, file: 'b.png', type: 'overlay', scale: 1.5 },
    ];
    expect(anchorImages(images, REGIONS)).toEqual([
      { id: 1, originalStart: 500, originalEnd: 800, file: 'a.png', type: 'photo' },
      { id: 2, originalStart: 3500, originalEnd: 3800, file: 'b.png', type: 'overlay', scale: 1.5 },
    ]);
  });

  it('カット無しなら frame はそのまま', () => {
    expect(
      anchorImages(
        [{ id: 1, startFrame: 80, endFrame: 200, file: 'a.png', type: 'photo' }],
        [],
      ),
    ).toEqual([
      { id: 1, originalStart: 80, originalEnd: 200, file: 'a.png', type: 'photo' },
    ]);
  });
});

describe('projectImages', () => {
  it('原本フレーム区間を再生フレーム区間へ射影する', () => {
    const images: EditorImage[] = [
      { id: 1, originalStart: 500, originalEnd: 800, file: 'a.png', type: 'photo' },
      { id: 2, originalStart: 3500, originalEnd: 3800, file: 'b.png', type: 'overlay', scale: 1.5 },
    ];
    expect(projectImages(images, REGIONS)).toEqual([
      { id: 1, startFrame: 500, endFrame: 800, file: 'a.png', type: 'photo' },
      { id: 2, startFrame: 1500, endFrame: 1800, file: 'b.png', type: 'overlay', scale: 1.5 },
    ]);
  });

  it('anchorImages → projectImages はカット外で往復一致する', () => {
    const images: ImageSegment[] = [
      { id: 1, startFrame: 100, endFrame: 600, file: 'a.png', type: 'infographic' },
    ];
    expect(projectImages(anchorImages(images, REGIONS), REGIONS)).toEqual(images);
  });
});

describe('clampImages', () => {
  it('開始端がカット内なら区間終端へ寄せる', () => {
    const result = clampImages(
      [{ id: 1, originalStart: 1500, originalEnd: 3500, file: 'a.png', type: 'photo' }],
      REGIONS,
    );
    expect(result.images).toEqual([
      { id: 1, originalStart: 3000, originalEnd: 3500, file: 'a.png', type: 'photo' },
    ]);
    expect(result.flaggedIds).toEqual([]);
  });

  it('終了端がカット内なら区間始端へ寄せる', () => {
    const result = clampImages(
      [{ id: 1, originalStart: 500, originalEnd: 2500, file: 'a.png', type: 'photo' }],
      REGIONS,
    );
    expect(result.images).toEqual([
      { id: 1, originalStart: 500, originalEnd: 1000, file: 'a.png', type: 'photo' },
    ]);
    expect(result.flaggedIds).toEqual([]);
  });

  it('完全にカット区間内へ飲まれた画像は flagged になり原形のまま残す', () => {
    const original: EditorImage = {
      id: 7, originalStart: 1500, originalEnd: 2500, file: 'a.png', type: 'photo',
    };
    const result = clampImages([original], REGIONS);
    expect(result.images).toEqual([original]);
    expect(result.flaggedIds).toEqual([7]);
  });

  it('カット境界に触れない画像は手を加えない（参照同一）', () => {
    const original: EditorImage = {
      id: 1, originalStart: 100, originalEnd: 900, file: 'a.png', type: 'photo',
    };
    const result = clampImages([original], REGIONS);
    expect(result.images[0]).toBe(original);
    expect(result.flaggedIds).toEqual([]);
  });
});

describe('imageInCutRegion', () => {
  // imageInCutRegion は「区間の両端」がカット内にあるかを判定する。
  // セマンティクスを明示するため境界ケースをテストで固定する。M5 の UI 警告表示で使用予定。

  it('両端がカット内なら true', () => {
    expect(imageInCutRegion(1200, 2500, REGIONS)).toBe(true);
  });

  it('開始のみカット内（部分カット）は false', () => {
    expect(imageInCutRegion(1500, 3500, REGIONS)).toBe(false);
  });

  it('終了のみカット内（部分カット）は false', () => {
    expect(imageInCutRegion(500, 2500, REGIONS)).toBe(false);
  });

  it('カット区間を跨ぐが両端は外側なら false（区間を含むだけでは true にしない）', () => {
    expect(imageInCutRegion(500, 3500, REGIONS)).toBe(false);
  });

  it('終端が cut.end と一致する場合は exclusive 扱いで両端外と判定して false', () => {
    // endFrame は排他的（[start, end)）。originalEnd = 3000 は kept 区間の最初のフレーム。
    expect(imageInCutRegion(500, 3000, REGIONS)).toBe(false);
  });

  it('開始端が cut.start と一致する場合（区間内扱い）+ 終了も区間内 → true', () => {
    expect(imageInCutRegion(1000, 2500, REGIONS)).toBe(true);
  });
});
