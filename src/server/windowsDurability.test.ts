import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows の fsync（FlushFileBuffers）は書き込み権限のある開き方を要求する。読み取り専用で開くと EPERM で落ちる（Windows 11 の利用者報告 2026-11-04）。
// Mac では素通りするので、実行では気づけない。ソースの形で止める。
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__fixtures__' ? [] : sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('Windows の fsync', () => {
  it('読み取り専用で開いたファイルを fsync しない', () => {
    // フォルダーの同期のように Windows を除いて行うものは対象外（同じ行で win32 を除いている）。
    const readOnlySync = /(\w+)\s*=\s*await open\([^;]*,\s*'r'\)\s*;\s*try\s*\{\s*await \1\.sync\(\)/;
    const bad = sources('src/server').filter((path) => readFileSync(path, 'utf8').split('\n')
      .some((line) => readOnlySync.test(line) && !line.includes("process.platform !== 'win32'")));
    expect(bad).toEqual([]);
  });
});
