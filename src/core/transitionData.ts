import { evalDataModule, assertNoNullOrNonFinite } from './dataModule';
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
  // 配列をそのまま EditState.sceneTransitions へ通すため、ここで止めないと
  // `durationFrames: NaN` が素通りする（formatTransitionArray は数値を素で埋めるので往復もする）。
  // さらに保存側の NUMERIC_EDIT_FIELDS は 'sceneTransitions' を含むので、通してしまうと
  // 「開けるのにテロップ 1 文字の修正すら 400 で保存できない」プロジェクトになる。
  assertNoNullOrNonFinite('transitionData.ts', 'transitionData', m.transitionData);
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
    // B-0: slide/wipe の方向（UI にはあるのに書き出されず、保存→再読込で既定へ戻っていた）。
    // 未指定なら書かない＝既存ファイル（direction を持たない）の出力は 1 バイトも変わらない。
    if ((t.kind === 'slide' || t.kind === 'wipe') && t.direction !== undefined) {
      lines.push(`    direction: ${jsString(t.direction)},`);
    }
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
