/**
 * プレビュー軽量化（preview proxy）の ffmpeg 引数を組み立てる純関数。
 *
 * 出力仕様: H.264 / 短辺 720px / CRF 26 / 固定フレームレート（fps フィルタ）/
 * キーフレーム間隔 2 秒 / faststart。
 * - fps フィルタは VFR（Zoom・画面録画）を CFR 化し、シークと同期を安定させる
 * - キーフレーム間隔を短くするとタイムラインのスクラブが軽くなる
 *   （Remotion のシークは直前キーフレームからデコードし直すため）
 * - 書き出しは常に原本を使うため、この変換は成果物の画質に影響しない
 */

/** プロキシの短辺目標（px）。 */
export const PROXY_SHORT_SIDE = 720;

export interface PreviewProxyArgsInput {
  input: string;
  output: string;
  sourceWidth: number;
  sourceHeight: number;
  /** 元動画の公称 fps（r_frame_rate）。CFR 化の目標フレームレートに丸めて使う。 */
  fps: number;
  /** 実測平均 fps（avg_frame_rate）。VFR ソースでは公称より低いことがある。 */
  avgFps?: number | null;
}

/**
 * CFR 化の目標 fps（整数へ丸め、1〜60 にクランプ）。
 * VFR ソースは r_frame_rate が timebase 由来の高値になることがあるため、
 * avg_frame_rate が取れていれば低い方を採る（平均 15fps の画面録画を
 * 60fps CFR に膨らませて「軽量化の逆」になるのを防ぐ）。
 */
export function targetProxyFps(fps: number, avgFps: number | null = null): number {
  const effective = avgFps !== null && avgFps > 0 ? Math.min(fps, avgFps) : fps;
  return Math.min(60, Math.max(1, Math.round(effective)));
}

/** -vf に渡すフィルタチェーン。短辺が 720 以下なら scale は入れない。 */
export function buildProxyFilters(i: Pick<PreviewProxyArgsInput, 'sourceWidth' | 'sourceHeight' | 'fps' | 'avgFps'>): string {
  const filters = [`fps=${targetProxyFps(i.fps, i.avgFps ?? null)}`];
  if (Math.min(i.sourceWidth, i.sourceHeight) > PROXY_SHORT_SIDE) {
    // 横長は高さを 720 に、縦長は幅を 720 に。-2 で偶数を保証（libx264 の要件）。
    filters.push(
      i.sourceWidth >= i.sourceHeight ? `scale=-2:${PROXY_SHORT_SIDE}` : `scale=${PROXY_SHORT_SIDE}:-2`,
    );
  }
  return filters.join(',');
}

export function buildPreviewProxyArgs(i: PreviewProxyArgsInput): string[] {
  const tf = targetProxyFps(i.fps, i.avgFps ?? null);
  return [
    '-y',
    // 進捗を stdout へ 1 行ずつ吐かせる（ジョブが out_time= を percent に変換する）
    '-progress', 'pipe:1',
    '-nostats',
    '-i', i.input,
    '-vf', buildProxyFilters(i),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    '-g', String(tf * 2), // キーフレーム間隔 2 秒
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    i.output,
  ];
}
