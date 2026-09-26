import {describe,expect,it} from 'vitest';
import {BUILTIN_TELOP_ANIMATION_IDS,NEW_TELOP_ANIMATION_IDS,TELOP_ANIMATION_IDS} from './types';
import type {TelopAnimation} from './types';
import {
  TELOP_ANIMATION_LABELS, TELOP_TYPE_CURSOR,
  isNewTelopAnimation, telopAnimationEffect, telopBandColor, telopExitOpacity,
  telopEnterFrames,telopExitFrames,telopTypeCursorPlan,telopScaleFrames,
  telopGraphemeCount, telopSliceGraphemes, type TelopAnimationId,
} from './telopAnimation';
import { TELOP_ANIMATION_CASE_FRAMES, TELOP_ANIMATION_CASES } from './telopAnimationCases';

it('17 種を既存 9＋新規 8 で構成する',()=>{
  expect(BUILTIN_TELOP_ANIMATION_IDS).toEqual(['none','slideIn','fadeOnly','slideFromLeft','fadeBlurFromBottom','slideLeftFadeBlur','fadeFromRight','fadeFromLeft','charByChar']);
  expect(NEW_TELOP_ANIMATION_IDS).toEqual(['popIn','wipeReveal','typeCursor','underlineGrow','bandLeadsText','jumpPop','stampPress','blurOutFocus']);
  expect(TELOP_ANIMATION_IDS).toHaveLength(17);
  expect(new Set(TELOP_ANIMATION_IDS).size).toBe(17);
});
it('入場は規定値・尺の半分・最低 1 フレームで頭打ちになる',()=>{
  expect(telopEnterFrames(18,600)).toBe(18);
  expect(telopEnterFrames(18,20)).toBe(10);
  expect(telopEnterFrames(18,1)).toBe(1);
  expect(telopEnterFrames(18,0)).toBe(1);
});
it('退場は規定値と尺の三分の一で頭打ちになり、尺が足りなければ 0 になる',()=>{
  expect(telopExitFrames(8,600)).toBe(8);
  expect(telopExitFrames(8,12)).toBe(4);
  expect(telopExitFrames(8,2)).toBe(0);
});
it('文字送りは fps 基準で、長文では尺の 80% までに出切るまで縮む',()=>{
  expect(telopTypeCursorPlan({durationFrames:300,fps:30,charCount:10})).toEqual({charFrames:2,blinkPeriodFrames:15});
  expect(telopTypeCursorPlan({durationFrames:300,fps:60,charCount:10})).toEqual({charFrames:4,blinkPeriodFrames:30});
  const tight=telopTypeCursorPlan({durationFrames:90,fps:30,charCount:60});
  expect(tight.charFrames).toBe(1);
  expect(tight.charFrames*60).toBeLessThanOrEqual(90*0.8);
});
it('1 文字 1 フレームでも 80% に収まらない尺では、床の 1 フレームが勝つ',()=>{
  // 60 文字を 60 フレームへ入れる要求。80% 予算は 48fr で、1 文字 1 フレームの床（60fr）を
  // 下回れない。ここで 0 フレームへ潰すと文字が一切出ないので、床を優先して予算を超える。
  const long=telopTypeCursorPlan({durationFrames:60,fps:30,charCount:60});
  expect(long.charFrames).toBe(1);
  expect(long.charFrames*60).toBeGreaterThan(60*0.8);
});
it('文字数 0 では縮退しない',()=>{
  expect(telopTypeCursorPlan({durationFrames:1,fps:30,charCount:0})).toEqual({charFrames:2,blinkPeriodFrames:15});
});

/** 17 値が `src/core/types.ts` の union と双方向に代入できる（片方だけ増えたら typecheck が落ちる）。 */
const _toCore: TelopAnimation[] = [...TELOP_ANIMATION_IDS];
const _fromCore: TelopAnimationId[] = [] as TelopAnimation[];
void _toCore; void _fromCore;

const effect = (id: TelopAnimationId, localFrame: number, extra: Partial<{ durationFrames: number; fps: number; fontSizePx: number; charCount: number }> = {}) =>
  telopAnimationEffect({ id, localFrame, durationFrames: 90, fps: 30, fontSizePx: 40, charCount: 8, ...extra });

describe('telopAnimationEffect', () => {
  it('17 値を数え、新しい動きは 8 種だけ', () => {
    expect(TELOP_ANIMATION_IDS).toHaveLength(17);
    expect(NEW_TELOP_ANIMATION_IDS).toHaveLength(8);
    expect(TELOP_ANIMATION_IDS.filter(isNewTelopAnimation)).toEqual([...NEW_TELOP_ANIMATION_IDS]);
    expect(Object.keys(TELOP_ANIMATION_LABELS).sort()).toEqual([...TELOP_ANIMATION_IDS].sort());
  });

  it('既存 9 種は効果を持たない（描画は従来の式のまま）', () => {
    for (const id of TELOP_ANIMATION_IDS.filter(value => !isNewTelopAnimation(value)))
      expect(effect(id, 5), id).toBeNull();
  });

  it('popIn は 0.3 倍から始まり 1.15 倍まで行き過ぎて 1.0 で止まる', () => {
    expect(effect('popIn', 0)).toEqual({ transform: 'scale(0.3)', opacity: 0 });
    const peak = effect('popIn', 18 * .6)!;
    expect(Number(/scale\(([\d.]+)\)/.exec(peak.transform!)![1])).toBeCloseTo(1.15, 6);
    expect(peak.opacity).toBe(1);
    expect(effect('popIn', 18)).toEqual({ transform: 'scale(1)', opacity: 1 });
    expect(effect('popIn', 99)).toEqual({ transform: 'scale(1)', opacity: 1 });
  });

  it('wipeReveal は 20 段の刻みで左から開く', () => {
    expect(effect('wipeReveal', 0)!.clipPath).toBe('inset(0 100% 0 0)');
    expect(effect('wipeReveal', 8)!.clipPath).toBe('inset(0 50% 0 0)');
    expect(effect('wipeReveal', 16)!.clipPath).toBe('inset(0 0% 0 0)');
    // 刻みなので値は 5% の倍数にしか止まらない（連続値を取らない）
    for (const frame of [4, 5, 6]) {
      const match = /inset\(0 (-?[\d.]+)% 0 0\)/.exec(effect('wipeReveal', frame)!.clipPath!)!;
      expect(Number(match[1]) % 5).toBeCloseTo(0, 6);
    }
    // 60fps（span 32 フレーム）では連続フレームが同じ刻みに止まる（steps() らしく値が重複する）
    const clips60 = [4, 5, 6].map(frame => effect('wipeReveal', frame, { fps: 60 })!.clipPath);
    expect(new Set(clips60).size).toBe(2);
  });

  it('typeCursor は 30fps で 2 フレームに 1 文字、カーソルは 15 フレーム周期で点滅する', () => {
    expect(effect('typeCursor', 0)).toEqual({ opacity: 1, visibleChars: 0, cursor: true });
    expect(effect('typeCursor', 6)!.visibleChars).toBe(3);
    expect(effect('typeCursor', 15)!.cursor).toBe(false);
    expect(effect('typeCursor', 16)!.visibleChars).toBe(8);
    // 出切ったらカーソルは消える（終了状態でカーソルが残らない）
    expect(effect('typeCursor', 40)).toEqual({ opacity: 1, visibleChars: 8, cursor: false });
  });

  it('typeCursor は文字数が多くても尺の 80% までに出切る', () => {
    const shown = (frame: number) => effect('typeCursor', frame, { durationFrames: 120, charCount: 60 })!.visibleChars;
    expect(shown(Math.floor(120 * .8))).toBe(60);
    expect(effect('typeCursor', 60, { durationFrames: 60, charCount: 60 })!.cursor).toBe(false);
  });

  it('60fps でも 30fps と同じ見た目になる（文字送りも点滅も倍になる）', () => {
    expect(effect('typeCursor', 12, { fps: 60 })!.visibleChars).toBe(effect('typeCursor', 6)!.visibleChars);
    expect(effect('typeCursor', 30, { fps: 60 })!.cursor).toBe(effect('typeCursor', 15)!.cursor);
    expect(effect('popIn', 36, { fps: 60 })).toEqual(effect('popIn', 18));
  });

  it('短い尺では入場が縮む（入場が退場に食い込まない）', () => {
    // 18 フレーム規定でも 10 フレームのクリップでは 5 フレームで出切る
    expect(effect('popIn', 5, { durationFrames: 10 })).toEqual({ transform: 'scale(1)', opacity: 1 });
    expect(effect('popIn', 1, { durationFrames: 2 })).toEqual({ transform: 'scale(1)', opacity: 1 });
  });

  it('underlineGrow・bandLeadsText・jumpPop・stampPress・blurOutFocus の端の値', () => {
    expect(effect('underlineGrow', 0)).toEqual({ underline: 0, opacity: 1 });
    expect(effect('underlineGrow', 16)).toEqual({ underline: 1, opacity: 1 });
    expect(effect('bandLeadsText', 0)).toEqual({ band: 0, opacity: 0 });
    expect(effect('bandLeadsText', 9)!.band).toBe(1);
    expect(effect('bandLeadsText', 9)!.opacity).toBe(0);      // 帯が伸びきるまで文字は出ない
    expect(effect('bandLeadsText', 17)).toEqual({ band: 1, opacity: 1 });
    expect(effect('jumpPop', 0)).toEqual({ transform: 'translateY(0px)', opacity: 1 });
    expect(Number(/translateY\((-?[\d.]+)px\)/.exec(effect('jumpPop', Math.round(24 * .3))!.transform!)![1])).toBeCloseTo(-20, 1); // -0.5em × 40px
    expect(effect('jumpPop', 24)).toEqual({ transform: 'translateY(0px)', opacity: 1 });
    expect(effect('stampPress', 0)).toEqual({ transform: 'scale(2.2) rotate(-8deg)', opacity: 0 });
    expect(effect('stampPress', 14)).toEqual({ transform: 'scale(1) rotate(-8deg)', opacity: 1 });
    expect(effect('blurOutFocus', 0)).toEqual({ filter: 'blur(10px)', opacity: 0 });   // 40px × 0.25
    expect(effect('blurOutFocus', 14)).toEqual({ filter: 'blur(0px)', opacity: 1 });
  });

  it('退場は 8 フレームの不透明度フェードだけ（尺が短ければ縮む）', () => {
    expect(telopExitOpacity(0, 90, 8, 30)).toBe(1);
    expect(telopExitOpacity(86, 90, 8, 30)).toBe(.5);
    expect(telopExitOpacity(90, 90, 8, 30)).toBe(0);
    expect(telopExitOpacity(9, 9, 8, 30)).toBe(0);
    expect(telopExitOpacity(178, 180, 8, 60)).toBe(.125);  // 60fps では 16 フレーム
    // 尺が足りず退場フレームが 0 のときは退場しない（最終フレームでも opacity は 1）
    expect(telopExitOpacity(2, 2, 8, 30)).toBe(1);
  });

  it('書記素で数え、書記素で切る', () => {
    expect(telopGraphemeCount('あア阿👨‍👩‍👦')).toBe(4);
    expect(telopSliceGraphemes('あア阿👨‍👩‍👦', 3)).toBe('あア阿');
    expect(telopSliceGraphemes('あア阿', 99)).toBe('あア阿');
  });

  it('帯の色は空・transparent を既定色へ落とす（CSS.supports に依存しない）', () => {
    expect(telopBandColor('linear-gradient(90deg,#111,#222)')).toBe('linear-gradient(90deg,#111,#222)');
    expect(telopBandColor('transparent')).toBe('#1e3a8a');
    expect(telopBandColor('  ')).toBe('#1e3a8a');
    expect(telopBandColor(undefined)).toBe('#1e3a8a');
  });

  // 単発 2 点の決定性テストは下の走査表 192×37 に包含されるので置かない（同一 ms 内では
  // 2 回呼びが一致してしまい、Date.now 混入をほとんど検出できなかった。Task 10 Minor）。
  it('走査表 192×37 を localFrame 昇順で 2 回収集しても一致する（Date.now 混入を検出できる形）', () => {
    const collect = () => TELOP_ANIMATION_CASES.map(({ id, fps, fontSizePx, charCount, durationFrames }) =>
      TELOP_ANIMATION_CASE_FRAMES.map(localFrame =>
        telopAnimationEffect({ id, localFrame, durationFrames, fps, fontSizePx, charCount })));
    expect(JSON.stringify(collect())).toBe(JSON.stringify(collect()));
  });

  it('telopScaleFrames は 30fps 基準を実 fps へ換算する', () => {
    expect(telopScaleFrames(8, 60)).toBe(16);
    expect(telopScaleFrames(1, 30)).toBe(1);
  });

  it('TELOP_TYPE_CURSOR はカーソル文字', () => {
    expect(TELOP_TYPE_CURSOR).toBe('|');
  });
});
