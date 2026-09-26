import { evalDataModule, assertNoNullOrNonFinite } from './dataModule';
import { replaceExportArray } from './sourceEdit';
import { formatMotion } from './motion';
import { ProjectFileError, type ImageSegment } from './types';

/**
 * ハーネス形式の insertImageData.ts を読み取り ImageSegment[] を返す。
 * source が null（insertImageData.ts 不在＝画像未配置）の場合は空配列。
 * insertImageData.ts は `../videoConfig` から FPS を値 import し `toFrame(秒)` を計算式へ
 * 使うため、スタブで FPS を渡して評価する。`./types` は型 import のみなので空オブジェクト。
 */
export function parseInsertImageData(source: string | null, fps: number): ImageSegment[] {
  if (source === null) return [];
  const m = evalDataModule(source, {
    '../videoConfig': { FPS: fps },
    './types': {},
  });
  if (!Array.isArray(m.insertImageData)) {
    throw new ProjectFileError('insertImageData.ts', 'insertImageData 配列が見つかりません');
  }
  assertNoNullOrNonFinite('insertImageData.ts', 'insertImageData', m.insertImageData);
  return m.insertImageData as ImageSegment[];
}

/** 文字列をダブルクオートの JS リテラルへ。改行は \n / \r、" と \ をエスケープ。 */
function jsString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

/** ElementAnim をオブジェクトリテラル文字列へ。direction フィールドが存在するときのみ出力。 */
function formatElementAnim(a: { kind: string; frames: number; direction?: string }): string {
  const parts = [`kind: ${jsString(a.kind)}`, `frames: ${a.frames}`];
  if (a.direction !== undefined) parts.push(`direction: ${jsString(a.direction)}`);
  return `{ ${parts.join(', ')} }`;
}

/** ImageSegment[] を insertImageData.ts の配列リテラル文字列へ整形する。 */
export function formatInsertImageArray(images: ImageSegment[]): string {
  if (images.length === 0) return '[]';
  const items = images.map((s) => {
    const lines = [
      `    id: ${s.id},`,
      `    startFrame: ${s.startFrame},`,
      `    endFrame: ${s.endFrame},`,
      `    file: ${jsString(s.file)},`,
      `    type: ${jsString(s.type)},`,
    ];
    if (s.position !== undefined) {
      lines.push(`    position: { x: ${s.position.x}, y: ${s.position.y} },`);
    }
    if (s.scale !== undefined) lines.push(`    scale: ${s.scale},`);
    if (s.opacity !== undefined) lines.push(`    opacity: ${s.opacity},`);
    if (s.rotation !== undefined) lines.push(`    rotation: ${s.rotation},`);
    if (s.motion !== undefined) lines.push(`    motion: ${formatMotion(s.motion)},`);
    if (s.enter !== undefined) lines.push(`    enter: ${formatElementAnim(s.enter)},`);
    if (s.exit !== undefined) lines.push(`    exit: ${formatElementAnim(s.exit)},`);
    return `  {\n${lines.join('\n')}\n  }`;
  });
  return `[\n${items.join(',\n')},\n]`;
}

/** 画像未配置プロジェクト用に insertImageData.ts を新規生成するときのテンプレート。 */
function newInsertImageDataSource(): string {
  return `import type { ImageSegment } from './types';

// Harness Editor が生成・更新します

export const insertImageData: ImageSegment[] = [];
`;
}

/**
 * ImageSegment[] を insertImageData.ts ソースへ書き戻す。
 * originalSource が null かつ画像が空なら null を返す（空の insertImageData.ts を作らない）。
 * originalSource が null かつ画像があれば新規雛形を生成する。
 * 既存ソースを差し替えるときは、`toFrame()` ヘルパや `FPS` import は残るが、配列の値は
 * 生整数になるため未使用になる（ハーネス形式側の build には影響しない）。
 */
export function serializeInsertImageData(
  originalSource: string | null,
  images: ImageSegment[],
): string | null {
  if (originalSource === null && images.length === 0) return null;
  const base = originalSource ?? newInsertImageDataSource();
  return replaceExportArray(base, 'insertImageData', formatInsertImageArray(images));
}
