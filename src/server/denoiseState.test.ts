import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureBackup,
  resolveInputFromBackup,
  readDenoiseMarker,
  writeDenoiseMarker,
  isDenoiseApplied,
  restoreFromBackup,
  type DenoiseMarker,
} from './denoiseState';

const TMP = join(import.meta.dirname, '__test_denoise_state__');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  // sample main.mp4 (stub)
  writeFileSync(join(TMP, 'main.mp4'), 'VIDEO_STUB');
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('ensureBackup', () => {
  it('初回: main.denoise-backup.mp4 を作成して backup パスを返す', () => {
    const bak = ensureBackup(TMP, 'main.mp4');
    expect(bak).not.toBeNull();
    expect(existsSync(bak!)).toBe(true);
    expect(bak!).toMatch(/main\.denoise-backup\.mp4$/);
  });

  it('再実行時: バックアップが既にあれば再作成せずパスを返す', () => {
    const bak1 = ensureBackup(TMP, 'main.mp4');
    expect(bak1).not.toBeNull();
    // バックアップ後に本ファイルを書き替えても...
    writeFileSync(join(TMP, 'main.mp4'), 'MODIFIED');
    const bak2 = ensureBackup(TMP, 'main.mp4');
    expect(bak1).toBe(bak2);
    // バックアップ内容は初回コピーのまま（上書きされない）
    expect(readFileSync(bak1!, 'utf8')).toBe('VIDEO_STUB');
  });

  it('original が存在しなければ null を返す', () => {
    const result = ensureBackup(TMP, 'nonexistent.mp4');
    expect(result).toBeNull();
  });
});

describe('resolveInputFromBackup', () => {
  it('バックアップが存在すればバックアップパスを返す（常に原本から処理）', () => {
    const bak = ensureBackup(TMP, 'main.mp4');
    expect(bak).not.toBeNull();
    const input = resolveInputFromBackup(TMP, 'main.mp4');
    expect(input).toBe(bak);
  });

  it('バックアップが無ければ元ファイルパスを返す', () => {
    const input = resolveInputFromBackup(TMP, 'main.mp4');
    expect(input).toBe(join(TMP, 'main.mp4'));
  });
});

describe('readDenoiseMarker / writeDenoiseMarker', () => {
  it('マーカーが無ければ null を返す', () => {
    expect(readDenoiseMarker(TMP)).toBeNull();
  });

  it('書き込んだマーカーを読み返せる', () => {
    const marker: DenoiseMarker = { applied: true, strength: 'mid', backupRel: 'main.denoise-backup.mp4' };
    writeDenoiseMarker(TMP, marker);
    expect(readDenoiseMarker(TMP)).toEqual(marker);
  });

  it('上書きできる', () => {
    writeDenoiseMarker(TMP, { applied: true, strength: 'weak', backupRel: 'main.denoise-backup.mp4' });
    writeDenoiseMarker(TMP, { applied: false, strength: 'mid', backupRel: 'main.denoise-backup.mp4' });
    expect(readDenoiseMarker(TMP)?.applied).toBe(false);
  });
});

describe('isDenoiseApplied', () => {
  it('マーカーが無ければ false', () => {
    expect(isDenoiseApplied(TMP)).toBe(false);
  });

  it('applied=true のマーカーがあれば true', () => {
    writeDenoiseMarker(TMP, { applied: true, strength: 'mid', backupRel: 'main.denoise-backup.mp4' });
    expect(isDenoiseApplied(TMP)).toBe(true);
  });

  it('applied=false のマーカーがあれば false', () => {
    writeDenoiseMarker(TMP, { applied: false, strength: 'mid', backupRel: 'main.denoise-backup.mp4' });
    expect(isDenoiseApplied(TMP)).toBe(false);
  });
});

describe('restoreFromBackup', () => {
  it('バックアップから元ファイルを復元し true を返す（マーカー更新は呼び出し側）', () => {
    ensureBackup(TMP, 'main.mp4');
    // 処理済みファイルに見せかける
    writeFileSync(join(TMP, 'main.mp4'), 'DENOISED');

    const restored = restoreFromBackup(TMP, 'main.mp4');

    expect(restored).toBe(true);
    expect(readFileSync(join(TMP, 'main.mp4'), 'utf8')).toBe('VIDEO_STUB');
  });

  it('バックアップが無ければ false を返す（エラーなし）', () => {
    expect(restoreFromBackup(TMP, 'main.mp4')).toBe(false);
  });
});
