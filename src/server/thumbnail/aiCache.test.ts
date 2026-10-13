import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evictThumbnailAiCache } from './aiCache';

let directory = '';
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
function fill(names: string[], bytes = 10) {
  directory = mkdtempSync(join(tmpdir(), 'thumb-ai-cache-'));
  names.forEach((name, index) => { const file = join(directory, name); writeFileSync(file, Buffer.alloc(bytes)); utimesSync(file, 1000 + index, 1000 + index); });
}
describe('evictThumbnailAiCache', () => {
  it('枚数の上限を超えたら古い順に消す', async () => {
    fill(['a-1.jpg', 'a-2.jpg', 'a-3.jpg', 'a-4.jpg']);
    expect(await evictThumbnailAiCache(directory, () => false, { files: 2, bytes: 1e9 })).toEqual(['a-1.jpg', 'a-2.jpg']);
    expect(readdirSync(directory).sort()).toEqual(['a-3.jpg', 'a-4.jpg']);
  });
  it('容量の上限でも消す。作業中の依頼の画像は古くても残す', async () => {
    fill(['busy-1.jpg', 'old-1.jpg', 'old-2.jpg', 'new-1.jpg'], 100);
    expect(await evictThumbnailAiCache(directory, name => name.startsWith('busy-'), { files: 50, bytes: 250 })).toEqual(['old-1.jpg', 'old-2.jpg']);
    expect(readdirSync(directory).sort()).toEqual(['busy-1.jpg', 'new-1.jpg']);
  });
});
