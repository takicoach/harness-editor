import { describe, expect, it } from 'vitest';
import {
  analyzeProxyNeed,
  parseProxyProbeOutput,
  parseRational,
  type ProxySourceInfo,
} from './previewProxyAnalysis';

const MB = 1024 * 1024;

/** 快適ゾーンの基準値（どのトリガーにも当たらない）。 */
function comfy(overrides: Partial<ProxySourceInfo> = {}): ProxySourceInfo {
  return {
    sizeBytes: 100 * MB,
    durationSeconds: 5 * 60,
    width: 1920,
    height: 1080,
    fps: 30,
    avgFps: 30,
    codecName: 'h264',
    ...overrides,
  };
}

describe('parseRational', () => {
  it('"30000/1001" を数値へ変換する', () => {
    expect(parseRational('30000/1001')).toBeCloseTo(29.97, 2);
  });
  it('分母なし・ゼロ割り・空は適切に処理する', () => {
    expect(parseRational('30')).toBe(30);
    expect(parseRational('0/0')).toBeNull();
    expect(parseRational('')).toBeNull();
    expect(parseRational(undefined)).toBeNull();
  });
});

describe('analyzeProxyNeed', () => {
  it('快適ゾーンの動画は推奨しない', () => {
    expect(analyzeProxyNeed(comfy())).toEqual({ recommended: false, reasons: [] });
  });

  it('尺 10 分以上で推奨（分数入りの理由）', () => {
    const r = analyzeProxyNeed(comfy({ durationSeconds: 23.5 * 60 }));
    expect(r.recommended).toBe(true);
    expect(r.reasons).toEqual(['長尺（約24分）']);
  });

  it('500MB 以上で推奨', () => {
    const r = analyzeProxyNeed(comfy({ sizeBytes: 600 * MB }));
    expect(r.reasons).toEqual(['容量が大きい（600MB）']);
  });

  it('短辺 1080px 超（4K）で推奨・縦動画の 1080×1920 は対象外', () => {
    expect(analyzeProxyNeed(comfy({ width: 3840, height: 2160 })).recommended).toBe(true);
    expect(analyzeProxyNeed(comfy({ width: 1080, height: 1920 })).recommended).toBe(false);
  });

  it('H.264 以外のコーデック（HEVC）で推奨', () => {
    const r = analyzeProxyNeed(comfy({ codecName: 'hevc' }));
    expect(r.reasons).toEqual(['ブラウザが苦手なコーデック（HEVC）']);
  });

  it('公称と平均の fps 乖離（VFR）で推奨・codec 不明は理由にしない', () => {
    const r = analyzeProxyNeed(comfy({ fps: 30, avgFps: 24.4, codecName: null }));
    expect(r.reasons).toEqual(['可変フレームレート（Zoom・画面録画で多い形式）']);
  });

  it('avgFps が取れない場合は VFR 判定しない', () => {
    expect(analyzeProxyNeed(comfy({ avgFps: null })).recommended).toBe(false);
  });

  it('複数トリガーは理由が並ぶ（Zoom 23分・VFR の実例形）', () => {
    const r = analyzeProxyNeed(
      comfy({ durationSeconds: 23.5 * 60, fps: 25, avgFps: 24.36 }),
    );
    expect(r.recommended).toBe(true);
    expect(r.reasons).toHaveLength(2);
  });
});

describe('parseProxyProbeOutput', () => {
  const json = JSON.stringify({
    streams: [
      {
        width: 1280,
        height: 720,
        r_frame_rate: '25/1',
        avg_frame_rate: '2436/100',
        codec_name: 'h264',
        duration: '1410.5',
      },
    ],
    format: { duration: '1410.6' },
  });

  it('拡張 entries（codec・avg fps）込みで取り出す', () => {
    const info = parseProxyProbeOutput(json, 342 * MB);
    expect(info).toEqual({
      sizeBytes: 342 * MB,
      durationSeconds: 1410.5,
      width: 1280,
      height: 720,
      fps: 25,
      avgFps: 24.36,
      codecName: 'h264',
    });
  });

  it('stream.duration が "N/A" 文字列でも有効な format.duration を使う（ffprobe 版差）', () => {
    const naDur = JSON.stringify({
      streams: [{ width: 1280, height: 720, r_frame_rate: '30/1', duration: 'N/A' }],
      format: { duration: '90.5' },
    });
    expect(parseProxyProbeOutput(naDur, MB).durationSeconds).toBe(90.5);
  });

  it('stream.duration が無ければ format.duration へフォールバック', () => {
    const noStreamDur = JSON.stringify({
      streams: [{ width: 1280, height: 720, r_frame_rate: '30/1' }],
      format: { duration: '60' },
    });
    const info = parseProxyProbeOutput(noStreamDur, MB);
    expect(info.durationSeconds).toBe(60);
    expect(info.avgFps).toBeNull();
    expect(info.codecName).toBeNull();
  });

  it('映像ストリームなし・壊れた JSON は 422 エラー', () => {
    expect(() => parseProxyProbeOutput('{}', MB)).toThrowError(/映像ストリーム/);
    expect(() => parseProxyProbeOutput('not-json', MB)).toThrowError(/ffprobe 出力が不正/);
  });
});
