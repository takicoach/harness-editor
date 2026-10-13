import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readRegularFileNoFollow } from './cover';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function folder(): string { const directory = mkdtempSync(join(tmpdir(), 'thumb-cover-')); directories.push(directory); return directory; }

describe('readRegularFileNoFollow（カードの画像を配る時の読み込み）', () => {
  it('通常のファイルだけを読む。リンク・フォルダー・空・上限超えは読まない', () => {
    const directory = folder(), file = join(directory, 'a.png'), outside = join(folder(), 'outside.png');
    writeFileSync(file, 'png'); writeFileSync(outside, 'secret'); symlinkSync(outside, join(directory, 'link.png'));
    mkdirSync(join(directory, 'dir.png')); writeFileSync(join(directory, 'empty.png'), '');
    expect(readRegularFileNoFollow(file, 10)!.toString()).toBe('png');
    expect(readRegularFileNoFollow(join(directory, 'link.png'), 10)).toBeNull();
    expect(readRegularFileNoFollow(join(directory, 'dir.png'), 10)).toBeNull();
    expect(readRegularFileNoFollow(join(directory, 'empty.png'), 10)).toBeNull();
    expect(readRegularFileNoFollow(file, 2)).toBeNull();
    expect(readRegularFileNoFollow(join(directory, 'missing.png'), 10)).toBeNull();
  });
  it('確かめた後に FIFO へ差し替えられても、開くところで止まらずに読まない', () => {
    const fifo = join(folder(), 'case サムネ.png');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    // 止まると同じプロセスのテストごと固まるので、別のプロセスで時間を区切って確かめる。
    const script = `import { readRegularFileNoFollow } from ${JSON.stringify(resolve('src/server/thumbnail/cover.ts'))};\n`
      + `process.stdout.write(String(readRegularFileNoFollow(${JSON.stringify(fifo)}, 1024)));`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
    expect(result.error?.message).toBeUndefined();
    expect(result.stdout).toBe('null');
  }, 20_000);
});
