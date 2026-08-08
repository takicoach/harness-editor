import { describe, it, expect } from 'vitest';
import { parseTranscriptFixed } from './transcriptFixed';

const SAMPLE = JSON.stringify({
  drill: 'drill-01',
  source_start_ms: 97000,
  segments: [
    { text: 'ゼロ式ドリル', start: 100, end: 800, is_golf_shot: false },
    { text: '長いアイアン2本', start: 900, end: 1600 },
  ],
  words: [{ text: 'ゼロ', start: 100, end: 400 }],
});

describe('parseTranscriptFixed', () => {
  it('segments を読む（text/start/end）', () => {
    const t = parseTranscriptFixed(SAMPLE);
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0]).toEqual({ text: 'ゼロ式ドリル', start: 100, end: 800 });
  });

  it('segments が無ければ throw する', () => {
    expect(() => parseTranscriptFixed('{"words":[]}')).toThrow(/segments/);
  });

  it('不正な JSON は throw する', () => {
    expect(() => parseTranscriptFixed('not json')).toThrow();
  });

  it('JSON ルートが null なら throw する', () => {
    expect(() => parseTranscriptFixed('null')).toThrow();
  });
});
