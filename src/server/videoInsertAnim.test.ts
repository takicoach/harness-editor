/**
 * サブ動画の出入りアニメ（正典⑥）を native の静的レイヤ列へ分解する層のテスト（M4 T4）。
 *
 * ここが守るのは2つ:
 *  1. **正典との数値パリティ**: `videoInsertAnimSampleAt` が `core/elementAnim.animStyleAt`
 *     （正典そのもの・Remotion 側と同一ファイル）と opacity / scale / translate で一致すること。
 *     正典の `transform` は文字列なので、**文字列を解析して数値へ戻して**突き合わせる
 *     ——「別の式を書き写した」ではなく「同じ関数の出力」であることを機械で確かめる。
 *  2. **分解の不変条件**: 生成された step 列が窓 [0,D) を穴なく覆い、可視な k を1つも落とさず、
 *     アニメが恒等の場合は `undefined`（＝従来の1レイヤ経路＝出力1文字不変）になること。
 */
import { describe, expect, it } from 'vitest';
import { animStyleAt } from '../core/elementAnim';
import type { ElementAnim } from '../core/types';
import { videoInsertPlacement } from './nativeExportVideo';
import {
  MAX_VIDEO_INSERT_ANIM_STEPS,
  videoInsertAnimSampleAt,
  videoInsertAnimSteps,
} from './videoInsertAnim';

const SIZE = { width: 1280, height: 720 };

/** 正典の transform 文字列（'' / `scale(x)` / `translate(a%, b%)`）を数値へ戻す。 */
function parseTransform(t: string): { scale: number; tx: number; ty: number } {
  if (t === '') return { scale: 1, tx: 0, ty: 0 };
  const s = /^scale\((-?[\d.]+)\)$/.exec(t);
  if (s !== null) return { scale: Number(s[1]), tx: 0, ty: 0 };
  const m = /^translate\((-?[\d.]+)%, (-?[\d.]+)%\)$/.exec(t);
  if (m !== null) return { scale: 1, tx: Number(m[1]), ty: Number(m[2]) };
  throw new Error(`解析できない transform: ${t}`);
}

const KINDS = ['none', 'fade', 'zoom', 'pop', 'slideIn'] as const;
const DIRECTIONS = ['left', 'right', 'up', 'down'] as const;

describe('videoInsertAnimSampleAt（正典 animStyleAt との数値パリティ）', () => {
  it('5 種 × 方向 4 × frames 1..12 × 全 k で opacity/scale/translate が正典と一致する', () => {
    const D = 30;
    let compared = 0;
    let nonIdentity = 0;
    for (const kind of KINDS) {
      for (const direction of DIRECTIONS) {
        for (let frames = 1; frames <= 12; frames += 1) {
          const enter: ElementAnim = { kind, frames, direction };
          const exit: ElementAnim = { kind, frames, direction };
          for (let k = 0; k < D; k += 1) {
            const want = animStyleAt(k, D, enter, exit);
            const got = videoInsertAnimSampleAt(k, D, enter, exit);
            const wt = parseTransform(want.transform);
            expect(got.opacity, `${kind}/${direction}/${frames}/k=${k} opacity`).toBeCloseTo(want.opacity, 12);
            expect(got.scale, `${kind}/${direction}/${frames}/k=${k} scale`).toBeCloseTo(wt.scale, 12);
            expect(got.translateXPercent, `${kind}/${direction}/${frames}/k=${k} tx`).toBeCloseTo(wt.tx, 12);
            expect(got.translateYPercent, `${kind}/${direction}/${frames}/k=${k} ty`).toBeCloseTo(wt.ty, 12);
            compared += 1;
            if (want.opacity !== 1 || want.transform !== '') nonIdentity += 1;
          }
        }
      }
    }
    // 恒等ばかりを比べて緑になる穴を塞ぐ（vacuous PASS 封じ）。
    expect(compared).toBeGreaterThan(0);
    expect(nonIdentity).toBeGreaterThan(0);
  });

  it('enter が exit より優先される（両端の窓が重なる D < enter+exit で正典と一致）', () => {
    const D = 6;
    const enter: ElementAnim = { kind: 'fade', frames: 5 };
    const exit: ElementAnim = { kind: 'zoom', frames: 5 };
    let overlapping = 0;
    for (let k = 0; k < D; k += 1) {
      const want = animStyleAt(k, D, enter, exit);
      const got = videoInsertAnimSampleAt(k, D, enter, exit);
      expect(got.opacity).toBeCloseTo(want.opacity, 12);
      expect(got.scale).toBeCloseTo(parseTransform(want.transform).scale, 12);
      if (k < 5 && k > D - 5) overlapping += 1;
    }
    expect(overlapping).toBeGreaterThan(0); // 実際に両窓が重なる k を測っている
  });
});

describe('videoInsertAnimSteps（静的レイヤ列への分解）', () => {
  const base = videoInsertPlacement(SIZE, undefined, 1);

  it('enter/exit が none なら undefined（従来の1レイヤ経路＝出力1文字不変）', () => {
    expect(videoInsertAnimSteps(SIZE, undefined, 1, 30, undefined, undefined)).toBeUndefined();
    expect(
      videoInsertAnimSteps(SIZE, undefined, 1, 30, { kind: 'none', frames: 8 }, { kind: 'none', frames: 8 }),
    ).toBeUndefined();
  });

  it('frames=0 は正典では無アニメ＝undefined（種別だけを見た過剰退避をしない・M-6 1）', () => {
    expect(
      videoInsertAnimSteps(SIZE, undefined, 1, 30, { kind: 'fade', frames: 0 }, { kind: 'pop', frames: 0 }),
    ).toBeUndefined();
  });

  it('enter=fade 8fr: k=0 は不可視で落ち、k=1..7 が 1 フレームずつ、残りは平坦部 1 段にまとまる', () => {
    const steps = videoInsertAnimSteps(SIZE, undefined, 1, 30, { kind: 'fade', frames: 8 }, undefined)!;
    expect(steps).toBeDefined();
    // k=0（opacity 0）は描かれない → 最初の step は k=1 から。
    expect(steps[0]!.kStart).toBe(1);
    expect(steps.map((s) => [s.kStart, s.kEnd])).toEqual([
      [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 30],
    ]);
    for (let j = 0; j < 7; j += 1) {
      expect(steps[j]!.opacity).toBeCloseTo((j + 1) / 8, 12);
      // fade は幾何を変えない＝配置は静的 placement と同一。
      expect(steps[j]!.placement).toEqual(base);
    }
    expect(steps[7]!.opacity).toBe(1);
  });

  it('exit=fade 8fr: 窓は (D-frames, D] ＝ k=23..29 が 1 フレームずつ（k=22 はまだ平坦）', () => {
    const steps = videoInsertAnimSteps(SIZE, undefined, 1, 30, undefined, { kind: 'fade', frames: 8 })!;
    expect(steps[0]).toEqual({ kStart: 0, kEnd: 23, opacity: 1, placement: base });
    expect(steps.slice(1).map((s) => s.kStart)).toEqual([23, 24, 25, 26, 27, 28, 29]);
    expect(steps.at(-1)!.opacity).toBeCloseTo(1 / 8, 12);
  });

  it('pop enter: k=2 の配置が幅 512（scale 0.4＝1.12 倍のオーバーシュートを含む正典どおり）', () => {
    const steps = videoInsertAnimSteps(SIZE, undefined, 1, 30, { kind: 'pop', frames: 8 }, undefined)!;
    const k2 = steps.find((s) => s.kStart === 2)!;
    expect(k2.placement.width).toBe(512);
    // 中心基準の配置（(1280-512)/2 = 384）。
    expect(k2.placement.x).toBe(384);
  });

  it('pop enter の 1.12 倍オーバーシュート域では配置が合成解像度を超え、crop が可視域だけを残す', () => {
    const steps = videoInsertAnimSteps(SIZE, undefined, 1, 30, { kind: 'pop', frames: 8 }, undefined)!;
    const over = steps.filter((s) => s.placement.width > SIZE.width);
    expect(over.length).toBeGreaterThan(0); // オーバーシュートが実際に起きている
    for (const s of over) {
      expect(s.placement.crop).toBeDefined();
      // 可視域は合成のちょうど中（はみ出した分だけを捨てる）。
      expect(s.placement.x + s.placement.crop!.x).toBe(0);
      expect(s.placement.crop!.width).toBe(SIZE.width);
    }
  });

  it('slideIn enter(left): k=7 の配置が正典実測（bbox [0,0]-[1119,719]）と一致する', () => {
    const steps = videoInsertAnimSteps(
      SIZE, undefined, 1, 30, { kind: 'slideIn', frames: 8, direction: 'left' }, undefined,
    )!;
    const k7 = steps.find((s) => s.kStart === 7)!;
    expect(k7.placement.width).toBe(1280);
    expect(k7.placement.x).toBe(-160); // -12.5% × 1280
    expect(k7.placement.x + k7.placement.crop!.x).toBe(0);
    expect(k7.placement.crop!.width).toBe(1120); // 可視域 0..1119
  });

  it('外側アニメ scale は内側 position も一緒に拡大する（別レイヤの合成順を畳んだ式）', () => {
    // zoom k=4: t=0.5 → s_a=0.925。position(0.4,0) の画素量は s_a 倍される。
    const steps = videoInsertAnimSteps(
      SIZE, { x: 0.4, y: 0 }, 1, 30, { kind: 'zoom', frames: 8 }, undefined,
    )!;
    const k4 = steps.find((s) => s.kStart === 4)!;
    const sa = 0.925;
    const width = Math.round(1280 * sa);
    expect(k4.placement.width).toBe(width);
    expect(k4.placement.x).toBe(Math.round((1280 - width) / 2 + sa * ((0.4 * 1280) / 2)));
  });

  it('step 列は窓 [0,D) の可視 k を漏れなく覆い、重ならない', () => {
    for (const kind of KINDS) {
      if (kind === 'none') continue;
      const steps = videoInsertAnimSteps(SIZE, { x: -0.2, y: 0.1 }, 0.8, 24, { kind, frames: 6 }, { kind, frames: 6 })!;
      expect(steps.length).toBeGreaterThan(1);
      let prev = -1;
      for (const s of steps) {
        expect(s.kStart).toBeGreaterThan(prev);
        expect(s.kEnd).toBeGreaterThan(s.kStart);
        prev = s.kEnd - 1;
      }
      expect(steps.at(-1)!.kEnd).toBe(24);
      // 落ちた k は「正典でも見えない k」だけ。
      const covered = new Set<number>();
      for (const s of steps) for (let k = s.kStart; k < s.kEnd; k += 1) covered.add(k);
      for (let k = 0; k < 24; k += 1) {
        if (covered.has(k)) continue;
        const a = videoInsertAnimSampleAt(k, 24, { kind, frames: 6 }, { kind, frames: 6 });
        expect(a.opacity === 0 || Math.round(1280 * 0.8 * a.scale) <= 0, `${kind} k=${k} が理由なく落ちた`).toBe(true);
      }
    }
  });

  it('step 数が上限を超えると throw（呼び出し側が Remotion へ退避するための境界）', () => {
    const frames = MAX_VIDEO_INSERT_ANIM_STEPS;
    expect(() =>
      videoInsertAnimSteps(SIZE, undefined, 1, frames * 4, { kind: 'fade', frames }, { kind: 'fade', frames }),
    ).toThrow(/step/);
    // 陽性対照: 上限ちょうど手前は throw しない（上限が「常に throw」になっていない）。
    expect(() =>
      videoInsertAnimSteps(SIZE, undefined, 1, 200, { kind: 'fade', frames: 8 }, { kind: 'fade', frames: 8 }),
    ).not.toThrow();
  });
});
