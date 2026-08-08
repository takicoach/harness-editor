import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** cutData.ts の候補（loadProjectFiles・installSpeed と同一順）。 */
export const CUT_DATA_CANDIDATES: { rel: string; importSpec: string }[] = [
  { rel: 'cutData.ts', importSpec: '../cutData' },
  { rel: 'src/cutData.ts', importSpec: './cutData' },
  { rel: 'src/テロップテンプレート/cutData.ts', importSpec: './テロップテンプレート/cutData' },
];

/** プロジェクト dir 内の cutData.ts を候補順に探し、MainVideo（src/）からの import 指定子を返す。無ければ null。 */
export function cutDataImport(dir: string): string | null {
  for (const c of CUT_DATA_CANDIDATES) {
    if (existsSync(join(dir, c.rel))) return c.importSpec;
  }
  return null;
}
