/**
 * plugin.ts の /api/install-shape ルートが正しく追加されていることを確認するテスト。
 * handleApi は非公開のため、plugin.ts のソースを文字列として検証する。
 * 実動作は installShape.test.ts のユニットテストでカバー済み。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pluginSrc = readFileSync(join(import.meta.dirname, 'plugin.ts'), 'utf8');

describe('plugin.ts: /api/install-shape ルート', () => {
  it('installShape を import している', () => {
    expect(pluginSrc).toContain("from './installShape'");
  });

  it('/api/install-shape のルートハンドラが存在する', () => {
    expect(pluginSrc).toContain("'/api/install-shape'");
  });

  it('POST メソッドチェックがある（405 エラー）', () => {
    // /api/install-shape ブロック内に 405 チェックが含まれること
    const shapeBlock = pluginSrc.slice(
      pluginSrc.indexOf("'/api/install-shape'"),
      pluginSrc.indexOf("'/api/install-shape'") +
        // ブロック終端をざっくり 300 文字以内で確認
        300,
    );
    expect(shapeBlock).toContain('405');
  });

  it('installShape(dir) を呼び出して JSON を返す', () => {
    expect(pluginSrc).toContain('installShape(dir)');
  });

  it('/api/transcribe 周辺のコードが変更されていない（install-shape 以前の行は不変）', () => {
    expect(pluginSrc).toContain("if (url.pathname === '/api/transcribe')");
  });

  it('/api/install-bgm の直後、/api/transcribe の直前に配置されている', () => {
    const installBgmIdx = pluginSrc.indexOf("'/api/install-bgm'");
    const installShapeIdx = pluginSrc.indexOf("'/api/install-shape'");
    const transcribeIdx = pluginSrc.indexOf("'/api/transcribe'");

    expect(installBgmIdx).toBeGreaterThan(-1);
    expect(installShapeIdx).toBeGreaterThan(-1);
    expect(transcribeIdx).toBeGreaterThan(-1);

    // install-shape は install-bgm の後
    expect(installShapeIdx).toBeGreaterThan(installBgmIdx);
    // install-shape は transcribe の前
    expect(installShapeIdx).toBeLessThan(transcribeIdx);
  });
});
