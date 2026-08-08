/**
 * ffmpeg 音声ノイズ除去に渡す引数を組み立てる純関数群。
 *
 * 使用フィルタ: afftdn（適応型高速フーリエ変換デノイズ）
 *   -af afftdn=nr=<dB>  で nr（ノイズリダクション量・dB）を指定する。
 *   値が大きいほどノイズ除去が強くなるが、音声の自然さが損なわれる。
 *
 * 映像ストリームは -c:v copy でコピーする（再エンコードなし・尺不変・高速）。
 * 音声は AAC 192k で再エンコードする（フィルタ適用に再エンコードが必須）。
 */

/** ノイズ除去強度の識別子。 */
export type DenoiseStrength = 'weak' | 'mid' | 'strong';

/**
 * 強度識別子を afftdn の nr 値（dB）へ変換する。
 * 省略時は既定値 'mid'（12 dB）を使う。
 */
export function strengthToNr(strength: DenoiseStrength | undefined): number {
  const s = strength ?? 'mid';
  if (s === 'weak') return 6;
  if (s === 'strong') return 21;
  return 12; // 'mid'
}

export interface BuildDenoiseArgsInput {
  /** 入力ファイルの絶対パス。 */
  input: string;
  /** 出力ファイルの絶対パス（一時ファイルを指定し、完了後に rename する）。 */
  output: string;
  /** ノイズ除去強度。省略時は 'mid'。 */
  strength?: DenoiseStrength;
}

/**
 * ffmpeg に渡す引数配列を返す。
 *
 * 出力順:
 *   -y -i <input> -af afftdn=nr=<dB> -c:v copy -c:a aac -b:a 192k <output>
 */
export function buildDenoiseArgs({ input, output, strength }: BuildDenoiseArgsInput): string[] {
  const nr = strengthToNr(strength);
  return [
    '-y',
    '-i', input,
    '-af', `afftdn=nr=${nr}`,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    output,
  ];
}
