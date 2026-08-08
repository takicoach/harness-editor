import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVideoConfigStatic } from '../core';

/**
 * プロジェクトの合成解像度を videoConfig.ts から静的に読む（コードは実行しない）。
 * 読めない場合は 1080p 横型を仮定する（従来の固定比率と同じ結果になる無害な既定）。
 */
export function projectResolution(projectDir: string): { width: number; height: number } {
  try {
    const vc = parseVideoConfigStatic(readFileSync(join(projectDir, 'src', 'videoConfig.ts'), 'utf8'));
    return { width: vc.resolution.width, height: vc.resolution.height };
  } catch {
    return { width: 1920, height: 1080 };
  }
}
