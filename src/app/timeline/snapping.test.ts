import { describe, expect, it } from 'vitest';
import { collectSnapTargets, snapFrame, snapFrameMapped, type SnapTarget } from './snapping';
import type { EditorTelop, Transcript } from '../../core/types';
import { buildDisplayMap } from '../../core/timelineDisplayMap';

function transcript(): Transcript {
  // 30fps 想定。単語は ms。30 フレーム = 1000ms。
  return {
    durationMs: 10000,
    words: [
      { text: 'ゆる', start: 1000, end: 1500 }, // 30..45 フレーム
      { text: '素振り', start: 1500, end: 2000 }, // 45..60 フレーム
      // 2000..4000ms はギャップ（無音）= 60..120 フレーム
      { text: '2本', start: 4000, end: 4500 }, // 120..135 フレーム
    ],
    segments: [],
  };
}

function telops(): EditorTelop[] {
  return [
    { id: 1, originalStart: 30, originalEnd: 60, text: 'ゆる素振り' },
    { id: 2, originalStart: 120, originalEnd: 200, text: '2本ですね' },
  ];
}

describe('collectSnapTargets', () => {
  it('単語境界・テロップ境界・再生ヘッド・無音端を収集する', () => {
    const targets = collectSnapTargets(transcript(), telops(), 90, 30);
    const frames = targets.map((t) => t.frame);
    // 単語境界（msToFrame round）: 30,45,45,60,120,135
    expect(frames).toContain(30);
    expect(frames).toContain(45);
    expect(frames).toContain(60);
    expect(frames).toContain(135);
    // テロップ境界: 30,60,120,200
    expect(frames).toContain(200);
    // 再生ヘッド
    expect(frames).toContain(90);
    // 無音区間端（単語間ギャップ 60..120 の両端）
    const silence = targets.filter((t) => t.kind === 'silence').map((t) => t.frame);
    expect(silence).toContain(60);
    expect(silence).toContain(120);
  });

  it('単語が空でもテロップ境界と再生ヘッドは収集する', () => {
    const empty: Transcript = { durationMs: 0, words: [], segments: [] };
    const targets = collectSnapTargets(empty, telops(), 50, 30);
    const kinds = new Set(targets.map((t) => t.kind));
    expect(kinds.has('telop')).toBe(true);
    expect(kinds.has('playhead')).toBe(true);
    expect(kinds.has('word')).toBe(false);
  });

  it('各ターゲットに日本語ラベルが付く', () => {
    const targets = collectSnapTargets(transcript(), telops(), 90, 30);
    const word = targets.find((t) => t.kind === 'word');
    expect(word?.label).toContain('単語境界');
  });
});

describe('snapFrame', () => {
  const targets: SnapTarget[] = [
    { frame: 45, kind: 'word', label: '単語境界:「素振り」' },
    { frame: 120, kind: 'silence', label: '無音区間' },
  ];

  it('しきい値内の最近傍ターゲットへ吸着する', () => {
    const r = snapFrame(48, targets, 5);
    expect(r.frame).toBe(45);
    expect(r.target?.kind).toBe('word');
  });

  it('しきい値外なら吸着しない（入力フレームをそのまま返す）', () => {
    const r = snapFrame(60, targets, 5);
    expect(r.frame).toBe(60);
    expect(r.target).toBeNull();
  });

  it('複数候補が範囲内なら最も近い方へ吸着する', () => {
    const r = snapFrame(110, [
      { frame: 100, kind: 'word', label: 'a' },
      { frame: 118, kind: 'word', label: 'b' },
    ], 20);
    expect(r.frame).toBe(118);
  });

  it('距離がしきい値ちょうどなら吸着する', () => {
    // frame=50, target.frame=45 → 距離 5 = threshold 5 で吸着するはず（dist <= threshold）
    const r = snapFrame(50, targets, 5);
    expect(r.frame).toBe(45);
    expect(r.target?.kind).toBe('word');
  });

  it('ターゲットが空なら吸着しない', () => {
    const r = snapFrame(48, [], 5);
    expect(r.frame).toBe(48);
    expect(r.target).toBeNull();
  });
});

describe('snapFrameMapped', () => {
  const targets: SnapTarget[] = [
    { frame: 45, kind: 'word', label: '単語境界:「素振り」' },
    { frame: 120, kind: 'silence', label: '無音区間' },
  ];

  // (a) identity / undefined map — snapFrame と同一結果になること。
  it('(a) map 省略時は原本座標でしきい値内に吸着する', () => {
    const r = snapFrameMapped(48, targets, 5);
    expect(r.frame).toBe(45);
    expect(r.snapped?.kind).toBe('word');
  });

  it('(a) map 省略時、しきい値外なら吸着しない（rawFrame をそのまま返す）', () => {
    const r = snapFrameMapped(60, targets, 5);
    expect(r.frame).toBe(60);
    expect(r.snapped).toBeNull();
  });

  it('(a) ターゲットが空なら吸着しない', () => {
    const r = snapFrameMapped(48, [], 5);
    expect(r.frame).toBe(48);
    expect(r.snapped).toBeNull();
  });

  // (b) 伸縮マップ — 表示座標で距離を測るため、原本距離が遠くても表示距離が近ければ吸着。
  it('(b) 伸縮マップで表示距離がしきい値内なら吸着する（原本距離は遠い）', () => {
    // id1: 原本 [0, 100) を speed 2x → 表示 [0, 50)
    // 原本 50 → 表示 25、原本 90（target）→ 表示 45
    // 表示距離 = |45 - 25| = 20、しきい値 25 → 吸着
    // 原本距離 = |90 - 50| = 40 → 原本座標では吸着しない
    const keptSegs = [{ id: 1, originalStart: 0, originalEnd: 100 }];
    const m = buildDisplayMap(100, [], keptSegs, { 1: 2 }, 1);
    const stretched: SnapTarget[] = [{ frame: 90, kind: 'word', label: 'far in original' }];
    const r = snapFrameMapped(50, stretched, 25, m);
    expect(r.frame).toBe(90);
    expect(r.snapped).not.toBeNull();
  });

  it('(b) 伸縮マップで表示距離がしきい値外なら吸着しない（原本距離は近い）', () => {
    // id1: 原本 [0, 100) を speed 2x → 表示 [0, 50)
    // 原本 50 → 表示 25、原本 56（target）→ 表示 28
    // 表示距離 = |28 - 25| = 3、しきい値 2 → 吸着しない
    // 原本距離 = |56 - 50| = 6 → こちらでも吸着しない（どちらでも ok な例）
    // より明確な例: しきい値=2 で表示距離=3 → 吸着しない
    const keptSegs = [{ id: 1, originalStart: 0, originalEnd: 100 }];
    const m = buildDisplayMap(100, [], keptSegs, { 1: 2 }, 1);
    const stretched: SnapTarget[] = [{ frame: 56, kind: 'word', label: 'close in original' }];
    const r = snapFrameMapped(50, stretched, 2, m);
    expect(r.frame).toBe(50);
    expect(r.snapped).toBeNull();
  });
});
