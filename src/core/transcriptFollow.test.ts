import { describe, it, expect } from 'vitest';
import {
  resolveInitialFollowEnabled,
  followedTelopId,
  shouldAutoFollow,
  MANUAL_SCROLL_PAUSE_MS,
} from './transcriptFollow';

describe('resolveInitialFollowEnabled', () => {
  it('未保存（null）は既定 ON', () => {
    expect(resolveInitialFollowEnabled(null)).toBe(true);
  });
  it("保存値 'true' は ON", () => {
    expect(resolveInitialFollowEnabled('true')).toBe(true);
  });
  it("保存値 'false' は OFF", () => {
    expect(resolveInitialFollowEnabled('false')).toBe(false);
  });
  it('不正値は既定 ON へフォールバック', () => {
    expect(resolveInitialFollowEnabled('garbage')).toBe(true);
  });
});

describe('followedTelopId', () => {
  const telops = [
    { id: 1, originalStart: 0, originalEnd: 100 },
    { id: 2, originalStart: 100, originalEnd: 200 },
    { id: 3, originalStart: 250, originalEnd: 300 },
  ];

  it('区間内のフレームはそのテロップの id を返す', () => {
    expect(followedTelopId(telops, 50)).toBe(1);
    expect(followedTelopId(telops, 150)).toBe(2);
  });

  it('区間境界は開始側を含み終了側を含まない（半開区間）', () => {
    expect(followedTelopId(telops, 100)).toBe(2);
    expect(followedTelopId(telops, 200)).toBe(null);
  });

  it('どのテロップにも属さない隙間（ギャップ）は null', () => {
    expect(followedTelopId(telops, 220)).toBe(null);
  });

  it('空配列は null', () => {
    expect(followedTelopId([], 10)).toBe(null);
  });
});

describe('shouldAutoFollow', () => {
  it('トグルON・再生中・一時停止明けなら true', () => {
    expect(
      shouldAutoFollow({ enabled: true, isPlaying: true, now: 1000, pausedUntil: 0 }),
    ).toBe(true);
  });

  it('トグル OFF なら false', () => {
    expect(
      shouldAutoFollow({ enabled: false, isPlaying: true, now: 1000, pausedUntil: 0 }),
    ).toBe(false);
  });

  it('再生中でない（一時停止/停止）なら false', () => {
    expect(
      shouldAutoFollow({ enabled: true, isPlaying: false, now: 1000, pausedUntil: 0 }),
    ).toBe(false);
  });

  it('手動スクロール直後の一時停止中は false', () => {
    expect(
      shouldAutoFollow({ enabled: true, isPlaying: true, now: 1000, pausedUntil: 1500 }),
    ).toBe(false);
  });

  it('一時停止がちょうど明けた瞬間（now===pausedUntil）は true', () => {
    expect(
      shouldAutoFollow({ enabled: true, isPlaying: true, now: 1500, pausedUntil: 1500 }),
    ).toBe(true);
  });

  it('MANUAL_SCROLL_PAUSE_MS は正の値', () => {
    expect(MANUAL_SCROLL_PAUSE_MS).toBeGreaterThan(0);
  });
});
