import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CutLearningRecord } from '../core/cutLearning';

const LEARNING_FILE = 'cutLearning.json';

/** 学習レコードをプロジェクト直下 cutLearning.json へ整形 JSON で書き出す。 */
export function writeCutLearning(dir: string, record: CutLearningRecord): void {
  writeFileSync(join(dir, LEARNING_FILE), JSON.stringify(record, null, 2), 'utf8');
}
