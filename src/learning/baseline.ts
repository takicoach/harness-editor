import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { baselineDir } from './paths';
import type { TrackedFile } from './types';

export interface SnapshotResult {
  /** 今回ベースライン保存した追跡ファイルの relPath。 */
  snapshotted: string[];
  /** 元ファイルが無く保存できなかった relPath。 */
  skipped: string[];
}

/**
 * 追跡ファイルを <root>/.learning/baseline/ へコピーする。
 * 既にベースラインのあるファイルは触らない（遅延・冪等）。
 */
export function snapshotBaseline(projectRoot: string, tracked: TrackedFile[]): SnapshotResult {
  const baseDir = baselineDir(projectRoot);
  mkdirSync(baseDir, { recursive: true });

  const snapshotted: string[] = [];
  const skipped: string[] = [];
  for (const file of tracked) {
    const dest = join(baseDir, file.relPath);
    if (existsSync(dest)) continue; // 既にベースラインあり
    const src = join(projectRoot, file.relPath);
    if (!existsSync(src)) {
      skipped.push(file.relPath);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    snapshotted.push(file.relPath);
  }
  return { snapshotted, skipped };
}
