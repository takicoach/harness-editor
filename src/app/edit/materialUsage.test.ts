import { describe, it, expect } from 'vitest';
import { collectUsedAssetKeys } from './materialUsage';
import { makeAssetKey } from '../../shared/assetKey';

describe('collectUsedAssetKeys（未保存の編集状態から使用素材を数える）', () => {
  it('4種の配列から種別つきキーで数える（重複は加算・任意配列は未設定許容）', () => {
    const map = collectUsedAssetKeys({
      se: [{ file: 'beep.mp3' }, { file: 'beep.mp3' }],
      images: [{ file: 'sub/logo.png' }],
      videoInserts: [{ file: 'broll.mp4' }],
      // bgm は未導入プロジェクトでは undefined
    });
    expect(map.get(makeAssetKey('se', 'beep.mp3'))).toBe(2);
    expect(map.get(makeAssetKey('image', 'sub/logo.png'))).toBe(1);
    expect(map.get(makeAssetKey('video', 'broll.mp4'))).toBe(1);
    expect(map.get(makeAssetKey('bgm', 'beep.mp3'))).toBeUndefined();
  });

  it('NFD の参照も NFC キーで一致する', () => {
    // macOS が返す濁点分解（NFD）のファイル名。リテラルで書くと環境依存で NFC に
    // 潰れうるので、明示的に normalize して「本当に NFD である」ことを担保する。
    const nfd = 'バ.mp3'.normalize('NFD');
    const nfc = 'バ.mp3'.normalize('NFC');
    expect(nfd).not.toBe(nfc);
    const map = collectUsedAssetKeys({ se: [{ file: nfd }], images: [] });
    expect(map.get(makeAssetKey('se', nfc))).toBe(1);
  });
});
