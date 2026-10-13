// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { NativePreviewBridge } from './previewBridge';

describe('NativePreviewBridge の素材経路', () => {
  it('サムネ用は thumbnail=1 で原本の経路を使い、従来の呼び方は変わらない', () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const thumbnail = new NativePreviewBridge(host, 'case', undefined, 'thumbnail');
    expect(host.querySelector('iframe')!.getAttribute('src')).toBe('/native-render.html?id=case&preview=1&thumbnail=1');
    thumbnail.dispose();
    const video = new NativePreviewBridge(host, 'case');
    expect(host.querySelector('iframe')!.getAttribute('src')).toBe('/native-render.html?id=case&preview=1');
    video.dispose();
  });
});
