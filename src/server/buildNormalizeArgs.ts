/**
 * ffmpeg loudnorm（EBU R128 ラウドネス正規化）の引数を組み立てる純関数群。
 *
 * 2パス方式:
 *   1パス目（測定）: print_format=json で実測ラウドネスを stderr に出させる。
 *   2パス目（適用）: 実測値を measured_* に埋めて linear=true で正規化する。
 * 映像は -c:v copy でコピー（無劣化・尺不変）。音声は AAC 192k で再エンコード。
 */

/** 目標ラウドネスのプリセット識別子。 */
export type NormalizeStrength = 'loud' | 'standard' | 'quiet';

/** loudnorm 1パス目の実測値（2パス目に渡す）。 */
export interface LoudnormMeasured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** 強さ→目標統合ラウドネス I（LUFS）。省略時は standard(-14)。 */
export function targetToLufs(strength: NormalizeStrength | undefined): number {
  const s = strength ?? 'standard';
  if (s === 'loud') return -10;
  if (s === 'quiet') return -18;
  return -14; // standard
}

/** 1パス目（測定）の ffmpeg 引数。stderr 末尾に JSON を出させ、本体出力は捨てる。 */
export function buildMeasureArgs({ input, targetLufs }: { input: string; targetLufs: number }): string[] {
  return [
    '-hide_banner',
    '-i', input,
    '-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json`,
    '-f', 'null', '-',
  ];
}

/**
 * 2パス目（適用）の ffmpeg 引数。
 * measured があれば measured_* と offset を埋め linear=true で正規化（高精度）。
 * measured が null（測定値が取れなかった）なら loudnorm 単体の動的正規化にフォールバック。
 */
export function buildApplyArgs({
  input,
  output,
  targetLufs,
  measured,
}: {
  input: string;
  output: string;
  targetLufs: number;
  measured: LoudnormMeasured | null;
}): string[] {
  const filter = measured
    ? `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=summary`
    : `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`;
  return [
    '-y',
    '-i', input,
    '-af', filter,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    output,
  ];
}

/**
 * loudnorm の stderr から実測 JSON を取り出す。
 * loudnorm は stderr 末尾に { ... } ブロックを出力する。
 * 最後の '{' から最後の '}' までを取り出して parse し、必要キーが揃っていれば返す。
 */
export function parseLoudnormJson(stderr: string): LoudnormMeasured | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const;
    for (const k of keys) {
      if (typeof obj[k] !== 'string') return null;
    }
    return {
      input_i: obj['input_i'] as string,
      input_tp: obj['input_tp'] as string,
      input_lra: obj['input_lra'] as string,
      input_thresh: obj['input_thresh'] as string,
      target_offset: obj['target_offset'] as string,
    };
  } catch {
    return null;
  }
}
