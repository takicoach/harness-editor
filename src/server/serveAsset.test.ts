import { describe, expect, it } from 'vitest';
import { contentTypeFor } from './serveAsset';

describe('contentTypeFor', () => {
  it('拡張子から Content-Type を決める', () => {
    expect(contentTypeFor('se/パッ.mp3')).toBe('audio/mpeg');
    expect(contentTypeFor('a.wav')).toBe('audio/wav');
    expect(contentTypeFor('images/x.PNG')).toBe('image/png');
    expect(contentTypeFor('y.jpeg')).toBe('image/jpeg');
  });

  it('未知の拡張子は octet-stream', () => {
    expect(contentTypeFor('a.xyz')).toBe('application/octet-stream');
  });
});
