import { describe, it, expect } from 'vitest';
import { animStyleAt, DEFAULT_FADE } from './elementAnim';
import type { ElementAnim } from './types';

const none: ElementAnim = { kind: 'none', frames: 0 };
const fade8: ElementAnim = { kind: 'fade', frames: 8 };
const zoom8: ElementAnim = { kind: 'zoom', frames: 8 };
const pop10: ElementAnim = { kind: 'pop', frames: 10 };
const slideL: ElementAnim = { kind: 'slideIn', frames: 10, direction: 'left' };

describe('animStyleAt', () => {
  it('既定フェードは 8fr', () => {
    expect(DEFAULT_FADE).toEqual({ kind: 'fade', frames: 8 });
  });

  it('none/none は常に素通し（不透明・無変形）', () => {
    expect(animStyleAt(0, 100, none, none)).toEqual({ opacity: 1, transform: '' });
    expect(animStyleAt(50, 100, none, none)).toEqual({ opacity: 1, transform: '' });
  });

  it('フェード登場：先頭で透明→8fr で不透明', () => {
    expect(animStyleAt(0, 100, fade8, none).opacity).toBe(0);
    expect(animStyleAt(4, 100, fade8, none).opacity).toBeCloseTo(0.5, 5);
    expect(animStyleAt(8, 100, fade8, none).opacity).toBe(1);
    expect(animStyleAt(50, 100, fade8, none)).toEqual({ opacity: 1, transform: '' });
  });

  it('フェード退場：末尾 8fr で不透明→透明', () => {
    expect(animStyleAt(100, 100, none, fade8).opacity).toBe(0);
    expect(animStyleAt(96, 100, none, fade8).opacity).toBeCloseTo(0.5, 5);
    expect(animStyleAt(92, 100, none, fade8).opacity).toBe(1);
  });

  it('ズーム登場：先頭は scale 0.85・透明', () => {
    const s = animStyleAt(0, 100, zoom8, none);
    expect(s.opacity).toBe(0);
    expect(s.transform).toBe('scale(0.85)');
    expect(animStyleAt(8, 100, zoom8, none)).toEqual({ opacity: 1, transform: '' });
  });

  it('ポップ登場：途中でオーバーシュート（scale>1）', () => {
    const mid = animStyleAt(7, 100, pop10, none); // p=0.7
    expect(mid.transform).toBe('scale(1.12)');
  });

  it('スライドイン左：先頭は左へ 100% 退避', () => {
    const s = animStyleAt(0, 100, slideL, none);
    expect(s.transform).toBe('translate(-100%, 0%)');
    expect(s.opacity).toBe(0);
  });

  it('登場窓は退場窓より優先（短い区間でも先頭はフェードイン）', () => {
    expect(animStyleAt(0, 10, fade8, fade8).opacity).toBe(0);
  });

  it('長さ 0 は透明', () => {
    expect(animStyleAt(0, 0, fade8, fade8)).toEqual({ opacity: 0, transform: '' });
  });
});
