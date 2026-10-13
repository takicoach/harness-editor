import { describe, expect, it } from 'vitest';
import type { MediaStream } from '../../../core/sequence/model';
import { formatFrameTime, frameCountOf, frameTime, sourceTimeOf, streamFps } from './framePick';

const stream = (frameRate?: { num: number; den: number }): MediaStream => ({ index: 0, kind: 'video', codec: 'h264', duration: { num: 3, den: 1 }, ...(frameRate ? { frameRate } : {}) });
describe('コマを選ぶ', () => {
  it('コマ数は長さ × fps の切り捨て。fps が無ければ 30', () => {
    expect(frameCountOf(stream({ num: 30, den: 1 }))).toBe(90);
    expect(frameCountOf(stream())).toBe(90);
    expect(streamFps(stream())).toEqual({ num: 30, den: 1 });
  });
  it('原本の時刻はコマの中央を約分した分数で持つ', () => {
    expect(sourceTimeOf(0, { num: 30, den: 1 })).toEqual({ num: 1, den: 60 });
    expect(sourceTimeOf(2, { num: 30, den: 1 })).toEqual({ num: 1, den: 12 });
    expect(sourceTimeOf(0, { num: 30000, den: 1001 })).toEqual({ num: 1001, den: 60000 });
    expect(frameTime(5, { num: 10, den: 1 })).toBeCloseTo(.55, 10);
  });
  it('時刻は 分:秒.コマ で出す', () => {
    expect(formatFrameTime(5, { num: 10, den: 1 })).toBe('0:00.05');
    expect(formatFrameTime(3725, { num: 30, den: 1 })).toBe('2:04.05');
  });
});
