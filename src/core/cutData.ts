import { evalDataModule } from './dataModule';
import { replaceExportArray } from './sourceEdit';
import { ProjectFileError, type CutSegment } from './types';

/**
 * ハーネス形式の cutData.ts を読み取り CutSegment[] を返す。
 * source が null（cutData.ts 不在＝カット未実施）の場合は空配列。
 * cutData.ts 内の toFrame 等の関数はファイル内で完結するためそのまま評価される。
 */
export function parseCutData(source: string | null): CutSegment[] {
  if (source === null) return [];
  const m = evalDataModule(source);
  if (!Array.isArray(m.cutData)) {
    throw new ProjectFileError('cutData.ts', 'cutData 配列が見つかりません');
  }
  return m.cutData as CutSegment[];
}

/** CutSegment[] を cutData.ts の配列リテラル文字列へ整形する。 */
export function formatCutArray(cuts: CutSegment[]): string {
  if (cuts.length === 0) return '[]';
  const items = cuts.map(
    (c) =>
      `  { id: ${c.id}, originalStart: ${c.originalStart}, originalEnd: ${c.originalEnd}, ` +
      `playbackStart: ${c.playbackStart}, playbackEnd: ${c.playbackEnd} }`,
  );
  return `[\n${items.join(',\n')},\n]`;
}

/** カット未実施プロジェクト用に cutData.ts を新規生成するときのテンプレート。 */
function newCutDataSource(): string {
  return `export interface CutSegment {
  id: number;
  originalStart: number;
  originalEnd: number;
  playbackStart: number;
  playbackEnd: number;
}

// Harness Editor が生成・更新します

export const cutData: CutSegment[] = [];

export const ORIGINAL_DURATION_FRAMES = 0;
export const CUT_DURATION_FRAMES = 0;
`;
}

/** ORIGINAL/CUT_DURATION_FRAMES の数値だけを置換する。 */
function replaceConst(source: string, name: string, value: number): string {
  const re = new RegExp(`(export\\s+const\\s+${name}\\s*=\\s*)[^;]*;`);
  if (!re.test(source)) {
    return `${source.replace(/\n*$/, '')}\nexport const ${name} = ${value};\n`;
  }
  return source.replace(re, `$1${value};`);
}

/**
 * CutSegment[] を cutData.ts ソースへ書き戻す。
 * originalSource が null なら新規 cutData.ts を生成する。
 */
export function serializeCutData(
  originalSource: string | null,
  cuts: CutSegment[],
  originalDurationFrames: number,
  cutDurationFrames: number,
): string {
  const base = originalSource ?? newCutDataSource();
  let out = replaceExportArray(base, 'cutData', formatCutArray(cuts));
  out = replaceConst(out, 'ORIGINAL_DURATION_FRAMES', originalDurationFrames);
  out = replaceConst(out, 'CUT_DURATION_FRAMES', cutDurationFrames);
  return out;
}
