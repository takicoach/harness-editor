import { evalDataModule } from './dataModule';
import { replaceExportArray } from './sourceEdit';
import { ProjectFileError, type SoundEffect } from './types';

/**
 * ハーネス形式の seData.ts を読み取り SoundEffect[] を返す。
 * source が null（seData.ts 不在＝SE 未配置）の場合は空配列。
 * seData.ts は SoundEffect 型を './SEPlayer' から import するため型スタブを渡す。
 */
export function parseSeData(source: string | null): SoundEffect[] {
  if (source === null) return [];
  const m = evalDataModule(source, { './SEPlayer': {} });
  if (!Array.isArray(m.seData)) {
    throw new ProjectFileError('seData.ts', 'seData 配列が見つかりません');
  }
  return m.seData as SoundEffect[];
}

/** 文字列をダブルクオートの JS リテラルへ。改行は \n / \r、" と \ をエスケープ。 */
function jsString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

/** SoundEffect[] を seData.ts の配列リテラル文字列へ整形する。 */
export function formatSeArray(se: SoundEffect[]): string {
  if (se.length === 0) return '[]';
  const items = se.map((s) => {
    const lines = [
      `    id: ${s.id},`,
      `    startFrame: ${s.startFrame},`,
    ];
    if (s.endFrame !== undefined) lines.push(`    endFrame: ${s.endFrame},`);
    lines.push(`    file: ${jsString(s.file)},`);
    if (s.volume !== undefined) lines.push(`    volume: ${s.volume},`);
    if (s.fadeInFrames !== undefined && s.fadeInFrames !== 0) lines.push(`    fadeInFrames: ${s.fadeInFrames},`);
    if (s.fadeOutFrames !== undefined && s.fadeOutFrames !== 0) lines.push(`    fadeOutFrames: ${s.fadeOutFrames},`);
    return `  {\n${lines.join('\n')}\n  }`;
  });
  return `[\n${items.join(',\n')},\n]`;
}

/**
 * SE 未配置プロジェクト用に seData.ts を新規生成するときのテンプレート。
 * SoundEffect 型は ハーネス標準の `./SEPlayer` から import する形にすることで、
 * プロジェクト内に型を二重定義しない（フィクスチャ・上流の seData.ts と同じ形）。
 * 注: `./SEPlayer.ts` が無いプロジェクトでは ハーネス側の build が落ちるが、
 * SE を使うプロジェクトには SEPlayer.ts が同梱されている前提のため、ここでは作らない。
 */
function newSeDataSource(): string {
  return `import type { SoundEffect } from './SEPlayer';

// Harness Editor が生成・更新します

export const seData: SoundEffect[] = [];
`;
}

/**
 * SoundEffect[] を seData.ts ソースへ書き戻す。
 * originalSource が null かつ SE が空なら null を返す（空の seData.ts を作らない）。
 * originalSource が null かつ SE があれば新規雛形を生成する。
 */
export function serializeSeData(
  originalSource: string | null,
  se: SoundEffect[],
): string | null {
  if (originalSource === null && se.length === 0) return null;
  const base = originalSource ?? newSeDataSource();
  return replaceExportArray(base, 'seData', formatSeArray(se));
}
