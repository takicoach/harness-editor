import { evalDataModule } from './dataModule';
import { replaceExportArray } from './sourceEdit';
import { ProjectFileError, type VideoInsert } from './types';

/**
 * ハーネス形式の insertVideoData.ts を読み取り VideoInsert[] を返す。
 * source が null（ファイル不在＝サブ動画未配置）の場合は空配列。
 * insertImageData と同じく `../videoConfig` の FPS と `./types` をスタブ評価する。
 */
export function parseInsertVideoData(source: string | null, fps: number): VideoInsert[] {
  if (source === null) return [];
  const m = evalDataModule(source, {
    '../videoConfig': { FPS: fps },
    './types': {},
  });
  if (!Array.isArray(m.insertVideoData)) {
    throw new ProjectFileError('insertVideoData.ts', 'insertVideoData 配列が見つかりません');
  }
  return m.insertVideoData as VideoInsert[];
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

/** VideoInsert[] を insertVideoData.ts の配列リテラル文字列へ整形する。 */
export function formatInsertVideoArray(items: VideoInsert[]): string {
  if (items.length === 0) return '[]';
  const blocks = items.map((s) => {
    const lines = [
      `    id: ${s.id},`,
      `    startFrame: ${s.startFrame},`,
      `    endFrame: ${s.endFrame},`,
      `    file: ${jsString(s.file)},`,
      `    sourceInFrame: ${s.sourceInFrame},`,
    ];
    if (s.position !== undefined) {
      lines.push(`    position: { x: ${s.position.x}, y: ${s.position.y} },`);
    }
    if (s.scale !== undefined) lines.push(`    scale: ${s.scale},`);
    if (s.playbackRate !== undefined) lines.push(`    playbackRate: ${s.playbackRate},`);
    if (s.enter !== undefined) lines.push(`    enter: ${formatElementAnim(s.enter)},`);
    if (s.exit !== undefined) lines.push(`    exit: ${formatElementAnim(s.exit)},`);
    return `  {\n${lines.join('\n')}\n  }`;
  });
  return `[\n${blocks.join(',\n')},\n]`;
}

/** サブ動画未配置プロジェクト用に insertVideoData.ts を新規生成するテンプレート。 */
function newInsertVideoDataSource(): string {
  return `import type { VideoInsert } from './types';

// Harness Editor が生成・更新します

export const insertVideoData: VideoInsert[] = [];
`;
}

/**
 * VideoInsert[] を insertVideoData.ts ソースへ書き戻す。
 * originalSource が null かつクリップが空なら null（空ファイルを作らない）。
 * originalSource が null かつクリップがあれば新規雛形を生成する。
 */
export function serializeInsertVideoData(
  originalSource: string | null,
  items: VideoInsert[],
): string | null {
  if (originalSource === null && items.length === 0) return null;
  const base = originalSource ?? newInsertVideoDataSource();
  return replaceExportArray(base, 'insertVideoData', formatInsertVideoArray(items));
}
