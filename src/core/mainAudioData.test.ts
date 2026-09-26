import { describe, expect, it } from 'vitest';
import { ProjectFileError } from './types';
import {
  parseMainAudioData,
  serializeMainAudioData,
} from './mainAudioData';
import { DEFAULT_MAIN_AUDIO, mainAudioGainFactor } from './mainAudio';

describe('mainAudioData', () => {
  it('ファイル不在と省略propertyだけを既定扱いにし、未知keyは無視する', () => {
    expect(parseMainAudioData(null)).toEqual(DEFAULT_MAIN_AUDIO);
    expect(parseMainAudioData('export const MAIN_AUDIO = { gainDb: 6, future: true };')).toEqual({
      gainDb: 6,
      muted: false,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    });
  });

  it.each([
    ['exportなし', 'export const OTHER = {};'],
    ['object以外', 'export const MAIN_AUDIO = null;'],
    ['gain型', 'export const MAIN_AUDIO = { gainDb: "6" };'],
    ['gain非有限', 'export const MAIN_AUDIO = { gainDb: NaN };'],
    ['gain範囲外', 'export const MAIN_AUDIO = { gainDb: 12.1 };'],
    ['mute型', 'export const MAIN_AUDIO = { muted: 1 };'],
    ['fade小数', 'export const MAIN_AUDIO = { fadeInFrames: 1.5 };'],
    ['fade負数', 'export const MAIN_AUDIO = { fadeOutFrames: -1 };'],
  ])('%sを既定へ黙って落とさず読込を止める', (_label, source) => {
    expect(() => parseMainAudioData(source)).toThrow(ProjectFileError);
  });

  it('gain -60..+12 dBと非負safe integer fadeを完全形で往復する', () => {
    const value = { gainDb: 12, muted: true, fadeInFrames: 90, fadeOutFrames: 180 };
    const source = serializeMainAudioData(value);
    expect(source).toContain('export const MAIN_AUDIO');
    expect(parseMainAudioData(source)).toEqual(value);
    expect(parseMainAudioData(serializeMainAudioData({ ...value, gainDb: -60 }))).toEqual({ ...value, gainDb: -60 });
  });

  it('完全既定だけはファイル不要、無効な保存値は拒否する', () => {
    expect(serializeMainAudioData(DEFAULT_MAIN_AUDIO)).toBeNull();
    expect(() => serializeMainAudioData({ ...DEFAULT_MAIN_AUDIO, gainDb: 13 })).toThrow();
    expect(() => serializeMainAudioData({ ...DEFAULT_MAIN_AUDIO, fadeInFrames: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });

  it('正gain・mute・完成座標fadeを同じ係数へ畳む', () => {
    const value = { gainDb: 6, muted: false, fadeInFrames: 3, fadeOutFrames: 3 };
    expect(mainAudioGainFactor(value, 0, 6)).toBe(0);
    expect(mainAudioGainFactor(value, 1, 6)).toBeCloseTo(10 ** (6 / 20) / 3);
    expect(mainAudioGainFactor(value, 2, 6)).toBeCloseTo(10 ** (6 / 20) * 2 / 3);
    expect(mainAudioGainFactor(value, 5, 6)).toBe(0);
    expect(mainAudioGainFactor({ ...value, muted: true }, 2, 6)).toBe(0);
  });

  it('完成尺より長いfadeを完成尺へ制限し、非有限の座標を拒否する', () => {
    const value = { gainDb: 0, muted: false, fadeInFrames: 100, fadeOutFrames: 0 };
    expect(mainAudioGainFactor(value, 9, 10)).toBeCloseTo(0.9);
    expect(() => mainAudioGainFactor(value, Number.NaN, 10)).toThrow(/finalFrame/);
    expect(() => mainAudioGainFactor(value, 0, Number.POSITIVE_INFINITY)).toThrow(/finalDurationFrames/);
  });
});
