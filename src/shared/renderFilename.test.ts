import { describe, expect, it } from 'vitest';
import { parseRenderOptions, renderOutputName } from './renderPreset';

describe('export file names', () => {
  it('keeps an explicit Japanese MP4 name with quality and ducking', () => {
    const options = { resolution: '720p', quality: 'high', outputName: '素振り 最終.mp4', ducking: { enabled: true, strength: 'mid' } };
    expect(parseRenderOptions(options)).toEqual(options);
    expect(renderOutputName(parseRenderOptions(options)!)).toBe(options.outputName);
  });
  it.each(['', '../result.mp4', '/tmp/result.mp4', 'C:\\result.mp4', 'result.mov', '.hidden.mp4', 'result.mp4 ', ' result.mp4', 'CON.mp4', 'a\n.mp4', 'a?b.mp4', 'あ'.repeat(100) + '.mp4'])('rejects invalid file name %j', outputName => {
    expect(parseRenderOptions({ resolution: 'full', quality: 'high', outputName })).toBeNull();
  });
  it('preserves the legacy omitted filename and refuses a non-string', () => {
    expect(renderOutputName(parseRenderOptions({ resolution: '720p', quality: 'light' })!)).toBe('video-720p.mp4');
    expect(parseRenderOptions({ resolution: 'full', quality: 'high', outputName: 7 })).toBeNull();
  });
});
