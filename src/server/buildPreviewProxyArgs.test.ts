import { describe, expect, it } from 'vitest';
import { buildPreviewProxyArgs, buildProxyFilters, targetProxyFps } from './buildPreviewProxyArgs';

describe('targetProxyFps', () => {
  it('整数へ丸め、1〜60 にクランプする', () => {
    expect(targetProxyFps(29.97)).toBe(30);
    expect(targetProxyFps(59.94)).toBe(60);
    expect(targetProxyFps(120)).toBe(60);
    expect(targetProxyFps(0.5)).toBe(1);
  });

  it('VFR（公称が timebase 由来の高値）は平均 fps の低い方を採る', () => {
    expect(targetProxyFps(1000, 15)).toBe(15); // 画面録画の実例形
    expect(targetProxyFps(30, 29.97)).toBe(30); // 通常 CFR は実質同値
    expect(targetProxyFps(30, null)).toBe(30); // avg 不明は公称
    expect(targetProxyFps(30, 0)).toBe(30); // 壊れた avg は無視
  });
});

describe('buildProxyFilters', () => {
  it('横長 1080p 超は高さ 720 へ縮小（fps フィルタ先行）', () => {
    expect(buildProxyFilters({ sourceWidth: 3840, sourceHeight: 2160, fps: 30 })).toBe('fps=30,scale=-2:720');
  });
  it('縦長は幅 720 へ縮小', () => {
    expect(buildProxyFilters({ sourceWidth: 2160, sourceHeight: 3840, fps: 30 })).toBe('fps=30,scale=720:-2');
  });
  it('短辺 720 以下は scale を入れない（CFR 化のみ）', () => {
    expect(buildProxyFilters({ sourceWidth: 1280, sourceHeight: 720, fps: 25 })).toBe('fps=25');
  });
});

describe('buildPreviewProxyArgs', () => {
  const args = buildPreviewProxyArgs({
    input: '/pj/public/main.mp4',
    output: '/pj/public/.sme-preview-tmp.mp4',
    sourceWidth: 1920,
    sourceHeight: 1080,
    fps: 29.97,
  });

  it('進捗出力・入出力・H.264 仕様が入っている', () => {
    expect(args.slice(0, 4)).toEqual(['-y', '-progress', 'pipe:1', '-nostats']);
    expect(args).toContain('/pj/public/main.mp4');
    expect(args[args.length - 1]).toBe('/pj/public/.sme-preview-tmp.mp4');
    expect(args.join(' ')).toContain('-c:v libx264 -preset veryfast -crf 26');
    expect(args.join(' ')).toContain('-movflags +faststart');
  });

  it('キーフレーム間隔は 2 秒（-g = fps×2）', () => {
    const g = args[args.indexOf('-g') + 1];
    expect(g).toBe('60'); // 29.97 → 30fps × 2
  });

  it('scale と fps は -vf に集約される', () => {
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toBe('fps=30,scale=-2:720');
  });
});
