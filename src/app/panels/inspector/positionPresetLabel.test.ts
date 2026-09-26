/**
 * 位置プリセット 9 個の読み上げ名（座標を知らなくても押せるようにする）。
 */
import { describe, it, expect } from 'vitest';
import { positionPresetLabel } from './TelopPositionFields';

describe('positionPresetLabel', () => {
  it('四隅は「左上に配置」等', () => {
    expect(positionPresetLabel(0, 0)).toBe('左上に配置');
    expect(positionPresetLabel(0, 2)).toBe('右上に配置');
    expect(positionPresetLabel(2, 0)).toBe('左下に配置');
    expect(positionPresetLabel(2, 2)).toBe('右下に配置');
  });

  it('中央は「中央」を重ねない', () => {
    expect(positionPresetLabel(1, 1)).toBe('中央に配置');
    expect(positionPresetLabel(1, 0)).toBe('左中央に配置');
    expect(positionPresetLabel(0, 1)).toBe('上中央に配置');
  });
});
