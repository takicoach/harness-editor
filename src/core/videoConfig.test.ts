import { describe, it, expect } from 'vitest';
import { parseVideoConfig, parseVideoConfigStatic } from './videoConfig';
import { VIDEO_CONFIG_SOURCE } from './__fixtures__/videoConfig.fixture';
import { ProjectFileError } from './types';

describe('parseVideoConfig', () => {
  it('FORMAT / FPS / DURATION_FRAMES / VIDEO_FILE / RESOLUTION を読む', () => {
    const cfg = parseVideoConfig(VIDEO_CONFIG_SOURCE);
    expect(cfg.format).toBe('short');
    expect(cfg.fps).toBe(60);
    expect(cfg.durationFrames).toBe(12000);
    expect(cfg.videoFile).toBe('main.mp4');
    expect(cfg.resolution).toEqual({ width: 1080, height: 1920 });
  });

  it('解像度から向きを判定する（short は portrait）', () => {
    expect(parseVideoConfig(VIDEO_CONFIG_SOURCE).orientation).toBe('portrait');
  });

  it('必須値が欠けると ProjectFileError を投げる', () => {
    expect(() => parseVideoConfig('export const FORMAT = "short";')).toThrow(ProjectFileError);
  });

  it('TELOP_CONFIG からタイトルスタイル（titleTop/titleLeft/titleFontSize）を読む', () => {
    const source = `export type VideoFormat = 'youtube' | 'short' | 'square';
export const FORMAT: VideoFormat = 'short';
export const FPS = 60;
export const DURATION_FRAMES = 12000;
export const VIDEO_FILE = 'main.mp4';
const RESOLUTION_MAP = { short: { width: 1080, height: 1920 } } as const;
const TELOP_CONFIG_MAP = {
  short: { fontSize: 56, titleFontSize: 30, titleTop: 60, titleLeft: 30 },
} as const;
export const RESOLUTION = RESOLUTION_MAP[FORMAT];
export const TELOP_CONFIG = TELOP_CONFIG_MAP[FORMAT];
`;
    const cfg = parseVideoConfig(source);
    expect(cfg.titleStyle).toEqual({ top: 60, left: 30, fontSize: 30 });
  });

  it('TELOP_CONFIG からテロップ下端オフセット（bottomOffset）を読む', () => {
    // golf-short-gold プリセット（short: bottomOffset 540）相当。
    const source = `export type VideoFormat = 'youtube' | 'short' | 'square';
export const FORMAT: VideoFormat = 'short';
export const FPS = 60;
export const DURATION_FRAMES = 12000;
export const VIDEO_FILE = 'main.mp4';
const RESOLUTION_MAP = { short: { width: 1080, height: 1920 } } as const;
const TELOP_CONFIG_MAP = {
  short: { fontSize: 84, bottomOffset: 540, titleTop: 220, titleLeft: 64 },
} as const;
export const RESOLUTION = RESOLUTION_MAP[FORMAT];
export const TELOP_CONFIG = TELOP_CONFIG_MAP[FORMAT];
`;
    expect(parseVideoConfig(source).telopBottomOffset).toBe(540);
    expect(parseVideoConfigStatic(source).telopBottomOffset).toBe(540);
  });

  it('TELOP_CONFIG が無い / bottomOffset が数値でない場合は null（呼び出し側が標準値へフォールバック）', () => {
    // フィクスチャ（VIDEO_CONFIG_SOURCE）は TELOP_CONFIG を持たない。
    expect(parseVideoConfig(VIDEO_CONFIG_SOURCE).telopBottomOffset).toBeNull();

    const notNumber = `export type VideoFormat = 'youtube' | 'short' | 'square';
export const FORMAT: VideoFormat = 'short';
export const FPS = 60;
export const DURATION_FRAMES = 12000;
export const RESOLUTION = { width: 1080, height: 1920 };
export const TELOP_CONFIG = { bottomOffset: '540px' };
`;
    expect(parseVideoConfig(notNumber).telopBottomOffset).toBeNull();
  });

  it('bottomOffset が負なら null（画面外アンカーを作らない）', () => {
    const negative = `export type VideoFormat = 'youtube' | 'short' | 'square';
export const FORMAT: VideoFormat = 'short';
export const FPS = 60;
export const DURATION_FRAMES = 12000;
export const RESOLUTION = { width: 1080, height: 1920 };
export const TELOP_CONFIG = { bottomOffset: -100 };
`;
    expect(parseVideoConfig(negative).telopBottomOffset).toBeNull();
    // 0 は有効値（下端ぴったり）。
    expect(parseVideoConfig(negative.replace('-100', '0')).telopBottomOffset).toBe(0);
  });

  it('TELOP_CONFIG が無い場合は解像度から既定のタイトルスタイルを導く', () => {
    // フィクスチャ（VIDEO_CONFIG_SOURCE）は TELOP_CONFIG を持たない → フォールバック。
    const cfg = parseVideoConfig(VIDEO_CONFIG_SOURCE);
    // height=1920, width=1080 のとき: fontSize=round(1920*0.022)=42, top=round(1920*0.03)=58, left=round(1080*0.03)=32
    expect(cfg.titleStyle).toEqual({ top: 58, left: 32, fontSize: 42 });
  });
});

describe('parseVideoConfigStatic（コードを実行しない一覧表示用）', () => {
  it('標準フィクスチャを parseVideoConfig と同じ結果で読む', () => {
    const eval_ = parseVideoConfig(VIDEO_CONFIG_SOURCE);
    const static_ = parseVideoConfigStatic(VIDEO_CONFIG_SOURCE);
    expect(static_).toEqual(eval_);
    expect(static_.resolution).toEqual({ width: 1080, height: 1920 });
    expect(static_.orientation).toBe('portrait');
  });

  it('必須値が欠けると ProjectFileError を投げる', () => {
    expect(() => parseVideoConfigStatic(`export const FPS = 30;`)).toThrow(ProjectFileError);
  });

  it('悪意ある videoConfig（サンドボックス脱出）はコードを実行せず ProjectFileError', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.__SME_PWNED_CFG__;
    const malicious = `
      export const FORMAT = (() => { globalThis.__SME_PWNED_CFG__ = true; return 'short'; })();
      export const FPS = 30;
      export const DURATION_FRAMES = 100;
      export const RESOLUTION = { width: 1080, height: 1920 };
    `;
    expect(() => parseVideoConfigStatic(malicious)).toThrow(ProjectFileError);
    expect(g.__SME_PWNED_CFG__).toBeUndefined();
  });
});
