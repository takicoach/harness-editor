import { describe, expect, it } from 'vitest';
import { hiddenTracksBelow, moreTracksLabel } from './trackOverflow';

describe('hiddenTracksBelow', () => {
  // 動画 58 / じまく 36 / テロップ 36 / 画像 40 / サブ動画 46 / BGM 44 / 効果音 38 / 図形 40
  const bottoms = [58, 94, 130, 170, 216, 260, 298, 338];

  it('全部入る高さなら 0', () => {
    expect(hiddenTracksBelow(bottoms, 0, 400)).toBe(0);
  });

  it('可視 130px（動画・じまく・テロップまで）なら残り 5 本が隠れている', () => {
    expect(hiddenTracksBelow(bottoms, 0, 130)).toBe(5);
  });

  it('スクロールすると隠れている本数が減る', () => {
    expect(hiddenTracksBelow(bottoms, 100, 130)).toBe(3);
    expect(hiddenTracksBelow(bottoms, 208, 130)).toBe(0);
  });

  it('境界: 下端ちょうどは「見えている」（1px の遊び込み）', () => {
    expect(hiddenTracksBelow([130], 0, 130)).toBe(0);
    expect(hiddenTracksBelow([131], 0, 130)).toBe(0);
    expect(hiddenTracksBelow([132], 0, 130)).toBe(1);
  });

  it('レイアウト前（高さ 0）は 0（手がかりを出さない）', () => {
    expect(hiddenTracksBelow(bottoms, 0, 0)).toBe(0);
    expect(hiddenTracksBelow(bottoms, 0, Number.NaN)).toBe(0);
  });

  it('トラックが 1 本も無ければ 0', () => {
    expect(hiddenTracksBelow([], 0, 130)).toBe(0);
  });
});

describe('moreTracksLabel', () => {
  it('0 以下なら出さない', () => {
    expect(moreTracksLabel(0)).toBeNull();
    expect(moreTracksLabel(-1)).toBeNull();
  });

  it('本数を日本語で言う', () => {
    expect(moreTracksLabel(5)).toBe('▼ さらに 5 トラック');
  });
});
