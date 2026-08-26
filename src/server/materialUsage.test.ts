// src/server/materialUsage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFileLiterals, scanMaterialUsage } from './materialUsage';
import { makeAssetKey } from '../shared/assetKey';

describe('collectFileLiterals', () => {
  it('file: 文字列リテラルを列挙する（関数呼び出しが混在しても壊れない）', () => {
    const src = [
      "import { toFrame } from './helper';",
      'export const insertImageData = [',
      "  { id: 1, startFrame: toFrame(1.0), endFrame: toFrame(3.0), file: 'sample.png', type: 'photo' },",
      "  { id: 2, startFrame: 0, endFrame: 10, file: 'sub/logo.png', type: 'photo' },",
      '];',
    ].join('\n');
    expect(collectFileLiterals(src)).toEqual(['sample.png', 'sub/logo.png']);
  });

  it('file 以外のプロパティ・非リテラルは拾わない', () => {
    expect(collectFileLiterals('export const x = [{ path: "a.png", file: name }];')).toEqual([]);
  });
});

describe('scanMaterialUsage', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sme-usage-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSe(content: string): void {
    mkdirSync(join(dir, 'src', 'SoundEffects'), { recursive: true });
    writeFileSync(join(dir, 'src', 'SoundEffects', 'seData.ts'), content, 'utf8');
  }

  it('seData の参照を数える（複数箇所）', () => {
    writeSe(
      "export const seData = [\n" +
        "  { id: 1, startFrame: 30, file: 'beep.mp3' },\n" +
        "  { id: 2, startFrame: 90, file: 'beep.mp3' },\n" +
        "  { id: 3, startFrame: 120, file: 'other.mp3' },\n" +
        '];',
    );
    expect(scanMaterialUsage(dir, makeAssetKey('se', 'beep.mp3'))).toEqual({ ok: true, count: 2 });
  });

  it('種別が違えば数えない（bgm の beep.mp3 は se データ由来ではヒットしない）', () => {
    writeSe("export const seData = [{ id: 1, startFrame: 0, file: 'beep.mp3' }];");
    expect(scanMaterialUsage(dir, makeAssetKey('bgm', 'beep.mp3'))).toEqual({ ok: true, count: 0 });
  });

  it('NFD で書かれた参照も NFC キーでヒットする', () => {
    writeSe(`export const seData = [{ id: 1, startFrame: 0, file: 'バ.mp3' }];`);
    expect(scanMaterialUsage(dir, makeAssetKey('se', 'バ.mp3'))).toEqual({ ok: true, count: 1 });
  });

  it('データファイルが1つも無い → ok:true, count:0', () => {
    expect(scanMaterialUsage(dir, makeAssetKey('se', 'beep.mp3'))).toEqual({ ok: true, count: 0 });
  });

  it('サイズ上限超のデータファイルがある → ok:false（削除保留）', () => {
    writeSe('// ' + 'x'.repeat(2 * 1024 * 1024 + 1));
    expect(scanMaterialUsage(dir, makeAssetKey('se', 'beep.mp3'))).toEqual({ ok: false });
  });

  it.skipIf(process.getuid?.() === 0)(
    '権限が無くて読めないデータファイルは「未使用」と誤認せず ok:false',
    () => {
      writeSe(`export const seData = [{ id: 1, startFrame: 0, file: 'beep.mp3' }];`);
      const seDir = join(dir, 'src', 'SoundEffects');
      chmodSync(seDir, 0o000);
      try {
        // existsSync は EACCES でも false を返すため、不在と区別せず continue すると
        // 「参照しているのに未使用」と誤判定して削除を許してしまう。
        expect(scanMaterialUsage(dir, makeAssetKey('se', 'beep.mp3'))).toEqual({ ok: false });
      } finally {
        chmodSync(seDir, 0o755);
      }
    },
  );

  it('データファイルの親が通常ファイル（ENOTDIR）でも ok:false', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'SoundEffects'), 'not a directory', 'utf8');
    expect(scanMaterialUsage(dir, makeAssetKey('se', 'beep.mp3'))).toEqual({ ok: false });
  });
});
