import { describe, it, expect } from 'vitest';
import { playbackToPlayer, playerToPlayback } from './speedBridge';
import { resolveSpeedSegments } from '../core/speedEngine';

describe('speedBridge（一律＝後方互換）', () => {
  const m = { speedSegments: null, playbackOverlaps: [], mainSpeed: 0.5 };
  it('一律は speedScale 相当（再生→プレイヤー）', () => {
    expect(playbackToPlayer(100, m)).toBe(200); // round(100/0.5)
  });
  it('一律の逆（プレイヤー→再生）', () => {
    expect(playerToPlayback(200, m)).toBe(100); // round(200*0.5)
  });
  it('mainSpeed=1・overlaps空は恒等', () => {
    const id = { speedSegments: null, playbackOverlaps: [], mainSpeed: 1 };
    expect(playbackToPlayer(123, id)).toBe(123);
    expect(playerToPlayback(123, id)).toBe(123);
  });
});

describe('speedBridge（区間ごと）', () => {
  const segs = resolveSpeedSegments(
    [
      { id: 1, playbackStart: 0, playbackEnd: 100 },
      { id: 2, playbackStart: 100, playbackEnd: 200 },
    ],
    1,
    { 2: 0.5 },
  );
  const m = { speedSegments: segs, playbackOverlaps: [], mainSpeed: 1 };
  it('区間2はプレイヤー座標で 2 倍', () => {
    expect(playbackToPlayer(150, m)).toBe(200); // 100 + 50/0.5
    expect(playerToPlayback(200, m)).toBe(150);
  });
  it('境界フレームと rate-1 区間内フレームの恒等性', () => {
    // 区間境界（playback=100）はそのままプレイヤー 100
    expect(playbackToPlayer(100, m)).toBe(100);
    expect(playerToPlayback(100, m)).toBe(100);
    // rate-1 区間（[0,100)）内のフレームは変換なし
    expect(playbackToPlayer(50, m)).toBe(50);
  });
});
