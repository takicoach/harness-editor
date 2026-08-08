import { evalDataModule } from './dataModule';
import { replaceExportArray } from './sourceEdit';
import { ProjectFileError, type TitleSegment } from './types';

/**
 * ハーネス形式の titleData.ts を読み取り TitleSegment[] を返す。
 * titleData.ts は Title と videoConfig を import するためスタブを渡す。
 */
export function parseTitleData(
  source: string,
  fps: number,
  durationFrames: number,
): TitleSegment[] {
  const m = evalDataModule(source, {
    './Title': {},
    '../videoConfig': { FPS: fps, DURATION_FRAMES: durationFrames },
  });
  if (!Array.isArray(m.titleData)) {
    throw new ProjectFileError('titleData.ts', 'titleData 配列が見つかりません');
  }
  return m.titleData as TitleSegment[];
}

/** 文字列をダブルクオートの JS リテラルへ。改行は \n / \r、" と \ をエスケープ。 */
function jsString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

/** TitleSegment[] を titleData.ts の配列リテラル文字列へ整形する。 */
export function formatTitleArray(segments: TitleSegment[]): string {
  if (segments.length === 0) return '[]';
  const items = segments.map((s) => {
    // I-1 修正: TitleSegment は下流の { id, startFrame, endFrame, text } のみ。
    // originalStart/End は書き出さない（読み戻しの後方互換フィールドとしては型に残す）。
    const lines = [`    id: ${s.id},`];
    lines.push(`    startFrame: ${s.startFrame},`);
    lines.push(`    endFrame: ${s.endFrame},`);
    lines.push(`    text: ${jsString(s.text)},`);
    return `  {\n${lines.join('\n')}\n  }`;
  });
  return `[\n${items.join(',\n')},\n]`;
}

/** 元ソースの import/コメントを保ったまま titleData 配列だけを差し替える。 */
export function serializeTitleData(originalSource: string, segments: TitleSegment[]): string {
  return replaceExportArray(originalSource, 'titleData', formatTitleArray(segments));
}

/** titleData.ts が存在しないプロジェクトで新規生成するためのテンプレート。 */
export const TITLE_DATA_TEMPLATE = `import type { TitleSegment } from './Title';
import { FPS } from '../videoConfig';

const toFrame = (seconds: number) => Math.round(seconds * FPS);

// ==== タイトル（セグメント見出し）データ ====
export const titleData: TitleSegment[] = [];
`;
