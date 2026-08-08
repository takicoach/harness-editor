import { describe, it, expect } from 'vitest';
import { buildSpeechRegions, speechRegionsToPlayback, DUCK_GAIN, bakeDuckEnvelope, duckFactorAt, applyDuckingToBgm } from './ducking';
import type { TranscriptWord, CutRegion } from './types';
import type { BgmClip, DuckEnvelope } from './types';

const w = (start: number, end: number): TranscriptWord => ({ text: 'x', start, end });

describe('DUCK_GAIN', () => {
  it('弱/中/強 = 0.7/0.5/0.25', () => {
    expect(DUCK_GAIN.weak).toBe(0.7);
    expect(DUCK_GAIN.mid).toBe(0.5);
    expect(DUCK_GAIN.strong).toBe(0.25);
  });
});

describe('buildSpeechRegions', () => {
  it('単語を ms→フレーム区間にする（fps=30）', () => {
    // 0..1000ms → 0..30フレーム
    expect(buildSpeechRegions([w(0, 1000)], 30, 12)).toEqual([{ start: 0, end: 30 }]);
  });
  it('短い無音（ギャップ<=閾値）は結合する', () => {
    // 0-500ms(0-15) と 600-1000ms(18-30): ギャップ 3 <= 12 → 結合
    expect(buildSpeechRegions([w(0, 500), w(600, 1000)], 30, 12)).toEqual([{ start: 0, end: 30 }]);
  });
  it('長い無音（ギャップ>閾値）は分割する', () => {
    // 0-500ms(0-15) と 2000-2500ms(60-75): ギャップ 45 > 12 → 2区間
    expect(buildSpeechRegions([w(0, 500), w(2000, 2500)], 30, 12)).toEqual([
      { start: 0, end: 15 },
      { start: 60, end: 75 },
    ]);
  });
  it('長さ0の単語は無視、空配列は空', () => {
    expect(buildSpeechRegions([w(100, 100)], 30, 12)).toEqual([]);
    expect(buildSpeechRegions([], 30, 12)).toEqual([]);
  });
});

describe('speechRegionsToPlayback', () => {
  const noCut: CutRegion[] = [];
  it('カット無しは素通し', () => {
    expect(speechRegionsToPlayback([{ start: 0, end: 30 }], noCut)).toEqual([{ start: 0, end: 30 }]);
  });
  it('区間をまたぐカットは収縮して連結（[10,20) 削除で 30→20）', () => {
    expect(speechRegionsToPlayback([{ start: 0, end: 30 }], [{ start: 10, end: 20 }])).toEqual([
      { start: 0, end: 20 },
    ]);
  });
  it('カットに完全に飲まれた区間は除外', () => {
    expect(speechRegionsToPlayback([{ start: 12, end: 18 }], [{ start: 10, end: 20 }])).toEqual([]);
  });
  it('複数カットが区間を分断する（[0,60) に [10,20) と [40,50) 削除 → [0,40)）', () => {
    expect(
      speechRegionsToPlayback([{ start: 0, end: 60 }], [
        { start: 10, end: 20 },
        { start: 40, end: 50 },
      ]),
    ).toEqual([{ start: 0, end: 40 }]);
  });
  it('区間 end がカット境界に着地（end=10・カット[10,20)→pEnd null補正）', () => {
    // end=10 はカット[10,20)内で originalToPlayback(10)=null → fallback (originalToPlayback(9)=9)+1=10
    expect(
      speechRegionsToPlayback([{ start: 0, end: 10 }], [{ start: 10, end: 20 }]),
    ).toEqual([{ start: 0, end: 10 }]);
  });
});

describe('bakeDuckEnvelope', () => {
  it('クリップと交差する区間だけ相対フレームで採用', () => {
    const env = bakeDuckEnvelope(100, 200, [{ start: 50, end: 120 }, { start: 150, end: 250 }], 0.5, 3, 9);
    expect(env).toEqual({ regions: [{ start: 0, end: 20 }, { start: 50, end: 100 }], gain: 0.5, attackFrames: 3, releaseFrames: 9 });
  });
  it('交差が無ければ undefined', () => {
    expect(bakeDuckEnvelope(100, 200, [{ start: 0, end: 50 }], 0.5, 3, 9)).toBeUndefined();
  });
});

describe('duckFactorAt', () => {
  const env: DuckEnvelope = { regions: [{ start: 10, end: 20 }], gain: 0.5, attackFrames: 3, releaseFrames: 9 };
  it('区間内は gain', () => expect(duckFactorAt(15, env)).toBe(0.5));
  it('区間内の開始境界は gain（start 含む）', () => expect(duckFactorAt(10, env)).toBe(0.5));
  it('ランプ手前は 1', () => expect(duckFactorAt(5, env)).toBe(1));
  it('アタック途中は線形補間（f=8 → 0.8333）', () => expect(duckFactorAt(8, env)).toBeCloseTo(0.8333, 3));
  it('リリース開始（f=end）は gain', () => expect(duckFactorAt(20, env)).toBe(0.5));
  it('リリース途中は線形補間（f=25 → 0.7778）', () => expect(duckFactorAt(25, env)).toBeCloseTo(0.7778, 3));
  it('リリース終了後は 1', () => expect(duckFactorAt(29, env)).toBe(1));
  it('undefined は 1', () => expect(duckFactorAt(15, undefined)).toBe(1));
  it('重なりは min（強い方）', () => {
    const overlap: DuckEnvelope = { regions: [{ start: 0, end: 10 }, { start: 5, end: 15 }], gain: 0.5, attackFrames: 3, releaseFrames: 9 };
    expect(duckFactorAt(7, overlap)).toBe(0.5);
  });
});

describe('applyDuckingToBgm', () => {
  const clip = (id: number, startFrame: number, endFrame: number): BgmClip => ({
    id, file: 'a.mp3', startFrame, endFrame, volume: 1, fadeInFrames: 0, fadeOutFrames: 0,
  });
  const words = [{ text: 'x', start: 0, end: 1000 }]; // 0..30フレーム（fps=30）

  it('設定なし/OFF はクリップを変えない', () => {
    const clips = [clip(1, 0, 100)];
    expect(applyDuckingToBgm(clips, words, [], 30, undefined)).toBe(clips);
    expect(applyDuckingToBgm(clips, words, [], 30, { enabled: false, strength: 'mid' })).toBe(clips);
  });
  it('ON のとき交差クリップへ ducking を付ける', () => {
    const out = applyDuckingToBgm([clip(1, 0, 100)], words, [], 30, { enabled: true, strength: 'mid' });
    expect(out[0]!.ducking).toBeDefined();
    expect(out[0]!.ducking!.gain).toBe(0.5);
    expect(out[0]!.ducking!.regions).toEqual([{ start: 0, end: 30 }]);
  });
  it('クリップ末尾にまたがる喋り区間はクリップ端でクランプされる', () => {
    // fps=30: word 2000-4000ms → 60..120フレーム。クリップ [0,90) → 交差 [60,90) → 相対 {60,90}
    const clampClip: BgmClip = { id: 1, file: 'a.mp3', startFrame: 0, endFrame: 90, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 };
    const out = applyDuckingToBgm([clampClip], [{ text: 'x', start: 2000, end: 4000 }], [], 30, { enabled: true, strength: 'mid' });
    expect(out[0]!.ducking!.regions).toEqual([{ start: 60, end: 90 }]);
  });
});
