import { evalDataModule, assertNoNullOrNonFinite } from './dataModule';
import { replaceExportArray } from './sourceEdit';
import { ProjectFileError, type BgmClip } from './types';

/** BgmSequence の型 import を解決するスタブ。 */
const STUBS: Record<string, Record<string, unknown>> = { './types': {}, './BgmSequence': {} };

/** src/Bgm/bgmData.ts を読み取り BgmClip[] を返す。source が null（不在）なら空配列。 */
export function parseBgmData(source: string | null, options: { includeDerivedDucking?: boolean } = {}): BgmClip[] {
  if (source === null) return [];
  const m = evalDataModule(source, STUBS);
  if (!Array.isArray(m.bgmData)) {
    throw new ProjectFileError('bgmData.ts', 'bgmData 配列が見つかりません');
  }
  assertNoNullOrNonFinite('bgmData.ts', 'bgmData', m.bgmData);
  // Ordinary project loading recomputes ducking. Merging already projected output
  // must retain that output's envelope instead of silently dropping it.
  return (m.bgmData as BgmClip[]).map(c => ({ ...normalize(c),
    ...(options.includeDerivedDucking && c.ducking ? { ducking: c.ducking } : {}),
  }));
}

/**
 * bgmData.ts に ducking が焼き込まれているか（評価済みモジュールで判定・整形に非依存）。
 * normalize() が ducking を捨てる前の生オブジェクト配列を見て判定するため、
 * インデント・改行・コメント等の整形差分に影響されない（正規表現の '^\s*ducking\s*:' より頑健）。
 * source が null（不在）なら false。パース不能（配列でない・vm 評価失敗）は安全側（true = Remotion 経路）に倒す。
 */
export function bgmSourceHasDucking(source: string | null): boolean {
  if (source === null) return false;
  try {
    const m = evalDataModule(source, STUBS);
    if (!Array.isArray(m.bgmData)) return true; // 想定外の形は安全側
    return (m.bgmData as Array<{ ducking?: unknown } | null | undefined>).some((c) => c?.ducking != null);
  } catch {
    return true; // 評価失敗（構文エラー等）も安全側
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normalize(c: BgmClip): BgmClip {
  return {
    id: c.id,
    file: c.file,
    startFrame: c.startFrame,
    endFrame: c.endFrame,
    volume: clamp(c.volume ?? 1, 0, 1),
    fadeInFrames: Math.max(0, c.fadeInFrames ?? 0),
    fadeOutFrames: Math.max(0, c.fadeOutFrames ?? 0),
  };
}

/** 文字列をダブルクオートの JS リテラルへ。 */
function jsString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

/** BgmClip[] を bgmData.ts の配列リテラル文字列へ整形。 */
export function formatBgmArray(clips: BgmClip[]): string {
  if (clips.length === 0) return '[]';
  const items = clips.map((c) => {
    const lines = [
      `    id: ${c.id},`,
      `    file: ${jsString(c.file)},`,
      `    startFrame: ${c.startFrame},`,
      `    endFrame: ${c.endFrame},`,
      `    volume: ${c.volume},`,
      `    fadeInFrames: ${c.fadeInFrames},`,
      `    fadeOutFrames: ${c.fadeOutFrames},`,
    ];
    if (c.ducking) {
      const regions = c.ducking.regions.map((r) => `{ start: ${r.start}, end: ${r.end} }`).join(', ');
      lines.push(
        `    ducking: { gain: ${c.ducking.gain}, attackFrames: ${c.ducking.attackFrames}, releaseFrames: ${c.ducking.releaseFrames}, regions: [${regions}] },`,
      );
    }
    return `  {\n${lines.join('\n')}\n  }`;
  });
  return `[\n${items.join(',\n')},\n]`;
}

const DEFAULT_HEADER = `import type { BgmClip } from './types';

export const bgmData: BgmClip[] = `;

/**
 * BgmClip[] を bgmData.ts ソースへ。既存 source があれば import/ヘッダを保持し配列だけ置換、
 * 無ければ既定ヘッダで新規生成する。
 * source が null かつ clips が空なら null（空ファイルを作らない）。
 */
export function serializeBgmData(clips: BgmClip[], source: string | null): string | null {
  if (source === null && clips.length === 0) return null;
  const arrayLiteral = formatBgmArray(clips);
  if (source === null) {
    return `${DEFAULT_HEADER}${arrayLiteral};\n`;
  }
  return replaceExportArray(source, 'bgmData', arrayLiteral);
}
