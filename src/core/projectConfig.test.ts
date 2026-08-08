import { describe, it, expect } from 'vitest';
import { parseProjectConfig } from './projectConfig';
import { ProjectFileError } from './types';

describe('parseProjectConfig', () => {
  it('JSON を ProjectConfig として読む', () => {
    const cfg = parseProjectConfig('{"format":"short","fps":60,"durationFrames":12000}');
    expect(cfg.format).toBe('short');
    expect(cfg.fps).toBe(60);
  });

  it('未知のキーも保持する', () => {
    const cfg = parseProjectConfig('{"videoType":"ゴルフ"}');
    expect(cfg.videoType).toBe('ゴルフ');
  });

  it('不正な JSON は ProjectFileError を投げる', () => {
    expect(() => parseProjectConfig('{not json')).toThrow(ProjectFileError);
  });
});
