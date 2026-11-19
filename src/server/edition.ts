import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppEdition } from '../shared/paidOffer';

/** 有料プラグインを入れた時だけ置かれる目印のファイル（src/server からの相対）。公開版には無い。 */
export const PRO_MARKER_FILE = join('proFeatures', 'pro.json');

/** 目印のファイルがあれば 'paid'、無ければ 'free'。 */
export function detectEdition(serverDir: string = dirname(fileURLToPath(import.meta.url))): AppEdition {
  try { return statSync(join(serverDir, PRO_MARKER_FILE)).isFile() ? 'paid' : 'free'; } catch { return 'free'; }
}
