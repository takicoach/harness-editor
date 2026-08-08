import type { RenderOptions } from '../shared/renderPreset';
import { targetResolution } from '../shared/renderPreset';

/**
 * カットしただけの動画を ffmpeg 直結で書き出す（Remotion を通さない高速経路）。
 *
 * Remotion 経路はフレームを 1.5 倍スーパーサンプリングで描き直すため、4K 指定だと
 * 5760×3240 の描画になり実測 10 時間超だった。テロップもエフェクトも無いなら
 * 原本を trim して concat するだけでよく、同じ素材が 9 分で終わる（2026-07-25 実測）。
 */

/** 残す区間（原本フレーム・end は排他）。 */
export interface KeptSegment {
  start: number;
  end: number;
}

/** 出力されるはずのフレーム数（＝カット後の尺）。書き出し後の検算に使う。 */
export function expectedCutFrames(segments: readonly KeptSegment[]): number {
  return segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
}

/** 秒を ffmpeg のフィルタ用文字列にする（小数 6 桁・指数表記を避ける）。 */
function sec(frame: number, fps: number): string {
  return (frame / fps).toFixed(6);
}

/**
 * 残す区間を trim/atrim して concat する filter_complex スクリプトを組み立てる。
 *
 * 区間が 100 を超えると引数長の上限に当たるため、呼び出し側はこれをファイルへ書き出し
 * `-filter_complex_script` で渡す（引き継ぎ手順と同じ形）。
 */
export function buildCutFilterScript(segments: readonly KeptSegment[], fps: number): string {
  if (segments.length === 0) {
    throw new Error('残す区間がありません（全部カットされています）');
  }
  const lines: string[] = [];
  segments.forEach((s, i) => {
    const start = sec(s.start, fps);
    const end = sec(s.end, fps);
    lines.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}];`);
    lines.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}];`);
  });
  const inputs = segments.map((_, i) => `[v${i}][a${i}]`).join('');
  lines.push(`${inputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`);
  return lines.join('\n') + '\n';
}

/**
 * 出力解像度が原本と同じなら null（スケールフィルタ不要）、違えば scale フィルタ文字列。
 * 偶数へ丸める（H.264 は奇数解像度を扱えない）。
 */
export function scaleFilterFor(
  options: RenderOptions,
  source: { width: number; height: number },
): string | null {
  const target = targetResolution(source.width, source.height, options.resolution);
  if (target.width === source.width && target.height === source.height) return null;
  return `scale=${target.width}:${target.height}:flags=lanczos`;
}

/** 画質（CRF 相当）→ ハードウェアエンコーダのビットレート。原本の解像度から決める。 */
function bitrateFor(quality: RenderOptions['quality'], pixels: number): string {
  // 4K(≒830万画素) で 高:80M / 標準:50M / 軽量:25M。解像度に比例させる。
  const base = quality === 'high' ? 80 : quality === 'standard' ? 50 : 25;
  const scaled = Math.max(6, Math.round((base * pixels) / (3840 * 2160)));
  return `${scaled}M`;
}

export interface FastCutArgsInput {
  /** 入力＝原本動画の絶対パス。 */
  input: string;
  /** filter_complex スクリプトのパス。 */
  filterScript: string;
  /** 出力パス。 */
  output: string;
  options: RenderOptions;
  /** 出力の画素数計算に使う最終解像度。 */
  target: { width: number; height: number };
  /** ハードウェアエンコーダ（macOS の VideoToolbox）を使えるか。 */
  hardware: boolean;
}

/**
 * ffmpeg の引数を組み立てる。
 *
 * - macOS は `h264_videotoolbox`（CRF ではなくビットレート指定）で数分に収まる。
 * - それ以外は `libx264`（CRF 指定）。速度は落ちるが同じ結果になる。
 * - 進捗は `-progress pipe:1` で stdout へ流し、UI の進捗バーに繋ぐ。
 */
export function buildFastCutArgs({
  input,
  filterScript,
  output,
  options,
  target,
  hardware,
}: FastCutArgsInput): string[] {
  const codec = hardware
    ? ['-c:v', 'h264_videotoolbox', '-b:v', bitrateFor(options.quality, target.width * target.height)]
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', options.quality === 'high' ? '18' : options.quality === 'standard' ? '21' : '24'];
  return [
    '-hide_banner',
    '-nostats',
    '-progress', 'pipe:1',
    '-i', input,
    '-filter_complex_script', filterScript,
    '-map', '[outv]',
    '-map', '[outa]',
    ...codec,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '320k',
    '-movflags', '+faststart',
    '-y', output,
  ];
}

/**
 * `-progress pipe:1` の出力から進捗を取り出す。総フレーム数は呼び出し側が持つ
 * （ffmpeg は concat 後の総尺を事前に知らせないため）。
 */
export function parseFfmpegProgress(
  chunk: string,
  total: number,
): { frames: number; total: number; percent: number } | null {
  if (total <= 0) return null;
  let last: number | null = null;
  for (const m of chunk.matchAll(/frame=\s*(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) last = n;
  }
  if (last === null) return null;
  return { frames: last, total, percent: Math.min(100, Math.round((last / total) * 100)) };
}

/**
 * 書き出した動画のフレーム数を ffprobe で数え、想定（カット後の尺）と一致するか検算する。
 * 一致すれば null、違えば注意書きを返す。数えられない場合も null（検算できないだけで失敗ではない）。
 */
export function verifyCutFrames(
  output: string,
  expectedFrames: number,
  probeFrames: (path: string) => number | null,
): string | null {
  const actual = probeFrames(output);
  if (actual === null || actual <= 0) return null;
  // 1 フレームのずれは端数（可変フレームレート素材など）で普通に起きる。
  if (Math.abs(actual - expectedFrames) <= 1) return null;
  return `書き出した動画の長さが想定と違います（想定 ${expectedFrames} フレーム / 実際 ${actual} フレーム）。カット位置がずれていないか確認してください`;
}
