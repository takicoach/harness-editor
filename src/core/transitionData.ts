import { evalDataModule } from './dataModule';
import { replaceExportArray } from './sourceEdit';
import { ProjectFileError, type SceneTransition } from './types';

/**
 * ハーネス形式の transitionData.ts を読み取り SceneTransition[] を返す。
 * source が null（transitionData.ts 不在＝トランジション未設定）の場合は空配列。
 * transitionData.ts は `./types` から型 import のみなので空オブジェクトでスタブする。
 */
export function parseTransitionData(source: string | null, _fps: number): SceneTransition[] {
  if (source === null) return [];
  const m = evalDataModule(source, {
    './types': {},
  });
  if (!Array.isArray(m.transitionData)) {
    throw new ProjectFileError('transitionData.ts', 'transitionData 配列が見つかりません');
  }
  return m.transitionData as SceneTransition[];
}

/** 文字列をダブルクオートの JS リテラルへ。改行は \n / \r、" と \ をエスケープ。 */
function jsString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

/** SceneTransition[] を transitionData.ts の配列リテラル文字列へ整形する。 */
export function formatTransitionArray(items: SceneTransition[]): string {
  if (items.length === 0) return '[]';
  const out = items.map((t) => {
    const lines = [
      `    id: ${t.id},`,
      typeof t.at === 'number' ? `    at: ${t.at},` : `    at: ${jsString(t.at)},`,
      `    kind: ${jsString(t.kind)},`,
      `    durationFrames: ${t.durationFrames},`,
    ];
    if (t.kind === 'fadeColor' && t.color !== undefined) lines.push(`    color: ${jsString(t.color)},`);
    return `  {\n${lines.join('\n')}\n  }`;
  });
  return `[\n${out.join(',\n')},\n]`;
}

/** トランジション未設定プロジェクト用に transitionData.ts を新規生成するときのテンプレート。 */
function newTransitionDataSource(): string {
  return `import type { SceneTransition } from './types';

// Harness Editor が生成・更新します

export const transitionData: SceneTransition[] = [];
`;
}

/**
 * SceneTransition[] を transitionData.ts ソースへ書き戻す。
 * originalSource が null かつ配列が空なら null を返す（空の transitionData.ts を作らない）。
 * originalSource が null かつ要素があれば新規雛形を生成する。
 */
export function serializeTransitionData(
  originalSource: string | null,
  items: SceneTransition[],
): string | null {
  if (originalSource === null && items.length === 0) return null;
  const base = originalSource ?? newTransitionDataSource();
  return replaceExportArray(base, 'transitionData', formatTransitionArray(items));
}
