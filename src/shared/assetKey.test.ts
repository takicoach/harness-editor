// src/shared/assetKey.test.ts
import { describe, it, expect } from 'vitest';
import { makeAssetKey } from './assetKey';

describe('makeAssetKey（種別 + 正規化パス）', () => {
  it('NFD（macOS 濁点分解）と NFC が同一キーになる', () => {
    const nfd = 'バナー.png'; // バ を分解表現で
    const nfc = 'バナー.png';
    expect(makeAssetKey('image', nfd)).toBe(makeAssetKey('image', nfc));
  });

  it('先頭スラッシュ・バックスラッシュを正規化する', () => {
    expect(makeAssetKey('se', '/beep.mp3')).toBe(makeAssetKey('se', 'beep.mp3'));
    expect(makeAssetKey('image', 'sub\\logo.png')).toBe(makeAssetKey('image', 'sub/logo.png'));
  });

  it('サブディレクトリは保持する（別ファイルは別キー）', () => {
    expect(makeAssetKey('image', 'sub/logo.png')).not.toBe(makeAssetKey('image', 'logo.png'));
  });

  it('種別が違えば同名でも別キー', () => {
    expect(makeAssetKey('se', 'a.mp3')).not.toBe(makeAssetKey('bgm', 'a.mp3'));
  });
});
