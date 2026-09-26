import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../http';

/** Once v2 exists, old writers/renderers may not silently use a second source of truth. */
export function assertLegacySequenceAuthority(directory: string): void {
  try { lstatSync(join(directory, '.harness/project.v2.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new HttpError(409, 'この案件は新形式で保存されています。新しい編集画面から保存・書き出しを行ってください');
}
