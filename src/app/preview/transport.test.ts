import { describe, it, expect } from 'vitest';
import { nextPlaybackRate, playbackRateLabel } from './transport';

describe('nextPlaybackRate', () => {
  it('L は押すたびに 1→2→4→8 と早送りし 8 で頭打ち', () => {
    expect(nextPlaybackRate(1, 'l')).toBe(2);
    expect(nextPlaybackRate(2, 'l')).toBe(4);
    expect(nextPlaybackRate(4, 'l')).toBe(8);
    expect(nextPlaybackRate(8, 'l')).toBe(8);
  });

  it('J は押すたびに -1→-2→-4→-8 と巻き戻し -8 で頭打ち', () => {
    expect(nextPlaybackRate(1, 'j')).toBe(-1);
    expect(nextPlaybackRate(-1, 'j')).toBe(-2);
    expect(nextPlaybackRate(-2, 'j')).toBe(-4);
    expect(nextPlaybackRate(-4, 'j')).toBe(-8);
    expect(nextPlaybackRate(-8, 'j')).toBe(-8);
  });

  it('逆向きのキーは段を積まず等速から入り直す', () => {
    expect(nextPlaybackRate(4, 'j')).toBe(-1);
    expect(nextPlaybackRate(-8, 'l')).toBe(1);
  });

  it('停止中（0）はどちらの向きも等速から', () => {
    expect(nextPlaybackRate(0, 'l')).toBe(1);
    expect(nextPlaybackRate(0, 'j')).toBe(-1);
  });

  it('K は常に等速へ戻す', () => {
    expect(nextPlaybackRate(8, 'k')).toBe(1);
    expect(nextPlaybackRate(-4, 'k')).toBe(1);
  });

  it('段に無い速度からは等速へ仕切り直す', () => {
    expect(nextPlaybackRate(3, 'l')).toBe(1);
    expect(nextPlaybackRate(-3, 'j')).toBe(-1);
  });
});

describe('playbackRateLabel', () => {
  it('等速はバッジを出さない', () => {
    expect(playbackRateLabel(1)).toBe('');
  });

  it('早送り・巻き戻しは向きと倍率を出す', () => {
    expect(playbackRateLabel(4)).toBe('▶▶ 4x');
    expect(playbackRateLabel(-2)).toBe('◀◀ 2x');
  });
});
