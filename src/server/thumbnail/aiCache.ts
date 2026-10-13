import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const THUMBNAIL_AI_CACHE_LIMITS = { files: 50, bytes: 200 * 1024 * 1024 } as const;
/** .harness/cache/thumbnail-ai/ を上限まで古い順に消す。keep が真のファイル（作業中の依頼の画像）は消さない。 */
export async function evictThumbnailAiCache(directory: string, keep: (name: string) => boolean, limits: { files: number; bytes: number } = THUMBNAIL_AI_CACHE_LIMITS): Promise<string[]> {
  const entries = await Promise.all((await readdir(directory)).map(async name => ({ name, info: await stat(join(directory, name)).catch(() => null) })));
  const files = entries.filter(entry => entry.info?.isFile()).map(entry => ({ name: entry.name, size: entry.info!.size, mtime: entry.info!.mtimeMs })).sort((a, b) => a.mtime - b.mtime);
  let count = files.length, bytes = files.reduce((sum, file) => sum + file.size, 0);
  const removed: string[] = [];
  for (const file of files) {
    if (count <= limits.files && bytes <= limits.bytes) break;
    if (keep(file.name)) continue;
    await unlink(join(directory, file.name)).catch(() => undefined);
    removed.push(file.name); count -= 1; bytes -= file.size;
  }
  return removed;
}
