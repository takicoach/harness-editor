import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTranscript, isTranscriptAlignedWithVideo } from './transcript';
import { ProjectFileError, type Transcript, type VideoConfig } from './types';

const FIXTURE = readFileSync(
  new URL('./__fixtures__/transcript.fixture.json', import.meta.url),
  'utf8',
);

describe('parseTranscript', () => {
  it('words / segments / durationMs を読む', () => {
    const t = parseTranscript(FIXTURE);
    expect(t.durationMs).toBe(200000);
    expect(t.words).toHaveLength(4);
    expect(t.words[0]).toEqual({ text: 'ゆる', start: 500, end: 800, confidence: 0.9 });
    expect(t.segments).toHaveLength(2);
  });

  it('words が無いと ProjectFileError を投げる', () => {
    expect(() => parseTranscript('{"segments":[]}')).toThrow(ProjectFileError);
  });

  it('不正な JSON は ProjectFileError を投げる', () => {
    expect(() => parseTranscript('xxx')).toThrow(ProjectFileError);
  });

  it('JSON ルートが null なら ProjectFileError を投げる', () => {
    expect(() => parseTranscript('null')).toThrow(ProjectFileError);
  });
});

// 焼き込み済みプロジェクト（transcript が元動画全体・telop/video は抽出後）を検知して
// 単語チップが意味を成さないことを上流で判定するためのヘルパー。
describe('isTranscriptAlignedWithVideo', () => {
  const video = (durationFrames: number, fps = 60): VideoConfig => ({
    format: 'short',
    fps,
    durationFrames,
    videoFile: 'main.mp4',
    resolution: { width: 1080, height: 1920 },
    orientation: 'portrait',
    titleStyle: { top: 60, left: 30, fontSize: 30 },
  });
  const tx = (durationMs: number, words: Transcript['words'] = []): Transcript => ({
    durationMs,
    words,
    segments: [],
  });

  it('transcript と動画長が一致していれば true', () => {
    // 6970 frames / 60fps = 116166.67ms
    expect(isTranscriptAlignedWithVideo(tx(116167), video(6970))).toBe(true);
  });

  it('±10% 以内のズレは許容して true', () => {
    expect(isTranscriptAlignedWithVideo(tx(120000), video(6970))).toBe(true);
  });

  it('transcript が動画より大幅に長ければ false（焼き込み済みプロジェクト）', () => {
    // drill-01 ケース: 動画 116s だが transcript は元動画 2168s
    expect(isTranscriptAlignedWithVideo(tx(2168540), video(6970))).toBe(false);
  });

  it('transcript.durationMs が 0 のときは words 末尾から推定する', () => {
    const words = [
      { text: 'a', start: 0, end: 1000 },
      { text: 'b', start: 1000, end: 2168540 },
    ];
    expect(isTranscriptAlignedWithVideo(tx(0, words), video(6970))).toBe(false);
  });

  it('transcript が空（duration 0・words 無し）なら true（判定不能は安全側）', () => {
    expect(isTranscriptAlignedWithVideo(tx(0), video(6970))).toBe(true);
  });
});
