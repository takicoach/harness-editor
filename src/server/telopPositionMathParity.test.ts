/**
 * project-template/src/テロップテンプレート/telopPositionMath.ts（書き出し正本の自己完結コピー）
 * および src/server/telopPack/Telop.tsx（テロップパック・同梱スタイルの自己完結アダプタ）
 * が Harness Editor 本体 src/preview/telopLayout.ts の clampTelopX / telopMaxWidthFrac と
 * 完全同一の値を返すことを固定する（B-1 差し戻し対応・2026-09-06 #2, #3）。
 *
 * どちらもプロジェクトへコピーされ本体の import を持たないため式が複製されている。
 * ドリフト（一箇所だけ直して他を直し忘れる）を機械的に検出する。
 */
import { describe, it, expect } from 'vitest';
import { clampTelopX as editorClampTelopX, telopMaxWidthFrac as editorMaxWidthFrac } from '../preview/telopLayout';
import {
  clampTelopX as templateClampTelopX,
  telopMaxWidthFrac as templateMaxWidthFrac,
} from '../../project-template/src/テロップテンプレート/telopPositionMath';
import { clampTelopX as packClampTelopX, telopMaxWidthFrac as packMaxWidthFrac } from './telopPack/Telop';

const SOURCES = [
  { label: 'project-template/telopPositionMath', clamp: templateClampTelopX, maxWidthFrac: templateMaxWidthFrac },
  { label: 'telopPack/Telop', clamp: packClampTelopX, maxWidthFrac: packMaxWidthFrac },
];

describe.each(SOURCES)('$label と telopLayout（本体）の一致', ({ clamp, maxWidthFrac }) => {
  const FORMATS = [
    { label: 'youtube(横)', w: 1920, h: 1080 },
    { label: 'short(縦)', w: 1080, h: 1920 },
    { label: 'square(正方形)', w: 1080, h: 1080 },
  ];

  for (const { label, w, h } of FORMATS) {
    it(`telopMaxWidthFrac: ${label}`, () => {
      expect(maxWidthFrac(w, h)).toBe(editorMaxWidthFrac(w, h));
    });
  }

  const CASES: Array<[x: number, containerW: number, elemW: number]> = [
    [-1, 1920, 800],
    [1, 1920, 800],
    [0, 1920, 1920],
    [1, 1080, 993.6],
    [-1, 0, 100], // 壊れた入力
    [NaN, 1920, 100],
    [1, 1920, 3000], // 帯がコンテナより広い
  ];

  for (const [x, containerW, elemW] of CASES) {
    it(`clampTelopX(${x}, ${containerW}, ${elemW})`, () => {
      expect(clamp(x, containerW, elemW)).toBe(editorClampTelopX(x, containerW, elemW));
    });
  }
});
