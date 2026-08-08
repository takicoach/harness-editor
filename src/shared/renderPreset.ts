/**
 * renderPreset — 書き出しプリセットの純ロジック（クライアント/サーバ共用）。
 *
 * プリセットは `remotion render` の `--scale` / `--crf` への変換だけで実現する。
 * フォーマット（youtube/short/square）自体は変えない（プロジェクト作成時に決まる）。
 */

import type { Orientation } from '../core/types';

/**
 * 解像度の選択肢。
 * - full  = 原本（プロジェクト）の解像度そのまま。4K 素材なら 4K で出る
 * - 1080p = 短辺 1080（横型なら 1920×1080）。原本がこれより小さければ縮小しない
 * - 720p  = 長辺基準で 2/3 縮小（従来の「軽量」）
 */
export type RenderResolution = 'full' | '1080p' | '720p';

/** 画質の選択肢（H.264 CRF へ変換）。 */
export type RenderQuality = 'high' | 'standard' | 'light';

/** ダイアログ→サーバへ渡す書き出しオプション。 */
export interface RenderOptions {
  resolution: RenderResolution;
  quality: RenderQuality;
}

/** SNS 名プリセット（詳細設定のショートカット）。 */
export type RenderPresetId = 'post' | 'standard' | 'light';

export const RENDER_PRESETS: Record<RenderPresetId, RenderOptions> = {
  post: { resolution: 'full', quality: 'high' },
  standard: { resolution: 'full', quality: 'standard' },
  light: { resolution: '720p', quality: 'light' },
};

/** 既定値（body 無し POST の後方互換もこれ）。 */
export const DEFAULT_RENDER_OPTIONS: RenderOptions = RENDER_PRESETS.post;

const CRF_MAP: Record<RenderQuality, number> = {
  high: 18,
  standard: 23,
  // 28 だとズーム/パン区間で圧縮ポンピング（微チラつき）が残るため 24（2026-07-09 実測）。
  light: 24,
};

/**
 * 中間レンダー用の低ロス CRF。最終画質は postScaleArgs（ffmpeg）側の CRF_MAP が決めるため、
 * ここは縮小前の情報量を保つことだけが目的。
 */
const INTERMEDIATE_CRF = 14;

/**
 * スーパーサンプリング倍率。ズーム/パン変形中の Chromium リサンプリングは
 * 細かいテクスチャ（ネット・芝目等）でフレーム毎に揺らぐシマー（チラつき）を生む。
 * 1.5 倍で描画→lanczos で 2/3 縮小すると実測でシマーが消える（2026-07-09 dji-0688 検証:
 * 隣接フレームのシャープネス振動 44/160 → 0/160）。
 */
const SUPERSAMPLE = 1.5;

/** 720p 相当 = 1080 基準の 2/3 縮小（縦横どちらのフォーマットでも長辺比は同じ）。 */
const SCALE_720P = 2 / 3;

/** 1080p の基準＝短辺 1080（横 1920×1080 / 縦 1080×1920 / 正方 1080×1080）。 */
const SHORT_EDGE_1080 = 1080;

/** 偶数へ丸める（H.264 は奇数解像度を扱えない）。 */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * 出力の実解像度を返す。UI のラベルと、ffmpeg の scale フィルタの両方がこれを使う
 * （表示と実出力がずれないよう 1 か所に集約する）。
 */
export function targetResolution(
  width: number,
  height: number,
  resolution: RenderResolution,
): { width: number; height: number } {
  if (resolution === 'full') return { width, height };
  if (resolution === '1080p') {
    const shortEdge = Math.min(width, height);
    // 原本が 1080 以下なら拡大しない（引き伸ばしても情報は増えない）。
    if (shortEdge <= SHORT_EDGE_1080) return { width, height };
    const ratio = SHORT_EDGE_1080 / shortEdge;
    return { width: even(width * ratio), height: even(height * ratio) };
  }
  return { width: even(width * SCALE_720P), height: even(height * SCALE_720P) };
}

/**
 * RenderOptions → remotion render の追加 CLI 引数（中間レンダー）。
 * 解像度によらず 1.5 倍スーパーサンプリングで描画し、postScaleArgs の ffmpeg で
 * full=2/3（等倍へ）、720p=4/9（720p へ）に lanczos 縮小して最終出力になる。
 * 720p も SS 中間を使う方が等倍中間よりシマーが少ない（2026-07-09 実測 13→8/160）。
 */
export function renderExtraArgs(_options: RenderOptions): string[] {
  return ['--crf', String(INTERMEDIATE_CRF), '--scale', String(SUPERSAMPLE)];
}

/**
 * 中間レンダー（1.5 倍）→ 最終出力の ffmpeg 引数（lanczos 縮小＋最終 CRF）。
 * trunc(iw/3)*2 = 2/3、trunc(iw/9)*4 = 4/9。どちらも偶数を同時に満たす
 * （H.264 は奇数解像度不可）。音声は中間ファイルからそのままコピー。
 */
export function postScaleArgs(
  options: RenderOptions,
  input: string,
  output: string,
  /** プロジェクト（合成）の解像度。中間ファイルはこの 1.5 倍で描かれている。 */
  source: { width: number; height: number },
): string[] {
  // 中間の 1.5 倍から、最終解像度（絶対値）へ一度で縮小する。
  const target = targetResolution(source.width, source.height, options.resolution);
  const vf = `scale=${target.width}:${target.height}:flags=lanczos`;
  return [
    '-i', input,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(CRF_MAP[options.quality]),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'copy',
    '-y', output,
  ];
}

/** 最終出力ファイル名。縮小版は投稿用と取り違えないよう suffix を付ける。 */
export function renderOutputName(options: RenderOptions): string {
  if (options.resolution === '720p') return 'video-720p.mp4';
  if (options.resolution === '1080p') return 'video-1080p.mp4';
  return 'video.mp4';
}

/** unknown な body 値を検証して RenderOptions にする（不正は null）。 */
export function parseRenderOptions(body: unknown): RenderOptions | null {
  if (body === undefined || body === null || (typeof body === 'object' && Object.keys(body as object).length === 0)) {
    return DEFAULT_RENDER_OPTIONS;
  }
  if (typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  const resolution = rec['resolution'];
  const quality = rec['quality'];
  if (resolution !== 'full' && resolution !== '1080p' && resolution !== '720p') return null;
  if (quality !== 'high' && quality !== 'standard' && quality !== 'light') return null;
  return { resolution, quality };
}

/** RenderOptions がどのプリセットに一致するか（一致しなければ null = カスタム）。 */
export function matchPreset(options: RenderOptions): RenderPresetId | null {
  for (const id of Object.keys(RENDER_PRESETS) as RenderPresetId[]) {
    const p = RENDER_PRESETS[id];
    if (p.resolution === options.resolution && p.quality === options.quality) return id;
  }
  return null;
}

/** プリセットの表示ラベル（orientation で投稿先名を出し分け）。 */
export function presetLabel(id: RenderPresetId, orientation: Orientation): string {
  if (id === 'post') {
    if (orientation === 'portrait') return 'ショート / Reels 投稿用（高画質）';
    if (orientation === 'square') return 'フィード投稿用（高画質・正方形）';
    return 'YouTube 投稿用（高画質）';
  }
  if (id === 'standard') return '標準（画質とサイズのバランス）';
  return '軽量・確認用（720p・共有やX投稿に）';
}

/** 出力解像度の表示用文字列（例: 1080×1920 → 720×1280）。 */
export function resolutionLabel(
  width: number,
  height: number,
  resolution: RenderResolution,
): string {
  const t = targetResolution(width, height, resolution);
  return `${t.width}×${t.height}`;
}
