import { evalDataModule } from './dataModule';
import { replaceExportArray } from './sourceEdit';
import { ProjectFileError, type ShapeSegment } from './types';

/**
 * ハーネス形式の shapeData.ts を読み取り ShapeSegment[] を返す。
 * source が null（shapeData.ts 不在＝図形未配置）の場合は空配列。
 * shapeData.ts は `./types` から型 import のみなので空オブジェクトでスタブする。
 */
export function parseInsertShapeData(source: string | null): ShapeSegment[] {
  if (source === null) return [];
  const m = evalDataModule(source, {
    './types': {},
  });
  if (!Array.isArray(m.shapeData)) {
    throw new ProjectFileError('shapeData.ts', 'shapeData 配列が見つかりません');
  }
  return m.shapeData as ShapeSegment[];
}

/** 文字列をダブルクオートの JS リテラルへ。改行は \n / \r、" と \ をエスケープ。 */
function jsString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

/** ShapeSegment[] を shapeData.ts の配列リテラル文字列へ整形する。 */
export function formatInsertShapeArray(shapes: ShapeSegment[]): string {
  if (shapes.length === 0) return '[]';
  const items = shapes.map((s) => {
    const lines = [
      `    id: ${s.id},`,
      `    startFrame: ${s.startFrame},`,
      `    endFrame: ${s.endFrame},`,
      `    kind: ${jsString(s.kind)},`,
      `    x1: ${s.x1},`,
      `    y1: ${s.y1},`,
      `    x2: ${s.x2},`,
      `    y2: ${s.y2},`,
      `    color: ${jsString(s.color)},`,
      `    thickness: ${jsString(s.thickness)},`,
    ];
    if (s.opacity !== undefined) lines.push(`    opacity: ${s.opacity},`);
    return `  {\n${lines.join('\n')}\n  }`;
  });
  return `[\n${items.join(',\n')},\n]`;
}

/** 図形未配置プロジェクト用に shapeData.ts を新規生成するときのテンプレート。 */
function newInsertShapeDataSource(): string {
  return `import type { ShapeSegment } from './types';

// Harness Editor が生成・更新します

export const shapeData: ShapeSegment[] = [];
`;
}

/**
 * ShapeSegment[] を shapeData.ts ソースへ書き戻す。
 * originalSource が null かつ図形が空なら null を返す（空の shapeData.ts を作らない）。
 * originalSource が null かつ図形があれば新規雛形を生成する。
 * originalStart/End は出力しない（ShapeSegment スキーマ外フィールド）。
 */
export function serializeInsertShapeData(
  originalSource: string | null,
  shapes: ShapeSegment[],
): string | null {
  if (originalSource === null && shapes.length === 0) return null;
  const base = originalSource ?? newInsertShapeDataSource();
  return replaceExportArray(base, 'shapeData', formatInsertShapeArray(shapes));
}
