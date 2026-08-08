import { describe, it, expect } from 'vitest';
import { nextReloadKey, withReloadBust } from './previewReload';

describe('previewReload', () => {
  describe('nextReloadKey', () => {
    it('現在値を1つ進める', () => {
      expect(nextReloadKey(0)).toBe(1);
      expect(nextReloadKey(1)).toBe(2);
      expect(nextReloadKey(41)).toBe(42);
    });
  });

  describe('withReloadBust', () => {
    it('key が 0（初期値）のとき URL を変更しない', () => {
      expect(withReloadBust('/api/video?id=p1&file=main.mp4', 0)).toBe('/api/video?id=p1&file=main.mp4');
    });

    it('空 URL はそのまま返す（プロジェクト未選択時の防御）', () => {
      expect(withReloadBust('', 3)).toBe('');
    });

    it('key > 0 のとき reload クエリを付与する（クエリ有り URL）', () => {
      expect(withReloadBust('/api/video?id=p1&file=main.mp4', 1)).toBe(
        '/api/video?id=p1&file=main.mp4&reload=1',
      );
    });

    it('クエリの無い URL には ? で付与する', () => {
      expect(withReloadBust('/api/video', 2)).toBe('/api/video?reload=2');
    });

    it('key が増えるたびに値が変わる（毎回キャッシュバストされる）', () => {
      const a = withReloadBust('/api/video?id=p1&file=main.mp4', 1);
      const b = withReloadBust('/api/video?id=p1&file=main.mp4', 2);
      expect(a).not.toBe(b);
    });
  });
});
